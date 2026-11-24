import type { FusedMemoryCandidate, MemoryRetrievalStrategy } from "./retrieval.ts";
import type { MemorySearchCandidateRow } from "./provider.ts";
import type { CanonicalMemoryRecord } from "./memory-record.ts";

export type MemoryDenseTelemetry = Pick<
  MemorySearchCandidateRow,
  "denseSourceDistances" | "denseSourceRanks"
>;

export function denseTelemetryFields(telemetry: MemoryDenseTelemetry): MemoryDenseTelemetry {
  return {
    ...(telemetry.denseSourceDistances === undefined
      ? {}
      : { denseSourceDistances: telemetry.denseSourceDistances }),
    ...(telemetry.denseSourceRanks === undefined
      ? {}
      : { denseSourceRanks: telemetry.denseSourceRanks }),
  };
}

export interface MemorySearchResult extends MemoryDenseTelemetry {
  readonly fusedRank?: number;
  readonly fusedScore?: number;
  readonly memory: CanonicalMemoryRecord;
  readonly rank: number;
  readonly score: number;
  readonly sourceRanks?: FusedMemoryCandidate["sourceRanks"];
  readonly sourceScores?: FusedMemoryCandidate["sourceScores"];
  readonly rerankDelta?: number;
  readonly rerankScore?: number;
}

export interface EnhancedMemorySearchResult {
  readonly candidateCount: number;
  readonly canonicalDropCount: number;
  readonly counts: {
    readonly dense: number;
    readonly denseOpenSearch: number;
    readonly entity: number;
    readonly exact: number;
    readonly lexical: number;
  };
  readonly results: readonly MemorySearchResult[];
  readonly strategy: MemoryRetrievalStrategy;
}
