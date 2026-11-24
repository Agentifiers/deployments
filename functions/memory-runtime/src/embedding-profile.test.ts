import { describe, expect, it } from "bun:test";
import { type DynamoDatabaseService } from "@deployments-ai/db";
import {
  loadActiveMemoryEmbeddingProfile,
  loadMemoryEmbeddingProfile,
  memoryEmbeddingRouteRequest,
  memoryEmbeddingRouteScope,
  memoryGatewayRouteIdentity,
  validateMemoryEmbeddingProfile,
  validateMemoryEmbeddingRoute,
} from "./embedding-profile.ts";

const route = {
  bifrostModelId: "text-embedding-3-small",
  fallbackModelIds: [],
  modelId: "openai/text-embedding-3-small",
  provider: "openai" as const,
  providerModelId: "text-embedding-3-small",
  requestedModelId: "openai/text-embedding-3-small",
};

function profile(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    data: {
      dimensions: 3,
      distanceMetric: "cosine",
      gatewayModel: route.modelId,
      gatewayRoute: memoryGatewayRouteIdentity(route),
      normalization: "l2",
      processingBoundary: "platform-approved",
      ...overrides,
    },
    itemType: "memory-embedding-profile",
  } as never;
}

describe("memory embedding profile enforcement", () => {
  it("uses one stable organization route scope across provisioning and data-plane calls", () => {
    expect(memoryEmbeddingRouteScope("org_1")).toEqual({ organizationId: "org_1" });
  });

  it("preserves ordered fallback models from the immutable route identity", () => {
    const fallbackModelIds = ["openrouter/fallback-a", "openrouter/fallback-b"];
    const fallbackRoute = { ...route, fallbackModelIds };
    const scope = memoryEmbeddingRouteScope("org_1");

    expect(
      memoryEmbeddingRouteRequest(
        profile({ gatewayRoute: memoryGatewayRouteIdentity(fallbackRoute) }),
        scope,
      ),
    ).toEqual({
      fallbackModelIds,
      modelId: route.modelId,
      routeIdentity: memoryGatewayRouteIdentity(fallbackRoute),
      scope,
    });
  });

  it("rejects a malformed fallback list before resolving a gateway route", () => {
    expect(() =>
      memoryEmbeddingRouteRequest(
        profile({ gatewayRoute: JSON.stringify({ fallbackModelIds: [" fallback"] }) }),
        memoryEmbeddingRouteScope("org_1"),
      ),
    ).toThrow("fallback");
  });

  it("loads retired immutable profiles for cleanup but rejects them for new embeddings", async () => {
    const retired = {
      data: { dimensions: 3, id: "01ARZ3NDEKTSV4RRFFQ69G5FA1", status: "retired" },
      itemType: "memory-embedding-profile",
    } as never;
    const database = {
      getRecord: async () => retired,
    } as unknown as DynamoDatabaseService;

    expect(
      loadMemoryEmbeddingProfile(database, "01ARZ3NDEKTSV4RRFFQ69G5FA1" as never),
    ).resolves.toBe(retired);
    expect(
      loadActiveMemoryEmbeddingProfile(database, "01ARZ3NDEKTSV4RRFFQ69G5FA1" as never),
    ).rejects.toThrow("inactive");
  });

  it("validates route provenance and applies declared L2 normalization", () => {
    validateMemoryEmbeddingRoute(profile(), route);
    const vector = validateMemoryEmbeddingProfile(profile(), route, {
      body: {},
      embedding: [3, 0, 4],
      modelId: route.modelId,
      provider: route.provider,
    });
    expect(vector).toEqual([0.6, 0, 0.8]);
  });

  it("rejects a fallback model vector from an immutable primary-model profile", () => {
    const fallbackModelId = "openai/text-embedding-3-large";
    const fallbackRoute = { ...route, fallbackModelIds: [fallbackModelId] };

    expect(() =>
      validateMemoryEmbeddingProfile(
        profile({ gatewayRoute: memoryGatewayRouteIdentity(fallbackRoute) }),
        fallbackRoute,
        {
          body: { model: "text-embedding-3-large" },
          embedding: [1, 0, 0],
          modelId: fallbackModelId,
          provider: "openai",
        },
      ),
    ).toThrow("model provenance");
  });

  it("rejects drift in every physical embedding route field", () => {
    const driftedRoutes = [
      { ...route, bifrostModelId: "different-physical-model" },
      { ...route, fallbackModelIds: ["openrouter/fallback"] },
      { ...route, providerModelId: "different-provider-model" },
      { ...route, requestedModelId: "text-embedding-3-small" },
      { ...route, routeScopeRef: "workspace:other" },
    ];

    for (const drifted of driftedRoutes) {
      expect(() => validateMemoryEmbeddingRoute(profile(), drifted)).toThrow("immutable");
    }
  });

  it("rejects an AWS-only profile before a non-AWS embedding request", () => {
    expect(() =>
      validateMemoryEmbeddingRoute(profile({ processingBoundary: "aws" }), route),
    ).toThrow("AWS-only");
  });
});
