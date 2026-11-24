import type { PlatformRequest } from "./index.ts";

/** Deterministic memory, memory-space, grant, and review responses for the mock transport. */
export function mockMemoryData(
  request: PlatformRequest,
  now: string,
): { readonly matched: false } | { readonly matched: true; readonly data: unknown } {
  const path = request.path;
  const memoryRecord = (
    suffix: string,
    status: "active" | "archived" | "deleted" = "active",
    id = `memory_${suffix}`,
  ) => ({
    data: {
      body: `Mock memory ${suffix}`,
      contentHash: `sha256:mock-${suffix}`,
      id,
      memorySpaceId: "space_mock",
      reviewStatus: "approved",
      scope: "organization",
      searchKey: `organization:${request.context?.organizationId ?? "org_mock"}`,
      sensitivity: "internal",
      source: "mock",
      status,
      version: 0,
    },
    itemType: "memory",
  });
  const memorySpaceRecord = (suffix: string) => ({
    data: {
      id: `space_${suffix}`,
      kind: "organization",
      name: `Mock memory space ${suffix}`,
      status: "active",
      version: 0,
    },
    itemType: "memory-space",
  });
  const memoryReviewRecord = (suffix: string) => ({
    data: {
      id: `review_${suffix}`,
      kind: "sampled-import",
      memoryId: `memory_${suffix}`,
      reason: "Mock review",
      status: "open",
    },
    itemType: "memory-review-item",
  });
  const memorySpaceGrantRecord = (suffix: string, revoked = false) => {
    const body =
      request.body && typeof request.body === "object"
        ? (request.body as Record<string, unknown>)
        : {};
    return {
      data: {
        agentDefinitionId:
          typeof body.agentDefinitionId === "string" ? body.agentDefinitionId : "agent_mock",
        id: `grant_${suffix}`,
        memorySpaceId: typeof body.memorySpaceId === "string" ? body.memorySpaceId : "space_mock",
        permission: body.permission === "read" ? "read" : "read-write",
        ...(revoked ? { revokedAt: now } : {}),
        version: 0,
      },
      itemType: "memory-space-grant",
    };
  };
  if (path === "/v1/memory/search" || path === "/v1/memory/evidence/strategy-search") {
    const body =
      request.body && typeof request.body === "object"
        ? (request.body as Record<string, unknown>)
        : {};
    return {
      matched: true,
      data: {
        ...(path === "/v1/memory/evidence/strategy-search"
          ? {
              attempt: {
                data: {
                  lexicalCandidateCount: 2,
                  strategy:
                    body.strategy === "dense-open-search-ann-control-v1" ||
                    body.strategy === "dense-exact-control-v1"
                      ? "dense-v1"
                      : body.strategy === "hybrid-rrf-v1"
                        ? "hybrid-rrf-v1"
                        : "hybrid-rerank-v1",
                },
              },
            }
          : {}),
        results: [
          { memory: memoryRecord("alpha"), rank: 1, score: 0.92 },
          { memory: memoryRecord("beta"), rank: 2, score: 0.81 },
        ],
        retrievals: [],
      },
    };
  }
  if (path === "/v1/memory" && request.method === "GET") {
    return {
      matched: true,
      data: {
        items: [memoryRecord("alpha"), memoryRecord("beta")],
        nextCursor: null,
      },
    };
  }
  if (path === "/v1/memory-spaces" && request.method === "GET") {
    return {
      matched: true,
      data: {
        items: [memorySpaceRecord("alpha"), memorySpaceRecord("beta")],
        nextCursor: null,
      },
    };
  }
  if (path === "/v1/memory/review-items" && request.method === "GET") {
    return {
      matched: true,
      data: {
        items: [memoryReviewRecord("alpha"), memoryReviewRecord("beta")],
        nextCursor: null,
      },
    };
  }
  if (path === "/v1/memory/imports" && request.method === "POST") {
    return {
      matched: true,
      data: { imported: [memoryRecord("imported")], rejected: [], replayed: [] },
    };
  }
  if (path === "/v1/memory-space-grants" && request.method === "POST") {
    return { matched: true, data: memorySpaceGrantRecord("mock") };
  }
  if (path === "/v1/memory-space-grants" && request.method === "GET") {
    return {
      matched: true,
      data: {
        items: [memorySpaceGrantRecord("alpha"), memorySpaceGrantRecord("beta")],
        nextCursor: null,
      },
    };
  }
  const grantMatch = path.match(/^\/v1\/memory-space-grants\/([^/]+)$/u);
  if (grantMatch && (request.method === "PATCH" || request.method === "DELETE")) {
    const grantId = decodeURIComponent(grantMatch[1] ?? "grant_mock");
    return {
      matched: true,
      data: {
        ...memorySpaceGrantRecord("mock", request.method === "DELETE"),
        data: {
          ...memorySpaceGrantRecord("mock", request.method === "DELETE").data,
          id: grantId,
        },
      },
    };
  }
  const reviewMatch = path.match(/^\/v1\/memory\/([^/]+)\/review-items\/([^/]+)$/u);
  if (reviewMatch && request.method === "POST") {
    const body =
      request.body && typeof request.body === "object"
        ? (request.body as Record<string, unknown>)
        : {};
    const decision = typeof body.decision === "string" ? body.decision : "approve";
    const status =
      decision === "delete" ? "deleted" : decision === "archive" ? "archived" : "active";
    const review = memoryReviewRecord("mock");
    return {
      matched: true,
      data: {
        memory: {
          ...memoryRecord("reviewed", status, decodeURIComponent(reviewMatch[1] ?? "memory_mock")),
          data: {
            ...memoryRecord("reviewed", status).data,
            id: decodeURIComponent(reviewMatch[1] ?? "memory_mock"),
            reviewStatus: decision === "approve" ? "approved" : "rejected",
          },
        },
        review: {
          ...review,
          data: {
            ...review.data,
            decision,
            id: decodeURIComponent(reviewMatch[2] ?? review.data.id),
            status: "resolved",
          },
        },
      },
    };
  }
  if (path === "/v1/memory-spaces" || /^\/v1\/memory-spaces\/[^/]+$/u.test(path)) {
    const body =
      request.body && typeof request.body === "object"
        ? (request.body as Record<string, unknown>)
        : {};
    const pathId = path.match(/^\/v1\/memory-spaces\/([^/]+)$/u)?.[1];
    const base = memorySpaceRecord("mock");
    return {
      matched: true,
      data: {
        ...base,
        data: {
          ...base.data,
          ...(typeof body.description === "string" ? { description: body.description } : {}),
          id: pathId ? decodeURIComponent(pathId) : base.data.id,
          kind:
            typeof body.kind === "string"
              ? body.kind
              : typeof body.workspaceId === "string"
                ? "workspace"
                : base.data.kind,
          name: typeof body.name === "string" ? body.name : base.data.name,
          ...(typeof body.retentionDays === "number" ? { retentionDays: body.retentionDays } : {}),
          status: request.method === "DELETE" ? "archived" : "active",
          ...(typeof body.workspaceId === "string" ? { workspaceId: body.workspaceId } : {}),
        },
      },
    };
  }
  if (/^\/v1\/memory\/[^/]+\/(?:archive|delete|restore)$/u.test(path)) {
    const segments = path.split("/");
    const action = segments.at(-1);
    const status = action === "archive" ? "archived" : action === "delete" ? "deleted" : "active";
    return {
      matched: true,
      data: memoryRecord("mock", status, decodeURIComponent(segments.at(-2) ?? "memory_mock")),
    };
  }
  return { matched: false };
}
