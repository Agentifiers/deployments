import "@tanstack/react-start/server-only";
import {
  decodeExportedMemory,
  decodeFeedback,
  decodeGrant,
  decodeImport,
  decodeMemory,
  decodePage,
  decodePolicy,
  decodeResolution,
  decodeSearch,
  decodeSpace,
} from "../memory/decode.ts";
import {
  MEMORY_EXPORT_LIMIT,
  MEMORY_PAGE_LIMIT,
  type GrantPermission,
  type ImportOutcome,
  type LifecycleAction,
  type Memory,
  type MemoryExport,
  type MemoryPolicy,
  type MemoryReviewItem,
  type MemorySearchResult,
  type MemorySpace,
  type MemorySpaceGrant,
  type RetrievalFeedback,
  type SearchRequest,
  type Usefulness,
} from "../memory/model.ts";
import { collectPagesUpTo } from "../overview/status-counts.ts";
import type { EnvironmentScope } from "../scope.ts";
import { memoryView } from "./memory-data.ts";
import { callRoute as platformCallRoute } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

export type CallRoute = typeof platformCallRoute;

interface MemoryMutation {
  readonly accessToken: string;
  readonly idempotencyKey: string;
  readonly scope: EnvironmentScope;
}

export async function createSpace(
  { accessToken, body, idempotencyKey, scope }: MemoryMutation & { readonly body: unknown },
  callRoute: CallRoute = platformCallRoute,
): Promise<MemorySpace> {
  const request = decodeRequestBody("createMemorySpace", "CreateMemorySpaceRequest", body);
  return memoryView(
    "createMemorySpace",
    decodeSpace,
    await callRoute("createMemorySpace", { body: request, idempotencyKey, scope }, accessToken),
  );
}

export async function archiveSpace(
  {
    accessToken,
    idempotencyKey,
    memorySpaceId,
    scope,
  }: MemoryMutation & { readonly memorySpaceId: string },
  callRoute: CallRoute = platformCallRoute,
): Promise<MemorySpace> {
  return memoryView(
    "archiveMemorySpace",
    decodeSpace,
    await callRoute(
      "archiveMemorySpace",
      { idempotencyKey, path: { memorySpaceId }, scope },
      accessToken,
    ),
  );
}

export async function createPolicy(
  { accessToken, body, idempotencyKey, scope }: MemoryMutation & { readonly body: unknown },
  callRoute: CallRoute = platformCallRoute,
): Promise<MemoryPolicy> {
  const request = decodeRequestBody("createMemoryPolicy", "UpsertMemoryPolicyRequest", body);
  return memoryView(
    "createMemoryPolicy",
    decodePolicy,
    await callRoute("createMemoryPolicy", { body: request, idempotencyKey, scope }, accessToken),
  );
}

export async function updatePolicy(
  {
    accessToken,
    body,
    idempotencyKey,
    policyId,
    scope,
  }: MemoryMutation & {
    readonly body: Readonly<Record<string, unknown>>;
    readonly policyId: string;
  },
  callRoute: CallRoute = platformCallRoute,
): Promise<MemoryPolicy> {
  const request = decodeRequestBody("upsertMemoryPolicy", "UpsertMemoryPolicyRequest", {
    ...body,
    id: policyId,
  });
  return memoryView(
    "upsertMemoryPolicy",
    decodePolicy,
    await callRoute("upsertMemoryPolicy", { body: request, idempotencyKey, scope }, accessToken),
  );
}

export async function createGrant(
  { accessToken, body, idempotencyKey, scope }: MemoryMutation & { readonly body: unknown },
  callRoute: CallRoute = platformCallRoute,
): Promise<MemorySpaceGrant> {
  const request = decodeRequestBody(
    "createMemorySpaceGrant",
    "CreateMemorySpaceGrantRequest",
    body,
  );
  return memoryView(
    "createMemorySpaceGrant",
    decodeGrant,
    await callRoute(
      "createMemorySpaceGrant",
      { body: request, idempotencyKey, scope },
      accessToken,
    ),
  );
}

export async function updateGrant(
  {
    accessToken,
    grantId,
    idempotencyKey,
    permission,
    scope,
  }: MemoryMutation & { readonly grantId: string; readonly permission: GrantPermission },
  callRoute: CallRoute = platformCallRoute,
): Promise<MemorySpaceGrant> {
  return memoryView(
    "updateMemorySpaceGrant",
    decodeGrant,
    await callRoute(
      "updateMemorySpaceGrant",
      { body: { permission }, idempotencyKey, path: { grantId }, scope },
      accessToken,
    ),
  );
}

export async function revokeGrant(
  { accessToken, grantId, idempotencyKey, scope }: MemoryMutation & { readonly grantId: string },
  callRoute: CallRoute = platformCallRoute,
): Promise<MemorySpaceGrant> {
  return memoryView(
    "revokeMemorySpaceGrant",
    decodeGrant,
    await callRoute(
      "revokeMemorySpaceGrant",
      { idempotencyKey, path: { grantId }, scope },
      accessToken,
    ),
  );
}

export async function importMemories(
  { accessToken, body, idempotencyKey, scope }: MemoryMutation & { readonly body: unknown },
  callRoute: CallRoute = platformCallRoute,
): Promise<ImportOutcome> {
  const request = decodeRequestBody("importMemories", "ImportMemoriesRequest", body);
  return memoryView(
    "importMemories",
    decodeImport,
    await callRoute("importMemories", { body: request, idempotencyKey, scope }, accessToken),
  );
}

const decodeExportPage = decodePage(decodeExportedMemory);

export async function exportSpace(
  {
    accessToken,
    memorySpaceId,
    scope,
  }: {
    readonly accessToken: string;
    readonly memorySpaceId: string;
    readonly scope: EnvironmentScope;
  },
  callRoute: CallRoute = platformCallRoute,
): Promise<MemoryExport> {
  const { complete, items } = await collectPagesUpTo(
    async (cursor) =>
      memoryView(
        "exportMemories",
        decodeExportPage,
        await callRoute(
          "exportMemories",
          {
            body: decodeRequestBody("exportMemories", "ExportMemoriesRequest", {
              ...(cursor === undefined ? {} : { cursor }),
              limit: MEMORY_PAGE_LIMIT,
              memorySpaceId,
            }),
            scope,
          },
          accessToken,
        ),
      ),
    MEMORY_EXPORT_LIMIT / MEMORY_PAGE_LIMIT,
  );
  return { complete, memories: items };
}

export async function changeLifecycle(
  {
    accessToken,
    action,
    idempotencyKey,
    memoryId,
    reason,
    scope,
  }: MemoryMutation & {
    readonly action: LifecycleAction;
    readonly memoryId: string;
    readonly reason?: string;
  },
  callRoute: CallRoute = platformCallRoute,
): Promise<Memory> {
  const path = { memoryId };
  switch (action) {
    case "archive":
      return memoryView(
        "archiveMemory",
        decodeMemory,
        await callRoute("archiveMemory", { idempotencyKey, path, scope }, accessToken),
      );
    case "restore":
      return memoryView(
        "restoreMemory",
        decodeMemory,
        await callRoute("restoreMemory", { idempotencyKey, path, scope }, accessToken),
      );
    case "delete":
      return memoryView(
        "deleteMemory",
        decodeMemory,
        await callRoute(
          "deleteMemory",
          { body: reason === undefined ? {} : { reason }, idempotencyKey, path, scope },
          accessToken,
        ),
      );
  }
}

export async function resolveReview(
  {
    accessToken,
    body,
    idempotencyKey,
    memoryId,
    reviewId,
    scope,
  }: MemoryMutation & {
    readonly body: unknown;
    readonly memoryId: string;
    readonly reviewId: string;
  },
  callRoute: CallRoute = platformCallRoute,
): Promise<{ readonly memory: Memory; readonly review: MemoryReviewItem }> {
  const request = decodeRequestBody("resolveMemoryReview", "ResolveMemoryReviewRequest", body);
  return memoryView(
    "resolveMemoryReview",
    decodeResolution,
    await callRoute(
      "resolveMemoryReview",
      { body: request, idempotencyKey, path: { memoryId, reviewId }, scope },
      accessToken,
    ),
  );
}

export async function searchMemories(
  {
    accessToken,
    request,
    scope,
  }: {
    readonly accessToken: string;
    readonly request: { readonly body: unknown; readonly kind: SearchRequest["kind"] };
    readonly scope: EnvironmentScope;
  },
  callRoute: CallRoute = platformCallRoute,
): Promise<MemorySearchResult> {
  switch (request.kind) {
    case "policy": {
      const body = decodeRequestBody("searchMemories", "SearchMemoriesRequest", request.body);
      return memoryView(
        "searchMemories",
        decodeSearch,
        await callRoute("searchMemories", { body, scope }, accessToken),
      );
    }
    case "strategy": {
      const body = decodeRequestBody(
        "strategySearchMemories",
        "StrategySearchMemoriesRequest",
        request.body,
      );
      return memoryView(
        "strategySearchMemories",
        decodeSearch,
        await callRoute("strategySearchMemories", { body, scope }, accessToken),
      );
    }
  }
}

export async function recordFeedback(
  {
    accessToken,
    idempotencyKey,
    memoryId,
    retrievalId,
    scope,
    usefulness,
  }: MemoryMutation & {
    readonly memoryId: string;
    readonly retrievalId: string;
    readonly usefulness: Usefulness;
  },
  callRoute: CallRoute = platformCallRoute,
): Promise<RetrievalFeedback> {
  return memoryView(
    "recordMemoryRetrievalFeedback",
    decodeFeedback,
    await callRoute(
      "recordMemoryRetrievalFeedback",
      { body: { usefulness }, idempotencyKey, path: { memoryId, retrievalId }, scope },
      accessToken,
    ),
  );
}
