import type {
  CreateMemorySpaceRequest,
  ImportMemoriesRequest,
  MemorySpaceGrantListQuery,
  ResolveMemoryReviewRequest,
  SearchMemoriesRequest,
  StrategySearchMemoriesRequest,
  UpsertMemoryPolicyRequest,
} from "@deployments-ai/api-contract/memory";
import type { JsonValue } from "@deployments-ai/api-contract/primitives";
import type {
  MemoryPolicyRecord,
  MemoryRecallAttemptRecord,
  MemoryRecord,
  MemoryRetrievalRecord,
  MemoryReviewItemRecord,
  MemorySpaceGrantRecord,
  MemorySpaceRecord,
} from "@deployments-ai/db";
import { formatExact } from "../observability/format.ts";

export const SPACE_STATUSES = ["active", "archived", "disabled"] as const;
export const SPACE_KINDS = ["agent", "organization", "shared", "workspace"] as const;
export const GRANT_PERMISSIONS = ["read", "read-write"] as const;
export const GRANT_STATUSES = ["active", "revoked"] as const;
export const POLICY_SCOPES = ["environment", "organization", "workspace"] as const;
export const SENSITIVITY_MODES = ["restricted", "standard", "strict"] as const;
export const RETRIEVAL_STRATEGIES = ["dense-v1", "hybrid-rerank-v1", "hybrid-rrf-v1"] as const;
export const MEMORY_STATUSES = ["active", "archived", "deleted"] as const;
export const MEMORY_REVIEW_STATUSES = ["approved", "pending", "rejected", "unreviewed"] as const;
export const MEMORY_SCOPES = ["agent", "organization", "thread", "workspace"] as const;
export const MEMORY_TYPES = ["episode", "fact", "preference", "procedure", "summary"] as const;
export const MEMORY_SENSITIVITIES = ["confidential", "internal", "public", "restricted"] as const;
export const REVIEW_ITEM_STATUSES = ["open", "resolved"] as const;
export const REVIEW_DECISIONS = ["approve", "edit", "reject", "archive", "delete"] as const;
export const USEFULNESS_RATINGS = ["useful", "neutral", "harmful"] as const;
export const SEARCH_STRATEGIES = [
  "hybrid-rrf-v1",
  "hybrid-rerank-v1",
  "dense-exact-control-v1",
  "dense-open-search-ann-control-v1",
] as const;

type SpaceStatus = (typeof SPACE_STATUSES)[number];
type SpaceKind = (typeof SPACE_KINDS)[number];
export type GrantPermission = (typeof GRANT_PERMISSIONS)[number];
export type GrantStatus = (typeof GRANT_STATUSES)[number];
type PolicyScope = (typeof POLICY_SCOPES)[number];
type SensitivityMode = (typeof SENSITIVITY_MODES)[number];
type RetrievalStrategy = (typeof RETRIEVAL_STRATEGIES)[number];
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
type MemoryReviewStatus = (typeof MEMORY_REVIEW_STATUSES)[number];
type MemoryScope = (typeof MEMORY_SCOPES)[number];
type MemoryType = (typeof MEMORY_TYPES)[number];
type MemorySensitivity = (typeof MEMORY_SENSITIVITIES)[number];
type ReviewItemStatus = (typeof REVIEW_ITEM_STATUSES)[number];
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];
export type Usefulness = (typeof USEFULNESS_RATINGS)[number];
type SearchStrategy = (typeof SEARCH_STRATEGIES)[number];

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type SpaceData = (typeof MemorySpaceRecord.Type)["data"];
type GrantData = (typeof MemorySpaceGrantRecord.Type)["data"];
type PolicyData = (typeof MemoryPolicyRecord.Type)["data"];
type MemoryData = (typeof MemoryRecord.Type)["data"];
type ReviewItemData = (typeof MemoryReviewItemRecord.Type)["data"];

const pinned: readonly true[] = [
  true satisfies Same<SpaceStatus, SpaceData["status"]>,
  true satisfies Same<SpaceKind, SpaceData["kind"]>,
  true satisfies Same<GrantPermission, GrantData["permission"]>,
  true satisfies Same<
    GrantStatus,
    Exclude<NonNullable<typeof MemorySpaceGrantListQuery.Type.status>, "all">
  >,
  true satisfies Same<PolicyScope, PolicyData["scope"]>,
  true satisfies Same<SensitivityMode, PolicyData["sensitivityMode"]>,
  true satisfies Same<
    RetrievalStrategy,
    (typeof MemoryRecallAttemptRecord.Type)["data"]["strategy"]
  >,
  true satisfies Same<MemoryStatus, MemoryData["status"]>,
  true satisfies Same<MemoryReviewStatus, MemoryData["reviewStatus"]>,
  true satisfies Same<MemoryScope, MemoryData["scope"]>,
  true satisfies Same<MemoryType, NonNullable<MemoryData["memoryType"]>>,
  true satisfies Same<MemorySensitivity, MemoryData["sensitivity"]>,
  true satisfies Same<ReviewItemStatus, ReviewItemData["status"]>,
  true satisfies Same<ReviewDecision, NonNullable<ReviewItemData["decision"]>>,
  true satisfies Same<
    Usefulness,
    NonNullable<(typeof MemoryRetrievalRecord.Type)["data"]["usefulness"]>
  >,
  true satisfies Same<SearchStrategy, (typeof StrategySearchMemoriesRequest.Type)["strategy"]>,
];
void pinned;

export interface MemorySpace {
  readonly createdAt: string;
  readonly description?: string;
  readonly id: string;
  readonly kind: SpaceKind;
  readonly name: string;
  readonly retentionDays?: number;
  readonly status: SpaceStatus;
  readonly updatedAt: string;
  readonly version: number;
  readonly workspaceId?: string;
}

export type MemorySpaceGrant = {
  readonly agentDefinitionId: string;
  readonly createdAt: string;
  readonly id: string;
  readonly memorySpaceId: string;
  readonly permission: GrantPermission;
  readonly updatedAt: string;
  readonly version: number;
} & ({ readonly status: "active" } | { readonly revokedAt: string; readonly status: "revoked" });

export type GrantFilter = GrantStatus | "all";
export const GRANT_FILTERS = [...GRANT_STATUSES, "all"] as const satisfies readonly GrantFilter[];

export interface SpaceSearch {
  readonly grants?: Exclude<GrantFilter, "active">;
  readonly memories?: Exclude<MemoryStatus, "active">;
}

export function parseSpaceSearch(search: Readonly<Record<string, unknown>>): SpaceSearch {
  const { grants, memories } = search;
  return {
    ...(grants === "revoked" || grants === "all" ? { grants } : {}),
    ...(memories === "archived" || memories === "deleted" ? { memories } : {}),
  };
}

function integerIn(text: string, minimum: number, maximum: number): number | undefined {
  const value = Number(text);
  return text !== "" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}

export interface SpaceDraft {
  readonly description: string;
  readonly kind: SpaceKind;
  readonly name: string;
  readonly retentionDays: string;
  /** The owning workspace; only a `workspace` space sends it, and it must have one. */
  readonly workspaceId: string;
}

export function spaceRequest(
  draft: SpaceDraft,
):
  | { readonly ok: true; readonly request: typeof CreateMemorySpaceRequest.Encoded }
  | { readonly ok: false; readonly problem: string } {
  const name = draft.name.trim();
  const description = draft.description.trim();
  const retentionText = draft.retentionDays.trim();
  const retention = integerIn(retentionText, 1, 3650);
  if (name === "" || name.length > 160) {
    return { ok: false, problem: "Name must be 1 to 160 characters." };
  }
  if (description.length > 2000) {
    return { ok: false, problem: "Description must be at most 2000 characters." };
  }
  if (retentionText !== "" && retention === undefined) {
    return { ok: false, problem: "Retention must be a whole number of days from 1 to 3650." };
  }
  if (draft.kind === "workspace" && draft.workspaceId === "") {
    return { ok: false, problem: "Choose the workspace that owns the space." };
  }
  return {
    ok: true,
    request: {
      ...(description === "" ? {} : { description }),
      kind: draft.kind,
      name,
      ...(retention === undefined ? {} : { retentionDays: retention }),
      ...(draft.kind === "workspace" ? { workspaceId: draft.workspaceId } : {}),
    },
  };
}

export type PolicyRetrieval = RetrievalStrategy | "custom" | "default";

export type JsonObject = { readonly [key: string]: JsonValue };

export interface MemoryPolicy {
  readonly activeRecallEnabled: boolean;
  readonly activeRecallRolloutPercent: number;
  readonly createdAt: string;
  readonly id: string;
  readonly processingConfig: JsonObject;
  readonly retentionDays?: number;
  readonly retrieval: PolicyRetrieval;
  readonly retrievalSettings: JsonObject;
  readonly scope: PolicyScope;
  readonly sensitivityMode: SensitivityMode;
  readonly updatedAt: string;
  readonly version: number;
  readonly workspaceId?: string;
}

export interface PolicyDraft {
  readonly activeRecallEnabled: boolean;
  readonly activeRecallRolloutPercent: string;
  readonly retentionDays: string;
  readonly retrieval: PolicyRetrieval;
  readonly scope: Exclude<PolicyScope, "workspace">;
  readonly sensitivityMode: SensitivityMode;
}

export type PolicyRequest = typeof UpsertMemoryPolicyRequest.Encoded;

export function policyDraft(policy: MemoryPolicy | undefined): PolicyDraft {
  return {
    activeRecallEnabled: policy?.activeRecallEnabled ?? false,
    activeRecallRolloutPercent: String(policy?.activeRecallRolloutPercent ?? 100),
    retentionDays: policy?.retentionDays === undefined ? "" : String(policy.retentionDays),
    retrieval: policy?.retrieval ?? "default",
    scope: policy?.scope === "organization" ? "organization" : "environment",
    sensitivityMode: policy?.sensitivityMode ?? "standard",
  };
}

export function policyRequest(
  current: MemoryPolicy | undefined,
  draft: PolicyDraft,
):
  | { readonly ok: true; readonly request: PolicyRequest }
  | { readonly ok: false; readonly problem: string } {
  const rollout = integerIn(draft.activeRecallRolloutPercent.trim(), 0, 100);
  if (rollout === undefined) {
    return { ok: false, problem: "Rollout must be a whole number from 0 to 100." };
  }
  const retentionText = draft.retentionDays.trim();
  const retention = integerIn(retentionText, 1, 3650);
  if (retentionText !== "" && retention === undefined) {
    return { ok: false, problem: "Retention must be a whole number of days from 1 to 3650." };
  }
  if (retention === undefined && current?.retentionDays !== undefined) {
    return { ok: false, problem: "A policy's retention can be changed but not removed." };
  }
  const { memoryRetrieval: _replaced, ...otherConfig } = current?.processingConfig ?? {};
  const { strategy: _strategy, ...settings } = current?.retrievalSettings ?? {};
  const memoryRetrieval =
    draft.retrieval === "default" ? settings : { ...settings, strategy: draft.retrieval };
  const processingConfig =
    current?.retrieval === "custom" || draft.retrieval === "custom"
      ? (current?.processingConfig ?? {})
      : Object.keys(memoryRetrieval).length === 0
        ? otherConfig
        : { ...otherConfig, memoryRetrieval };
  return {
    ok: true,
    request: {
      activeRecallEnabled: draft.activeRecallEnabled,
      activeRecallRolloutPercent: rollout,
      processingConfig,
      ...(retention === undefined ? {} : { retentionDays: retention }),
      sensitivityMode: draft.sensitivityMode,
      ...(current === undefined
        ? { scope: draft.scope }
        : {
            id: current.id,
            scope: current.scope,
            ...(current.workspaceId === undefined ? {} : { workspaceId: current.workspaceId }),
          }),
    },
  };
}

type Parsed<Request> =
  | { readonly ok: true; readonly request: Request }
  | { readonly ok: false; readonly problem: string };

export const MEMORY_PAGE_LIMIT = 20;
export const MEMORY_EXPORT_LIMIT = 500;
export const REVIEW_SCAN_LIMIT = 200;

type MemoryBody =
  | { readonly kind: "inline"; readonly text: string }
  | { readonly byteSize: number; readonly kind: "stored" };

export type Memory = {
  readonly createdAt: string;
  readonly entityKeys: readonly string[];
  readonly id: string;
  readonly importance?: number;
  readonly memorySpaceId: string;
  readonly memoryType?: MemoryType;
  readonly reviewStatus: MemoryReviewStatus;
  readonly scope: MemoryScope;
  readonly sensitivity: MemorySensitivity;
  readonly source: string;
  readonly updatedAt: string;
  readonly version: number;
} & (
  | { readonly body: MemoryBody; readonly status: Exclude<MemoryStatus, "deleted"> }
  | { readonly status: "deleted" }
);

export type LifecycleAction = "archive" | "delete" | "restore";

export const LIFECYCLE_ACTIONS: Readonly<Record<MemoryStatus, readonly LifecycleAction[]>> = {
  active: ["archive"],
  archived: ["restore", "delete"],
  deleted: [],
};

export interface MemoryReviewItem {
  readonly createdAt: string;
  readonly id: string;
  readonly kind: string;
  readonly memoryId: string;
  readonly proposedContent?: string;
  readonly reason?: string;
  readonly status: ReviewItemStatus;
  readonly updatedAt: string;
  readonly version: number;
}

export interface ReviewEntry {
  readonly item: MemoryReviewItem;
  readonly memory: Memory | undefined;
}

export interface ReviewQueuePage {
  readonly items: readonly ReviewEntry[];
  readonly nextCursor?: string | undefined;
  readonly scannedAllMemories: boolean;
}

interface ReviewDraft {
  readonly content: string;
  readonly decision: ReviewDecision;
  readonly reason: string;
}

export type ReviewRequest = typeof ResolveMemoryReviewRequest.Encoded;

export function reviewRequest(draft: ReviewDraft): Parsed<ReviewRequest> {
  const content = draft.content.trim();
  const reason = draft.reason.trim();
  if (draft.decision === "edit" && content === "") {
    return { ok: false, problem: "An edit needs the replacement content." };
  }
  return {
    ok: true,
    request: {
      ...(draft.decision === "edit" ? { content } : {}),
      decision: draft.decision,
      ...(reason === "" ? {} : { reason }),
    },
  };
}

const IMPORT_MAX_ITEMS = 100;
const IMPORT_MAX_BYTES = 4 * 1024 * 1024;
const IMPORT_MAX_ITEM_BYTES = 8000;

export interface ImportDraft {
  readonly memoryType: MemoryType | "unset";
  readonly text: string;
}

export type ImportRequest = typeof ImportMemoriesRequest.Encoded;

/**
 * The platform collapses each run of whitespace to one space, trims, and stores that text, so
 * the 8,000-byte limit applies after the collapse. It refuses a memory owned by another
 * workspace than its space's.
 */
export function importRequest(
  space: Pick<MemorySpace, "id" | "workspaceId">,
  draft: ImportDraft,
): Parsed<ImportRequest> {
  const encoder = new TextEncoder();
  const contents = draft.text
    .split(/\n\s*\n/u)
    .map((content) => content.replace(/\s+/gu, " ").trim())
    .filter((content) => content !== "");
  if (contents.length === 0) return { ok: false, problem: "Enter at least one memory." };
  if (contents.length > IMPORT_MAX_ITEMS) {
    return {
      ok: false,
      problem: `An import takes at most ${IMPORT_MAX_ITEMS} memories; this has ${contents.length}.`,
    };
  }
  for (const [index, content] of contents.entries()) {
    const bytes = encoder.encode(content).byteLength;
    if (bytes > IMPORT_MAX_ITEM_BYTES) {
      return {
        ok: false,
        problem: `Block ${index + 1} is ${formatExact(bytes)} bytes; each memory takes at most ${formatExact(IMPORT_MAX_ITEM_BYTES)} bytes.`,
      };
    }
  }
  const owner =
    space.workspaceId === undefined
      ? { scope: "organization" as const }
      : { scope: "workspace" as const, workspaceId: space.workspaceId };
  const data = contents.map((content) => ({
    content,
    ...(draft.memoryType === "unset" ? {} : { memoryType: draft.memoryType }),
    ...owner,
  }));
  if (encoder.encode(JSON.stringify(data)).byteLength > IMPORT_MAX_BYTES) {
    return { ok: false, problem: "An import must be at most 4 MiB." };
  }
  return { ok: true, request: { data, memorySpaceId: space.id } };
}

export interface ImportOutcome {
  readonly imported: number;
  readonly rejected: readonly { readonly index: number; readonly reason: string }[];
  readonly replayed: number;
}

export type SearchMode = "policy" | SearchStrategy;

export interface SearchDraft {
  readonly memorySpaceIds: readonly string[];
  readonly mode: SearchMode;
  readonly query: string;
  readonly topK: string;
}

export type SearchRequest =
  | { readonly body: typeof SearchMemoriesRequest.Encoded; readonly kind: "policy" }
  | { readonly body: typeof StrategySearchMemoriesRequest.Encoded; readonly kind: "strategy" };

export function searchRequest(draft: SearchDraft): Parsed<SearchRequest> {
  const query = draft.query.trim();
  const topK = integerIn(draft.topK.trim(), 1, 45);
  if (query === "") return { ok: false, problem: "Enter a query." };
  if (draft.memorySpaceIds.length === 0 || draft.memorySpaceIds.length > 20) {
    return { ok: false, problem: "Choose 1 to 20 spaces." };
  }
  if (topK === undefined)
    return { ok: false, problem: "Results must be a whole number from 1 to 45." };
  const body = { memorySpaceIds: [...draft.memorySpaceIds], query, topK };
  return {
    ok: true,
    request:
      draft.mode === "policy"
        ? { body, kind: "policy" }
        : { body: { ...body, strategy: draft.mode }, kind: "strategy" },
  };
}

export interface MemorySearchHit {
  readonly memory: Memory;
  readonly rank: number;
  readonly retrievalId: string | undefined;
  readonly score: number;
}

export interface MemorySearchResult {
  readonly attemptId: string;
  readonly hits: readonly MemorySearchHit[];
  readonly strategy: RetrievalStrategy;
}

export interface RetrievalFeedback {
  readonly retrievalId: string;
  readonly usefulness: Usefulness;
}

export const QUALITY_WINDOWS = [1, 7, 30, 90] as const;
export type QualityWindow = (typeof QUALITY_WINDOWS)[number];
export const DEFAULT_QUALITY_WINDOW = 7 satisfies QualityWindow;

export interface QualitySearch {
  readonly days?: Exclude<QualityWindow, typeof DEFAULT_QUALITY_WINDOW>;
}

export function parseQualitySearch(search: Readonly<Record<string, unknown>>): QualitySearch {
  const days = QUALITY_WINDOWS.find((window) => window === search["days"]);
  return days === undefined || days === DEFAULT_QUALITY_WINDOW ? {} : { days };
}

const DAY_MS = 86_400_000;
const QUALITY_MAX_MS = 90 * DAY_MS;
const QUALITY_CLOCK_MARGIN_MS = 5 * 60_000;

/**
 * The platform refuses a `since` older than 90 days by its own clock, which reads after the
 * request arrives, so the 90-day window starts five minutes later.
 */
export function qualitySince(days: QualityWindow, now: Date): string {
  const span = Math.min(days * DAY_MS, QUALITY_MAX_MS - QUALITY_CLOCK_MARGIN_MS);
  return new Date(now.getTime() - span).toISOString();
}

interface AttemptCounts {
  readonly attempts: number;
  readonly completed: number;
  readonly failed: number;
}

export interface MemoryQuality extends AttemptCounts {
  readonly canonicalDropRate: number;
  readonly duplicateRate: number;
  readonly latencyMs: {
    readonly p50?: number;
    readonly p95?: number;
    readonly p99?: number;
    readonly samples: number;
  };
  readonly retrievals: number;
  readonly sampleLimit: number;
  readonly strategies: readonly (AttemptCounts & { readonly strategy: string })[];
  readonly usefulness: Readonly<Record<Usefulness | "unreviewed", number>>;
}

export interface MemoryExport {
  readonly complete: boolean;
  readonly memories: readonly JsonObject[];
}

export function memoryExportFile(
  memorySpaceId: string,
  result: MemoryExport,
  exportedAt: Date,
): { readonly content: string; readonly filename: string } {
  const timestamp = exportedAt.toISOString();
  return {
    content: `${JSON.stringify(
      {
        complete: result.complete,
        exportedAt: timestamp,
        format: "json",
        memories: result.memories,
        memorySpaceId,
      },
      null,
      2,
    )}\n`,
    filename: `memory-${memorySpaceId}-${timestamp.slice(0, 10)}.json`,
  };
}
