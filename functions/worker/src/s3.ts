import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type HeadObjectCommandOutput,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { AgentRunMessageBodyWriteOutcomeUnknownError } from "./types.ts";
import { artifactBucketAllowed } from "./artifact-buckets.ts";
import { hasControlCharacter } from "./control-characters.ts";
import type {
  AgentRunMessageBodyDelete,
  AgentRunWorkerDependencies,
  MessageRecordValue,
} from "./types.ts";

export const DEFAULT_MAX_MESSAGE_BODY_BYTES = 4 * 1024 * 1024;
const MAX_CONDITIONAL_PUT_ATTEMPTS = 3;

type MessageBodyReader = NonNullable<AgentRunWorkerDependencies["readMessageBody"]>;
type MessageBodyWriter = NonNullable<AgentRunWorkerDependencies["writeMessageBody"]>;
type MessageBodyDeleter = NonNullable<AgentRunWorkerDependencies["deleteMessageBody"]>;

export interface S3MessageBodyReaderOptions {
  readonly bucket: string;
  readonly client?: Pick<S3Client, "send">;
  readonly clientConfig?: S3ClientConfig;
  readonly keyPrefix?: string;
  readonly legacyBuckets?: readonly string[];
  readonly maxBodyBytes?: number;
}

export interface S3MessageBodyWriterOptions {
  readonly bucket: string;
  readonly client?: Pick<S3Client, "send">;
  readonly clientConfig?: S3ClientConfig;
  readonly keyPrefix?: string;
  readonly kmsKeyId: string;
  readonly maxBodyBytes?: number;
}

function requiredText(value: string | undefined, label: string): string {
  const result = value?.trim();
  if (!result) throw new Error(`Agent run S3 ${label} is required.`);
  return result;
}

function kmsKeyArn(value: string): string {
  const arn = requiredText(value, "KMS key ARN");
  if (!/^arn:aws(?:-[a-z0-9-]+)?:kms:[a-z0-9-]+:\d{12}:key\/[A-Za-z0-9-]+$/u.test(arn)) {
    throw new Error("Agent run S3 KMS key must be a canonical key ARN.");
  }
  return arn;
}

function objectKey(value: string): string {
  if (!value || hasControlCharacter(value)) {
    throw new Error("Agent run S3 object key is required and must not contain control characters.");
  }
  return value;
}

function keyPrefix(value: string | undefined): string {
  const prefix = (value ?? "message-bodies").replace(/^\/+|\/+$/gu, "");
  if (!prefix || hasControlCharacter(prefix) || prefix.includes("..")) {
    throw new Error("Agent run S3 message body key prefix is invalid.");
  }
  return prefix;
}

function maximumBodyBytes(value: number | undefined): number {
  const maximum = value ?? DEFAULT_MAX_MESSAGE_BODY_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new Error("Agent run S3 maximum message body bytes must be a positive integer.");
  }
  return maximum;
}

function sha256(value: string, label: string): string {
  const normalized = value.toLowerCase().replace(/^sha256:/u, "");
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error(`Agent run S3 ${label} must be a SHA-256 hex digest.`);
  }
  return normalized;
}

function etag(value: string): string {
  return value.trim().replace(/^"|"$/gu, "");
}

function conflictExists(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false;
  const error = cause as {
    readonly $metadata?: { readonly httpStatusCode?: number };
    readonly name?: string;
  };
  return error.$metadata?.httpStatusCode === 412 || error.name === "PreconditionFailed";
}

function conditionalRequestConflict(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false;
  const error = cause as {
    readonly $metadata?: { readonly httpStatusCode?: number };
    readonly name?: string;
  };
  return error.$metadata?.httpStatusCode === 409 || error.name === "ConditionalRequestConflict";
}

function ambiguousPutFailure(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return true;
  const error = cause as {
    readonly $metadata?: { readonly httpStatusCode?: number };
    readonly name?: string;
  };
  const status = error.$metadata?.httpStatusCode;
  if (status === undefined) return true;
  if (status >= 500 || status === 408 || status === 429) return true;
  return ["AbortError", "RequestTimeout", "RequestTimeoutException", "TimeoutError"].includes(
    error.name ?? "",
  );
}

interface MessageBodyKeyScope {
  readonly contentHash: string;
  readonly environmentId: string;
  readonly messageId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly threadId: string;
}

function messageBodyKey(prefix: string, scope: MessageBodyKeyScope): string {
  return [
    prefix,
    "organizations",
    scope.organizationId,
    "projects",
    scope.projectId,
    "environments",
    scope.environmentId,
    "threads",
    scope.threadId,
    "runs",
    scope.runId,
    "messages",
    scope.messageId,
    "sha256",
    scope.contentHash,
  ].join("/");
}

class ExistingMessageBodyMismatchError extends Error {
  constructor() {
    super("Existing assistant message S3 object does not match the retry payload.");
    this.name = "ExistingMessageBodyMismatchError";
  }
}

function textualContentType(value: string): string {
  const contentType = value.trim().toLowerCase();
  const [mediaType = "", ...parameters] = contentType.split(";");
  if (
    !mediaType.startsWith("text/") &&
    mediaType !== "application/json" &&
    mediaType !== "application/xml" &&
    !mediaType.endsWith("+json") &&
    !mediaType.endsWith("+xml")
  ) {
    throw new Error("Agent run S3 message body content type must be textual.");
  }
  for (const parameter of parameters) {
    const separator = parameter.indexOf("=");
    if (separator < 0 || parameter.slice(0, separator).trim() !== "charset") continue;
    const charset = parameter
      .slice(separator + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/u, "$2");
    if (charset !== "utf-8" && charset !== "utf8") {
      throw new Error("Agent run S3 message body charset must be UTF-8.");
    }
  }
  return contentType;
}

function bodyReference(message: MessageRecordValue) {
  const reference = message.data.bodyRef;
  if (!reference) throw new Error(`Message ${message.data.id} does not contain a body reference.`);
  return reference;
}

function asyncBytes(value: unknown): value is AsyncIterable<Uint8Array> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

export async function readBoundedS3BodyBytes(
  body: unknown,
  expectedBytes: number,
  trustedContentLength: number | undefined,
): Promise<Uint8Array> {
  if (asyncBytes(body)) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of body) {
      if (!(chunk instanceof Uint8Array)) {
        throw new Error("Agent run S3 body stream returned a non-byte chunk.");
      }
      total += chunk.byteLength;
      if (total > expectedBytes) {
        throw new Error("Agent run S3 body stream exceeds its referenced size.");
      }
      chunks.push(chunk);
    }
    if (total !== expectedBytes) {
      throw new Error("Agent run S3 body stream does not match its referenced size.");
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
  const transform = (body as { readonly transformToByteArray?: unknown } | undefined)
    ?.transformToByteArray;
  if (typeof transform !== "function" || trustedContentLength !== expectedBytes) {
    throw new Error("Agent run S3 body cannot be read through a bounded byte stream.");
  }
  return transform.call(body) as Promise<Uint8Array>;
}

export function createS3MessageBodyReader(options: S3MessageBodyReaderOptions): MessageBodyReader {
  const expectedBucket = requiredText(options.bucket, "bucket");
  const prefix = keyPrefix(options.keyPrefix);
  const maxBodyBytes = maximumBodyBytes(options.maxBodyBytes);
  const client = options.client ?? new S3Client(options.clientConfig ?? {});

  return async (message, signal) => {
    const reference = bodyReference(message);
    if (!artifactBucketAllowed(reference.bucket, expectedBucket, options.legacyBuckets)) {
      throw new Error(`Message ${message.data.id} references an unexpected S3 bucket.`);
    }
    const expectedSha256 = sha256(reference.sha256, "body reference digest");
    const messageContentHash = sha256(message.data.contentHash, "message content hash");
    if (messageContentHash !== expectedSha256) {
      throw new Error(`Message ${message.data.id} content hashes do not match.`);
    }
    if (!message.data.runId) {
      throw new Error(`Message ${message.data.id} body reference requires a runId.`);
    }
    const key = objectKey(reference.key);
    const expectedKey = messageBodyKey(prefix, {
      contentHash: expectedSha256,
      environmentId: message.data.environmentId,
      messageId: message.data.id,
      organizationId: message.data.organizationId,
      projectId: message.data.projectId,
      runId: message.data.runId,
      threadId: message.data.threadId,
    });
    if (key !== expectedKey) {
      throw new Error(`Message ${message.data.id} references an unexpected S3 object key.`);
    }
    if (
      !Number.isSafeInteger(reference.byteSize) ||
      reference.byteSize < 0 ||
      reference.byteSize > maxBodyBytes
    ) {
      throw new Error(
        `Message ${message.data.id} body size must be from 0 to ${maxBodyBytes} bytes.`,
      );
    }
    const expectedContentType = textualContentType(reference.contentType);
    const response = await client.send(
      new GetObjectCommand({
        Bucket: reference.bucket,
        ...(reference.etag ? { IfMatch: reference.etag } : {}),
        Key: key,
        ...(reference.versionId ? { VersionId: reference.versionId } : {}),
      }),
      signal ? { abortSignal: signal } : undefined,
    );
    if (!response.Body) throw new Error(`Message ${message.data.id} S3 object body is missing.`);
    if (response.ContentLength !== undefined && response.ContentLength !== reference.byteSize) {
      throw new Error(`Message ${message.data.id} S3 object size does not match its reference.`);
    }
    if (
      response.ContentType !== undefined &&
      response.ContentType.trim().toLowerCase() !== expectedContentType
    ) {
      throw new Error(`Message ${message.data.id} S3 content type does not match its reference.`);
    }
    if (reference.etag && response.ETag && etag(response.ETag) !== etag(reference.etag)) {
      throw new Error(`Message ${message.data.id} S3 ETag does not match its reference.`);
    }
    if (
      reference.versionId &&
      response.VersionId !== undefined &&
      response.VersionId !== reference.versionId
    ) {
      throw new Error(`Message ${message.data.id} S3 version does not match its reference.`);
    }
    const bytes = await readBoundedS3BodyBytes(
      response.Body,
      reference.byteSize,
      response.ContentLength,
    );
    if (bytes.byteLength !== reference.byteSize || bytes.byteLength > maxBodyBytes) {
      throw new Error(`Message ${message.data.id} S3 body size does not match its reference.`);
    }
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (actualSha256 !== expectedSha256) {
      throw new Error(`Message ${message.data.id} S3 body digest does not match its reference.`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (cause) {
      throw new Error(`Message ${message.data.id} S3 body is not valid UTF-8.`, { cause });
    }
  };
}

export function createS3MessageBodyDeleter(
  options: S3MessageBodyReaderOptions,
): MessageBodyDeleter {
  const expectedBucket = requiredText(options.bucket, "bucket");
  const prefix = keyPrefix(options.keyPrefix);
  const client = options.client ?? new S3Client(options.clientConfig ?? {});

  return async (input: AgentRunMessageBodyDelete) => {
    if (!artifactBucketAllowed(input.bodyRef.bucket, expectedBucket, options.legacyBuckets)) {
      throw new Error(`Message ${input.messageId} references an unexpected S3 bucket.`);
    }
    const expectedKey = messageBodyKey(prefix, {
      contentHash: sha256(input.bodyRef.sha256, "body reference digest"),
      environmentId: input.run.data.environmentId,
      messageId: input.messageId,
      organizationId: input.run.data.organizationId,
      projectId: input.run.data.projectId,
      runId: input.run.data.id,
      threadId: input.run.data.threadId,
    });
    const key = objectKey(input.bodyRef.key);
    if (key !== expectedKey) {
      throw new Error(`Message ${input.messageId} references an unexpected S3 object key.`);
    }
    const versionId = requiredText(input.bodyRef.versionId, "body reference versionId");
    await client.send(
      new DeleteObjectCommand({
        Bucket: input.bodyRef.bucket,
        Key: key,
        VersionId: versionId,
      }),
      input.signal ? { abortSignal: input.signal } : undefined,
    );
  };
}

export function createS3MessageBodyWriter(options: S3MessageBodyWriterOptions): MessageBodyWriter {
  const bucket = requiredText(options.bucket, "bucket");
  const kmsKeyId = kmsKeyArn(options.kmsKeyId);
  const prefix = keyPrefix(options.keyPrefix);
  const maxBodyBytes = maximumBodyBytes(options.maxBodyBytes);
  const client = options.client ?? new S3Client(options.clientConfig ?? {});

  return async (input) => {
    const body = new TextEncoder().encode(input.body);
    if (body.byteLength > maxBodyBytes) {
      throw new Error(
        `Assistant message body exceeds the S3 write limit of ${maxBodyBytes} bytes.`,
      );
    }
    const digest = createHash("sha256").update(body).digest("hex");
    if (sha256(input.contentHash, "message content hash") !== digest) {
      throw new Error("Assistant message content hash does not match its body.");
    }
    const key = messageBodyKey(prefix, {
      contentHash: digest,
      environmentId: input.run.data.environmentId,
      messageId: input.messageId,
      organizationId: input.run.data.organizationId,
      projectId: input.run.data.projectId,
      runId: input.run.data.id,
      threadId: input.run.data.threadId,
    });
    const contentType = "text/plain; charset=utf-8";
    const checksum = Buffer.from(digest, "hex").toString("base64");
    const existingBodyReference = async () => {
      const existing: HeadObjectCommandOutput = await client.send(
        new HeadObjectCommand({ Bucket: bucket, ChecksumMode: "ENABLED", Key: key }),
        input.signal && !input.signal.aborted ? { abortSignal: input.signal } : undefined,
      );
      if (
        existing.ContentLength !== body.byteLength ||
        existing.ContentType?.trim().toLowerCase() !== contentType ||
        existing.Metadata?.messageId !== input.messageId ||
        existing.Metadata?.runId !== input.run.data.id ||
        existing.Metadata?.sha256 !== digest ||
        existing.ChecksumSHA256 !== checksum ||
        existing.ServerSideEncryption !== "aws:kms" ||
        existing.SSEKMSKeyId !== kmsKeyId ||
        !existing.VersionId?.trim()
      ) {
        throw new ExistingMessageBodyMismatchError();
      }
      return {
        bucket,
        byteSize: body.byteLength,
        contentType,
        ...(existing.ETag ? { etag: existing.ETag } : {}),
        key,
        sha256: digest,
        versionId: existing.VersionId.trim(),
      };
    };
    for (let attempt = 0; attempt < MAX_CONDITIONAL_PUT_ATTEMPTS; attempt += 1) {
      try {
        const response = await client.send(
          new PutObjectCommand({
            Body: body,
            Bucket: bucket,
            ChecksumSHA256: checksum,
            ContentType: contentType,
            IfNoneMatch: "*",
            Key: key,
            Metadata: {
              environmentId: input.run.data.environmentId,
              messageId: input.messageId,
              organizationId: input.run.data.organizationId,
              projectId: input.run.data.projectId,
              runId: input.run.data.id,
              sha256: digest,
              threadId: input.run.data.threadId,
            },
            ServerSideEncryption: "aws:kms",
            SSEKMSKeyId: kmsKeyId,
          }),
          input.signal ? { abortSignal: input.signal } : undefined,
        );
        if (!response.VersionId?.trim()) {
          const missingVersion = new Error(
            "Assistant message S3 write did not return an object version ID.",
          );
          try {
            return await existingBodyReference();
          } catch (reconciliationCause) {
            throw new AgentRunMessageBodyWriteOutcomeUnknownError([
              missingVersion,
              reconciliationCause,
            ]);
          }
        }
        return {
          bucket,
          byteSize: body.byteLength,
          contentType,
          ...(response.ETag ? { etag: response.ETag } : {}),
          key,
          sha256: digest,
          versionId: response.VersionId.trim(),
        };
      } catch (cause) {
        if (conditionalRequestConflict(cause)) {
          if (attempt < MAX_CONDITIONAL_PUT_ATTEMPTS - 1) continue;
        } else if (!conflictExists(cause)) {
          if (!ambiguousPutFailure(cause)) throw cause;
          try {
            return await existingBodyReference();
          } catch (reconciliationCause) {
            if (reconciliationCause instanceof ExistingMessageBodyMismatchError) {
              throw reconciliationCause;
            }
            throw new AgentRunMessageBodyWriteOutcomeUnknownError([cause, reconciliationCause]);
          }
        }
        try {
          return await existingBodyReference();
        } catch (reconciliationCause) {
          if (reconciliationCause instanceof ExistingMessageBodyMismatchError) {
            throw reconciliationCause;
          }
          throw new AgentRunMessageBodyWriteOutcomeUnknownError([cause, reconciliationCause]);
        }
      }
    }
    throw new Error("Agent run S3 conditional write retry limit was exhausted.");
  };
}
