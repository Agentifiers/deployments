import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type HeadObjectCommandOutput,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { checksumBase64 } from "./content-upload.ts";
import type { BrainTextRenditionStore } from "./index-text-rendition.ts";

const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";

export function makeS3BrainTextRenditionStore(input: {
  readonly bucket: string;
  readonly kmsKeyArn: string;
  readonly s3: S3Client;
}): BrainTextRenditionStore {
  return {
    presign: (reference) =>
      getSignedUrl(
        input.s3,
        new GetObjectCommand({
          Bucket: reference.bucket,
          Key: reference.key,
          VersionId: reference.versionId,
        }),
        { expiresIn: 300 },
      ),
    async putOnce({ key, sha256, text }) {
      const checksum = checksumBase64(sha256);
      const stored = (versionId: string | undefined) => {
        if (!versionId)
          throw new Error("Brain text storage did not return an immutable version ID.");
        return {
          bucket: input.bucket,
          byteSize: text.byteLength,
          contentType: TEXT_CONTENT_TYPE,
          key,
          sha256,
          versionId,
        };
      };
      try {
        const result = await input.s3.send(
          new PutObjectCommand({
            Body: text,
            Bucket: input.bucket,
            ChecksumSHA256: checksum,
            ContentLength: text.byteLength,
            ContentType: TEXT_CONTENT_TYPE,
            IfNoneMatch: "*",
            Key: key,
            ServerSideEncryption: "aws:kms",
            SSEKMSKeyId: input.kmsKeyArn,
          }),
        );
        return stored(result.VersionId);
      } catch (cause) {
        let head: HeadObjectCommandOutput;
        try {
          head = await input.s3.send(
            new HeadObjectCommand({ Bucket: input.bucket, ChecksumMode: "ENABLED", Key: key }),
          );
        } catch {
          throw cause;
        }
        if (head.ChecksumSHA256 !== checksum || head.ContentLength !== text.byteLength) throw cause;
        return stored(head.VersionId);
      }
    },
  };
}
