import { Schema } from "effect";
import { Cursor, PUBLIC_ID_PATTERN_SOURCE, PublicId } from "./primitives.ts";
import type { PublicApiRouteContract } from "./route-contract.ts";

const nonEmptyText = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter<string>((value) =>
      value.trim().length > 0 ? undefined : "Expected a non-empty string.",
    ),
  ),
);

const finiteNumber = Schema.Number.pipe(Schema.check(Schema.isFinite()));

function boundedInteger(maximum: number, label: string) {
  return Schema.Number.pipe(
    Schema.check(
      Schema.isInt({ message: `${label} must be an integer.` }),
      Schema.isGreaterThanOrEqualTo(1, {
        message: `${label} must be at least 1.`,
      }),
      Schema.isLessThanOrEqualTo(maximum, {
        message: `${label} must not exceed ${maximum}.`,
      }),
    ),
  );
}

function boundedStringArray(maximum: number, label: string) {
  return Schema.Array(nonEmptyText).pipe(
    Schema.check(
      Schema.isMaxLength(maximum, {
        message: `${label} must contain at most ${maximum} entries.`,
      }),
    ),
  );
}

const MemoryRetentionDays = boundedInteger(3_650, "Memory retention days");
const MemoryRolloutPercent = Schema.Number.pipe(
  Schema.check(
    Schema.isFinite(),
    Schema.isGreaterThanOrEqualTo(0, {
      message: "Active recall rollout percent must be at least 0.",
    }),
    Schema.isLessThanOrEqualTo(100, {
      message: "Active recall rollout percent must not exceed 100.",
    }),
  ),
);

const MemoryPageLimit = boundedInteger(200, "Memory page limits");
const MemoryContentPageLimit = boundedInteger(20, "Memory content page limits");
const MemoryQualityLimit = boundedInteger(5_000, "Memory quality limits");
const MemorySearchLimit = boundedInteger(45, "Memory search limits");

export const MemoryListQuery = Schema.Struct({
  cursor: Schema.optional(Cursor),
  limit: Schema.optional(MemoryPageLimit),
});

export const MemoryContentListQuery = Schema.Struct({
  cursor: Schema.optional(Cursor),
  limit: Schema.optional(MemoryContentPageLimit),
  space: Schema.optional(PublicId),
  status: Schema.optional(Schema.Literals(["active", "archived", "deleted"])),
});

export const MemorySpaceGrantListQuery = Schema.Struct({
  agentDefinitionId: Schema.optional(PublicId),
  cursor: Schema.optional(Cursor),
  limit: Schema.optional(MemoryPageLimit),
  memorySpaceId: Schema.optional(PublicId),
  status: Schema.optional(Schema.Literals(["active", "all", "revoked"])),
});

export const MemoryQualityQuery = Schema.Struct({
  limit: Schema.optional(MemoryQualityLimit),
  since: Schema.optional(Schema.String),
});

export const MemoryReviewListQuery = Schema.Struct({
  cursor: Schema.optional(Cursor),
  limit: Schema.optional(MemoryPageLimit),
  status: Schema.optional(Schema.Literals(["open", "resolved"])),
});

export const CreateMemorySpaceRequest = Schema.Struct({
  description: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.Literals(["agent", "organization", "shared", "workspace"])),
  name: nonEmptyText,
  retentionDays: Schema.optional(MemoryRetentionDays),
  workspaceId: Schema.optional(PublicId),
});

export const UpsertMemoryPolicyRequest = Schema.Struct({
  activeRecallEnabled: Schema.optional(Schema.Boolean),
  activeRecallRolloutPercent: Schema.optional(MemoryRolloutPercent),
  id: Schema.optional(PublicId),
  processingConfig: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  retentionDays: Schema.optional(MemoryRetentionDays),
  scope: Schema.optional(Schema.Literals(["environment", "organization", "workspace"])),
  sensitivityMode: Schema.optional(Schema.Literals(["restricted", "standard", "strict"])),
  workspaceId: Schema.optional(PublicId),
});

export const CreateMemorySpaceGrantRequest = Schema.Struct({
  agentDefinitionId: PublicId,
  memorySpaceId: PublicId,
  permission: Schema.Literals(["read", "read-write"]),
});

export const UpdateMemorySpaceGrantRequest = Schema.Struct({
  permission: Schema.Literals(["read", "read-write"]),
});

const ImportMemoryItem = Schema.Struct({
  agentDefinitionId: Schema.optional(PublicId),
  content: nonEmptyText,
  entityKeys: Schema.optional(boundedStringArray(20, "Memory entity keys")),
  idempotencyKey: Schema.optional(
    Schema.String.pipe(
      Schema.check(
        Schema.makeFilter<string>((value) => {
          const size = new TextEncoder().encode(value).byteLength;
          return value.trim().length >= 1 && size <= 500
            ? undefined
            : "Memory item idempotency keys must contain between 1 and 500 UTF-8 bytes.";
        }),
      ),
    ),
  ),
  importance: Schema.optional(finiteNumber),
  memoryType: Schema.optional(
    Schema.Literals(["episode", "fact", "preference", "procedure", "summary"]),
  ),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  scope: Schema.Literals(["agent", "organization", "thread", "workspace"]),
  searchKey: Schema.optional(Schema.String),
  sourceQuality: Schema.optional(finiteNumber),
  supersedesMemoryId: Schema.optional(PublicId),
  threadId: Schema.optional(PublicId),
  validFrom: Schema.optional(nonEmptyText),
  validUntil: Schema.optional(nonEmptyText),
  workspaceId: Schema.optional(PublicId),
});

const ImportMemoriesFields = {
  data: Schema.Array(ImportMemoryItem).pipe(
    Schema.check(
      Schema.isMinLength(1, {
        message: "Memory imports must contain at least one item.",
      }),
      Schema.isMaxLength(100, {
        message: "Memory imports must contain at most 100 items.",
      }),
    ),
  ),
} as const;

export const ImportMemoriesRequest = Schema.Union([
  Schema.Struct({
    ...ImportMemoriesFields,
    memorySpaceId: PublicId,
    space: Schema.optional(PublicId),
  }),
  Schema.Struct({
    ...ImportMemoriesFields,
    memorySpaceId: Schema.optional(PublicId),
    space: PublicId,
  }),
]).pipe(
  Schema.check(
    Schema.makeFilter((input) =>
      new TextEncoder().encode(JSON.stringify(input.data)).byteLength <= 4 * 1024 * 1024
        ? undefined
        : "Memory imports must serialize to at most 4194304 bytes.",
    ),
  ),
);

const ExportMemoriesFields = {
  cursor: Schema.optional(Cursor),
  format: Schema.optional(Schema.Literal("json")),
  limit: Schema.optional(MemoryContentPageLimit),
} as const;

export const ExportMemoriesRequest = Schema.Union([
  Schema.Struct({
    ...ExportMemoriesFields,
    memorySpaceId: PublicId,
    space: Schema.optional(PublicId),
  }),
  Schema.Struct({
    ...ExportMemoriesFields,
    memorySpaceId: Schema.optional(PublicId),
    space: PublicId,
  }),
]);

export const ActiveMemoryRecallRequest = Schema.Struct({
  query: nonEmptyText,
  runId: PublicId,
  topK: Schema.optional(MemorySearchLimit),
});

const MemorySpaceIds = Schema.Array(PublicId).pipe(
  Schema.check(
    Schema.isMinLength(1, {
      message: "At least one memory space is required.",
    }),
    Schema.isMaxLength(20, {
      message: "Memory searches accept at most 20 memory spaces.",
    }),
  ),
);

const SearchMemoryFields = {
  query: nonEmptyText,
  searchKeys: Schema.optional(boundedStringArray(50, "Memory search keys")),
  topK: Schema.optional(MemorySearchLimit),
} as const;

export const SearchMemoriesRequest = Schema.Union([
  Schema.Struct({
    ...SearchMemoryFields,
    memorySpaceIds: MemorySpaceIds,
    space: Schema.optional(PublicId),
  }),
  Schema.Struct({
    ...SearchMemoryFields,
    memorySpaceIds: Schema.optional(MemorySpaceIds),
    space: PublicId,
  }),
]);

export const StrategySearchMemoriesRequest = Schema.Union([
  Schema.Struct({
    ...SearchMemoryFields,
    memorySpaceIds: MemorySpaceIds,
    space: Schema.optional(PublicId),
    strategy: Schema.Literals([
      "dense-open-search-ann-control-v1",
      "dense-exact-control-v1",
      "hybrid-rerank-v1",
      "hybrid-rrf-v1",
    ]),
  }),
  Schema.Struct({
    ...SearchMemoryFields,
    memorySpaceIds: Schema.optional(MemorySpaceIds),
    space: PublicId,
    strategy: Schema.Literals([
      "dense-open-search-ann-control-v1",
      "dense-exact-control-v1",
      "hybrid-rerank-v1",
      "hybrid-rrf-v1",
    ]),
  }),
]);

export const ResolveMemoryReviewRequest = Schema.Struct({
  content: Schema.optional(Schema.String),
  decision: Schema.Literals(["approve", "archive", "delete", "edit", "reject"]),
  reason: Schema.optional(Schema.String),
});

export const DeleteMemoryRequest = Schema.Struct({
  reason: Schema.optional(Schema.String),
});

export const RecordMemoryRetrievalFeedbackRequest = Schema.Struct({
  feedback: Schema.optional(Schema.String),
  usefulness: Schema.Literals(["harmful", "neutral", "useful"]),
});

export const EnqueueMemoryFlushRequest = Schema.Struct({
  memoryMode: Schema.optional(
    Schema.Literals(["agent", "off", "organization", "thread", "workspace"]),
  ),
  memorySpaceId: Schema.optional(PublicId),
  runId: PublicId,
});

export const MemoryObjectResponse = Schema.Record(Schema.String, Schema.Unknown);

export const MemoryPageResponse = Schema.Struct({
  items: Schema.Array(MemoryObjectResponse),
  nextCursor: Schema.optional(Cursor),
});

export const MEMORY_API_SCHEMAS = {
  ActiveMemoryRecallRequest,
  CreateMemorySpaceGrantRequest,
  CreateMemorySpaceRequest,
  DeleteMemoryRequest,
  EnqueueMemoryFlushRequest,
  ExportMemoriesRequest,
  ImportMemoriesRequest,
  MemoryContentListQuery,
  MemoryListQuery,
  MemoryObjectResponse,
  MemoryPageResponse,
  MemoryQualityQuery,
  MemoryReviewListQuery,
  MemorySpaceGrantListQuery,
  RecordMemoryRetrievalFeedbackRequest,
  ResolveMemoryReviewRequest,
  SearchMemoriesRequest,
  StrategySearchMemoriesRequest,
  UpdateMemorySpaceGrantRequest,
  UpsertMemoryPolicyRequest,
} as const;

type MemoryRouteInput = Omit<
  PublicApiRouteContract,
  "authentication" | "errors" | "idempotency" | "scopeHeaders" | "tag"
>;

const memoryErrors = [400, 401, 403, 404, 409, 429, 500, 502, 503, 504] as const;

function memoryRoute<const Contract extends MemoryRouteInput>(
  contract: Contract,
): PublicApiRouteContract & Contract {
  const idempotency = contract.method === "GET" ? ("none" as const) : ("optional" as const);
  return {
    authentication: "tenant-jwt" as const,
    errors: memoryErrors,
    idempotency,
    scopeHeaders: "optional-tenant" as const,
    tag: "Memory" as const,
    ...contract,
  };
}

const cursorParameter = {
  name: "cursor",
  schema: { maxLength: 4_096, minLength: 1, type: "string" },
} as const;

function limitParameter(maximum: number) {
  return {
    name: "limit",
    schema: { maximum, minimum: 1, type: "integer" },
  } as const;
}

const listQueryParameters = [cursorParameter, limitParameter(200)] as const;
const contentListQueryParameters = [cursorParameter, limitParameter(20)] as const;

export const MEMORY_API_ROUTES = [
  memoryRoute({
    method: "GET",
    name: "listMemorySpaces",
    path: "/v1/memory-spaces",
    queryParameters: listQueryParameters,
    requiredAuthorization: "memory:read",
    responseBody: "MemoryPageResponse",
    successStatus: 200,
  }),
  memoryRoute({
    method: "POST",
    name: "createMemorySpace",
    path: "/v1/memory-spaces",
    requestBody: "CreateMemorySpaceRequest",
    requiredAuthorization: "memory:admin",
    responseBody: "MemoryObjectResponse",
    successStatus: 201,
  }),
  memoryRoute({
    method: "GET",
    name: "getMemorySpace",
    path: "/v1/memory-spaces/:memorySpaceId",
    requiredAuthorization: "memory:read",
    responseBody: "MemoryObjectResponse",
    successStatus: 200,
  }),
  memoryRoute({
    method: "DELETE",
    name: "archiveMemorySpace",
    path: "/v1/memory-spaces/:memorySpaceId",
    requiredAuthorization: "memory:admin",
    responseBody: "MemoryObjectResponse",
    standing: "remediation",
    successStatus: 200,
  }),
  memoryRoute({
    method: "GET",
    name: "listMemoryPolicies",
    path: "/v1/memory/policies",
    queryParameters: listQueryParameters,
    requiredAuthorization: "memory:read",
    responseBody: "MemoryPageResponse",
    successStatus: 200,
  }),
  memoryRoute({
    method: "POST",
    name: "createMemoryPolicy",
    path: "/v1/memory/policies",
    requestBody: "UpsertMemoryPolicyRequest",
    requestBodyRequired: false,
    requiredAuthorization: "memory:admin",
    responseBody: "MemoryObjectResponse",
    successStatus: 201,
  }),
  memoryRoute({
    method: "PUT",
    name: "upsertMemoryPolicy",
    path: "/v1/memory/policies",
    requestBody: "UpsertMemoryPolicyRequest",
    requestBodyRequired: false,
    requiredAuthorization: "memory:admin",
    responseBody: "MemoryObjectResponse",
    successStatus: 200,
  }),
  memoryRoute({
    method: "GET",
    name: "listMemorySpaceGrants",
    path: "/v1/memory-space-grants",
    queryParameters: [
      ...listQueryParameters,
      {
        name: "agentDefinitionId",
        schema: { pattern: PUBLIC_ID_PATTERN_SOURCE, type: "string" },
      },
      {
        name: "memorySpaceId",
        schema: { pattern: PUBLIC_ID_PATTERN_SOURCE, type: "string" },
      },
      {
        name: "status",
        schema: { enum: ["active", "all", "revoked"], type: "string" },
      },
    ],
    requiredAuthorization: "memory:admin",
    responseBody: "MemoryPageResponse",
    successStatus: 200,
  }),
  memoryRoute({
    method: "POST",
    name: "createMemorySpaceGrant",
    path: "/v1/memory-space-grants",
    requestBody: "CreateMemorySpaceGrantRequest",
    requiredAuthorization: "memory:admin",
    responseBody: "MemoryObjectResponse",
    successStatus: 201,
  }),
  memoryRoute({
    method: "PATCH",
    name: "updateMemorySpaceGrant",
    path: "/v1/memory-space-grants/:grantId",
    requestBody: "UpdateMemorySpaceGrantRequest",
    requiredAuthorization: "memory:admin",
    responseBody: "MemoryObjectResponse",
    successStatus: 200,
  }),
  memoryRoute({
    method: "DELETE",
    name: "revokeMemorySpaceGrant",
    path: "/v1/memory-space-grants/:grantId",
    requiredAuthorization: "memory:admin",
    responseBody: "MemoryObjectResponse",
    standing: "remediation",
    successStatus: 200,
  }),
  memoryRoute({
    method: "POST",
    name: "importMemories",
    path: "/v1/memory/imports",
    requestBody: "ImportMemoriesRequest",
    requiredAuthorization: "memory:write",
    responseBody: "MemoryObjectResponse",
    successStatus: 201,
  }),
  memoryRoute({
    method: "POST",
    name: "exportMemories",
    path: "/v1/memory/exports",
    requestBody: "ExportMemoriesRequest",
    requiredAuthorization: "memory:admin",
    responseBody: "MemoryObjectResponse",
    standing: "read",
    successStatus: 200,
  }),
  memoryRoute({
    method: "GET",
    name: "listMemories",
    path: "/v1/memory",
    queryParameters: [
      ...contentListQueryParameters,
      {
        name: "space",
        schema: { pattern: PUBLIC_ID_PATTERN_SOURCE, type: "string" },
      },
      {
        name: "status",
        schema: { enum: ["active", "archived", "deleted"], type: "string" },
      },
    ],
    requiredAuthorization: "memory:admin",
    responseBody: "MemoryPageResponse",
    successStatus: 200,
  }),
  memoryRoute({
    method: "POST",
    name: "activeMemoryRecall",
    path: "/v1/memory/active-recall",
    requestBody: "ActiveMemoryRecallRequest",
    requiredAuthorization: "memory:execute",
    responseBody: "MemoryObjectResponse",
    successStatus: 200,
  }),
  memoryRoute({
    method: "POST",
    name: "searchMemories",
    path: "/v1/memory/search",
    requestBody: "SearchMemoriesRequest",
    requiredAuthorization: "memory:read",
    responseBody: "MemoryObjectResponse",
    standing: "read",
    successStatus: 200,
  }),
  memoryRoute({
    method: "POST",
    name: "strategySearchMemories",
    path: "/v1/memory/evidence/strategy-search",
    requestBody: "StrategySearchMemoriesRequest",
    requiredAuthorization: "memory:admin",
    responseBody: "MemoryObjectResponse",
    standing: "read",
    successStatus: 200,
  }),
  memoryRoute({
    method: "GET",
    name: "getMemoryNamespaceReadiness",
    path: "/v1/memory/namespaces/readiness",
    requiredAuthorization: "memory:admin",
    responseBody: "MemoryObjectResponse",
    successStatus: 200,
  }),
  memoryRoute({
    method: "POST",
    name: "prepareMemoryNamespaceFullText",
    path: "/v1/memory/namespaces/prepare-full-text",
    requiredAuthorization: "memory:admin",
    responseBody: "MemoryObjectResponse",
    successStatus: 202,
  }),
  memoryRoute({
    method: "GET",
    name: "getMemoryQuality",
    path: "/v1/memory/quality",
    queryParameters: [
      {
        name: "since",
        schema: { type: "string" },
      },
      limitParameter(5_000),
    ],
    requiredAuthorization: "memory:read",
    responseBody: "MemoryObjectResponse",
    successStatus: 200,
  }),
  memoryRoute({
    method: "GET",
    name: "listMemoryReviewItems",
    path: "/v1/memory/review-items",
    queryParameters: [
      ...listQueryParameters,
      {
        name: "status",
        schema: { enum: ["open", "resolved"], type: "string" },
      },
    ],
    requiredAuthorization: "memory:admin",
    responseBody: "MemoryPageResponse",
    successStatus: 200,
  }),
  memoryRoute({
    method: "POST",
    name: "resolveMemoryReview",
    path: "/v1/memory/:memoryId/review-items/:reviewId",
    requestBody: "ResolveMemoryReviewRequest",
    requiredAuthorization: "memory:admin",
    responseBody: "MemoryObjectResponse",
    successStatus: 200,
  }),
  memoryRoute({
    method: "POST",
    name: "archiveMemory",
    path: "/v1/memory/:memoryId/archive",
    requiredAuthorization: "memory:admin",
    responseBody: "MemoryObjectResponse",
    successStatus: 200,
  }),
  memoryRoute({
    method: "POST",
    name: "deleteMemory",
    path: "/v1/memory/:memoryId/delete",
    requestBody: "DeleteMemoryRequest",
    requestBodyRequired: false,
    requiredAuthorization: "memory:admin",
    responseBody: "MemoryObjectResponse",
    standing: "erasure",
    successStatus: 200,
  }),
  memoryRoute({
    method: "POST",
    name: "restoreMemory",
    path: "/v1/memory/:memoryId/restore",
    requiredAuthorization: "memory:admin",
    responseBody: "MemoryObjectResponse",
    successStatus: 200,
  }),
  memoryRoute({
    method: "POST",
    name: "recordMemoryRetrievalFeedback",
    path: "/v1/memory/:memoryId/retrievals/:retrievalId/feedback",
    requestBody: "RecordMemoryRetrievalFeedbackRequest",
    requiredAuthorization: "memory:write",
    responseBody: "MemoryObjectResponse",
    successStatus: 200,
  }),
  memoryRoute({
    method: "GET",
    name: "getMemoryFlush",
    path: "/v1/memory/flushes/:runId",
    requiredAuthorization: "memory:execute",
    responseBody: "MemoryObjectResponse",
    successStatus: 200,
  }),
  memoryRoute({
    method: "POST",
    name: "enqueueMemoryFlush",
    path: "/v1/memory/flushes",
    requestBody: "EnqueueMemoryFlushRequest",
    requiredAuthorization: "memory:execute",
    responseBody: "MemoryObjectResponse",
    successStatus: 202,
  }),
] as const satisfies readonly PublicApiRouteContract[];

export type MemoryApiSchemaName = keyof typeof MEMORY_API_SCHEMAS;
export type MemoryApiRouteName = (typeof MEMORY_API_ROUTES)[number]["name"];
