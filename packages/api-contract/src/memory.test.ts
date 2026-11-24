import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  CreateMemorySpaceRequest,
  ExportMemoriesRequest,
  ImportMemoriesRequest,
  MEMORY_API_ROUTES,
  MEMORY_API_SCHEMAS,
  MemoryListQuery,
  SearchMemoriesRequest,
  StrategySearchMemoriesRequest,
  UpsertMemoryPolicyRequest,
} from "./memory.ts";
import { makePublicOpenApiSpec } from "./openapi.ts";

describe("memory API contract", () => {
  test("publishes 28 unique deployed operations", () => {
    expect(MEMORY_API_ROUTES).toHaveLength(28);
    expect(new Set(MEMORY_API_ROUTES.map((route) => route.name)).size).toBe(28);
    expect(new Set(MEMORY_API_ROUTES.map((route) => `${route.method} ${route.path}`)).size).toBe(
      28,
    );
  });

  test("matches representative runtime request limits", () => {
    const decodeSearch = Schema.decodeUnknownSync(SearchMemoriesRequest);
    const search = {
      memorySpaceIds: ["01ARZ3NDEKTSV4RRFFQ69G5FAV"],
      query: "deployment window",
    };
    expect(() =>
      decodeSearch({
        ...search,
        memorySpaceIds: Array.from({ length: 20 }, () => "01ARZ3NDEKTSV4RRFFQ69G5FAV"),
        searchKeys: Array.from({ length: 50 }, (_, index) => `key:${index}`),
        topK: 45,
      }),
    ).not.toThrow();
    expect(() =>
      decodeSearch({
        ...search,
        memorySpaceIds: Array.from({ length: 21 }, () => "01ARZ3NDEKTSV4RRFFQ69G5FAV"),
      }),
    ).toThrow();
    expect(() => decodeSearch({ ...search, topK: 46 })).toThrow();
    expect(() => decodeSearch({ query: "deployment window" })).toThrow();

    const decodeStrategy = Schema.decodeUnknownSync(StrategySearchMemoriesRequest);
    expect(() => decodeStrategy({ ...search, strategy: "hybrid-rerank-v1" })).not.toThrow();
    expect(() =>
      decodeStrategy({
        ...search,
        strategy: "dense-open-search-ann-control-v1",
      }),
    ).not.toThrow();
    expect(() => decodeStrategy({ ...search, strategy: "dense-exact-control-v1" })).not.toThrow();
    expect(() => decodeStrategy({ ...search, strategy: "dense-v1" })).toThrow();
    expect(() =>
      decodeStrategy({
        query: "deployment window",
        strategy: "hybrid-rerank-v1",
      }),
    ).toThrow();

    const decodeImport = Schema.decodeUnknownSync(ImportMemoriesRequest);
    const item = { content: "Remember this", scope: "organization" };
    expect(() =>
      decodeImport({
        data: Array.from({ length: 100 }, () => item),
        space: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      }),
    ).not.toThrow();
    expect(() =>
      decodeImport({
        data: Array.from({ length: 101 }, () => item),
        space: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      }),
    ).toThrow();
    expect(() =>
      decodeImport({
        data: [{ ...item, idempotencyKey: `key${" ".repeat(498)}` }],
        space: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      }),
    ).toThrow();
    expect(() => decodeImport({ data: [item] })).toThrow();

    const decodeExport = Schema.decodeUnknownSync(ExportMemoriesRequest);
    expect(() => decodeExport({})).toThrow();

    const decodeList = Schema.decodeUnknownSync(MemoryListQuery);
    expect(() => decodeList({ limit: 200 })).not.toThrow();
    expect(() => decodeList({ limit: 201 })).toThrow();

    const decodeSpace = Schema.decodeUnknownSync(CreateMemorySpaceRequest);
    expect(() => decodeSpace({ name: "Operations", retentionDays: 1 })).not.toThrow();
    expect(() => decodeSpace({ name: "Operations", retentionDays: 1.5 })).toThrow();
    expect(() => decodeSpace({ name: "Operations", retentionDays: 3_651 })).toThrow();

    const decodePolicy = Schema.decodeUnknownSync(UpsertMemoryPolicyRequest);
    expect(() => decodePolicy({ activeRecallRolloutPercent: 0 })).not.toThrow();
    expect(() => decodePolicy({ activeRecallRolloutPercent: 100 })).not.toThrow();
    expect(() => decodePolicy({ activeRecallRolloutPercent: -1 })).toThrow();
    expect(() => decodePolicy({ activeRecallRolloutPercent: 101 })).toThrow();
  });

  test("references registered request and response schemas", () => {
    for (const route of MEMORY_API_ROUTES) {
      expect(MEMORY_API_SCHEMAS).toHaveProperty(route.responseBody);
      if ("requestBody" in route && route.requestBody) {
        expect(MEMORY_API_SCHEMAS).toHaveProperty(route.requestBody);
      }
    }
  });

  test("publishes cross-field memory-space requirements in OpenAPI", () => {
    const schemas = makePublicOpenApiSpec().components.schemas as Readonly<
      Record<
        string,
        {
          readonly anyOf?: readonly { readonly required?: readonly string[] }[];
        }
      >
    >;
    const alternatives = [
      ["ImportMemoriesRequest", "memorySpaceId", "space"],
      ["ExportMemoriesRequest", "memorySpaceId", "space"],
      ["SearchMemoriesRequest", "memorySpaceIds", "space"],
      ["StrategySearchMemoriesRequest", "memorySpaceIds", "space"],
    ] as const;

    for (const [name, firstSelector, secondSelector] of alternatives) {
      const variants = schemas[name]?.anyOf ?? [];
      expect(variants).toHaveLength(2);
      expect(variants.some((variant) => variant.required?.includes(firstSelector))).toBe(true);
      expect(variants.some((variant) => variant.required?.includes(secondSelector))).toBe(true);
      expect(
        variants.every(
          (variant) =>
            variant.required?.includes(firstSelector) || variant.required?.includes(secondSelector),
        ),
      ).toBe(true);
    }
  });

  test("declares tenant JWT authorization, capabilities, and idempotency", () => {
    for (const route of MEMORY_API_ROUTES) {
      expect(route.authentication).toBe("tenant-jwt");
      expect(route.scopeHeaders).toBe("optional-tenant");
      expect(route.tag).toBe("Memory");
      expect(route.idempotency).toBe(route.method === "GET" ? "none" : "optional");
    }

    expect(MEMORY_API_ROUTES.find((route) => route.name === "searchMemories")).toMatchObject({
      requiredAuthorization: "memory:read",
    });
    expect(MEMORY_API_ROUTES.find((route) => route.name === "importMemories")).toMatchObject({
      requiredAuthorization: "memory:write",
      successStatus: 201,
    });
    expect(MEMORY_API_ROUTES.find((route) => route.name === "listMemories")).toMatchObject({
      requiredAuthorization: "memory:admin",
    });
    expect(MEMORY_API_ROUTES.find((route) => route.name === "activeMemoryRecall")).toMatchObject({
      requiredAuthorization: "memory:execute",
    });
  });

  test("describes route-specific query bounds", () => {
    const memoryList = MEMORY_API_ROUTES.find((route) => route.name === "listMemories");
    const memoryLimit = memoryList?.queryParameters?.find(
      (parameter) => parameter.name === "limit",
    );
    expect(memoryLimit?.schema).toMatchObject({
      maximum: 20,
      minimum: 1,
      type: "integer",
    });

    const quality = MEMORY_API_ROUTES.find((route) => route.name === "getMemoryQuality");
    const qualityLimit = quality?.queryParameters?.find((parameter) => parameter.name === "limit");
    expect(qualityLimit?.schema).toMatchObject({
      maximum: 5_000,
      minimum: 1,
      type: "integer",
    });

    const grants = MEMORY_API_ROUTES.find((route) => route.name === "listMemorySpaceGrants");
    expect(grants?.queryParameters?.map((parameter) => parameter.name)).toEqual([
      "cursor",
      "limit",
      "agentDefinitionId",
      "memorySpaceId",
      "status",
    ]);
  });
});
