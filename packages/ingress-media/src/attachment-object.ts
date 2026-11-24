import {
  HeadObjectCommand,
  PutObjectCommand,
  S3ServiceException,
  type S3Client,
} from "@aws-sdk/client-s3";
import { makeS3InputFileObjectStore, type InputFileObjectStore } from "@deployments-ai/file-text";
import { Schema } from "effect";

export interface IngressSourceObject {
  readonly bucket: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly key: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly sha256: string;
}

export interface IngressAttachmentObjectStore extends Pick<
  InputFileObjectStore,
  "presignSource" | "putTextOnce"
> {
  putSourceOnce(
    source: IngressSourceObject,
  ): Promise<{ readonly etag?: string; readonly versionId: string }>;
}

const PutObjectResult = Schema.Struct({
  ETag: Schema.optional(Schema.String),
  VersionId: Schema.NonEmptyString,
});

const HeadObjectResult = Schema.Struct({
  ChecksumSHA256: Schema.optional(Schema.String),
  ContentLength: Schema.optional(Schema.Number),
  ContentType: Schema.optional(Schema.String),
  ETag: Schema.optional(Schema.String),
  SSEKMSKeyId: Schema.optional(Schema.String),
  ServerSideEncryption: Schema.optional(Schema.String),
  VersionId: Schema.optional(Schema.String),
});

async function putSourceOnce(s3: S3Client, kmsKeyArn: string, source: IngressSourceObject) {
  const checksum = Buffer.from(source.sha256, "hex").toString("base64");
  try {
    const stored = Schema.decodeUnknownSync(PutObjectResult)(
      await s3.send(
        new PutObjectCommand({
          Body: source.bytes,
          Bucket: source.bucket,
          ChecksumSHA256: checksum,
          ContentLength: source.bytes.byteLength,
          ContentType: source.contentType,
          IfNoneMatch: "*",
          Key: source.key,
          Metadata: source.metadata,
          ServerSideEncryption: "aws:kms",
          SSEKMSKeyId: kmsKeyArn,
        }),
      ),
    );
    return { ...(stored.ETag ? { etag: stored.ETag } : {}), versionId: stored.VersionId };
  } catch (cause) {
    if (!(cause instanceof S3ServiceException && cause.$metadata.httpStatusCode === 412)) {
      throw cause;
    }
  }
  const head = Schema.decodeUnknownSync(HeadObjectResult)(
    await s3.send(
      new HeadObjectCommand({ Bucket: source.bucket, ChecksumMode: "ENABLED", Key: source.key }),
    ),
  );
  if (
    head.ContentLength !== source.bytes.byteLength ||
    head.ContentType !== source.contentType ||
    head.ChecksumSHA256 !== checksum ||
    head.ServerSideEncryption !== "aws:kms" ||
    head.SSEKMSKeyId !== kmsKeyArn ||
    !head.VersionId
  ) {
    throw new Error("The artifact object already exists with different content or encryption.");
  }
  return { ...(head.ETag ? { etag: head.ETag } : {}), versionId: head.VersionId };
}

export function makeS3IngressAttachmentObjectStore(options: {
  readonly kmsKeyArn: string;
  readonly s3: S3Client;
}): IngressAttachmentObjectStore {
  return {
    ...makeS3InputFileObjectStore(options),
    putSourceOnce: (source) => putSourceOnce(options.s3, options.kmsKeyArn, source),
  };
}
