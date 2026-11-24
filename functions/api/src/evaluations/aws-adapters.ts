import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type HeadObjectCommandOutput,
  type S3Client,
} from "@aws-sdk/client-s3";
import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PersistenceError } from "@deployments-ai/db";
import {
  CASE_MATERIAL_CONTENT_TYPE,
  caseMaterialObjectKey,
  evaluationQueueEnvelope,
} from "@deployments-ai/observability/evaluators";
import type {
  EvaluationArtifactStore,
  EvaluationBlobReference,
  EvaluationQueue,
} from "./service-contracts.ts";

export const EVALUATION_DOWNLOAD_URL_TTL_SECONDS = 300;

export interface S3EvaluationArtifactStoreOptions {
  readonly bucket: string;
  readonly client: S3Client;
  readonly kmsKeyArn: string;
  readonly now?: () => Date;
}

/**
 * Artifact-bucket storage: create-only, KMS-encrypted, checksummed case material (an
 * identical existing object is verified and reused), bounded reads, and short-lived
 * presigned report downloads.
 */
export function makeS3EvaluationArtifactStore(
  options: S3EvaluationArtifactStoreOptions,
): EvaluationArtifactStore {
  const { bucket, client, kmsKeyArn } = options;
  return {
    async putCaseMaterial(input) {
      const key = caseMaterialObjectKey(input.organizationId, input.datasetId, input.contentSha256);
      const checksum = Buffer.from(input.contentSha256, "hex").toString("base64");
      const reference = (versionId: string | undefined, etag: string | undefined) => {
        if (!versionId) {
          throw new Error("Evaluation artifact storage did not return an immutable version ID.");
        }
        return {
          bucket,
          byteSize: input.bytes.byteLength,
          contentType: CASE_MATERIAL_CONTENT_TYPE,
          ...(etag ? { etag } : {}),
          key,
          sha256: input.contentSha256,
          versionId,
        };
      };
      try {
        const result = await client.send(
          new PutObjectCommand({
            Body: input.bytes,
            Bucket: bucket,
            ChecksumSHA256: checksum,
            ContentLength: input.bytes.byteLength,
            ContentType: CASE_MATERIAL_CONTENT_TYPE,
            IfNoneMatch: "*",
            Key: key,
            Metadata: { datasetid: input.datasetId, organizationid: input.organizationId },
            ServerSideEncryption: "aws:kms",
            SSEKMSKeyId: kmsKeyArn,
          }),
        );
        return reference(result.VersionId, result.ETag);
      } catch (cause) {
        let head: HeadObjectCommandOutput;
        try {
          head = await client.send(
            new HeadObjectCommand({ Bucket: bucket, ChecksumMode: "ENABLED", Key: key }),
          );
        } catch {
          throw cause;
        }
        if (
          head.ContentLength !== input.bytes.byteLength ||
          head.ContentType !== CASE_MATERIAL_CONTENT_TYPE ||
          head.ChecksumSHA256 !== checksum ||
          head.ServerSideEncryption !== "aws:kms" ||
          head.SSEKMSKeyId !== kmsKeyArn ||
          head.Metadata?.organizationid !== input.organizationId ||
          head.Metadata.datasetid !== input.datasetId
        ) {
          throw cause;
        }
        return reference(head.VersionId, head.ETag);
      }
    },

    async readText(reference: EvaluationBlobReference, maximumBytes: number) {
      if (reference.byteSize > maximumBytes) {
        throw new PersistenceError(
          "unprocessable",
          "evaluation_artifact_too_large",
          `The stored content exceeds ${maximumBytes} bytes.`,
        );
      }
      const result = await client.send(
        new GetObjectCommand({
          Bucket: reference.bucket,
          Key: reference.key,
          Range: `bytes=0-${maximumBytes}`,
          ...(reference.versionId ? { VersionId: reference.versionId } : {}),
        }),
      );
      const bytes = result.Body ? await result.Body.transformToByteArray() : new Uint8Array();
      if (bytes.byteLength > maximumBytes) {
        throw new PersistenceError(
          "unprocessable",
          "evaluation_artifact_too_large",
          `The stored content exceeds ${maximumBytes} bytes.`,
        );
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    },

    async createDownloadUrl(reference: EvaluationBlobReference) {
      const issuedAt = options.now?.() ?? new Date();
      const downloadUrl = await getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: reference.bucket,
          Key: reference.key,
          ...(reference.versionId ? { VersionId: reference.versionId } : {}),
        }),
        { expiresIn: EVALUATION_DOWNLOAD_URL_TTL_SECONDS },
      );
      return {
        downloadUrl,
        downloadUrlExpiresAt: new Date(
          issuedAt.getTime() + EVALUATION_DOWNLOAD_URL_TTL_SECONDS * 1_000,
        ).toISOString(),
      };
    },
  };
}

/** FIFO evaluation queue producer: group and deduplication IDs come from the message. */
export function makeSqsEvaluationQueue(options: {
  readonly client: SQSClient;
  readonly queueUrl: string;
}): EvaluationQueue {
  return {
    async send(message) {
      const envelope = evaluationQueueEnvelope(message);
      await options.client.send(
        new SendMessageCommand({
          MessageBody: envelope.body,
          MessageDeduplicationId: envelope.deduplicationId,
          MessageGroupId: envelope.groupId,
          QueueUrl: options.queueUrl,
        }),
      );
    },
  };
}
