import type { Ulid } from "@deployments-ai/db";
import { Effect } from "effect";
import {
  loadActiveMemoryEmbeddingProfile,
  memoryEmbeddingRouteRequest,
  memoryEmbeddingRouteScope,
  validateMemoryEmbeddingProfile,
  validateMemoryEmbeddingRoute,
} from "./embedding-profile.ts";
import { runtimeModelComponents } from "./runtime.ts";

export async function runtimeProvisioningEvidenceEmbedding(input: {
  readonly content: string;
  readonly embeddingProfileId: Ulid;
  readonly environmentId: Ulid;
  readonly operationId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
}) {
  const { database, gateway, usage } = await runtimeModelComponents();
  const profile = await loadActiveMemoryEmbeddingProfile(database, input.embeddingProfileId);
  const scope = memoryEmbeddingRouteScope(input.organizationId);
  const routeRequest = memoryEmbeddingRouteRequest(profile, scope);
  const route = await Effect.runPromise(gateway.resolveRoute(routeRequest));
  validateMemoryEmbeddingRoute(profile, route);
  const result = await Effect.runPromise(
    gateway.embedding({
      dimensions: profile.data.dimensions,
      ...(routeRequest.fallbackModelIds ? { fallbackModelIds: routeRequest.fallbackModelIds } : {}),
      input: input.content,
      modelCallId: input.operationId,
      modelId: profile.data.gatewayModel,
      resolvedRoute: route,
      runId: input.operationId,
      scope,
    }),
  );
  if (result.usage) {
    await Effect.runPromise(
      usage.record(result.usage, {
        environmentId: input.environmentId,
        operationId: input.operationId,
        operationType: "memory-search-provisioning-evidence",
        organizationId: input.organizationId,
        projectId: input.projectId,
        workspaceId: undefined,
      }),
    );
  }
  return {
    embedding: validateMemoryEmbeddingProfile(profile, route, result),
    model: result.modelId,
    provider: result.provider,
  };
}
