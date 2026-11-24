import { MEMORY_API_ROUTES } from "@deployments-ai/api-contract/memory";
import { MAX_PERSISTED_RETRIEVALS, type MemoryPlatform } from "@deployments-ai/memory";
import {
  apiRequestClassifier,
  makeOrganizationGateFromEnvironment,
  organizationRefusalResult,
  type OrganizationGate,
} from "@deployments-ai/organization-admission";
import {
  MAX_SEARCH_KEY_COUNT,
  MAX_SEARCH_SPACE_COUNT,
  MemoryApiError,
  authorize,
  authorizeRun,
  derivedImportIdempotencyKey,
  importItems,
  memoryPaginationInput,
  mutationIdempotencyKey,
  oneOf,
  optionalBoolean,
  optionalLimit,
  optionalNumber,
  optionalOneOf,
  optionalQualityLimit,
  optionalRecord,
  optionalUlid,
  paginationInput,
  parseBody,
  problem,
  platformScopeAuthorizer,
  required,
  response,
  routePath,
  scope,
  stringArray,
  ulid,
  type MemoryApiEvent,
} from "./api-support.ts";
import { runtimeDatabase, runtimeDocumentClient, runtimeMemoryPlatform } from "./runtime.ts";
import { authenticateMemoryApiEvent } from "./api-auth.ts";
export type { MemoryApiEvent } from "./api-support.ts";

let defaultPlatformScopeAuthorizer: ReturnType<typeof platformScopeAuthorizer> | undefined;
let defaultOrganizationGate: OrganizationGate | undefined;
const classifyMemoryRequest = apiRequestClassifier(MEMORY_API_ROUTES);

function authorizeRuntimePlatformScope(
  input: Parameters<ReturnType<typeof platformScopeAuthorizer>>[0],
) {
  defaultPlatformScopeAuthorizer ??= platformScopeAuthorizer(runtimeDatabase());
  return defaultPlatformScopeAuthorizer(input);
}

export async function handleMemoryApi(
  event: MemoryApiEvent,
  dependencies: {
    readonly authorizePlatformScope?: Parameters<typeof scope>[1];
    readonly platform?: MemoryPlatform;
    readonly organizationGate?: OrganizationGate;
  } = {},
) {
  const requestId = event.requestContext?.requestId ?? crypto.randomUUID();
  try {
    const tenant = await scope(
      event,
      dependencies.authorizePlatformScope ?? authorizeRuntimePlatformScope,
    );
    const method = event.requestContext?.http?.method?.toUpperCase() ?? "GET";
    const path = routePath(event);
    const decision = await dependencies.organizationGate?.admit(
      tenant.organizationId,
      classifyMemoryRequest(method, path),
    );
    if (decision && decision.kind !== "admitted") {
      return organizationRefusalResult(decision, requestId);
    }
    authorize(event, path, method, tenant);
    const platform = dependencies.platform ?? (await runtimeMemoryPlatform());
    const query = event.queryStringParameters ?? {};
    const body = method === "GET" ? {} : parseBody(event);
    const idempotencyKey = method === "GET" ? undefined : mutationIdempotencyKey(event, tenant);

    if (path === "/v1/memory-spaces" && method === "POST") {
      if (body.policy !== undefined) {
        throw new MemoryApiError(
          400,
          "unsupported_field",
          "Memory-space policy must be configured through /v1/memory/policies.",
        );
      }
      const retentionDays = optionalNumber(body.retentionDays, "retentionDays");
      const workspaceId = optionalUlid(body.workspaceId, "workspaceId");
      return response(
        201,
        await platform.createMemorySpace(tenant, {
          ...(typeof body.description === "string" ? { description: body.description } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(body.kind === undefined
            ? {}
            : {
                kind: oneOf(body.kind, "kind", ["agent", "organization", "shared", "workspace"]),
              }),
          name: required(body.name, "name"),
          ...(retentionDays === undefined ? {} : { retentionDays }),
          ...(workspaceId ? { workspaceId } : {}),
        }),
        requestId,
      );
    }
    if (path === "/v1/memory-spaces" && method === "GET") {
      return response(
        200,
        await platform.listMemorySpacesPage(tenant, {
          ...paginationInput(query.cursor, query.limit),
        }),
        requestId,
      );
    }
    const spaceMatch = path.match(/^\/v1\/memory-spaces\/([^/]+)$/u);
    if (spaceMatch && method === "GET") {
      return response(
        200,
        await platform.requiredSpace(tenant, ulid(spaceMatch[1], "memorySpaceId")),
        requestId,
      );
    }
    if (spaceMatch && method === "DELETE") {
      return response(
        200,
        await platform.archiveMemorySpace(
          tenant,
          ulid(spaceMatch[1], "memorySpaceId"),
          idempotencyKey ? { idempotencyKey } : {},
        ),
        requestId,
      );
    }
    if (path === "/v1/memory/policies" && method === "GET") {
      return response(
        200,
        await platform.listPoliciesPage(tenant, {
          ...paginationInput(query.cursor, query.limit),
        }),
        requestId,
      );
    }
    if (path === "/v1/memory/policies" && (method === "POST" || method === "PUT")) {
      const requestedActiveRecall = optionalBoolean(
        body.activeRecallEnabled,
        "activeRecallEnabled",
      );
      const activeRecallRolloutPercent = optionalNumber(
        body.activeRecallRolloutPercent,
        "activeRecallRolloutPercent",
      );
      const processingConfig = optionalRecord(body.processingConfig, "processingConfig");
      const retentionDays = optionalNumber(body.retentionDays, "retentionDays");
      const policyId = optionalUlid(body.id, "id");
      const workspaceId = optionalUlid(body.workspaceId, "workspaceId");
      return response(
        method === "POST" ? 201 : 200,
        await platform.upsertPolicy(tenant, {
          ...(requestedActiveRecall === undefined
            ? {}
            : { activeRecallEnabled: requestedActiveRecall }),
          ...(activeRecallRolloutPercent === undefined ? {} : { activeRecallRolloutPercent }),
          ...(method === "POST" ? { createOnly: true } : {}),
          ...(policyId ? { id: policyId } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(processingConfig === undefined ? {} : { processingConfig }),
          ...(retentionDays === undefined ? {} : { retentionDays }),
          ...(body.scope === undefined
            ? {}
            : {
                scope: oneOf(body.scope, "scope", ["environment", "organization", "workspace"]),
              }),
          ...(body.sensitivityMode === undefined
            ? {}
            : {
                sensitivityMode: oneOf(body.sensitivityMode, "sensitivityMode", [
                  "restricted",
                  "standard",
                  "strict",
                ]),
              }),
          ...(workspaceId ? { workspaceId } : {}),
        }),
        requestId,
      );
    }
    if (path === "/v1/memory-space-grants" && method === "POST") {
      return response(
        201,
        await platform.grantMemorySpace(tenant, {
          agentDefinitionId: ulid(body.agentDefinitionId, "agentDefinitionId"),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          memorySpaceId: ulid(body.memorySpaceId, "memorySpaceId"),
          permission: oneOf(body.permission, "permission", ["read", "read-write"]),
        }),
        requestId,
      );
    }
    if (path === "/v1/memory-space-grants" && method === "GET") {
      const agentDefinitionId = optionalUlid(query.agentDefinitionId, "agentDefinitionId");
      const memorySpaceId = optionalUlid(query.memorySpaceId, "memorySpaceId");
      const status = optionalOneOf(query.status, "status", ["active", "all", "revoked"]);
      return response(
        200,
        await platform.listMemorySpaceGrantsPage(tenant, {
          ...paginationInput(query.cursor, query.limit),
          ...(agentDefinitionId ? { agentDefinitionId } : {}),
          ...(memorySpaceId ? { memorySpaceId } : {}),
          ...(status ? { status } : {}),
        }),
        requestId,
      );
    }
    const grantMatch = path.match(/^\/v1\/memory-space-grants\/([^/]+)$/u);
    if (grantMatch && method === "PATCH") {
      return response(
        200,
        await platform.updateMemorySpaceGrant(tenant, ulid(grantMatch[1], "grantId"), {
          ...(idempotencyKey ? { idempotencyKey } : {}),
          permission: oneOf(body.permission, "permission", ["read", "read-write"]),
        }),
        requestId,
      );
    }
    if (grantMatch && method === "DELETE") {
      return response(
        200,
        await platform.revokeMemorySpaceGrant(
          tenant,
          ulid(grantMatch[1], "grantId"),
          idempotencyKey ? { idempotencyKey } : {},
        ),
        requestId,
      );
    }
    if (path === "/v1/memory/imports" && method === "POST") {
      return response(
        201,
        await platform.importMemories(tenant, {
          items: importItems(body.data).map((item, index) => ({
            ...item,
            ...(item.idempotencyKey
              ? {}
              : idempotencyKey
                ? { idempotencyKey: derivedImportIdempotencyKey(idempotencyKey, index) }
                : {}),
            source: "api",
          })),
          memorySpaceId: ulid(body.space ?? body.memorySpaceId, "space"),
        }),
        requestId,
      );
    }
    if (path === "/v1/memory/exports" && method === "POST") {
      const format = body.format === undefined ? "json" : oneOf(body.format, "format", ["json"]);
      const page = await platform.exportMemoriesPage(tenant, {
        ...memoryPaginationInput(body.cursor, body.limit),
        memorySpaceId: ulid(body.space ?? body.memorySpaceId, "space"),
      });
      return response(
        200,
        {
          format,
          ...page,
        },
        requestId,
      );
    }
    if (path === "/v1/memory" && method === "GET") {
      return response(
        200,
        await platform.listMemoriesPage(tenant, {
          ...memoryPaginationInput(query.cursor, query.limit),
          ...(query.space ? { memorySpaceId: ulid(query.space, "space") } : {}),
          ...(query.status
            ? {
                status: oneOf(query.status, "status", ["active", "archived", "deleted"]),
              }
            : {}),
        }),
        requestId,
      );
    }
    if (path === "/v1/memory/active-recall" && method === "POST") {
      const runId = ulid(body.runId, "runId");
      authorizeRun(event, runId, tenant);
      const topK = optionalLimit(body.topK, "topK", MAX_PERSISTED_RETRIEVALS);
      const access = await platform.memoryAccessForRun(tenant, runId);
      if (tenant.workspaceId && access.run.data.workspaceId !== tenant.workspaceId) {
        throw new MemoryApiError(404, "run_not_found", "Run was not found.");
      }
      const { workspaceId: _claimedWorkspaceId, ...tenantScope } = tenant;
      return response(
        200,
        await platform.search(
          {
            ...tenantScope,
            ...(access.run.data.workspaceId ? { workspaceId: access.run.data.workspaceId } : {}),
          },
          {
            allowedScopeKeys: access.searchKeys,
            memorySpaceIds: access.readMemorySpaceIds,
            observability: {
              captureMode: access.run.data.captureMode,
              ...(access.run.data.parentSpanId
                ? { parentSpanId: access.run.data.parentSpanId }
                : {}),
              runSpanId: access.run.data.spanId,
              sessionId: access.run.data.threadId,
              traceId: access.run.data.traceId,
              ...(access.run.data.workspaceId ? { workspaceId: access.run.data.workspaceId } : {}),
            },
            purpose: "active-recall",
            query: required(body.query, "query"),
            runId,
            searchKeys: access.searchKeys,
            threadId: access.run.data.threadId,
            ...(topK === undefined ? {} : { topK }),
          },
        ),
        requestId,
      );
    }
    if (path === "/v1/memory/search" && method === "POST") {
      if (body.purpose !== undefined || body.runId !== undefined) {
        throw new MemoryApiError(
          400,
          "unsupported_field",
          "Public memory search does not accept purpose or runId attribution.",
        );
      }
      const memorySpaceIds = [
        ...new Set(
          stringArray(
            body.memorySpaceIds ?? [body.space],
            "memorySpaceIds",
            MAX_SEARCH_SPACE_COUNT,
          ).map((id) => ulid(id, "memorySpaceId")),
        ),
      ];
      if (memorySpaceIds.length === 0) {
        throw new MemoryApiError(
          400,
          "memory_space_required",
          "At least one memory space is required.",
        );
      }
      if (memorySpaceIds.length > MAX_SEARCH_SPACE_COUNT) {
        throw new MemoryApiError(
          400,
          "too_many_memory_spaces",
          `Memory searches accept at most ${MAX_SEARCH_SPACE_COUNT} memory spaces.`,
        );
      }
      return response(
        200,
        await platform.search(tenant, {
          memorySpaceIds,
          query: required(body.query, "query"),
          ...(body.searchKeys !== undefined
            ? {
                searchKeys: stringArray(body.searchKeys, "searchKeys", MAX_SEARCH_KEY_COUNT).map(
                  (value, index) => required(value, `searchKeys[${index}]`),
                ),
              }
            : {}),
          topK: optionalLimit(body.topK, "topK", MAX_PERSISTED_RETRIEVALS) ?? 10,
        }),
        requestId,
      );
    }
    if (path === "/v1/memory/evidence/strategy-search" && method === "POST") {
      const memorySpaceIds = [
        ...new Set(
          stringArray(
            body.memorySpaceIds ?? [body.space],
            "memorySpaceIds",
            MAX_SEARCH_SPACE_COUNT,
          ).map((id) => ulid(id, "memorySpaceId")),
        ),
      ];
      if (memorySpaceIds.length === 0) {
        throw new MemoryApiError(
          400,
          "memory_space_required",
          "At least one memory space is required.",
        );
      }
      const strategy = required(body.strategy, "strategy");
      if (
        strategy !== "dense-open-search-ann-control-v1" &&
        strategy !== "dense-exact-control-v1" &&
        strategy !== "hybrid-rerank-v1" &&
        strategy !== "hybrid-rrf-v1"
      ) {
        throw new MemoryApiError(
          400,
          "invalid_strategy",
          "strategy must be dense-open-search-ann-control-v1, dense-exact-control-v1, hybrid-rerank-v1, or hybrid-rrf-v1.",
        );
      }
      return response(
        200,
        await platform.search(tenant, {
          memorySpaceIds,
          query: required(body.query, "query"),
          ...(body.searchKeys !== undefined
            ? {
                searchKeys: stringArray(body.searchKeys, "searchKeys", MAX_SEARCH_KEY_COUNT).map(
                  (value, index) => required(value, `searchKeys[${index}]`),
                ),
              }
            : {}),
          ...(strategy === "dense-open-search-ann-control-v1"
            ? { comparisonPurpose: "quality" as const, denseAnnControl: true }
            : strategy === "dense-exact-control-v1"
              ? { comparisonPurpose: "quality" as const, denseExactControl: true }
              : {}),
          strategyOverride:
            strategy === "dense-open-search-ann-control-v1" || strategy === "dense-exact-control-v1"
              ? "dense-v1"
              : strategy,
          topK: optionalLimit(body.topK, "topK", MAX_PERSISTED_RETRIEVALS) ?? 10,
        }),
        requestId,
      );
    }
    if (path === "/v1/memory/namespaces/readiness" && method === "GET") {
      return response(200, await platform.namespaceReadiness(tenant), requestId);
    }
    if (path === "/v1/memory/namespaces/prepare-full-text" && method === "POST") {
      return response(202, await platform.prepareNamespaceFullText(tenant), requestId);
    }
    if (path === "/v1/memory/quality" && method === "GET") {
      if (query.space !== undefined) {
        throw new MemoryApiError(
          400,
          "unsupported_filter",
          "Memory quality does not support memory-space filtering.",
        );
      }
      const limit = optionalQualityLimit(query.limit);
      return response(
        200,
        await platform.quality(tenant, {
          ...(query.since ? { since: query.since } : {}),
          ...(limit === undefined ? {} : { limit }),
        }),
        requestId,
      );
    }
    if (path === "/v1/memory/review-items" && method === "GET") {
      return response(
        200,
        await platform.listReviewItemsPage(tenant, {
          ...paginationInput(query.cursor, query.limit),
          status: optionalOneOf(query.status, "status", ["open", "resolved"]) ?? "open",
        }),
        requestId,
      );
    }
    const reviewItemMatch = path.match(/^\/v1\/memory\/([^/]+)\/review-items\/([^/]+)$/u);
    if (reviewItemMatch && method === "POST") {
      return response(
        200,
        await platform.resolveReview(tenant, {
          ...(typeof body.content === "string" ? { content: body.content } : {}),
          decision: oneOf(body.decision, "decision", [
            "approve",
            "archive",
            "delete",
            "edit",
            "reject",
          ]),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          memoryId: ulid(reviewItemMatch[1], "memoryId"),
          ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
          reviewId: ulid(reviewItemMatch[2], "reviewId"),
        }),
        requestId,
      );
    }
    const lifecycleMatch = path.match(/^\/v1\/memory\/([^/]+)\/(archive|delete|restore)$/u);
    if (lifecycleMatch && method === "POST") {
      const memoryId = ulid(lifecycleMatch[1], "memoryId");
      const action = lifecycleMatch[2];
      return response(
        200,
        action === "archive"
          ? await platform.archiveMemory(tenant, memoryId, idempotencyKey ? { idempotencyKey } : {})
          : action === "restore"
            ? await platform.restoreMemory(
                tenant,
                memoryId,
                idempotencyKey ? { idempotencyKey } : {},
              )
            : await platform.deleteMemory(tenant, memoryId, {
                ...(idempotencyKey ? { idempotencyKey } : {}),
                ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
              }),
        requestId,
      );
    }
    const feedbackMatch = path.match(/^\/v1\/memory\/([^/]+)\/retrievals\/([^/]+)\/feedback$/u);
    if (feedbackMatch && method === "POST") {
      return response(
        200,
        await platform.recordRetrievalFeedback(
          tenant,
          ulid(feedbackMatch[2], "retrievalId"),
          ulid(feedbackMatch[1], "memoryId"),
          oneOf(body.usefulness, "usefulness", ["harmful", "neutral", "useful"]),
          typeof body.feedback === "string" ? body.feedback : undefined,
          idempotencyKey ? { idempotencyKey } : {},
        ),
        requestId,
      );
    }
    const flushMatch = path.match(/^\/v1\/memory\/flushes\/([^/]+)$/u);
    if (flushMatch && method === "GET") {
      const runId = ulid(flushMatch[1], "runId");
      authorizeRun(event, runId, tenant);
      const run = await platform.findRun(tenant, runId);
      if (tenant.workspaceId && run.data.workspaceId !== tenant.workspaceId) {
        throw new MemoryApiError(404, "run_not_found", "Run was not found.");
      }
      return response(200, await platform.requiredFlush(tenant, runId), requestId);
    }
    if (path === "/v1/memory/flushes" && method === "POST") {
      const memorySpaceId =
        body.memorySpaceId === undefined ? undefined : ulid(body.memorySpaceId, "memorySpaceId");
      const runId = ulid(body.runId, "runId");
      authorizeRun(event, runId, tenant);
      const run = await platform.findRun(tenant, runId);
      return response(
        202,
        await platform.enqueueFlush(tenant, run, {
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(body.memoryMode === undefined
            ? {}
            : {
                memoryMode: oneOf(body.memoryMode, "memoryMode", [
                  "agent",
                  "off",
                  "organization",
                  "thread",
                  "workspace",
                ]),
              }),
          ...(memorySpaceId ? { memorySpaceId } : {}),
        }),
        requestId,
      );
    }
    return response(404, { code: "not_found", detail: "Memory route was not found." }, requestId);
  } catch (cause) {
    return problem(cause, requestId);
  }
}

export async function handler(event: MemoryApiEvent) {
  const requestId = event.requestContext?.requestId ?? crypto.randomUUID();
  try {
    const authenticated = await authenticateMemoryApiEvent(event);
    defaultOrganizationGate ??= makeOrganizationGateFromEnvironment({
      client: runtimeDocumentClient(),
      database: runtimeDatabase(),
      environment: process.env,
    });
    return await handleMemoryApi(authenticated, { organizationGate: defaultOrganizationGate });
  } catch (cause) {
    return problem(cause, requestId);
  }
}
