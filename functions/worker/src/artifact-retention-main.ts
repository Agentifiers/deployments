import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { DeleteObjectsCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { INPUT_ARTIFACT_TYPE } from "@deployments-ai/agent-manifest";
import { decodePlatformRecord, inputFileTextKey, type PlatformRecord } from "@deployments-ai/db";
import { Effect } from "effect";

export interface ArtifactRetentionStreamRecord {
  readonly dynamodb?: {
    readonly OldImage?: Record<string, AttributeValue>;
    readonly SequenceNumber?: string;
  };
  readonly eventID?: string;
  readonly eventName?: string;
}

interface ArtifactRetentionStreamEvent {
  readonly Records?: readonly ArtifactRetentionStreamRecord[];
}

export interface ArtifactRetentionS3 {
  readonly send: (command: DeleteObjectsCommand | ListObjectVersionsCommand) => Promise<unknown>;
}

function failureIdentifier(record: ArtifactRetentionStreamRecord) {
  return record.dynamodb?.SequenceNumber?.trim() || record.eventID?.trim() || "unknown-record";
}

async function deleteEveryVersion(s3: ArtifactRetentionS3, bucket: string, objectKey: string) {
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  let isTruncated: boolean;
  do {
    const page = (await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: objectKey,
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
      }),
    )) as {
      readonly DeleteMarkers?: readonly { readonly Key?: string; readonly VersionId?: string }[];
      readonly IsTruncated?: boolean;
      readonly NextKeyMarker?: string;
      readonly NextVersionIdMarker?: string;
      readonly Versions?: readonly { readonly Key?: string; readonly VersionId?: string }[];
    };
    const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].flatMap((value) =>
      value.Key === objectKey && value.VersionId
        ? [{ Key: objectKey, VersionId: value.VersionId }]
        : [],
    );
    if (objects.length > 0) {
      const deleted = (await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects, Quiet: true },
        }),
      )) as { readonly Errors?: readonly unknown[] };
      if ((deleted.Errors?.length ?? 0) > 0) {
        throw new Error("S3 rejected one or more retained artifact version deletions.");
      }
    }
    keyMarker = page.NextKeyMarker;
    versionIdMarker = page.NextVersionIdMarker;
    isTruncated = page.IsTruncated === true;
    if (isTruncated && !keyMarker) {
      throw new Error("S3 returned a truncated artifact-version page without a key marker.");
    }
  } while (isTruncated);
}

async function sweepInputFileText(
  s3: ArtifactRetentionS3,
  { data }: Extract<PlatformRecord, { readonly itemType: "artifact" }>,
) {
  if (data.type !== INPUT_ARTIFACT_TYPE) return;
  const { bucket, sha256 } = data.storage;
  await deleteEveryVersion(s3, bucket, inputFileTextKey(data, data.id, sha256));
}

export async function purgeRetainedArtifact(
  record: ArtifactRetentionStreamRecord,
  s3: ArtifactRetentionS3,
) {
  if (record.eventName !== "REMOVE" || !record.dynamodb?.OldImage) return;
  const decoded = await Effect.runPromise(
    decodePlatformRecord(unmarshall(record.dynamodb.OldImage)),
  );
  if (decoded.itemType !== "artifact") return;
  if (decoded.data.retentionExpiresAt || decoded.data.uploadExpiresAt) {
    await deleteEveryVersion(s3, decoded.data.storage.bucket, decoded.data.storage.key);
  }
  await sweepInputFileText(s3, decoded);
}

let s3Client: S3Client | undefined;

export async function handler(event: ArtifactRetentionStreamEvent) {
  s3Client ??= new S3Client({});
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records ?? []) {
    try {
      await purgeRetainedArtifact(record, s3Client);
    } catch {
      batchItemFailures.push({ itemIdentifier: failureIdentifier(record) });
    }
  }
  return { batchItemFailures };
}
