import type { Ulid } from "@deployments-ai/db";
import { Schema } from "effect";
import type { MemorySearchTarget } from "./provider.ts";

export const AWS_NATIVE_AUTOMATED_SNAPSHOT_RETENTION_HOURS = 14 * 24;
export const AWS_NATIVE_BACKUP_SAFETY_MARGIN_MINUTES = 60;
// Deployment IAM scopes Memory runtimes to this index prefix so Memory and Brain
// can share one OpenSearch domain without reaching each other's indexes.
export const AWS_NATIVE_MEMORY_INDEX_PREFIX = "memory-";

export function requireAwsNativeBackupPolicy(location: Readonly<Record<string, unknown>>) {
  if (
    location.automatedSnapshotRetentionHours !== AWS_NATIVE_AUTOMATED_SNAPSHOT_RETENTION_HOURS ||
    location.backupSafetyMarginMinutes !== AWS_NATIVE_BACKUP_SAFETY_MARGIN_MINUTES
  ) {
    throw new TypeError("AWS-native target does not match the deployment-owned backup policy.");
  }
}

export interface AwsNativeMemoryConfig {
  readonly automatedSnapshotRetentionHours: number;
  readonly backupSafetyMarginMinutes: number;
  readonly embeddingDimensions: number;
  readonly openSearchEndpoint: string;
  readonly openSearchIndex: string;
  readonly region: string;
}

export interface OpenSearchTransport {
  request(input: {
    readonly body?: unknown;
    readonly method: "DELETE" | "GET" | "POST" | "PUT";
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
}

export class AwsNativeMemoryError extends Schema.TaggedErrorClass<AwsNativeMemoryError>()(
  "AwsNativeMemoryError",
  { cause: Schema.Unknown, message: Schema.String, operation: Schema.String },
) {}

export function awsNativeTargetLocation(target: MemorySearchTarget): AwsNativeMemoryConfig {
  const location = target.location;
  const stringValue = (name: string) => {
    const value = location[name];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeError(`AWS-native memory target location requires ${name}.`);
    }
    return value;
  };
  const dimensions = location.embeddingDimensions;
  if (!Number.isSafeInteger(dimensions) || (dimensions as number) <= 0) {
    throw new TypeError("AWS-native memory target requires positive embeddingDimensions.");
  }
  const positiveNumber = (name: string) => {
    const value = location[name];
    if (!Number.isFinite(value) || (value as number) <= 0) {
      throw new TypeError(`AWS-native memory target requires positive ${name}.`);
    }
    return value as number;
  };
  const automatedSnapshotRetentionHours = positiveNumber("automatedSnapshotRetentionHours");
  const backupSafetyMarginMinutes = positiveNumber("backupSafetyMarginMinutes");
  requireAwsNativeBackupPolicy({ automatedSnapshotRetentionHours, backupSafetyMarginMinutes });
  const openSearchIndex = stringValue("openSearchIndex");
  if (!openSearchIndex.startsWith(AWS_NATIVE_MEMORY_INDEX_PREFIX)) {
    throw new TypeError(
      `AWS-native memory target index must start with ${AWS_NATIVE_MEMORY_INDEX_PREFIX}.`,
    );
  }
  return {
    automatedSnapshotRetentionHours: AWS_NATIVE_AUTOMATED_SNAPSHOT_RETENTION_HOURS,
    backupSafetyMarginMinutes: AWS_NATIVE_BACKUP_SAFETY_MARGIN_MINUTES,
    embeddingDimensions: dimensions as number,
    openSearchEndpoint: stringValue("openSearchEndpoint"),
    openSearchIndex,
    region: stringValue("region"),
  };
}

export const AWS_NATIVE_PROVIDER_ID = "aws-native" as const;
export const AWS_NATIVE_REQUIRES_TARGET_FIFO = true;
export type AwsNativeTargetId = Ulid;
