import {
  canonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
  memoryRuntimePersistence,
} from "@deployments-ai/db";
import type {
  ModelGatewayEmbeddingResult,
  ModelGatewayRoute,
  ModelGatewayRouteScope,
  ResolveModelRouteRequest,
} from "@deployments-ai/model-gateway";
import { modelGatewayRouteIdentity } from "@deployments-ai/model-gateway";

type EmbeddingProfile = Extract<PlatformRecord, { readonly itemType: "memory-embedding-profile" }>;

export function memoryEmbeddingRouteScope(organizationId: string): ModelGatewayRouteScope {
  return { organizationId };
}

export { modelGatewayRouteIdentity as memoryGatewayRouteIdentity };

export function memoryEmbeddingRouteRequest(
  profile: EmbeddingProfile,
  scope: ModelGatewayRouteScope,
): ResolveModelRouteRequest {
  let identity: unknown;
  try {
    identity = JSON.parse(profile.data.gatewayRoute);
  } catch (cause) {
    throw new TypeError("Memory embedding profile has an invalid gateway route identity.", {
      cause,
    });
  }
  const fallbackModelIds =
    identity && typeof identity === "object" && "fallbackModelIds" in identity
      ? (identity as Readonly<Record<string, unknown>>).fallbackModelIds
      : undefined;
  if (
    !Array.isArray(fallbackModelIds) ||
    fallbackModelIds.some(
      (modelId) =>
        typeof modelId !== "string" || modelId.length === 0 || modelId.trim() !== modelId,
    )
  ) {
    throw new TypeError("Memory embedding profile has invalid gateway fallback models.");
  }
  return {
    fallbackModelIds: [...fallbackModelIds] as string[],
    modelId: profile.data.gatewayModel,
    routeIdentity: profile.data.gatewayRoute,
    scope,
  };
}

export async function loadMemoryEmbeddingProfile(database: DynamoDatabaseService, profileId: Ulid) {
  const value = await memoryRuntimePersistence.read(
    database,
    "control",
    canonicalRecordKeys(
      { data: { id: profileId }, itemType: "memory-embedding-profile" },
      "control",
    ),
    true,
  );
  if (!value || value.itemType !== "memory-embedding-profile") {
    throw new TypeError("Memory embedding profile is unavailable.");
  }
  return value;
}

export async function loadActiveMemoryEmbeddingProfile(
  database: DynamoDatabaseService,
  profileId: Ulid,
) {
  const profile = await loadMemoryEmbeddingProfile(database, profileId);
  if (profile.data.status !== "active") {
    throw new TypeError("Memory embedding profile is unavailable or inactive.");
  }
  return profile;
}

export function validateMemoryEmbeddingRoute(profile: EmbeddingProfile, route: ModelGatewayRoute) {
  if (profile.data.gatewayRoute !== modelGatewayRouteIdentity(route)) {
    throw new Error("Embedding gateway route does not match the immutable memory profile.");
  }
  if (profile.data.processingBoundary === "aws") {
    throw new Error("No AWS-hosted embedding route currently satisfies the AWS-only boundary.");
  }
  if (profile.data.distanceMetric !== "cosine") {
    throw new Error("The deployed memory providers require a cosine embedding profile.");
  }
}

export function validateMemoryEmbeddingProfile(
  profile: EmbeddingProfile,
  route: ModelGatewayRoute,
  result: ModelGatewayEmbeddingResult,
) {
  validateMemoryEmbeddingRoute(profile, route);
  if (result.modelId !== profile.data.gatewayModel || result.provider !== route.provider) {
    throw new Error("Embedding model provenance does not match the immutable memory profile.");
  }
  if (
    result.embedding.length !== profile.data.dimensions ||
    result.embedding.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("Embedding dimensions or values do not match the immutable memory profile.");
  }
  if (profile.data.normalization === "none") return result.embedding;
  const norm = Math.hypot(...result.embedding);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new Error("Embedding cannot be L2-normalized for the immutable memory profile.");
  }
  return result.embedding.map((value) => value / norm);
}
