import { type MemoryPlatform } from "@deployments-ai/memory";
import { describe, expect, it } from "bun:test";
import { handleMemoryApi } from "./api.ts";
import { ids, event } from "./api-test-support.ts";

describe("memory API", () => {
  it("forwards validated custom search keys", async () => {
    let received: unknown;
    const platform = {
      search: async (
        _scope: Parameters<MemoryPlatform["search"]>[0],
        input: Parameters<MemoryPlatform["search"]>[1],
      ) => {
        received = input;
        return { results: [] };
      },
    } as unknown as MemoryPlatform;

    const result = await handleMemoryApi(
      event("/v1/memory/search", "POST", {
        memorySpaceIds: ["01ARZ3NDEKTSV4RRFFQ69G5FA7", "01ARZ3NDEKTSV4RRFFQ69G5FA7"],
        query: "change window",
        searchKeys: ["custom:operations"],
      }),
      { platform },
    );

    expect(result.statusCode).toBe(200);
    expect(received).toMatchObject({
      memorySpaceIds: ["01ARZ3NDEKTSV4RRFFQ69G5FA7"],
      searchKeys: ["custom:operations"],
    });
  });

  it("rejects internal recall attribution on public search", async () => {
    const result = await handleMemoryApi(
      event("/v1/memory/search", "POST", {
        memorySpaceIds: ["01ARZ3NDEKTSV4RRFFQ69G5FA7"],
        purpose: "active-recall",
        query: "change window",
        runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
      }),
      { platform: {} as MemoryPlatform },
    );

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body ?? "{}")).toMatchObject({ code: "unsupported_field" });
  });

  it("derives active-recall attribution and authorization from the canonical run", async () => {
    const received: unknown[] = [];
    const platform = {
      memoryAccessForRun: async () => ({
        agentDefinitionId: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
        readMemorySpaceIds: ["01ARZ3NDEKTSV4RRFFQ69G5FA7"],
        run: {
          data: {
            captureMode: "metadata-only",
            id: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
            spanId: "0123456789abcdef",
            threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
            traceId: "0123456789abcdef0123456789abcdef",
            workspaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA8",
          },
        },
        searchKeys: ["workspace:01ARZ3NDEKTSV4RRFFQ69G5FA8"],
        writeMemorySpaceIds: [],
      }),
      search: async (activeScope: unknown, input: unknown) => {
        received.push(activeScope, input);
        return { results: [] };
      },
    } as unknown as MemoryPlatform;

    const request = event("/v1/memory/active-recall", "POST", {
      query: "change window",
      runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
      topK: 5,
    });
    const claims = request.requestContext?.authorizer?.jwt?.claims ?? {};
    const result = await handleMemoryApi(
      {
        ...request,
        requestContext: {
          ...request.requestContext,
          authorizer: {
            jwt: { claims: { ...claims, run_id: "01ARZ3NDEKTSV4RRFFQ69G5FA9" } },
          },
        },
      },
      { platform },
    );

    expect(result.statusCode).toBe(200);
    expect(received).toEqual([
      {
        environmentId: ids.environment,
        organizationId: ids.organization,
        projectId: ids.project,
        workspaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA8",
      },
      {
        allowedScopeKeys: ["workspace:01ARZ3NDEKTSV4RRFFQ69G5FA8"],
        memorySpaceIds: ["01ARZ3NDEKTSV4RRFFQ69G5FA7"],
        observability: {
          captureMode: "metadata-only",
          runSpanId: "0123456789abcdef",
          sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
          traceId: "0123456789abcdef0123456789abcdef",
          workspaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA8",
        },
        purpose: "active-recall",
        query: "change window",
        runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
        searchKeys: ["workspace:01ARZ3NDEKTSV4RRFFQ69G5FA8"],
        threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
        topK: 5,
      },
    ]);
  });

  it("keeps workspace-bound active recall on a run in the claimed workspace", async () => {
    let searched = false;
    const platform = {
      memoryAccessForRun: async () => ({
        readMemorySpaceIds: ["01ARZ3NDEKTSV4RRFFQ69G5FA7"],
        run: { data: { id: "01ARZ3NDEKTSV4RRFFQ69G5FA9" } },
        searchKeys: ["organization:01ARZ3NDEKTSV4RRFFQ69G5FA5"],
        writeMemorySpaceIds: [],
      }),
      search: async () => {
        searched = true;
        return { results: [] };
      },
    } as unknown as MemoryPlatform;
    const request = event("/v1/memory/active-recall", "POST", {
      query: "change window",
      runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
    });
    const claims = request.requestContext?.authorizer?.jwt?.claims ?? {};

    const result = await handleMemoryApi(
      {
        ...request,
        requestContext: {
          ...request.requestContext,
          authorizer: {
            jwt: {
              claims: {
                ...claims,
                run_id: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
                workspace_id: "01ARZ3NDEKTSV4RRFFQ69G5FA8",
              },
            },
          },
        },
      },
      { platform },
    );

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body ?? "{}")).toMatchObject({ code: "run_not_found" });
    expect(searched).toBe(false);
  });

  it("rejects invalid active-recall result limits before resolving the run", async () => {
    let resolvedRun = false;
    const platform = {
      memoryAccessForRun: async () => {
        resolvedRun = true;
        throw new Error("unexpected run lookup");
      },
    } as unknown as MemoryPlatform;

    for (const topK of [0, -1, 1.5, 100]) {
      const request = event("/v1/memory/active-recall", "POST", {
        query: "change window",
        runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
        topK,
      });
      const claims = request.requestContext?.authorizer?.jwt?.claims ?? {};
      const result = await handleMemoryApi(
        {
          ...request,
          requestContext: {
            ...request.requestContext,
            authorizer: {
              jwt: { claims: { ...claims, run_id: "01ARZ3NDEKTSV4RRFFQ69G5FA9" } },
            },
          },
        },
        { platform },
      );
      expect(result.statusCode).toBe(400);
    }
    expect(resolvedRun).toBe(false);
  });

  it("requires active-recall tokens to be bound to the requested run", async () => {
    const request = event("/v1/memory/active-recall", "POST", {
      query: "change window",
      runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
    });
    const claims = request.requestContext?.authorizer?.jwt?.claims ?? {};
    const missing = await handleMemoryApi(request, { platform: {} as MemoryPlatform });
    const mismatched = await handleMemoryApi(
      {
        ...request,
        requestContext: {
          ...request.requestContext,
          authorizer: {
            jwt: { claims: { ...claims, run_id: "01ARZ3NDEKTSV4RRFFQ69G5FAB" } },
          },
        },
      },
      { platform: {} as MemoryPlatform },
    );

    expect(missing.statusCode).toBe(403);
    expect(JSON.parse(missing.body ?? "{}")).toMatchObject({
      code: "run_bound_token_required",
    });
    expect(mismatched.statusCode).toBe(403);
    expect(JSON.parse(mismatched.body ?? "{}")).toMatchObject({ code: "run_forbidden" });
  });

  it("bounds public search memory-space fan-out", async () => {
    const base = "01ARZ3NDEKTSV4RRFFQ69G5FA7";
    const memorySpaceIds = Array.from({ length: 21 }, () => base);
    const result = await handleMemoryApi(
      event("/v1/memory/search", "POST", {
        memorySpaceIds,
        query: "change window",
      }),
      { platform: {} as MemoryPlatform },
    );

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body ?? "{}")).toMatchObject({
      code: "invalid_request",
    });
    const searchKeys = await handleMemoryApi(
      event("/v1/memory/search", "POST", {
        memorySpaceIds: [base],
        query: "change window",
        searchKeys: Array.from({ length: 51 }, (_, index) => `custom:key-${index}`),
      }),
      { platform: {} as MemoryPlatform },
    );
    expect(searchKeys.statusCode).toBe(400);
    expect(JSON.parse(searchKeys.body ?? "{}")).toMatchObject({ code: "invalid_request" });
  });

  it("does not accept memory search queries in GET URLs", async () => {
    let called = false;
    const platform = {
      search: async () => {
        called = true;
      },
    } as unknown as MemoryPlatform;
    const request = event("/v1/memory/search", "GET");
    const result = await handleMemoryApi(
      {
        ...request,
        queryStringParameters: {
          query: "change window",
          space: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
          topK: "5",
        },
      },
      { platform },
    );

    expect(result.statusCode).toBe(404);
    expect(called).toBe(false);
  });
});
