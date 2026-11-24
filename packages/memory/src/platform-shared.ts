import {
  isDatabaseWriteConflict,
  key,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
  memoryPersistence,
} from "@deployments-ai/db";
import { Effect, Schema } from "effect";
import { createHash } from "node:crypto";
import { validateMemorySearchKey, type MemoryScope } from "./governance.ts";
import { boundedLimit, MAX_LIMIT } from "./platform-pagination.ts";
import { makeMemoryRepository } from "./repository.ts";
import { makeMemoryService } from "./service.ts";
import { type CanonicalMemoryRecord, type MemorySensitivity } from "./memory-record.ts";
import * as Types from "./platform-types.ts";
export {
  boundedLimit,
  localPageCursorCodec,
  MAX_FILTERED_PAGE_QUERIES,
  MAX_LIMIT,
  queryEnvironmentRecordPage,
} from "./platform-pagination.ts";
export interface MemoryPlatformRuntime {
  readonly cursorCodec: Types.MemoryPageCursorCodec;
  readonly database: DynamoDatabaseService;
  readonly dependencies: Types.MemoryPlatformDependencies;
  readonly generateId: () => Promise<Ulid>;
  readonly now: () => Date;
  readonly repository: ReturnType<typeof makeMemoryRepository>;
  readonly searchService: ReturnType<typeof makeMemoryService>;
}

export const MAX_IMPORT_COUNT = 100;
const MAX_CONTENT_LENGTH = 50_000;
export const MAX_MEMORY_METADATA_BYTES = 64 * 1_024;
export const MAX_POLICY_PROCESSING_CONFIG_BYTES = 64 * 1_024;
export const MAX_EMBEDDING_CONTENT_BYTES = 8_000;
export const MAX_MEMORY_BLOB_BYTES = MAX_CONTENT_LENGTH * 4;
export const MAX_MESSAGE_BLOB_BYTES = 512_000;
// A worst-case strategy-shadow search uses two transaction operations per retrieval, plus ten
// operations for its attempt, shadow job/event, search-target and governance-directory
// companions, and the organization erasure-fence/existence invariants.
export const MAX_PERSISTED_RETRIEVALS = 45;
export const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";
export const INDEX_LEASE_MS = 5 * 60_000;
export const INDEX_DISPATCH_RETRY_MS = 5 * 60_000;
export const FLUSH_LEASE_MS = 10 * 60_000;
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
export const RECONCILIATION_RESYNC_MS = 24 * 60 * 60_000;
export const DEFAULT_QUALITY_WINDOW_MS = 30 * 24 * 60 * 60_000;
export const MAX_QUALITY_WINDOW_MS = 90 * 24 * 60 * 60_000;
const DEFAULT_QUALITY_SAMPLE_LIMIT = 1_000;
const MAX_QUALITY_SAMPLE_LIMIT = 5_000;
const MAX_DATABASE_WRITE_ATTEMPTS = 4;

type MemoryIndexJob = Extract<PlatformRecord, { readonly itemType: "memory-index-job" }>;

export async function memoryIndexJobEventVersion(
  database: DynamoDatabaseService,
  job: MemoryIndexJob,
) {
  if (job.data.eventVersion !== undefined) return job.data.eventVersion;
  const page = await memoryPersistence.find(database, "events", {
    ConsistentRead: true,
    ExpressionAttributeValues: {
      ":pk": key("ORG", job.data.organizationId, "AGGREGATE", "memory-index-job", job.data.id),
    },
    KeyConditionExpression: "pk = :pk",
    Limit: 1,
    ScanIndexForward: false,
  });
  const latest = page.items[0];
  if (
    latest?.itemType !== "semantic-event" ||
    latest.data.aggregateType !== "memory-index-job" ||
    latest.data.aggregateId !== job.data.id
  ) {
    throw new Error("Memory index job semantic event sequence is unavailable.");
  }
  return latest.data.aggregateVersion;
}

export async function retryDatabaseWriteConflicts<Result>(operation: () => Promise<Result>) {
  let lastCause: unknown;
  for (let attempt = 0; attempt < MAX_DATABASE_WRITE_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (cause) {
      if (!isDatabaseWriteConflict(cause)) throw cause;
      lastCause = cause;
    }
  }
  throw lastCause;
}

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry) ?? "null").join(",")}]`;
  }
  const toJSON = (value as { readonly toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") {
    return canonicalJson(toJSON.call(value));
  }
  const entries = Object.entries(value as Readonly<Record<string, unknown>>)
    .map(([key, entry]) => [key, canonicalJson(entry)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${entry}`).join(",")}}`;
}

export function commandHash(value: unknown) {
  const encoded = canonicalJson(value);
  if (encoded === undefined) throw new TypeError("Idempotent command must be JSON serializable.");
  return sha256(encoded);
}

export function importCommandHash(
  item: Types.ImportMemoryItem,
  memorySpaceId: Ulid,
  normalizedContent: string,
  searchKey: string,
) {
  return commandHash({
    agentDefinitionId: item.agentDefinitionId,
    brainProvenance: item.brainProvenance,
    content: normalizedContent,
    entityKeys: item.entityKeys,
    importance: item.importance,
    memorySpaceId,
    memoryType: item.memoryType,
    metadata: item.metadata,
    observability: item.observability,
    ...(item.retainPersonalData ? { retainPersonalData: true } : {}),
    scope: item.scope,
    searchKey,
    source: item.source ?? "import",
    sourceQuality: item.sourceQuality,
    sourceRunId: item.sourceRunId,
    threadId: item.threadId,
    supersedesMemoryId: item.supersedesMemoryId,
    validFrom: item.validFrom,
    validUntil: item.validUntil,
    workspaceId: item.workspaceId,
  });
}

export function qualitySampleLimit(value: number | undefined) {
  if (value === undefined) return DEFAULT_QUALITY_SAMPLE_LIMIT;
  if (!Number.isFinite(value)) {
    throw new Types.MemoryPlatformError(
      400,
      "invalid_limit",
      "Memory quality limit must be finite.",
    );
  }
  return Math.min(Math.max(Math.trunc(value), 1), MAX_QUALITY_SAMPLE_LIMIT);
}

export function iso(date: Date) {
  return date.toISOString();
}

export function addDays(date: Date, days: number | undefined) {
  return days === undefined
    ? undefined
    : new Date(date.getTime() + days * 86_400_000).toISOString();
}

export function synchronizationGeneration(date: Date, sequence = 0) {
  const generation = date.getTime() * 1_000 + Math.min(Math.max(Math.trunc(sequence), 0), 999);
  if (!Number.isSafeInteger(generation)) {
    throw new Types.MemoryPlatformError(
      500,
      "invalid_synchronization_generation",
      "Memory synchronization generation exceeded the safe integer range.",
    );
  }
  return generation;
}

export function memorySynchronizationGeneration(memory: CanonicalMemoryRecord) {
  return synchronizationGeneration(new Date(memory.data.updatedAt), memory.data.version);
}

export function requireText(value: string, label: string, maximum = MAX_CONTENT_LENGTH) {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized)
    throw new Types.MemoryPlatformError(400, "invalid_request", `${label} is required.`);
  if (normalized.length > maximum) {
    throw new Types.MemoryPlatformError(
      400,
      "invalid_request",
      `${label} must not exceed ${maximum} characters.`,
    );
  }
  return normalized;
}

export function embeddableText(value: string, label: string, maximum = MAX_CONTENT_LENGTH) {
  const normalized = requireText(value, label, maximum);
  if (new TextEncoder().encode(normalized).byteLength > MAX_EMBEDDING_CONTENT_BYTES) {
    throw new Types.MemoryPlatformError(
      400,
      "invalid_request",
      `${label} must not exceed ${MAX_EMBEDDING_CONTENT_BYTES} UTF-8 bytes.`,
    );
  }
  return normalized;
}

export function embeddingContentTooLarge(value: string) {
  return new TextEncoder().encode(value).byteLength > MAX_EMBEDDING_CONTENT_BYTES;
}

export function record<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] {
  return Schema.decodeUnknownSync(schema)(value);
}

export function memoryKey(scope: Types.MemoryPlatformScope, memoryId: Ulid) {
  return {
    pk: key("ORG", scope.organizationId, "MEMORY", memoryId),
    sk: key("MEMORY", memoryId),
  };
}

export function memorySpaceKey(scope: Types.MemoryPlatformScope, memorySpaceId: Ulid) {
  return {
    pk: key("ORG", scope.organizationId, "ENV", scope.environmentId),
    sk: key("MEMORY-SPACE", memorySpaceId),
  };
}

export function activeMemorySpaceCondition(
  space: Types.MemorySpace,
): Extract<TransactionOperation, { readonly kind: "condition-check" }> {
  return {
    conditionExpression:
      "#itemType = :itemType AND #data.#status = :status AND #data.#version = :version",
    expressionAttributeNames: {
      "#data": "data",
      "#itemType": "itemType",
      "#status": "status",
      "#version": "version",
    },
    expressionAttributeValues: {
      ":itemType": "memory-space",
      ":status": "active",
      ":version": space.data.version,
    },
    key: { pk: space.pk, sk: space.sk },
    kind: "condition-check",
    table: "control",
  };
}

export function memoryPolicyKey(scope: Types.MemoryPlatformScope, memoryPolicyId: Ulid) {
  return {
    pk: key("ORG", scope.organizationId, "ENV", scope.environmentId),
    sk: key("MEMORY-POLICY", memoryPolicyId),
  };
}

export function memoryGrantKey(scope: Types.MemoryPlatformScope, memoryGrantId: Ulid) {
  return {
    pk: key("ORG", scope.organizationId, "ENV", scope.environmentId),
    sk: key("MEMORY-SPACE-GRANT", memoryGrantId),
  };
}

export function idempotencyRecordKey(scope: Types.MemoryPlatformScope, idempotencyKey: string) {
  const scopedKey = scopedIdempotencyKey(scope, idempotencyKey);
  const recordKey = {
    pk: key("ORG", scope.organizationId),
    sk: key("IDEMPOTENCY", scopedKey),
  };
  if (new TextEncoder().encode(recordKey.sk).byteLength > 1_024) {
    throw new Types.MemoryPlatformError(
      400,
      "invalid_idempotency_key",
      "The idempotency key is too large after canonical encoding.",
    );
  }
  return recordKey;
}

export function scopedIdempotencyKey(scope: Types.MemoryPlatformScope, idempotencyKey: string) {
  return `${scope.projectId}:${scope.environmentId}:${scope.workspaceId ?? "environment"}:${idempotencyKey}`;
}

export function memoryReviewKey(scope: Types.MemoryPlatformScope, memoryId: Ulid, reviewId: Ulid) {
  return {
    pk: key("ORG", scope.organizationId, "MEMORY", memoryId),
    sk: key("MEMORY-REVIEW-ITEM", reviewId),
  };
}

export function memoryJobKey(
  scope: Types.MemoryPlatformScope,
  memoryId: Ulid,
  idempotencyKey: string,
  targetId?: Ulid,
) {
  const encodedTargetId =
    targetId ??
    (idempotencyKey.split(":").length >= 5 ? (idempotencyKey.split(":")[0] as Ulid) : undefined);
  return {
    pk: key("ORG", scope.organizationId, "MEMORY", memoryId),
    sk: encodedTargetId
      ? key("MEMORY-INDEX-JOB", encodedTargetId, idempotencyKey)
      : key("MEMORY-INDEX-JOB", idempotencyKey),
  };
}

export function memoryFlushKey(
  scope: Types.MemoryPlatformScope,
  runId: Ulid,
  idempotencyKey: string,
) {
  return {
    pk: key("ORG", scope.organizationId, "RUN", runId),
    sk: key("MEMORY-FLUSH", idempotencyKey),
  };
}

export function runLocatorKey(scope: Types.MemoryPlatformScope, runId: Ulid) {
  return {
    pk: key("ORG", scope.organizationId, "ENV", scope.environmentId),
    sk: key("RUN-LOCATOR", runId),
  };
}

export function scopeMatches(
  record: { readonly data: Record<string, unknown> },
  scope: Types.MemoryPlatformScope,
) {
  return (
    tenantScopeMatches(record, scope) &&
    (scope.workspaceId === undefined ||
      record.data.workspaceId === undefined ||
      record.data.workspaceId === scope.workspaceId)
  );
}

export function tenantScopeMatches(
  record: { readonly data: Record<string, unknown> },
  scope: Types.MemoryPlatformScope,
) {
  return (
    record.data.organizationId === scope.organizationId &&
    record.data.projectId === scope.projectId &&
    record.data.environmentId === scope.environmentId
  );
}

export function telemetryScopeMatches(
  record: { readonly data: Record<string, unknown> },
  scope: Types.MemoryPlatformScope,
) {
  return (
    scopeMatches(record, scope) &&
    (scope.workspaceId === undefined || record.data.workspaceId === scope.workspaceId)
  );
}

export function mutationScopeMatches(
  record: { readonly data: Record<string, unknown> },
  scope: Types.MemoryPlatformScope,
) {
  return (
    scopeMatches(record, scope) &&
    (!scope.exactWorkspaceMutations ||
      scope.workspaceId === undefined ||
      record.data.workspaceId === scope.workspaceId)
  );
}

export function reconciliationScopeMatches(
  record: { readonly data: Record<string, unknown> },
  scope: Types.MemoryPlatformScope,
) {
  return (
    record.data.organizationId === scope.organizationId &&
    record.data.projectId === scope.projectId &&
    record.data.environmentId === scope.environmentId &&
    (scope.workspaceId === undefined || record.data.workspaceId === scope.workspaceId)
  );
}

export function memoryOwnedScope(scope: Types.MemoryPlatformScope, workspaceId: Ulid | undefined) {
  const { workspaceId: _requestedWorkspaceId, ...tenantScope } = scope;
  return {
    ...tenantScope,
    ...(workspaceId ? { workspaceId } : {}),
  };
}

/** Workspace policy beats environment beats organization; the newest wins within a level. */
export function effectivePolicyAmong(
  policies: readonly Types.MemoryPolicy[],
  workspaceId: Ulid | undefined,
) {
  const latest = (matching: readonly Types.MemoryPolicy[]) =>
    [...matching].sort(
      (left, right) =>
        right.data.updatedAt.localeCompare(left.data.updatedAt) ||
        right.data.id.localeCompare(left.data.id),
    )[0];
  return (
    latest(
      policies.filter(
        (policy) => policy.data.scope === "workspace" && policy.data.workspaceId === workspaceId,
      ),
    ) ??
    latest(policies.filter((policy) => policy.data.scope === "environment")) ??
    latest(policies.filter((policy) => policy.data.scope === "organization"))
  );
}

/**
 * The effective policy fields memory reconciliation applies to stored memories and their index.
 * A policy write starts a reconcile only when one of these changes, so every reader that turns
 * a policy into stored or indexed state goes through `reconciledPolicyFields`.
 */
export interface ReconciledPolicyFields {
  readonly retentionDays: number | undefined;
  readonly sensitivityMode: Types.MemoryPolicy["data"]["sensitivityMode"];
}

export function reconciledPolicyFields(
  policy: Types.MemoryPolicy | undefined,
): ReconciledPolicyFields {
  return {
    retentionDays: policy?.data.retentionDays,
    sensitivityMode: policy?.data.sensitivityMode ?? "standard",
  };
}

export function reconciledPolicyChanged(
  before: Types.MemoryPolicy | undefined,
  after: Types.MemoryPolicy | undefined,
) {
  const previous = reconciledPolicyFields(before);
  const next = reconciledPolicyFields(after);
  return (
    previous.retentionDays !== next.retentionDays ||
    previous.sensitivityMode !== next.sensitivityMode
  );
}

export function memoryWorkspaceForScope(run: Types.Run, memoryScope: MemoryScope) {
  return memoryScope === "organization" ? undefined : run.data.workspaceId;
}

export function writableMemorySpaceForScope(
  access: Types.MemoryRunAccess,
  memoryScope: MemoryScope,
  requestedMemorySpaceId?: Ulid,
) {
  const workspaceId = memoryWorkspaceForScope(access.run, memoryScope);
  return access.writeMemorySpaces.find(
    (space) =>
      (requestedMemorySpaceId === undefined || space.id === requestedMemorySpaceId) &&
      space.workspaceId === workspaceId,
  );
}

export async function effectValue<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect);
}

export async function loadRecord<ItemType extends PlatformRecord["itemType"]>(
  database: DynamoDatabaseService,
  table: "control" | "events" | "execution" | "usage",
  keyValue: { readonly pk: string; readonly sk: string },
  itemType: ItemType,
): Promise<Extract<PlatformRecord, { readonly itemType: ItemType }> | undefined> {
  const value = await memoryPersistence.read(database, table, keyValue, true);
  return value?.itemType === itemType
    ? (value as Extract<PlatformRecord, { readonly itemType: ItemType }>)
    : undefined;
}

export function memoryShadowJobKey(scope: Types.MemoryPlatformScope, jobId: Ulid) {
  return {
    pk: key("ORG", scope.organizationId, "ENV", scope.environmentId),
    sk: key("MEMORY-SHADOW-JOB", jobId),
  };
}

export async function queryEnvironmentRecords<T extends PlatformRecord>(args: {
  readonly all?: boolean;
  readonly database: DynamoDatabaseService;
  readonly environmentId: Ulid;
  readonly filter?: (record: T) => boolean;
  readonly itemType: T["itemType"];
  readonly limit?: number;
  readonly status?: string;
  readonly table: "control" | "execution";
}): Promise<T[]> {
  const prefix = `${key(String(args.itemType).toUpperCase(), ...(args.status ? [args.status] : []))}#`;
  const items: T[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await memoryPersistence.find(args.database, args.table, {
      ExpressionAttributeValues: {
        ":pk": key("ENV", args.environmentId),
        ":prefix": prefix,
      },
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      IndexName: "gsi2",
      KeyConditionExpression: "gsi2pk = :pk AND begins_with(gsi2sk, :prefix)",
      Limit: args.all ? MAX_LIMIT : boundedLimit(args.limit),
      ScanIndexForward: false,
    });
    const page = result.items.filter((value): value is T => value.itemType === args.itemType);
    items.push(...(args.filter ? page.filter(args.filter) : page));
    exclusiveStartKey = result.lastEvaluatedKey;
  } while (exclusiveStartKey && (args.all || items.length < boundedLimit(args.limit)));
  return args.all ? items : items.slice(0, boundedLimit(args.limit));
}

export function sensitivityModeValues(
  mode: Types.MemoryPolicy["data"]["sensitivityMode"],
): readonly MemorySensitivity[] {
  if (mode === "strict") return ["public", "internal"];
  if (mode === "standard") return ["public", "internal", "restricted"];
  return ["public", "internal", "restricted", "confidential"];
}

export function searchKeyForItem(item: Types.ImportMemoryItem, scope: Types.MemoryPlatformScope) {
  if (item.searchKey?.trim()) return validatedSearchKey(item.searchKey);
  switch (item.scope) {
    case "organization":
      return `organization:${scope.organizationId}`;
    case "workspace":
      return `workspace:${item.workspaceId ?? scope.workspaceId ?? "missing"}`;
    case "agent":
      return `agent:${item.agentDefinitionId ?? "missing"}`;
    case "thread":
      return `thread:${item.threadId ?? "missing"}`;
  }
}

export function validatedSearchKey(value: string) {
  try {
    return validateMemorySearchKey(value);
  } catch (cause) {
    throw new Types.MemoryPlatformError(
      400,
      "invalid_search_key",
      cause instanceof Error ? cause.message : "Memory search key is invalid.",
    );
  }
}

export function reviewScopeMatches(
  review: Types.MemoryReviewItem,
  scope: Types.MemoryPlatformScope,
) {
  return scopeMatches(review, scope);
}

export function validateImportScope(
  item: Types.ImportMemoryItem,
  scope: Types.MemoryPlatformScope,
) {
  requireWorkspaceMatch(scope, item.workspaceId, "Memory import workspaceId");
  if (scope.exactWorkspaceMutations && item.scope === "organization") {
    throw new Types.MemoryPlatformError(
      403,
      "workspace_scope_conflict",
      "Workspace-scoped credentials cannot create organization memory.",
    );
  }
  if (item.scope === "workspace" && !(item.workspaceId ?? scope.workspaceId)) {
    throw new Types.MemoryPlatformError(
      400,
      "invalid_scope",
      "Workspace memory requires workspaceId.",
    );
  }
  if (item.scope === "agent" && !item.agentDefinitionId) {
    throw new Types.MemoryPlatformError(
      400,
      "invalid_scope",
      "Agent memory requires agentDefinitionId.",
    );
  }
  if (item.scope === "thread" && !item.threadId) {
    throw new Types.MemoryPlatformError(400, "invalid_scope", "Thread memory requires threadId.");
  }
}

export function requireWorkspaceMatch(
  scope: Types.MemoryPlatformScope,
  requestedWorkspaceId: Ulid | undefined,
  label: string,
) {
  if (
    scope.workspaceId !== undefined &&
    requestedWorkspaceId !== undefined &&
    requestedWorkspaceId !== scope.workspaceId
  ) {
    throw new Types.MemoryPlatformError(
      403,
      "workspace_scope_conflict",
      `${label} must match the authenticated workspace.`,
    );
  }
}

export function memoryOperation(
  memory: CanonicalMemoryRecord,
): Types.MemoryIndexJob["data"]["operation"] {
  if (memory.data.status === "deleted") return "delete";
  if (memory.data.status === "archived") return "archive";
  return memory.data.version === 0 ? "index" : "update";
}
