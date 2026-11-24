import type { MemoryRecallSelectionMode, MemorySearchProviderId, Ulid } from "@deployments-ai/db";
import type { MemoryRetrievalStrategy } from "./retrieval.ts";

const MEMORY_SEARCH_PHASES = [
  "policy",
  "preparation",
  "placement",
  "embeddingPreparation",
  "embedding",
  "search",
  "hydration",
  "usefulness",
  "rerank",
  "selection",
  "persistence",
] as const;

export type MemorySearchPhase = (typeof MEMORY_SEARCH_PHASES)[number];

export interface MemorySearchTelemetry {
  actualStrategy?: MemoryRetrievalStrategy;
  candidateCount?: number;
  canonicalDropCount?: number;
  contextTokens?: number;
  currentStage?: MemorySearchPhase;
  denseCandidateCount?: number;
  denseOpenSearchCandidateCount?: number;
  duplicateCount?: number;
  entityCandidateCount?: number;
  exactCandidateCount?: number;
  failureStage?: MemorySearchPhase;
  injectedCount?: number;
  lexicalCandidateCount?: number;
  phaseTimingsMs: Partial<Record<MemorySearchPhase, number>>;
  placementGeneration?: number;
  plannerModel?: string;
  plannerProvider?: string;
  provider?: MemorySearchProviderId;
  rerankLatencyMs?: number;
  rerankModel?: string;
  rerankProvider?: string;
  retrievedCount?: number;
  selectedMemoryIds?: readonly Ulid[];
  selectionMode?: MemoryRecallSelectionMode;
  targetId?: Ulid;
}

export function createMemorySearchTelemetry(): MemorySearchTelemetry {
  return { phaseTimingsMs: {} };
}

export async function observeMemorySearchPhase<Value>(
  telemetry: MemorySearchTelemetry,
  phase: MemorySearchPhase,
  operation: () => Value | Promise<Value>,
): Promise<Value> {
  telemetry.currentStage = phase;
  delete telemetry.failureStage;
  const startedAt = Date.now();
  try {
    const value = await operation();
    telemetry.phaseTimingsMs[phase] = Math.max(0, Date.now() - startedAt);
    return value;
  } catch (cause) {
    telemetry.phaseTimingsMs[phase] = Math.max(0, Date.now() - startedAt);
    telemetry.failureStage = phase;
    throw cause;
  }
}

export function completedMemorySearchPhaseTimings(telemetry: MemorySearchTelemetry) {
  return { ...telemetry.phaseTimingsMs };
}

export function failedMemorySearchStage(telemetry: MemorySearchTelemetry) {
  return telemetry.failureStage ?? telemetry.currentStage;
}
