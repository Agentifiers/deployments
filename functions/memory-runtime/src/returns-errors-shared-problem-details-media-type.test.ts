import { DatabaseError } from "@deployments-ai/db";
import { AwsNativeMemoryError, type MemoryPlatform } from "@deployments-ai/memory";
import { describe, expect, it, spyOn } from "bun:test";
import { handleMemoryApi } from "./api.ts";
import { problem } from "./api-support.ts";
import { event } from "./api-test-support.ts";

describe("memory API", () => {
  it("classifies retrieval deadline exhaustion as a retryable gateway timeout", () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = problem(
        new DOMException("The operation timed out.", "TimeoutError"),
        "request-timeout",
      );

      expect(result.statusCode).toBe(504);
      expect(JSON.parse(result.body ?? "{}")).toMatchObject({
        code: "memory_timeout",
        detail: "Memory request timed out.",
        requestId: "request-timeout",
        status: 504,
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("classifies an aborted deadline-bound database write as a gateway timeout", () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = problem(
        new DatabaseError({
          cause: new DOMException("The operation was aborted.", "AbortError"),
          message: "DynamoDB transact-write failed for table multiple.",
          operation: "transact-write",
          reason: "unknown",
          table: "multiple",
        }),
        "request-database-timeout",
      );

      expect(result.statusCode).toBe(504);
      expect(JSON.parse(result.body ?? "{}")).toMatchObject({
        code: "memory_timeout",
        detail: "Memory request timed out.",
        requestId: "request-database-timeout",
        status: 504,
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("preserves timeout classification through AWS-native provider diagnostics", () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = problem(
        new AwsNativeMemoryError({
          cause: new DOMException("The operation timed out.", "TimeoutError"),
          message: "AWS-native memory query-vector failed.",
          operation: "query-vector",
        }),
        "request-provider-timeout",
      );

      expect(result.statusCode).toBe(504);
      expect(JSON.parse(result.body ?? "{}")).toMatchObject({
        code: "memory_timeout",
        detail: "Memory request timed out.",
        requestId: "request-provider-timeout",
        status: 504,
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("logs bounded AWS-native provider context without exposing provider details", () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const providerCause = Object.assign(new Error("sensitive provider response"), {
        details: {
          error: {
            reason: "unknown setting [index.knn]",
            type: "illegal_argument_exception",
          },
        },
        status: 400,
      });
      problem(
        new AwsNativeMemoryError({
          cause: providerCause,
          message: "AWS-native memory prepare-open-search-index failed.",
          operation: "prepare-open-search-index",
        }),
        "request-provider",
      );

      expect(consoleError).toHaveBeenCalledWith("Memory API request failed.", {
        errorType: "AwsNativeMemoryError",
        providerErrorReason: "unknown setting [index.knn]",
        providerErrorType: "illegal_argument_exception",
        providerOperation: "prepare-open-search-index",
        providerStatus: 400,
        requestId: "request-provider",
      });
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("sensitive provider response");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("logs actionable database failure context without exposing it to clients", () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = problem(
        new DatabaseError({
          cause: {
            CancellationReasons: [
              { Code: "None" },
              { Code: "ConditionalCheckFailed" },
              { Code: "None" },
            ],
            name: "TransactionCanceledException",
          },
          message: "Unable to transact records.",
          operation: "transactWrite",
          reason: "conflict",
          table: "execution",
        }),
        "request-database",
      );

      expect(consoleError).toHaveBeenCalledWith("Memory API request failed.", {
        databaseCancellationCodes: ["None", "ConditionalCheckFailed", "None"],
        databaseCauseType: "TransactionCanceledException",
        databaseOperation: "transactWrite",
        databaseReason: "conflict",
        databaseTable: "execution",
        errorMessage: "Unable to transact records.",
        errorType: "DatabaseError",
        requestId: "request-database",
      });
      expect(JSON.parse(result.body ?? "{}")).toMatchObject({
        code: "memory_internal_error",
        detail: "Memory request failed.",
        requestId: "request-database",
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("returns errors with the shared problem-details media type", async () => {
    const request = event("/v1/memory-spaces", "GET");
    const result = await handleMemoryApi({
      ...request,
      requestContext: {
        ...request.requestContext,
        authorizer: { jwt: { claims: {} } },
      },
    });

    expect(result.statusCode).toBe(401);
    expect(result.headers["content-type"]).toBe("application/problem+json");
  });

  it("routes authenticated public memory-space creation", async () => {
    let received: unknown;
    const platform = {
      createMemorySpace: async (
        _scope: Parameters<MemoryPlatform["createMemorySpace"]>[0],
        input: Parameters<MemoryPlatform["createMemorySpace"]>[1],
      ) => {
        received = input;
        return { id: "memory-space-1" };
      },
    } as unknown as MemoryPlatform;
    const request = event("/v1/memory-spaces", "POST", { name: "Ops" });
    const result = await handleMemoryApi(
      { ...request, headers: { "Idempotency-Key": "space-create-1" } },
      { platform },
    );
    expect(result.statusCode).toBe(201);
    expect(JSON.parse(result.body ?? "{}")).toEqual({ id: "memory-space-1" });
    expect(received).toMatchObject({ idempotencyKey: "space-create-1", name: "Ops" });
  });

  it("forwards memory-space archive idempotency keys", async () => {
    let received: unknown;
    const platform = {
      archiveMemorySpace: async (
        _scope: Parameters<MemoryPlatform["archiveMemorySpace"]>[0],
        _spaceId: Parameters<MemoryPlatform["archiveMemorySpace"]>[1],
        input: Parameters<MemoryPlatform["archiveMemorySpace"]>[2],
      ) => {
        received = input;
        return { data: { id: _spaceId, status: "archived" } };
      },
    } as unknown as MemoryPlatform;
    const request = event("/v1/memory-spaces/01ARZ3NDEKTSV4RRFFQ69G5FA7", "DELETE");

    const result = await handleMemoryApi(
      { ...request, headers: { "idempotency-key": "space-archive-1" } },
      { platform },
    );

    expect(result.statusCode).toBe(200);
    expect(received).toEqual({ idempotencyKey: "space-archive-1" });
  });

  it("derives per-item import idempotency from the request header", async () => {
    const received: Parameters<MemoryPlatform["importMemories"]>[1][] = [];
    const platform = {
      importMemories: async (
        _scope: Parameters<MemoryPlatform["importMemories"]>[0],
        input: Parameters<MemoryPlatform["importMemories"]>[1],
      ) => {
        received.push(input);
        return { imported: [], rejected: [], replayed: [] };
      },
    } as unknown as MemoryPlatform;
    const request = event("/v1/memory/imports", "POST", {
      data: [
        { content: "First", scope: "organization" },
        { content: "Second", scope: "organization" },
        { content: "Third", idempotencyKey: "item-explicit", scope: "organization" },
      ],
      space: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
    });
    const idempotencyKey = "x".repeat(500);

    const first = await handleMemoryApi(
      { ...request, headers: { "idempotency-key": idempotencyKey } },
      { platform },
    );
    const second = await handleMemoryApi(
      { ...request, headers: { "idempotency-key": idempotencyKey } },
      { platform },
    );

    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    const firstKeys = received[0]!.items.map((item) => item.idempotencyKey);
    const secondKeys = received[1]!.items.map((item) => item.idempotencyKey);
    expect(firstKeys).toEqual(secondKeys);
    expect(firstKeys[0]).not.toBe(firstKeys[1]);
    expect(
      firstKeys.slice(0, 2).every((key) => new TextEncoder().encode(key).byteLength <= 500),
    ).toBe(true);
    expect(firstKeys[2]).toBe("item-explicit");
  });

  it("forwards typed memory formation fields", async () => {
    let received: Parameters<MemoryPlatform["importMemories"]>[1] | undefined;
    const platform = {
      importMemories: async (
        _scope: Parameters<MemoryPlatform["importMemories"]>[0],
        input: Parameters<MemoryPlatform["importMemories"]>[1],
      ) => {
        received = input;
        return { imported: [], rejected: [], replayed: [] };
      },
    } as unknown as MemoryPlatform;
    const result = await handleMemoryApi(
      event("/v1/memory/imports", "POST", {
        data: [
          {
            content: "Use the Tuesday deployment window.",
            entityKeys: ["deployment:production"],
            importance: 0.8,
            memoryType: "procedure",
            scope: "organization",
            sourceQuality: 0.9,
            validFrom: "2026-07-25T00:00:00.000Z",
          },
        ],
        space: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
      }),
      { platform },
    );
    expect(result.statusCode).toBe(201);
    expect(received?.items[0]).toMatchObject({
      entityKeys: ["deployment:production"],
      importance: 0.8,
      memoryType: "procedure",
      sourceQuality: 0.9,
      validFrom: "2026-07-25T00:00:00.000Z",
    });
  });

  it("exposes namespace readiness and preparation", async () => {
    const calls: string[] = [];
    const platform = {
      namespaceReadiness: async () => {
        calls.push("readiness");
        return { ready: true };
      },
      prepareNamespaceFullText: async () => {
        calls.push("prepare");
        return { ready: false };
      },
    } as unknown as MemoryPlatform;
    const readiness = await handleMemoryApi(event("/v1/memory/namespaces/readiness", "GET"), {
      platform,
    });
    const preparation = await handleMemoryApi(
      event("/v1/memory/namespaces/prepare-full-text", "POST"),
      { platform },
    );
    expect([readiness.statusCode, preparation.statusCode]).toEqual([200, 202]);
    expect(calls).toEqual(["readiness", "prepare"]);
  });

  it("runs one-shot strategy evidence only with memory admin access", async () => {
    let received: Parameters<MemoryPlatform["search"]>[1] | undefined;
    const platform = {
      search: async (
        _scope: Parameters<MemoryPlatform["search"]>[0],
        input: Parameters<MemoryPlatform["search"]>[1],
      ) => {
        received = input;
        return { attempt: { data: { strategy: input.strategyOverride } }, results: [] };
      },
    } as unknown as MemoryPlatform;
    const request = event("/v1/memory/evidence/strategy-search", "POST", {
      memorySpaceIds: ["01ARZ3NDEKTSV4RRFFQ69G5FA7"],
      query: "deployment marker",
      strategy: "hybrid-rerank-v1",
      topK: 20,
    });

    const allowed = await handleMemoryApi(request, { platform });
    const claims = request.requestContext?.authorizer?.jwt?.claims ?? {};
    const denied = await handleMemoryApi(
      {
        ...request,
        requestContext: {
          ...request.requestContext,
          authorizer: { jwt: { claims: { ...claims, scope: "memory:read" } } },
        },
      },
      { platform },
    );

    expect(allowed.statusCode).toBe(200);
    expect(received).toMatchObject({
      query: "deployment marker",
      strategyOverride: "hybrid-rerank-v1",
      topK: 20,
    });
    await handleMemoryApi(
      event("/v1/memory/evidence/strategy-search", "POST", {
        memorySpaceIds: ["01ARZ3NDEKTSV4RRFFQ69G5FA7"],
        query: "deployment marker",
        strategy: "dense-exact-control-v1",
        topK: 10,
      }),
      { platform },
    );
    expect(received).toMatchObject({
      comparisonPurpose: "quality",
      denseExactControl: true,
      strategyOverride: "dense-v1",
    });
    await handleMemoryApi(
      event("/v1/memory/evidence/strategy-search", "POST", {
        memorySpaceIds: ["01ARZ3NDEKTSV4RRFFQ69G5FA7"],
        query: "deployment marker",
        strategy: "dense-open-search-ann-control-v1",
        topK: 10,
      }),
      { platform },
    );
    expect(received).toMatchObject({
      comparisonPurpose: "quality",
      denseAnnControl: true,
      strategyOverride: "dense-v1",
    });
    expect(denied.statusCode).toBe(403);
    expect(JSON.parse(denied.body ?? "{}")).toMatchObject({ code: "forbidden" });
  });

  it("rejects idempotency keys that exceed the encoded DynamoDB key limit", async () => {
    let called = false;
    const platform = {
      createMemorySpace: async () => {
        called = true;
        return { id: "memory-space-1" };
      },
    } as unknown as MemoryPlatform;
    const request = event("/v1/memory-spaces", "POST", { name: "Ops" });

    const result = await handleMemoryApi(
      { ...request, headers: { "Idempotency-Key": "/".repeat(400) } },
      { platform },
    );

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body ?? "{}")).toMatchObject({ code: "invalid_idempotency_key" });
    expect(called).toBe(false);
  });

  it("forwards lifecycle idempotency keys", async () => {
    const calls: unknown[] = [];
    const platform = {
      archiveMemory: async (
        _scope: Parameters<MemoryPlatform["archiveMemory"]>[0],
        memoryId: Parameters<MemoryPlatform["archiveMemory"]>[1],
        options: Parameters<MemoryPlatform["archiveMemory"]>[2],
      ) => {
        calls.push({ memoryId, options });
        return { data: { id: memoryId, status: "archived" } };
      },
    } as unknown as MemoryPlatform;
    const request = event("/v1/memory/01ARZ3NDEKTSV4RRFFQ69G5FA3/archive", "POST");

    const result = await handleMemoryApi(
      { ...request, headers: { "idempotency-key": "archive-request" } },
      { platform },
    );

    expect(result.statusCode).toBe(200);
    expect(calls).toEqual([
      {
        memoryId: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
        options: { idempotencyKey: "archive-request" },
      },
    ]);
  });

  it("rejects client-supplied memory provenance and memory-space policy", async () => {
    const platform = {} as MemoryPlatform;
    const imported = await handleMemoryApi(
      event("/v1/memory/imports", "POST", {
        data: [{ content: "Forged provenance", scope: "organization", source: "tool" }],
        space: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
      }),
      { platform },
    );
    const runAttributed = await handleMemoryApi(
      event("/v1/memory/imports", "POST", {
        data: [
          {
            content: "Forged run provenance",
            scope: "organization",
            sourceRunId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
          },
        ],
        space: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
      }),
      { platform },
    );
    const space = await handleMemoryApi(
      event("/v1/memory-spaces", "POST", {
        name: "Unsupported inline policy",
        policy: { retentionDays: 30 },
      }),
      { platform },
    );
    const oversized = await handleMemoryApi(
      event("/v1/memory/imports", "POST", {
        data: Array.from({ length: 101 }, () => null),
        space: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
      }),
      { platform },
    );

    expect(imported.statusCode).toBe(400);
    expect(JSON.parse(imported.body ?? "{}")).toMatchObject({ code: "invalid_import" });
    expect(runAttributed.statusCode).toBe(400);
    expect(JSON.parse(runAttributed.body ?? "{}")).toMatchObject({ code: "invalid_import" });
    expect(oversized.statusCode).toBe(400);
    expect(JSON.parse(oversized.body ?? "{}")).toMatchObject({
      code: "invalid_import",
      detail: "data must contain between 1 and 100 items.",
    });
    expect(space.statusCode).toBe(400);
    expect(JSON.parse(space.body ?? "{}")).toMatchObject({ code: "unsupported_field" });
  });
});
