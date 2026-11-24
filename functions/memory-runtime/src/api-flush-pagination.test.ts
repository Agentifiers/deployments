import { describe, expect, it } from "bun:test";
import type { MemoryPlatform } from "@deployments-ai/memory";
import { handleMemoryApi, type MemoryApiEvent } from "./api.ts";
import { authorizeRun } from "./api-support.ts";
const ids = {
  environment: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
  organization: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
  project: "01ARZ3NDEKTSV4RRFFQ69G5FA6",
};

function event(path: string, method: string, body?: unknown): MemoryApiEvent {
  return {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    rawPath: path,
    requestContext: {
      authorizer: {
        jwt: {
          claims: {
            environment_id: ids.environment,
            organization_id: ids.organization,
            project_id: ids.project,
            scope: "memory:admin memory:read memory:write",
          },
        },
      },
      http: { method, path },
      requestId: "request-1",
    },
  };
}

function runBoundEvent(
  path: string,
  method: string,
  runId: string,
  body?: unknown,
): MemoryApiEvent {
  const request = event(path, method, body);
  const claims = request.requestContext?.authorizer?.jwt?.claims ?? {};
  return {
    ...request,
    requestContext: {
      ...request.requestContext,
      authorizer: { jwt: { claims: { ...claims, run_id: runId } } },
    },
  };
}

describe("memory API", () => {
  it("accepts Cognito custom run binding claims", () => {
    const runId = "01ARZ3NDEKTSV4RRFFQ69G5FA9";
    const request = event("/v1/memory/active-recall", "POST");
    const claims = request.requestContext?.authorizer?.jwt?.claims ?? {};

    expect(() =>
      authorizeRun(
        {
          ...request,
          requestContext: {
            ...request.requestContext,
            authorizer: { jwt: { claims: { ...claims, "custom:run_id": runId } } },
          },
        },
        runId,
      ),
    ).not.toThrow();
  });

  it("forwards bounded cursor pagination for memory lists and exports", async () => {
    const received: unknown[] = [];
    const platform = {
      exportMemoriesPage: async (
        _scope: Parameters<MemoryPlatform["exportMemoriesPage"]>[0],
        input: Parameters<MemoryPlatform["exportMemoriesPage"]>[1],
      ) => {
        received.push(input);
        return { items: [], nextCursor: "next-page" };
      },
      listMemoriesPage: async (
        _scope: Parameters<MemoryPlatform["listMemoriesPage"]>[0],
        input: Parameters<MemoryPlatform["listMemoriesPage"]>[1],
      ) => {
        received.push(input);
        return { items: [], nextCursor: "next-page" };
      },
    } as unknown as MemoryPlatform;

    const listed = await handleMemoryApi(
      {
        ...event("/v1/memory", "GET"),
        queryStringParameters: {
          cursor: "list-page",
          limit: "25",
          space: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
        },
      },
      { platform },
    );
    const exported = await handleMemoryApi(
      event("/v1/memory/exports", "POST", {
        cursor: "export-page",
        format: "json",
        limit: 40,
        space: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
      }),
      { platform },
    );

    expect(listed.statusCode).toBe(200);
    expect(exported.statusCode).toBe(200);
    expect(received).toEqual([
      {
        cursor: "list-page",
        limit: 20,
        memorySpaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
      },
      {
        cursor: "export-page",
        limit: 20,
        memorySpaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
      },
    ]);
    expect(JSON.parse(exported.body ?? "{}")).toEqual({
      format: "json",
      items: [],
      nextCursor: "next-page",
    });
  });

  it("forwards flush idempotency keys", async () => {
    let received: unknown;
    const platform = {
      enqueueFlush: async (
        _scope: Parameters<MemoryPlatform["enqueueFlush"]>[0],
        _run: Parameters<MemoryPlatform["enqueueFlush"]>[1],
        input: Parameters<MemoryPlatform["enqueueFlush"]>[2],
      ) => {
        received = input;
        return { data: { id: "flush-1", status: "queued" } };
      },
      findRun: async () => ({ data: { id: "01ARZ3NDEKTSV4RRFFQ69G5FA9" } }),
    } as unknown as MemoryPlatform;
    const request = runBoundEvent("/v1/memory/flushes", "POST", "01ARZ3NDEKTSV4RRFFQ69G5FA9", {
      memoryMode: "workspace",
      memorySpaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
      runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
    });

    const result = await handleMemoryApi(
      { ...request, headers: { "idempotency-key": "flush-request" } },
      { platform },
    );

    expect(result.statusCode).toBe(202);
    expect(received).toEqual({
      idempotencyKey: "flush-request",
      memoryMode: "workspace",
      memorySpaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
    });
  });

  it("reads flush status without re-enqueueing it", async () => {
    let receivedRunId: unknown;
    const platform = {
      findRun: async () => ({ data: { id: "01ARZ3NDEKTSV4RRFFQ69G5FA9" } }),
      requiredFlush: async (
        _scope: Parameters<MemoryPlatform["requiredFlush"]>[0],
        runId: Parameters<MemoryPlatform["requiredFlush"]>[1],
      ) => {
        receivedRunId = runId;
        return { data: { id: "flush-1", status: "failed" } };
      },
    } as unknown as MemoryPlatform;

    const result = await handleMemoryApi(
      runBoundEvent(
        "/v1/memory/flushes/01ARZ3NDEKTSV4RRFFQ69G5FA9",
        "GET",
        "01ARZ3NDEKTSV4RRFFQ69G5FA9",
      ),
      { platform },
    );

    expect(result.statusCode).toBe(200);
    expect(receivedRunId).toBe("01ARZ3NDEKTSV4RRFFQ69G5FA9");
    expect(JSON.parse(result.body ?? "{}")).toMatchObject({ data: { status: "failed" } });
  });

  it("keeps flush status reads within the token workspace", async () => {
    let flushReads = 0;
    const platform = {
      findRun: async () => ({
        data: {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
          workspaceId: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
        },
      }),
      requiredFlush: async () => {
        flushReads += 1;
        return { data: { id: "flush-1", status: "failed" } };
      },
    } as unknown as MemoryPlatform;
    const request = runBoundEvent(
      "/v1/memory/flushes/01ARZ3NDEKTSV4RRFFQ69G5FA9",
      "GET",
      "01ARZ3NDEKTSV4RRFFQ69G5FA9",
    );
    const claims = request.requestContext?.authorizer?.jwt?.claims ?? {};

    const result = await handleMemoryApi(
      {
        ...request,
        requestContext: {
          ...request.requestContext,
          authorizer: {
            jwt: {
              claims: { ...claims, workspace_id: "01ARZ3NDEKTSV4RRFFQ69G5FA8" },
            },
          },
        },
      },
      { platform },
    );

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body ?? "{}")).toMatchObject({ code: "run_not_found" });
    expect(flushReads).toBe(0);
  });

  it("rejects malformed flush memory-space ids", async () => {
    let called = false;
    const platform = {
      enqueueFlush: async () => {
        called = true;
      },
      findRun: async () => {
        called = true;
      },
    } as unknown as MemoryPlatform;

    const result = await handleMemoryApi(
      runBoundEvent("/v1/memory/flushes", "POST", "01ARZ3NDEKTSV4RRFFQ69G5FA9", {
        memorySpaceId: 42,
        runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
      }),
      { platform },
    );

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body ?? "{}")).toMatchObject({ code: "invalid_id" });
    expect(called).toBe(false);
  });

  it("requires flush tokens to be bound to the requested run", async () => {
    const runId = "01ARZ3NDEKTSV4RRFFQ69G5FA9";
    const missing = await handleMemoryApi(event("/v1/memory/flushes", "POST", { runId }), {
      platform: {} as MemoryPlatform,
    });
    const mismatched = await handleMemoryApi(
      runBoundEvent("/v1/memory/flushes", "POST", "01ARZ3NDEKTSV4RRFFQ69G5FAB", { runId }),
      { platform: {} as MemoryPlatform },
    );

    expect(missing.statusCode).toBe(403);
    expect(JSON.parse(missing.body ?? "{}")).toMatchObject({
      code: "run_bound_token_required",
    });
    expect(mismatched.statusCode).toBe(403);
    expect(JSON.parse(mismatched.body ?? "{}")).toMatchObject({ code: "run_forbidden" });
  });

  it("forwards retrieval feedback idempotency keys", async () => {
    let received: unknown;
    const platform = {
      recordRetrievalFeedback: async (
        ...args: Parameters<MemoryPlatform["recordRetrievalFeedback"]>
      ) => {
        received = args.slice(1);
        return { data: { id: args[1], usefulness: args[3] } };
      },
    } as unknown as MemoryPlatform;
    const request = event(
      "/v1/memory/01ARZ3NDEKTSV4RRFFQ69G5FA3/retrievals/01ARZ3NDEKTSV4RRFFQ69G5FAB/feedback",
      "POST",
      { feedback: "Useful context", usefulness: "useful" },
    );

    const result = await handleMemoryApi(
      { ...request, headers: { "idempotency-key": "feedback-request" } },
      { platform },
    );

    expect(result.statusCode).toBe(200);
    expect(received).toEqual([
      "01ARZ3NDEKTSV4RRFFQ69G5FAB",
      "01ARZ3NDEKTSV4RRFFQ69G5FA3",
      "useful",
      "Useful context",
      { idempotencyKey: "feedback-request" },
    ]);
  });

  it("rejects unsupported memory export formats", async () => {
    const result = await handleMemoryApi(
      event("/v1/memory/exports", "POST", {
        format: "csv",
        space: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
      }),
      { platform: {} as MemoryPlatform },
    );

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body ?? "{}")).toMatchObject({ code: "invalid_request" });
  });

  it("rejects unsupported memory-space quality filtering", async () => {
    const result = await handleMemoryApi(
      {
        ...event("/v1/memory/quality", "GET"),
        queryStringParameters: { space: "01ARZ3NDEKTSV4RRFFQ69G5FA7" },
      },
      { platform: {} as MemoryPlatform },
    );

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body ?? "{}")).toMatchObject({ code: "unsupported_filter" });
  });

  it("forwards bounded memory quality sampling", async () => {
    let received: unknown;
    const platform = {
      quality: async (
        _scope: Parameters<MemoryPlatform["quality"]>[0],
        input: Parameters<MemoryPlatform["quality"]>[1],
      ) => {
        received = input;
        return { attempts: 0, sampleLimit: input?.limit };
      },
    } as unknown as MemoryPlatform;
    const result = await handleMemoryApi(
      {
        ...event("/v1/memory/quality", "GET"),
        queryStringParameters: { limit: "5000", since: "2026-07-01T00:00:00.000Z" },
      },
      { platform },
    );

    expect(result.statusCode).toBe(200);
    expect(received).toEqual({ limit: 5_000, since: "2026-07-01T00:00:00.000Z" });

    const invalid = await handleMemoryApi(
      {
        ...event("/v1/memory/quality", "GET"),
        queryStringParameters: { limit: "5001" },
      },
      { platform },
    );
    expect(invalid.statusCode).toBe(400);
    expect(JSON.parse(invalid.body ?? "{}")).toMatchObject({ code: "invalid_request" });
  });

  it("rejects missing tenant claims", async () => {
    const result = await handleMemoryApi(
      {
        rawPath: "/v1/memory-spaces",
        requestContext: { http: { method: "GET" }, requestId: "request-2" },
      },
      { platform: {} as MemoryPlatform },
    );
    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body ?? "{}")).toMatchObject({ code: "unauthorized" });
  });

  it("requires explicit memory capabilities for tenant JWTs", async () => {
    const request = event("/v1/memory/exports", "POST", {
      space: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
    });
    const claims = request.requestContext?.authorizer?.jwt?.claims ?? {};
    const result = await handleMemoryApi(
      {
        ...request,
        requestContext: {
          ...request.requestContext,
          authorizer: { jwt: { claims: { ...claims, scope: "memory:read" } } },
        },
      },
      { platform: {} as MemoryPlatform },
    );

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body ?? "{}")).toMatchObject({ code: "forbidden" });
  });

  it("does not let write-only credentials read memory", async () => {
    let called = false;
    const request = event("/v1/memory/search", "POST", {
      memorySpaceIds: ["01ARZ3NDEKTSV4RRFFQ69G5FA7"],
      query: "change window",
    });
    const claims = request.requestContext?.authorizer?.jwt?.claims ?? {};
    const result = await handleMemoryApi(
      {
        ...request,
        requestContext: {
          ...request.requestContext,
          authorizer: { jwt: { claims: { ...claims, scope: "memory:write" } } },
        },
      },
      {
        platform: {
          search: async () => {
            called = true;
          },
        } as unknown as MemoryPlatform,
      },
    );

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body ?? "{}")).toMatchObject({ code: "forbidden" });
    expect(called).toBe(false);
  });

  it("rejects SDK tenant headers that disagree with JWT claims", async () => {
    let called = false;
    const request = event("/v1/memory-spaces", "GET");
    const result = await handleMemoryApi(
      {
        ...request,
        headers: { "x-deployments-organization": "01ARZ3NDEKTSV4RRFFQ69G5FAB" },
      },
      {
        platform: {
          listMemorySpacesPage: async () => {
            called = true;
          },
        } as unknown as MemoryPlatform,
      },
    );

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body ?? "{}")).toMatchObject({ code: "tenant_context_mismatch" });
    expect(called).toBe(false);
  });

  it("requires admin capability for canonical memory listing", async () => {
    const request = event("/v1/memory", "GET");
    const claims = request.requestContext?.authorizer?.jwt?.claims ?? {};
    const result = await handleMemoryApi(
      {
        ...request,
        requestContext: {
          ...request.requestContext,
          authorizer: { jwt: { claims: { ...claims, scope: "memory:read memory:write" } } },
        },
      },
      { platform: {} as MemoryPlatform },
    );

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body ?? "{}")).toMatchObject({ code: "forbidden" });
  });

  it("requires execute capability for active recall", async () => {
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
          authorizer: { jwt: { claims: { ...claims, scope: "memory:read" } } },
        },
      },
      { platform: {} as MemoryPlatform },
    );

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body ?? "{}")).toMatchObject({ code: "forbidden" });
  });
});
