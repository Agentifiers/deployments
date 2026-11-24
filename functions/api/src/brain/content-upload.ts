import { HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";
import type { BrainBlobReference } from "@deployments-ai/brains";

/** The immutable object a Brain upload ticket names. */
export interface BrainContentObject {
  readonly brainId: string;
  readonly bucket: string;
  readonly contentLength: number;
  readonly contentType: string;
  readonly expectedContentHash: string;
  readonly kmsKeyArn: string;
  readonly objectKey: string;
  readonly organizationId: string;
  readonly sourceId: string;
  readonly ticketId: string;
}

export interface BrainContentUploadInput extends BrainContentObject {
  readonly body: ReadableStream<Uint8Array>;
}

/** A presigned storage PUT and the exact headers it was signed with. */
export interface BrainContentDirectUpload {
  readonly headers: Readonly<Record<string, string>>;
  readonly url: string;
}

export interface BrainContentUploader {
  readonly presign: (
    object: BrainContentObject,
    signing: { readonly expiresInSeconds: number; readonly signedAt: Date },
  ) => Promise<BrainContentDirectUpload>;
  readonly upload: (input: BrainContentUploadInput) => Promise<BrainBlobReference>;
  /** Resolves the stored object when it exactly matches the ticket, or `undefined`. */
  readonly verify: (object: BrainContentObject) => Promise<BrainBlobReference | undefined>;
}

export function checksumBase64(expectedContentHash: string) {
  const hex = expectedContentHash.replace(/^sha256:/u, "");
  if (!/^[a-f0-9]{64}$/u.test(hex)) throw new TypeError("Invalid Brain content checksum.");
  return Buffer.from(hex, "hex").toString("base64");
}

function encryptionContext(object: BrainContentObject) {
  return Buffer.from(
    JSON.stringify({
      brainId: object.brainId,
      organizationId: object.organizationId,
      purpose: "brain-content",
      sourceId: object.sourceId,
      ticketId: object.ticketId,
    }),
  ).toString("base64");
}

function reference(
  object: BrainContentObject,
  versionId: string | undefined,
  etag?: string,
): BrainBlobReference {
  if (!versionId) throw new Error("Brain content storage did not return an immutable version ID.");
  return {
    bucket: object.bucket,
    byteSize: object.contentLength,
    contentType: object.contentType,
    ...(etag ? { etag } : {}),
    key: object.objectKey,
    sha256: object.expectedContentHash,
    versionId,
  };
}

function putObjectCommand(object: BrainContentObject, body?: ReadableStream<Uint8Array>) {
  return new PutObjectCommand({
    ...(body ? { Body: Readable.fromWeb(body as never) } : {}),
    Bucket: object.bucket,
    ChecksumSHA256: checksumBase64(object.expectedContentHash),
    ContentLength: object.contentLength,
    ContentType: object.contentType,
    IfNoneMatch: "*",
    Key: object.objectKey,
    Metadata: {
      brainid: object.brainId,
      organizationid: object.organizationId,
      sourceid: object.sourceId,
      ticketid: object.ticketId,
    },
    ServerSideEncryption: "aws:kms",
    SSEKMSKeyId: object.kmsKeyArn,
    SSEKMSEncryptionContext: encryptionContext(object),
  });
}

export function makeS3BrainContentUploader(client: S3Client): BrainContentUploader {
  const verify = async (object: BrainContentObject) => {
    const head = await client
      .send(
        new HeadObjectCommand({
          Bucket: object.bucket,
          ChecksumMode: "ENABLED",
          Key: object.objectKey,
        }),
      )
      .catch((cause: unknown) => {
        if (cause instanceof Error && cause.name === "NotFound") return undefined;
        throw cause;
      });
    if (
      !head ||
      head.ContentLength !== object.contentLength ||
      head.ContentType !== object.contentType ||
      head.ChecksumSHA256 !== checksumBase64(object.expectedContentHash) ||
      head.ServerSideEncryption !== "aws:kms" ||
      head.SSEKMSKeyId !== object.kmsKeyArn ||
      head.Metadata?.organizationid !== object.organizationId ||
      head.Metadata.brainid !== object.brainId ||
      head.Metadata.sourceid !== object.sourceId ||
      head.Metadata.ticketid !== object.ticketId
    ) {
      return undefined;
    }
    return reference(object, head.VersionId, head.ETag);
  };
  return {
    async presign(object, signing) {
      const url = await getSignedUrl(client, putObjectCommand(object), {
        expiresIn: signing.expiresInSeconds,
        signableHeaders: new Set(["content-type"]),
        signingDate: signing.signedAt,
        unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
      });
      return {
        headers: {
          "content-length": String(object.contentLength),
          "content-type": object.contentType,
          "if-none-match": "*",
          "x-amz-checksum-sha256": checksumBase64(object.expectedContentHash),
          "x-amz-server-side-encryption": "aws:kms",
          "x-amz-server-side-encryption-aws-kms-key-id": object.kmsKeyArn,
          "x-amz-server-side-encryption-context": encryptionContext(object),
        },
        url,
      };
    },
    async upload(input) {
      try {
        const result = await client.send(putObjectCommand(input, input.body));
        return reference(input, result.VersionId, result.ETag);
      } catch (cause) {
        const stored = await verify(input).catch(() => undefined);
        if (!stored) throw cause;
        return stored;
      }
    },
    verify,
  };
}
