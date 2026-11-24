import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import type { RuntimePlatformBuiltinOptions } from "../platform-builtin-executors.ts";

export interface S3BrainContentUploaderOptions {
  readonly artifactBucket: string;
  readonly artifactKmsKeyArn: string;
  readonly artifactS3: S3Client;
}

/** Uploads captured Brain content as an immutable, KMS-encrypted S3 object version. */
export function createS3BrainContentUploader({
  artifactBucket,
  artifactKmsKeyArn,
  artifactS3,
}: S3BrainContentUploaderOptions): NonNullable<
  RuntimePlatformBuiltinOptions["uploadBrainContent"]
> {
  return async ({
    brainId,
    bytes,
    contentHash,
    contentType,
    objectKey,
    organizationId,
    signal,
  }) => {
    const response = await artifactS3.send(
      new PutObjectCommand({
        Body: bytes,
        Bucket: artifactBucket,
        ChecksumSHA256: createHash("sha256").update(bytes).digest("base64"),
        ContentLength: bytes.byteLength,
        ContentType: contentType,
        IfNoneMatch: "*",
        Key: objectKey,
        Metadata: { brainId, organizationId },
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: artifactKmsKeyArn,
      }),
      signal ? { abortSignal: signal } : undefined,
    );
    if (!response.VersionId) throw new Error("Brain capture upload has no immutable S3 version.");
    return {
      bucket: artifactBucket,
      byteSize: bytes.byteLength,
      contentType,
      ...(response.ETag ? { etag: response.ETag } : {}),
      key: objectKey,
      sha256: contentHash,
      versionId: response.VersionId,
    };
  };
}
