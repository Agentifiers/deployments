import { memoryContentMatchesHash } from "./governance.ts";
import {
  memoryScopeKey,
  type CanonicalMemoryRecord,
  type MemorySensitivity,
} from "./memory-record.ts";
import type { MemorySearchCandidateRow } from "./provider.ts";
import type { SearchMemoryInput } from "./service.ts";

function isSearchable(memory: CanonicalMemoryRecord, now: Date) {
  return (
    memory.data.status === "active" &&
    memory.data.reviewStatus === "approved" &&
    (!memory.data.validFrom || memory.data.validFrom <= now.toISOString()) &&
    (!memory.data.validUntil || memory.data.validUntil > now.toISOString()) &&
    (!memory.data.retentionExpiresAt || memory.data.retentionExpiresAt > now.toISOString())
  );
}

export function shouldRemoveFromIndex(
  memory: CanonicalMemoryRecord,
  allowedSensitivities: readonly MemorySensitivity[],
  now: Date,
) {
  return (
    memory.data.status !== "active" ||
    memory.data.reviewStatus !== "approved" ||
    !allowedSensitivities.includes(memory.data.sensitivity) ||
    (memory.data.retentionExpiresAt !== undefined &&
      memory.data.retentionExpiresAt <= now.toISOString())
  );
}

export function verifyCanonicalContent(
  memory: CanonicalMemoryRecord,
  content: string,
  embeddingContentHash: string,
) {
  const matchesInlineBody = memory.data.body === undefined || memory.data.body === content;
  const matchesBodyReference =
    memory.data.bodyRef === undefined ||
    memoryContentMatchesHash(content, memory.data.bodyRef.sha256);
  return (
    matchesInlineBody &&
    matchesBodyReference &&
    memoryContentMatchesHash(content, memory.data.contentHash) &&
    embeddingContentHash === memory.data.contentHash
  );
}

export function matchesAuthorization(
  memory: CanonicalMemoryRecord,
  row: MemorySearchCandidateRow,
  input: SearchMemoryInput,
  now: Date,
) {
  const spaceSensitivityAllowed = input.authorizationGroups?.length
    ? input.authorizationGroups.some(
        (group) =>
          group.memorySpaceIds.includes(memory.data.memorySpaceId) &&
          group.allowedSensitivities.includes(memory.data.sensitivity),
      )
    : input.memorySpaceIds.includes(memory.data.memorySpaceId) &&
      input.allowedSensitivities.includes(memory.data.sensitivity);
  return (
    memory.data.organizationId === input.organizationId &&
    memory.data.projectId === input.projectId &&
    memory.data.environmentId === input.environmentId &&
    memory.data.contentHash === row.contentHash &&
    memory.data.version === row.memoryVersion &&
    memory.data.memorySpaceId === row.memorySpaceId &&
    memory.data.searchKey === row.searchKey &&
    memoryScopeKey(memory) === row.scopeKey &&
    spaceSensitivityAllowed &&
    input.searchKeys.includes(memory.data.searchKey) &&
    input.allowedScopeKeys.includes(memoryScopeKey(memory)) &&
    isSearchable(memory, now)
  );
}

export function openSearchCandidateCount(rows: readonly MemorySearchCandidateRow[]) {
  const reportedCounts = rows.flatMap((row) => {
    const count = row.denseSourceCandidateCounts?.["open-search"];
    return count === undefined ? [] : [count];
  });
  return reportedCounts.length > 0
    ? Math.max(...reportedCounts)
    : rows.filter((row) => row.denseSourceRanks?.["open-search"] !== undefined).length;
}
