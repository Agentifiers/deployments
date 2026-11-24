import type { MemorySearchEvidenceBinding } from "./provider.ts";
import { memoryScopeKey, type CanonicalMemoryRecord } from "./memory-record.ts";
import { validateAwsNativeTimestamp } from "./aws-native-validation.ts";

const NO_EXPIRATION_MS = Date.parse("9999-12-31T23:59:59.999Z");
const NO_VALID_FROM_MS = Date.parse("1970-01-01T00:00:00.000Z");

export function awsNativeMetadata(
  memory: CanonicalMemoryRecord,
  synchronizationGeneration: number,
  mutationPriority: 0 | 1,
  embeddingModel: string,
  embeddingProvider: string,
  evidence?: MemorySearchEvidenceBinding,
) {
  return {
    contentHash: memory.data.contentHash,
    embeddingModel,
    embeddingProvider,
    ...(memory.data.entityKeys?.length ? { entityKeys: memory.data.entityKeys } : {}),
    environmentId: memory.data.environmentId,
    memorySpaceId: memory.data.memorySpaceId,
    memoryVersion: memory.data.version,
    mutationPriority,
    organizationId: memory.data.organizationId,
    projectId: memory.data.projectId,
    ...(evidence
      ? {
          evidenceOperationId: evidence.operationId,
          evidenceTargetId: evidence.targetId,
          projectionClass: "synthetic-evidence",
        }
      : { projectionClass: "customer" }),
    retentionExpiresAtMs: validateAwsNativeTimestamp(
      memory.data.retentionExpiresAt,
      NO_EXPIRATION_MS,
    ),
    reviewStatus: memory.data.reviewStatus,
    scopeKey: memoryScopeKey(memory),
    searchKey: memory.data.searchKey,
    sensitivity: memory.data.sensitivity,
    status: memory.data.status,
    synchronizationGeneration,
    validFromMs: validateAwsNativeTimestamp(memory.data.validFrom, NO_VALID_FROM_MS),
    validUntilMs: validateAwsNativeTimestamp(memory.data.validUntil, NO_EXPIRATION_MS),
  } as const;
}
