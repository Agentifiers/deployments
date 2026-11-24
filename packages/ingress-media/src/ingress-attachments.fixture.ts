import { S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import {
  Ulid,
  makeIngressInputArtifactPersistence,
  type DynamoDatabaseService,
  type IngressInputArtifactScope,
  type IngressSource,
  type PlatformRecord,
} from "@deployments-ai/db";
import type {
  ExtractionOutcome,
  ExtractionRequest,
  FileTextExtractor,
} from "@deployments-ai/file-text";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import {
  makeS3IngressAttachmentObjectStore,
  type IngressAttachmentCandidate,
  type IngressAttachmentReader,
} from "./index.ts";

export const ulid = Schema.decodeUnknownSync(Ulid);

export const NOW = new Date("2026-10-07T12:00:00.000Z");
export const KMS_KEY_ARN = "arn:aws:kms:us-east-1:123456789012:key/artifacts";
export const scope = {
  environmentId: ulid("01ARZ3NDEKTSV4RRFFQ69G5003"),
  organizationId: ulid("01ARZ3NDEKTSV4RRFFQ69G5001"),
  projectId: ulid("01ARZ3NDEKTSV4RRFFQ69G5002"),
};
export const owner: IngressSource = {
  sourceId: ulid("01ARZ3NDEKTSV4RRFFQ69G5004"),
  sourceKind: "channel-binding",
  type: "ingress",
};
export const threadId = ulid("01ARZ3NDEKTSV4RRFFQ69G5005");
export const otherThreadId = ulid("01ARZ3NDEKTSV4RRFFQ69G5006");

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const pngBytes = (body: string) =>
  Uint8Array.from([...PNG_SIGNATURE, ...new TextEncoder().encode(body)]);
export const pdfBytes = (body: string) => new TextEncoder().encode(`%PDF-1.7\n${body}`);
export const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export const customerKey = (artifactId: string, sha256: string, objectName: string) =>
  `artifacts/organizations/${scope.organizationId}/projects/${scope.projectId}/environments/${scope.environmentId}/customer/${artifactId}/${sha256}/${objectName}`;

export function channelAttachment(
  externalMessageId: string,
  ordinal: number,
  reference: string,
  declared: IngressAttachmentCandidate<string>["declared"] = {
    contentType: "image/png",
    fileName: "photo.png",
    kind: "image",
  },
): IngressAttachmentCandidate<string> {
  return {
    declared,
    identity: { externalMessageId, ordinal, type: "channel-attachment" },
    reference,
  };
}

export const pdfAttachment = (externalMessageId: string, ordinal: number, fileName: string) =>
  channelAttachment(externalMessageId, ordinal, fileName, {
    contentType: "application/pdf",
    fileName,
    kind: "file",
  });

class ConditionalCheckFailedException extends Error {
  override name = "ConditionalCheckFailedException";
}

export function memoryDatabase() {
  const records = new Map<string, PlatformRecord>();
  const failures = { nextTransaction: false };
  const database: DynamoDatabaseService = {
    deleteRecord: async (record) => {
      records.delete(`${record.pk}\n${record.sk}`);
    },
    getRecord: async (_table, recordKey) => records.get(`${recordKey.pk}\n${recordKey.sk}`),
    putRecord: async (record, conditionExpression) => {
      const recordKey = `${record.pk}\n${record.sk}`;
      if (conditionExpression?.includes("attribute_not_exists") && records.has(recordKey)) {
        throw new ConditionalCheckFailedException("conditional write failed");
      }
      records.set(recordKey, record);
    },
    queryRecords: async () => ({ items: [] }),
    transactWrite: async (operations) => {
      if (failures.nextTransaction) {
        failures.nextTransaction = false;
        throw new Error("DynamoDB is unavailable.");
      }
      for (const operation of operations) {
        if (operation.kind !== "put") throw new Error("Unexpected transaction operation.");
        const current = records.get(`${operation.record.pk}\n${operation.record.sk}`);
        const previous = operation.previousRecord;
        if (
          current?.itemType !== "artifact" ||
          previous?.itemType !== "artifact" ||
          current.data.version !== previous.data.version
        ) {
          throw new ConditionalCheckFailedException("conditional write failed");
        }
      }
      for (const operation of operations) {
        if (operation.kind === "put") {
          records.set(`${operation.record.pk}\n${operation.record.sk}`, operation.record);
        }
      }
    },
  };
  const artifact = async (artifactId: Ulid) =>
    makeIngressInputArtifactPersistence(database).find(scope, artifactId);
  return { artifact, database, failures, records };
}

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly checksumSha256: string;
  readonly contentType: string | undefined;
  readonly kmsKeyId: string | undefined;
  readonly metadata: Readonly<Record<string, string>>;
  readonly versionId: string;
}

function s3Error(name: string, httpStatusCode: number) {
  return new S3ServiceException({
    $fault: httpStatusCode >= 500 ? "server" : "client",
    $metadata: { httpStatusCode },
    message: name,
    name,
  });
}

const field = (input: object, name: string): unknown =>
  name in input ? Reflect.get(input, name) : undefined;
const textField = (input: object, name: string) => {
  const value = field(input, name);
  return typeof value === "string" ? value : undefined;
};

export function memoryArtifactBucket() {
  const objects = new Map<string, StoredObject>();
  const failures = { nextPut: false };
  const opened: IngressInputArtifactScope[] = [];
  let versions = 0;
  const s3 = new S3Client({
    credentials: { accessKeyId: "test-access-key", secretAccessKey: "test-secret-key" },
    region: "us-east-1",
  });
  s3.middlewareStack.add(
    (next, context) => async (args) => {
      const input: object = args.input;
      const key = textField(input, "Key") ?? "";
      if (context.commandName === "HeadObjectCommand") {
        const stored = objects.get(key);
        if (!stored) throw s3Error("NotFound", 404);
        return {
          output: {
            $metadata: { httpStatusCode: 200 },
            ChecksumSHA256: stored.checksumSha256,
            ContentLength: stored.bytes.byteLength,
            ContentType: stored.contentType,
            ETag: `"etag-${stored.versionId}"`,
            Metadata: stored.metadata,
            SSEKMSKeyId: stored.kmsKeyId,
            ServerSideEncryption: "aws:kms",
            VersionId: stored.versionId,
          },
          response: {},
        };
      }
      if (context.commandName !== "PutObjectCommand") return next(args);
      if (failures.nextPut) {
        failures.nextPut = false;
        throw s3Error("ServiceUnavailable", 503);
      }
      const body = field(input, "Body");
      if (!(body instanceof Uint8Array)) throw new Error("Expected a byte body.");
      const checksumSha256 = createHash("sha256").update(body).digest("base64");
      if (textField(input, "ChecksumSHA256") !== checksumSha256) throw s3Error("BadDigest", 400);
      if (textField(input, "ServerSideEncryption") !== "aws:kms") {
        throw s3Error("AccessDenied", 403);
      }
      if (textField(input, "IfNoneMatch") === "*" && objects.has(key)) {
        throw s3Error("PreconditionFailed", 412);
      }
      const metadata = field(input, "Metadata");
      versions += 1;
      const versionId = `version-${versions}`;
      objects.set(key, {
        bytes: body,
        checksumSha256,
        contentType: textField(input, "ContentType"),
        kmsKeyId: textField(input, "SSEKMSKeyId"),
        metadata:
          typeof metadata === "object" && metadata !== null
            ? Object.fromEntries(
                Object.entries(metadata).flatMap(([name, value]) =>
                  typeof value === "string" ? [[name, value]] : [],
                ),
              )
            : {},
        versionId,
      });
      return {
        output: {
          $metadata: { httpStatusCode: 200 },
          ETag: `"etag-${versionId}"`,
          VersionId: versionId,
        },
        response: {},
      };
    },
    { step: "initialize" },
  );
  const store = makeS3IngressAttachmentObjectStore({ kmsKeyArn: KMS_KEY_ARN, s3 });
  const openObjectStore = async (scope: IngressInputArtifactScope) => {
    opened.push(scope);
    return store;
  };
  return { failures, objects, openObjectStore, opened };
}

export function pdfText(text: string): ExtractionOutcome {
  const bytes = new TextEncoder().encode(text);
  return {
    facts: { kind: "pdf", pages: 2, pagesWithText: 2, ocrPages: 0 },
    mediaType: "application/pdf",
    status: "text",
    text: bytes,
    textSha256: sha256Hex(bytes),
    truncated: false,
  };
}

export function fakeExtractor(
  respond: (request: ExtractionRequest) => Promise<ExtractionOutcome> = async () =>
    pdfText("--- Page 1 ---\nRevenue grew."),
) {
  const requests: ExtractionRequest[] = [];
  const extractor: FileTextExtractor = {
    extract: async (request) => {
      requests.push(request);
      return respond(request);
    },
  };
  return { extractor, requests };
}

export function fakeProvider(files: Readonly<Record<string, Uint8Array | Error>>) {
  const reads: string[] = [];
  const openReader = async (): Promise<IngressAttachmentReader<string>> => async (reference) => {
    reads.push(reference);
    const file = files[reference];
    if (file === undefined) throw new Error(`No file ${reference}.`);
    if (file instanceof Error) throw file;
    return file;
  };
  return { openReader, reads };
}
