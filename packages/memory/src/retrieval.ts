import { inspectMemoryContent, validateMemorySearchKey } from "./governance.ts";
import type { CanonicalMemoryRecord } from "./memory-record.ts";
import type { MemorySearchCandidateRow } from "./provider.ts";

const MEMORY_RETRIEVAL_STRATEGIES = ["dense-v1", "hybrid-rrf-v1", "hybrid-rerank-v1"] as const;

export type MemoryRetrievalStrategy = (typeof MEMORY_RETRIEVAL_STRATEGIES)[number];
export type MemoryRetrievalPurpose = "active-recall" | "search";
export type MemoryCandidateSource = "dense" | "entity" | "memory-id" | "search-key" | "lexical";

export class MemoryRerankUsagePersistenceError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super("Memory rerank usage could not be persisted.");
    this.name = "MemoryRerankUsagePersistenceError";
    this.cause = cause;
  }
}

export interface MemoryRetrievalBudgets {
  readonly candidateK: number;
  readonly contextTokenBudget: number;
  /** Include the whole in-scope set, oldest first, when it fits under this many tokens; 0 disables it. */
  readonly fullContextTokenCap: number;
  /** Maximum time for all retrieval phases before result persistence. */
  readonly deadlineMs: number;
  /** Maximum time for one external retrieval phase. */
  readonly phaseDeadlineMs: number;
  readonly persistenceDeadlineMs: number;
  readonly rerankCandidateK: number;
  readonly rerankDeadlineMs: number;
  readonly rerankMaxOutputTokens: number;
  readonly rerankPromptBytes: number;
  /** Maximum time for provider search, including a cold signed connection. */
  readonly searchDeadlineMs: number;
}

const ACTIVE_RECALL_PHASE_DEADLINE_MS = 1_500;
const ACTIVE_RECALL_SEARCH_DEADLINE_MS = 3_000;
// Dev reranks on openrouter/openai/gpt-4o measured p50 1,030 ms and p90 1,599 ms; at 750 ms only 1
// of 78 finished, so active-recall rerank always fell back while still paying for the call.
const ACTIVE_RECALL_RERANK_DEADLINE_MS = 2_000;
const ACTIVE_RECALL_STANDARD_PHASE_COUNT = 4;
const ACTIVE_RECALL_OPERATION_RESERVE_MS = 100;
const ACTIVE_RECALL_OPERATION_DEADLINE_MS =
  ACTIVE_RECALL_PHASE_DEADLINE_MS * ACTIVE_RECALL_STANDARD_PHASE_COUNT +
  ACTIVE_RECALL_SEARCH_DEADLINE_MS +
  ACTIVE_RECALL_RERANK_DEADLINE_MS +
  ACTIVE_RECALL_OPERATION_RESERVE_MS;

export interface MemoryRetrievalConfig extends MemoryRetrievalBudgets {
  readonly rolloutPercent: number;
  readonly shadowRolloutPercent: number;
  readonly shadowStrategy?: MemoryRetrievalStrategy;
  readonly strategy: MemoryRetrievalStrategy;
}

export interface MemoryCandidate {
  readonly row: MemorySearchCandidateRow;
  readonly source: MemoryCandidateSource;
  readonly sourceRank: number;
}

export interface FusedMemoryCandidate {
  readonly fusedRank: number;
  readonly fusedScore: number;
  readonly id: string;
  readonly row: MemorySearchCandidateRow;
  readonly sourceScores: Partial<Record<MemoryCandidateSource, number>>;
  readonly sourceRanks: Partial<Record<MemoryCandidateSource, number>>;
}

export interface SelectableMemoryCandidate extends FusedMemoryCandidate {
  readonly denseSourceDistances?: NonNullable<MemorySearchCandidateRow["denseSourceDistances"]>;
  readonly denseSourceRanks?: NonNullable<MemorySearchCandidateRow["denseSourceRanks"]>;
  readonly memory: CanonicalMemoryRecord;
  readonly rerankScore?: number;
  readonly score: number;
  readonly usefulnessScore?: number;
}

export interface ReciprocalRankFusionOptions {
  readonly k: number;
  readonly sourceWeights?: Partial<Record<MemoryCandidateSource, number>>;
}

export const MEMORY_HYBRID_RRF_OPTIONS = {
  k: 5,
  sourceWeights: {
    dense: 2,
    entity: 3,
    lexical: 1,
    "memory-id": 4,
    "search-key": 4,
  },
} as const satisfies ReciprocalRankFusionOptions;

// The worker renders at most 32 memories and 32 KiB of memory text into the prompt
// (agent-runtime model-memory-context.ts), so active recall returns at most 32 memories by default,
// takes a whole set only up to 32 memories whatever the caller's topK, and caps a whole-set recall
// at 7,000 tokens (28,000 bytes), leaving room for each item's numbering and dates. A whole set
// comes back oldest first, so the renderer would cut the newest memories past those caps; each
// purpose's default token cap is therefore also its ceiling, and search never takes the whole set.
export const ACTIVE_RECALL_TOP_K = 32;

const DEFAULTS: Record<MemoryRetrievalPurpose, MemoryRetrievalConfig> = {
  "active-recall": {
    candidateK: 24,
    // LongMemEval_S on dev: 0.802 at 1,200 tokens and 0.870 at the search default of 4,000.
    contextTokenBudget: 4_000,
    fullContextTokenCap: 7_000,
    deadlineMs: ACTIVE_RECALL_OPERATION_DEADLINE_MS,
    phaseDeadlineMs: ACTIVE_RECALL_PHASE_DEADLINE_MS,
    persistenceDeadlineMs: 1_500,
    rerankCandidateK: 8,
    rerankDeadlineMs: ACTIVE_RECALL_RERANK_DEADLINE_MS,
    rerankMaxOutputTokens: 400,
    rerankPromptBytes: 24_000,
    rolloutPercent: 100,
    shadowRolloutPercent: 0,
    searchDeadlineMs: ACTIVE_RECALL_SEARCH_DEADLINE_MS,
    strategy: "dense-v1",
  },
  search: {
    candidateK: 50,
    contextTokenBudget: 4_000,
    fullContextTokenCap: 0,
    deadlineMs: 25_000,
    phaseDeadlineMs: 25_000,
    persistenceDeadlineMs: 5_000,
    rerankCandidateK: 20,
    rerankDeadlineMs: 20_000,
    rerankMaxOutputTokens: 800,
    rerankPromptBytes: 64_000,
    rolloutPercent: 100,
    shadowRolloutPercent: 0,
    searchDeadlineMs: 25_000,
    strategy: "dense-v1",
  },
};

const LIMITS = {
  candidateK: 100,
  contextTokenBudget: 32_000,
  deadlineMs: 25_000,
  phaseDeadlineMs: 25_000,
  persistenceDeadlineMs: 25_000,
  rerankCandidateK: 50,
  rerankDeadlineMs: 20_000,
  rerankMaxOutputTokens: 2_000,
  rerankPromptBytes: 256_000,
  searchDeadlineMs: 25_000,
} as const;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function strategy(value: unknown): MemoryRetrievalStrategy | undefined {
  return typeof value === "string" &&
    MEMORY_RETRIEVAL_STRATEGIES.includes(value as MemoryRetrievalStrategy)
    ? (value as MemoryRetrievalStrategy)
    : undefined;
}

function boundedInteger(value: unknown, fallback: number, maximum: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

// An explicitly configured context budget keeps ranked recall unless the cap is configured too.
function fullContextTokenCap(cap: unknown, budget: unknown, ceiling: number) {
  if (typeof cap === "number" && Number.isSafeInteger(cap) && cap >= 0) {
    return Math.min(cap, ceiling);
  }
  const budgetConfigured = typeof budget === "number" && Number.isSafeInteger(budget) && budget > 0;
  return budgetConfigured ? 0 : ceiling;
}

function boundedPercent(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : fallback;
}

export function memoryRetrievalConfig(
  processingConfig: Readonly<Record<string, unknown>> | undefined,
  purpose: MemoryRetrievalPurpose,
): MemoryRetrievalConfig {
  const defaults = DEFAULTS[purpose];
  const configured = record(processingConfig?.memoryRetrieval);
  const purposes = record(configured?.purposes);
  const purposeConfig = record(purposes?.[purpose]);
  const value = (field: string) => purposeConfig?.[field] ?? configured?.[field];
  const configuredStrategy = strategy(value("strategy")) ?? defaults.strategy;
  const shadowStrategy = strategy(value("shadowStrategy"));
  return {
    candidateK: boundedInteger(value("candidateK"), defaults.candidateK, LIMITS.candidateK),
    contextTokenBudget: boundedInteger(
      value("contextTokenBudget"),
      defaults.contextTokenBudget,
      LIMITS.contextTokenBudget,
    ),
    fullContextTokenCap: fullContextTokenCap(
      value("fullContextTokenCap"),
      value("contextTokenBudget"),
      defaults.fullContextTokenCap,
    ),
    deadlineMs: boundedInteger(value("deadlineMs"), defaults.deadlineMs, LIMITS.deadlineMs),
    phaseDeadlineMs: boundedInteger(
      value("phaseDeadlineMs"),
      defaults.phaseDeadlineMs,
      LIMITS.phaseDeadlineMs,
    ),
    persistenceDeadlineMs: boundedInteger(
      value("persistenceDeadlineMs"),
      defaults.persistenceDeadlineMs,
      LIMITS.persistenceDeadlineMs,
    ),
    rerankCandidateK: boundedInteger(
      value("rerankCandidateK"),
      defaults.rerankCandidateK,
      LIMITS.rerankCandidateK,
    ),
    rerankDeadlineMs: boundedInteger(
      value("rerankDeadlineMs"),
      defaults.rerankDeadlineMs,
      LIMITS.rerankDeadlineMs,
    ),
    rerankMaxOutputTokens: boundedInteger(
      value("rerankMaxOutputTokens"),
      defaults.rerankMaxOutputTokens,
      LIMITS.rerankMaxOutputTokens,
    ),
    rerankPromptBytes: boundedInteger(
      value("rerankPromptBytes"),
      defaults.rerankPromptBytes,
      LIMITS.rerankPromptBytes,
    ),
    searchDeadlineMs: boundedInteger(
      value("searchDeadlineMs"),
      defaults.searchDeadlineMs,
      LIMITS.searchDeadlineMs,
    ),
    rolloutPercent: boundedPercent(value("rolloutPercent"), defaults.rolloutPercent),
    shadowRolloutPercent: boundedPercent(
      value("shadowRolloutPercent"),
      defaults.shadowRolloutPercent,
    ),
    ...(shadowStrategy ? { shadowStrategy } : {}),
    strategy: configuredStrategy,
  };
}

export function lexicalQueryEligible(query: string) {
  if (query.length > 1_024) return false;
  const inspection = inspectMemoryContent(query);
  return (
    inspection.blockedReason === undefined &&
    inspection.reviewStatus === "approved" &&
    !inspection.redacted &&
    inspection.content === query.trim().replace(/\s+/gu, " ")
  );
}

export function queryIdentifiers(query: string) {
  const memoryIds = new Set<string>();
  const searchKeys = new Set<string>();
  const entityKeys = new Set<string>();
  for (const token of query.match(/[A-Za-z0-9][A-Za-z0-9._:/-]{2,199}/gu) ?? []) {
    if (/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(token)) memoryIds.add(token);
    try {
      const normalized = validateMemorySearchKey(token);
      if (normalized.includes(":")) searchKeys.add(normalized);
      if (
        normalized.includes(":") ||
        /[._/-]/u.test(normalized) ||
        /\d/u.test(normalized) ||
        /[a-z][A-Z]/u.test(normalized)
      ) {
        entityKeys.add(normalized.toLowerCase());
      }
    } catch {
      // Invalid or governed tokens are deliberately excluded from exact candidate queries.
    }
  }
  return {
    entityKeys: [...entityKeys].slice(0, 20),
    memoryIds: [...memoryIds].slice(0, 20),
    searchKeys: [...searchKeys].slice(0, 20),
  };
}

export function reciprocalRankFusion(
  sources: readonly (readonly MemoryCandidate[])[],
  options: number | ReciprocalRankFusionOptions = MEMORY_HYBRID_RRF_OPTIONS,
): FusedMemoryCandidate[] {
  const k = typeof options === "number" ? options : options.k;
  const sourceWeights = typeof options === "number" ? undefined : options.sourceWeights;
  if (!Number.isFinite(k) || k < 0) throw new TypeError("RRF k must be a non-negative number.");
  const fused = new Map<
    string,
    {
      row: MemorySearchCandidateRow;
      score: number;
      sourceScores: Partial<Record<MemoryCandidateSource, number>>;
      sourceRanks: Partial<Record<MemoryCandidateSource, number>>;
    }
  >();
  for (const source of sources) {
    for (const candidate of source) {
      const current = fused.get(candidate.row.id) ?? {
        row: candidate.row,
        score: 0,
        sourceScores: {},
        sourceRanks: {},
      };
      const priorRank = current.sourceRanks[candidate.source];
      if (priorRank === undefined || candidate.sourceRank < priorRank) {
        const weight = sourceWeights?.[candidate.source] ?? 1;
        if (!Number.isFinite(weight) || weight <= 0) {
          throw new TypeError(`RRF ${candidate.source} weight must be a positive number.`);
        }
        current.score +=
          weight / (k + candidate.sourceRank) - (priorRank ? weight / (k + priorRank) : 0);
        current.sourceRanks[candidate.source] = candidate.sourceRank;
      }
      fused.set(candidate.row.id, current);
      if (candidate.row.dist !== undefined) {
        current.sourceScores[candidate.source] = candidate.row.dist;
      }
    }
  }
  return [...fused.entries()]
    .sort(
      ([leftId, left], [rightId, right]) =>
        right.score - left.score || leftId.localeCompare(rightId),
    )
    .map(([id, value], index) => ({
      fusedRank: index + 1,
      fusedScore: value.score,
      id,
      row: value.row,
      sourceScores: value.sourceScores,
      sourceRanks: value.sourceRanks,
    }));
}

export function estimateMemoryTokens(content: string) {
  return Math.max(1, Math.ceil(new TextEncoder().encode(content).byteLength / 4));
}

function candidateContent(candidate: { readonly memory: CanonicalMemoryRecord }) {
  return candidate.memory.data.body ?? "";
}

function similarityFingerprint(candidate: { readonly memory: CanonicalMemoryRecord }) {
  return candidateContent(candidate)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

/**
 * Returns every memory of a complete in-scope set, oldest first and without the later copies of a
 * duplicate, when what remains fits in `topK` memories, `ACTIVE_RECALL_TOP_K` memories, and
 * `fullContextTokenCap` tokens; otherwise undefined.
 */
export function selectFullContextMemories<
  Candidate extends { readonly memory: CanonicalMemoryRecord },
>(args: {
  readonly candidates: readonly Candidate[];
  readonly fullContextTokenCap: number;
  readonly strategy: MemoryRetrievalStrategy;
  readonly topK: number;
}) {
  const occurredAt = ({ memory }: Candidate) =>
    Date.parse(memory.data.validFrom ?? memory.data.createdAt);
  const ordered = [...args.candidates].sort(
    (left, right) =>
      occurredAt(left) - occurredAt(right) ||
      left.memory.data.id.localeCompare(right.memory.data.id),
  );
  const selected: Candidate[] = [];
  const fingerprints = new Set<string>();
  let contextTokens = 0;
  let duplicateCount = 0;
  for (const candidate of ordered) {
    if (args.strategy !== "dense-v1") {
      const fingerprint = similarityFingerprint(candidate);
      if (fingerprint && fingerprints.has(fingerprint)) {
        duplicateCount += 1;
        continue;
      }
      if (fingerprint) fingerprints.add(fingerprint);
    }
    selected.push(candidate);
    contextTokens += estimateMemoryTokens(candidateContent(candidate));
  }
  if (
    selected.length > Math.min(args.topK, ACTIVE_RECALL_TOP_K) ||
    contextTokens > args.fullContextTokenCap
  ) {
    return undefined;
  }
  return { contextTokens, duplicateCount, selected };
}

export function rankAndSelectMemories(args: {
  readonly candidates: readonly SelectableMemoryCandidate[];
  readonly contextTokenBudget: number;
  readonly strategy: MemoryRetrievalStrategy;
  readonly topK: number;
}) {
  const ordered =
    args.strategy === "dense-v1"
      ? [...args.candidates]
      : [...args.candidates].sort(
          (left, right) =>
            right.score - left.score ||
            right.memory.data.updatedAt.localeCompare(left.memory.data.updatedAt) ||
            left.id.localeCompare(right.id),
        );
  const selected: SelectableMemoryCandidate[] = [];
  const fingerprints = new Set<string>();
  let contextTokens = 0;
  let duplicateCount = 0;
  for (const candidate of ordered) {
    if (selected.length >= args.topK) break;
    const tokens = estimateMemoryTokens(candidateContent(candidate));
    if (contextTokens + tokens > args.contextTokenBudget) continue;
    if (args.strategy !== "dense-v1") {
      const fingerprint = similarityFingerprint(candidate);
      if (fingerprint && fingerprints.has(fingerprint)) {
        duplicateCount += 1;
        continue;
      }
      if (fingerprint) fingerprints.add(fingerprint);
    }
    selected.push(candidate);
    contextTokens += tokens;
  }
  return { contextTokens, duplicateCount, selected };
}

export function adjustedCandidateScore(
  candidate: FusedMemoryCandidate,
  memory: CanonicalMemoryRecord,
  now: Date,
  usefulnessScore = 0,
) {
  const importance = memory.data.importance ?? 0.5;
  const sourceQuality = memory.data.sourceQuality ?? 0.5;
  const ageDays = Math.max(0, (now.getTime() - Date.parse(memory.data.updatedAt)) / 86_400_000);
  const recency = Math.max(0, 1 - ageDays / 365);
  const qualityAdjustment = (importance - 0.5) * 0.08 + (sourceQuality - 0.5) * 0.08;
  const temporalAdjustment = recency * 0.04;
  const feedbackAdjustment = Math.max(-1, Math.min(1, usefulnessScore)) * 0.05;
  const highConfidenceExact =
    candidate.sourceRanks["memory-id"] !== undefined ||
    candidate.sourceRanks["search-key"] !== undefined ||
    candidate.sourceRanks.entity !== undefined;
  const maximumAdjustment = candidate.fusedScore * (highConfidenceExact ? 0.1 : 0.2);
  const requestedAdjustment = qualityAdjustment + temporalAdjustment + feedbackAdjustment;
  const boundedAdjustment = Math.max(
    -maximumAdjustment,
    Math.min(maximumAdjustment, requestedAdjustment),
  );
  return candidate.fusedScore + boundedAdjustment;
}
