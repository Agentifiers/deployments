import type { PlatformContext, PlatformResponse, PlatformSdk } from "./index.ts";
export interface MemoryContext extends PlatformContext {
  readonly environmentId: string;
  readonly organizationId: string;
  readonly projectId: string;
}

export interface MemoryMutationOptions {
  readonly idempotencyKey?: string;
}

export interface MemoryDeleteOptions extends MemoryMutationOptions {
  readonly reason?: string;
}

export interface MemoryPaginationOptions {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface MemorySearchOptions {
  readonly signal?: AbortSignal;
}

export interface MemoryPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface MemorySpaceRecord {
  readonly data: {
    readonly description?: string;
    readonly id: string;
    readonly kind: "agent" | "organization" | "shared" | "workspace";
    readonly name: string;
    readonly retentionDays?: number;
    readonly status: "active" | "archived" | "disabled";
    readonly version: number;
    readonly workspaceId?: string;
  };
  readonly itemType: "memory-space";
}

export interface MemoryRecord {
  readonly data: {
    readonly body?: string;
    readonly contentHash: string;
    readonly entityKeys?: readonly string[];
    readonly id: string;
    readonly importance?: number;
    readonly memorySpaceId: string;
    readonly memoryType?: "episode" | "fact" | "preference" | "procedure" | "summary";
    readonly reviewStatus: "approved" | "pending" | "rejected" | "unreviewed";
    readonly scope: "agent" | "organization" | "thread" | "workspace";
    readonly searchKey: string;
    readonly sensitivity: "confidential" | "internal" | "public" | "restricted";
    readonly source: string;
    readonly sourceQuality?: number;
    readonly sourceRunId?: string;
    readonly status: "active" | "archived" | "deleted";
    readonly supersededByMemoryId?: string;
    readonly supersedesMemoryId?: string;
    readonly validFrom?: string;
    readonly validUntil?: string;
    readonly version: number;
  };
  readonly itemType: "memory";
}

export interface MemoryReviewItemRecord {
  readonly data: {
    readonly decision?: "approve" | "archive" | "delete" | "edit" | "reject";
    readonly id: string;
    readonly kind: string;
    readonly memoryId: string;
    readonly reason?: string;
    readonly resolutionReason?: string;
    readonly status: "open" | "resolved";
    readonly supersedesMemoryId?: string;
  };
  readonly itemType: "memory-review-item";
}

export interface MemorySpaceGrantRecord {
  readonly data: {
    readonly agentDefinitionId: string;
    readonly id: string;
    readonly memorySpaceId: string;
    readonly permission: "read" | "read-write";
    readonly revokedAt?: string;
    readonly version: number;
  };
  readonly itemType: "memory-space-grant";
}

export interface ImportMemoryRequest {
  readonly data: readonly {
    readonly agentDefinitionId?: string;
    readonly content: string;
    readonly entityKeys?: readonly string[];
    readonly idempotencyKey?: string;
    readonly importance?: number;
    readonly memoryType?: "episode" | "fact" | "preference" | "procedure" | "summary";
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly scope: "agent" | "organization" | "thread" | "workspace";
    readonly searchKey?: string;
    readonly sourceQuality?: number;
    readonly supersedesMemoryId?: string;
    readonly threadId?: string;
    readonly workspaceId?: string;
    readonly validFrom?: string;
    readonly validUntil?: string;
  }[];
  readonly space: string;
}

export interface SearchMemoryRequest {
  readonly memorySpaceIds: readonly string[];
  readonly query: string;
  readonly searchKeys?: readonly string[];
  readonly topK?: number;
}

export interface StrategyEvidenceSearchRequest extends SearchMemoryRequest {
  readonly strategy:
    | "dense-open-search-ann-control-v1"
    | "dense-exact-control-v1"
    | "hybrid-rerank-v1"
    | "hybrid-rrf-v1";
}

export interface MemorySdk {
  readonly evidence: {
    readonly strategySearch: (
      input: StrategyEvidenceSearchRequest,
      options?: MemorySearchOptions,
    ) => Promise<PlatformResponse<unknown>>;
  };
  readonly namespace: {
    readonly prepareFullText: () => Promise<PlatformResponse<unknown>>;
    readonly readiness: () => Promise<PlatformResponse<unknown>>;
  };
  readonly spaces: {
    create(
      input: {
        readonly description?: string;
        readonly kind?: MemorySpaceRecord["data"]["kind"];
        readonly name: string;
        readonly retentionDays?: number;
        readonly workspaceId?: string;
      },
      options?: MemoryMutationOptions,
    ): Promise<PlatformResponse<MemorySpaceRecord>>;
    list(
      options?: MemoryPaginationOptions,
    ): Promise<PlatformResponse<MemoryPage<MemorySpaceRecord>>>;
    get(memorySpaceId: string): Promise<PlatformResponse<MemorySpaceRecord>>;
    archive(
      memorySpaceId: string,
      options?: MemoryMutationOptions,
    ): Promise<PlatformResponse<MemorySpaceRecord>>;
  };
  readonly memories: {
    import(
      input: ImportMemoryRequest,
      options?: MemoryMutationOptions,
    ): Promise<PlatformResponse<unknown>>;
    export(
      space: string,
      format?: "json",
      options?: MemoryPaginationOptions,
    ): Promise<PlatformResponse<unknown>>;
    list(
      options?: MemoryPaginationOptions & {
        readonly space?: string;
        readonly status?: MemoryRecord["data"]["status"];
      },
    ): Promise<PlatformResponse<MemoryPage<MemoryRecord>>>;
    search(
      input: SearchMemoryRequest,
      options?: MemorySearchOptions,
    ): Promise<PlatformResponse<unknown>>;
    archive(
      memoryId: string,
      options?: MemoryMutationOptions,
    ): Promise<PlatformResponse<MemoryRecord>>;
    restore(
      memoryId: string,
      options?: MemoryMutationOptions,
    ): Promise<PlatformResponse<MemoryRecord>>;
    delete(
      memoryId: string,
      options?: MemoryDeleteOptions,
    ): Promise<PlatformResponse<MemoryRecord>>;
  };
  readonly recall: {
    active(input: {
      readonly query: string;
      readonly runId: string;
      readonly topK?: number;
    }): Promise<PlatformResponse<unknown>>;
  };
  readonly grants: {
    list(
      options?: MemoryPaginationOptions & {
        readonly agentDefinitionId?: string;
        readonly memorySpaceId?: string;
        readonly status?: "active" | "all" | "revoked";
      },
    ): Promise<PlatformResponse<MemoryPage<MemorySpaceGrantRecord>>>;
    create(
      input: {
        readonly agentDefinitionId: string;
        readonly memorySpaceId: string;
        readonly permission: MemorySpaceGrantRecord["data"]["permission"];
      },
      options?: MemoryMutationOptions,
    ): Promise<PlatformResponse<MemorySpaceGrantRecord>>;
    update(
      grantId: string,
      permission: MemorySpaceGrantRecord["data"]["permission"],
      options?: MemoryMutationOptions,
    ): Promise<PlatformResponse<MemorySpaceGrantRecord>>;
    revoke(
      grantId: string,
      options?: MemoryMutationOptions,
    ): Promise<PlatformResponse<MemorySpaceGrantRecord>>;
  };
  readonly reviews: {
    list(
      status?: "open" | "resolved",
      options?: MemoryPaginationOptions,
    ): Promise<PlatformResponse<MemoryPage<MemoryReviewItemRecord>>>;
    resolve(
      memoryId: string,
      reviewId: string,
      input: {
        readonly content?: string;
        readonly decision: "approve" | "archive" | "delete" | "edit" | "reject";
        readonly reason?: string;
      },
      options?: MemoryMutationOptions,
    ): Promise<PlatformResponse<unknown>>;
  };
  readonly policy: {
    list(options?: MemoryPaginationOptions): Promise<PlatformResponse<MemoryPage<unknown>>>;
    create(
      input: Readonly<Record<string, unknown>>,
      options?: MemoryMutationOptions,
    ): Promise<PlatformResponse<unknown>>;
    upsert(
      input: Readonly<Record<string, unknown>>,
      options?: MemoryMutationOptions,
    ): Promise<PlatformResponse<unknown>>;
  };
  readonly quality: {
    get(since?: string, limit?: number): Promise<PlatformResponse<unknown>>;
    feedback(
      memoryId: string,
      retrievalId: string,
      input: { readonly feedback?: string; readonly usefulness: "harmful" | "neutral" | "useful" },
      options?: MemoryMutationOptions,
    ): Promise<PlatformResponse<unknown>>;
  };
  readonly flushes: {
    get(runId: string): Promise<PlatformResponse<unknown>>;
    enqueue(
      input: {
        readonly memoryMode?: string;
        readonly memorySpaceId?: string;
        readonly runId: string;
      },
      options?: MemoryMutationOptions,
    ): Promise<PlatformResponse<unknown>>;
  };
}

function mutation(options: MemoryMutationOptions | undefined) {
  return options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {};
}

export function createMemorySdk(sdk: PlatformSdk, context: MemoryContext): MemorySdk {
  const request = <T>(input: Parameters<PlatformSdk["request"]>[0]) =>
    sdk.request<T>({ ...input, context });
  return {
    evidence: {
      strategySearch: (body, options) =>
        request({
          method: "POST",
          path: "/v1/memory/evidence/strategy-search",
          body,
          ...(options?.signal ? { signal: options.signal } : {}),
        }),
    },
    namespace: {
      prepareFullText: () =>
        request({ method: "POST", path: "/v1/memory/namespaces/prepare-full-text" }),
      readiness: () => request({ method: "GET", path: "/v1/memory/namespaces/readiness" }),
    },
    spaces: {
      create: (body, options) =>
        request({ method: "POST", path: "/v1/memory-spaces", body, ...mutation(options) }),
      list: (options = {}) =>
        request({
          method: "GET",
          path: "/v1/memory-spaces",
          query: { cursor: options.cursor, limit: options.limit },
        }),
      get: (id) => request({ method: "GET", path: `/v1/memory-spaces/${encodeURIComponent(id)}` }),
      archive: (id, options) =>
        request({
          method: "DELETE",
          path: `/v1/memory-spaces/${encodeURIComponent(id)}`,
          ...mutation(options),
        }),
    },
    memories: {
      import: (body, options) =>
        request({ method: "POST", path: "/v1/memory/imports", body, ...mutation(options) }),
      export: (space, format, options = {}) =>
        request({
          method: "POST",
          path: "/v1/memory/exports",
          body: { space, ...(format ? { format } : {}), ...options },
        }),
      list: (options = {}) =>
        request({
          method: "GET",
          path: "/v1/memory",
          query: {
            cursor: options.cursor,
            limit: options.limit,
            space: options.space,
            status: options.status,
          },
        }),
      search: (body, options) =>
        request({
          method: "POST",
          path: "/v1/memory/search",
          body,
          ...(options?.signal ? { signal: options.signal } : {}),
        }),
      archive: (id, options) =>
        request({
          method: "POST",
          path: `/v1/memory/${encodeURIComponent(id)}/archive`,
          ...mutation(options),
        }),
      restore: (id, options) =>
        request({
          method: "POST",
          path: `/v1/memory/${encodeURIComponent(id)}/restore`,
          ...mutation(options),
        }),
      delete: (id, options) =>
        request({
          method: "POST",
          path: `/v1/memory/${encodeURIComponent(id)}/delete`,
          ...(options?.reason === undefined ? {} : { body: { reason: options.reason } }),
          ...mutation(options),
        }),
    },
    recall: {
      active: (body) => request({ method: "POST", path: "/v1/memory/active-recall", body }),
    },
    grants: {
      list: (options = {}) =>
        request({
          method: "GET",
          path: "/v1/memory-space-grants",
          query: {
            agentDefinitionId: options.agentDefinitionId,
            cursor: options.cursor,
            limit: options.limit,
            memorySpaceId: options.memorySpaceId,
            status: options.status,
          },
        }),
      create: (body, options) =>
        request({
          method: "POST",
          path: "/v1/memory-space-grants",
          body,
          ...mutation(options),
        }),
      update: (grantId, permission, options) =>
        request({
          method: "PATCH",
          path: `/v1/memory-space-grants/${encodeURIComponent(grantId)}`,
          body: { permission },
          ...mutation(options),
        }),
      revoke: (grantId, options) =>
        request({
          method: "DELETE",
          path: `/v1/memory-space-grants/${encodeURIComponent(grantId)}`,
          ...mutation(options),
        }),
    },
    reviews: {
      list: (status, options = {}) =>
        request({
          method: "GET",
          path: "/v1/memory/review-items",
          query: { cursor: options.cursor, limit: options.limit, status },
        }),
      resolve: (memoryId, reviewId, body, options) =>
        request({
          method: "POST",
          path: `/v1/memory/${encodeURIComponent(memoryId)}/review-items/${encodeURIComponent(reviewId)}`,
          body,
          ...mutation(options),
        }),
    },
    policy: {
      list: (options = {}) =>
        request({
          method: "GET",
          path: "/v1/memory/policies",
          query: { cursor: options.cursor, limit: options.limit },
        }),
      create: (body, options) =>
        request({ method: "POST", path: "/v1/memory/policies", body, ...mutation(options) }),
      upsert: (body, options) =>
        request({ method: "PUT", path: "/v1/memory/policies", body, ...mutation(options) }),
    },
    quality: {
      get: (since, limit) =>
        request({ method: "GET", path: "/v1/memory/quality", query: { limit, since } }),
      feedback: (memoryId, retrievalId, body, options) =>
        request({
          method: "POST",
          path: `/v1/memory/${encodeURIComponent(memoryId)}/retrievals/${encodeURIComponent(retrievalId)}/feedback`,
          body,
          ...mutation(options),
        }),
    },
    flushes: {
      get: (runId) =>
        request({ method: "GET", path: `/v1/memory/flushes/${encodeURIComponent(runId)}` }),
      enqueue: (body, options) =>
        request({ method: "POST", path: "/v1/memory/flushes", body, ...mutation(options) }),
    },
  };
}
