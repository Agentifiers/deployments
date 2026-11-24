import type { Ulid } from "@deployments-ai/db";
import type { CanonicalMemoryRecord } from "./memory-record.ts";
import type { MemoryRecallAttempt, MemoryRecallResult } from "./platform-types.ts";

function withoutObservability<RecordType extends { readonly data: object }>(
  record: RecordType,
): RecordType {
  const { observability: _observability, ...data } = record.data as Record<string, unknown>;
  return { ...record, data } as RecordType;
}

export function publicMemoryRecord(memory: CanonicalMemoryRecord): CanonicalMemoryRecord {
  const projected = withoutObservability(memory);
  const { brainProvenance: _brainProvenance, ...data } = projected.data;
  return { ...projected, data } as CanonicalMemoryRecord;
}

export function publicMemoryRecallResult(result: MemoryRecallResult): MemoryRecallResult {
  const visibleResults = result.results.filter(
    (searchResult) => searchResult.memory.data.brainProvenance === undefined,
  );
  const visibleMemoryIds = new Set(
    visibleResults.map((searchResult) => searchResult.memory.data.id),
  );
  const visibleRetrievals = result.retrievals.filter((retrieval) =>
    visibleMemoryIds.has(retrieval.data.memoryId),
  );
  const attempt = withoutObservability(result.attempt) as MemoryRecallAttempt;
  return {
    ...result,
    attempt: {
      ...attempt,
      data: {
        ...attempt.data,
        candidateCount: visibleResults.length,
        injectedCount: visibleRetrievals.filter((retrieval) => retrieval.data.injected).length,
        retrievedCount: visibleResults.length,
        ...(attempt.data.selectedMemoryIds
          ? {
              selectedMemoryIds: attempt.data.selectedMemoryIds.filter((id: Ulid) =>
                visibleMemoryIds.has(id),
              ),
            }
          : {}),
      },
    },
    results: visibleResults.map((searchResult) => ({
      ...searchResult,
      memory: publicMemoryRecord(searchResult.memory),
    })),
    retrievals: visibleRetrievals,
  };
}
