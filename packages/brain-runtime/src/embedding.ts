import type { BrainEmbeddingPort, BrainQueryEmbeddingPort } from "@deployments-ai/brains";
import {
  canonicalRecordKeys,
  getBrainSearchPlacement,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
  brainRuntimePersistence,
} from "@deployments-ai/db";
import {
  ModelGatewayEmbeddingResponseError,
  modelGatewayRouteIdentity,
  modelUsageAttemptCallId,
  type ModelGatewayService,
  type ResolveModelRouteRequest,
} from "@deployments-ai/model-gateway";
import { Effect } from "effect";
import { createHash, randomUUID } from "node:crypto";
import { deterministicBrainRunId, type BrainModelUsageRecorder } from "./usage-identity.ts";
import { loadBrainModelGateway, type BrainModelGateway } from "./gateway-loader.ts";

type EmbeddingProfile = Extract<PlatformRecord, { readonly itemType: "memory-embedding-profile" }>;

export async function loadBrainEmbeddingProfile(database: DynamoDatabaseService, profileId: Ulid) {
  const value = await brainRuntimePersistence.read(
    database,
    "control",
    canonicalRecordKeys(
      { data: { id: profileId }, itemType: "memory-embedding-profile" },
      "control",
    ),
    true,
  );
  if (value?.itemType !== "memory-embedding-profile" || value.data.status !== "active") {
    throw new TypeError("Brain embedding profile is unavailable.");
  }
  return value;
}

function routeRequest(profile: EmbeddingProfile, organizationId: string): ResolveModelRouteRequest {
  let identity: unknown;
  try {
    identity = JSON.parse(profile.data.gatewayRoute);
  } catch (cause) {
    throw new TypeError("Brain embedding profile route identity is invalid.", { cause });
  }
  const fallbackModelIds =
    identity && typeof identity === "object" && "fallbackModelIds" in identity
      ? (identity as Readonly<Record<string, unknown>>).fallbackModelIds
      : undefined;
  if (
    !Array.isArray(fallbackModelIds) ||
    fallbackModelIds.some(
      (modelId) => typeof modelId !== "string" || !modelId || modelId.trim() !== modelId,
    )
  ) {
    throw new TypeError("Brain embedding profile fallback models are invalid.");
  }
  return {
    fallbackModelIds: fallbackModelIds as string[],
    modelId: profile.data.gatewayModel,
    routeIdentity: profile.data.gatewayRoute,
    scope: { organizationId },
  };
}

function normalize(profile: EmbeddingProfile, embedding: readonly number[]) {
  if (
    embedding.length !== profile.data.dimensions ||
    embedding.some((component) => !Number.isFinite(component))
  ) {
    throw new Error("Brain embedding dimensions or values do not match the immutable profile.");
  }
  if (profile.data.normalization === "none") return embedding;
  const norm = Math.hypot(...embedding);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new Error("Brain embedding cannot be L2-normalized.");
  }
  return embedding.map((component) => component / norm);
}

export function makeBrainQueryEmbeddingPort(input: {
  readonly database: DynamoDatabaseService;
  readonly gateway: BrainModelGateway;
  readonly recordUsage?: BrainModelUsageRecorder;
}): BrainQueryEmbeddingPort {
  return {
    async embedQuery(request) {
      const placement = await getBrainSearchPlacement(input.database, request.organizationId);
      const target = placement?.data.phase === "active" ? placement.data.readTarget : undefined;
      if (!target || !target.embeddingProfileId) {
        throw new Error("Brain search has no active embedding profile.");
      }
      const profile = await loadBrainEmbeddingProfile(input.database, target.embeddingProfileId);
      if (profile.data.distanceMetric !== "cosine") {
        throw new Error("Brain search requires a cosine embedding profile.");
      }
      if (profile.data.processingBoundary !== "platform-approved") {
        throw new Error("Brain query embedding requires a platform-approved processing boundary.");
      }
      const gateway = await loadBrainModelGateway(input.gateway);
      const routing = routeRequest(profile, request.organizationId);
      const resolvedRoute = await Effect.runPromise(gateway.resolveRoute(routing));
      if (profile.data.gatewayRoute !== modelGatewayRouteIdentity(resolvedRoute)) {
        throw new Error("Brain embedding route changed from its immutable profile.");
      }
      const correlation = createHash("sha256")
        .update(`${request.usageOperationId}\0${request.organizationId}\0${request.query}`)
        .digest("hex");
      const operationId = deterministicBrainRunId("brain-query", correlation);
      let result;
      try {
        result = await Effect.runPromise(
          gateway.embedding({
            dimensions: profile.data.dimensions,
            ...(routing.fallbackModelIds ? { fallbackModelIds: routing.fallbackModelIds } : {}),
            input: request.query,
            modelCallId: modelUsageAttemptCallId(`brain-query:${correlation}`, randomUUID()),
            modelId: profile.data.gatewayModel,
            resolvedRoute,
            runId: operationId,
            scope: { organizationId: request.organizationId },
            ...(request.signal ? { signal: request.signal } : {}),
          }),
        );
      } catch (cause) {
        if (
          cause instanceof ModelGatewayEmbeddingResponseError &&
          cause.usage &&
          request.usageScope &&
          input.recordUsage
        ) {
          await input.recordUsage({
            entry: cause.usage,
            operationId,
            operationType: "brain-query-embedding",
            scope: request.usageScope,
          });
        }
        throw cause;
      }
      if (result.usage && request.usageScope && input.recordUsage) {
        await input.recordUsage({
          entry: result.usage,
          operationId,
          operationType: "brain-query-embedding",
          scope: request.usageScope,
        });
      }
      if (
        result.modelId !== profile.data.gatewayModel ||
        result.provider !== resolvedRoute.provider
      ) {
        throw new Error("Brain embedding provenance does not match its immutable profile.");
      }
      return normalize(profile, result.embedding);
    },
  };
}

export function makeBrainIndexEmbeddingPort(input: {
  readonly database: DynamoDatabaseService;
  readonly gateway: ModelGatewayService;
  readonly organizationId: string;
  readonly profileId: Ulid;
}): BrainEmbeddingPort {
  const profile = loadBrainEmbeddingProfile(input.database, input.profileId);
  return {
    async embed(request) {
      const activeProfile = await profile;
      if (
        activeProfile.data.distanceMetric !== "cosine" ||
        activeProfile.data.processingBoundary !== "platform-approved"
      ) {
        throw new Error("Brain indexing requires an approved cosine embedding profile.");
      }
      const routing = routeRequest(activeProfile, input.organizationId);
      const resolvedRoute = await Effect.runPromise(input.gateway.resolveRoute(routing));
      if (activeProfile.data.gatewayRoute !== modelGatewayRouteIdentity(resolvedRoute)) {
        throw new Error("Brain embedding route changed from its immutable profile.");
      }
      const result = await Effect.runPromise(
        input.gateway.embedding({
          dimensions: activeProfile.data.dimensions,
          ...(routing.fallbackModelIds ? { fallbackModelIds: routing.fallbackModelIds } : {}),
          input: request.text,
          modelCallId: request.modelCallId,
          modelId: activeProfile.data.gatewayModel,
          resolvedRoute,
          runId: deterministicBrainRunId("brain-index", request.modelCallId),
          scope: { organizationId: input.organizationId },
        }),
      );
      if (
        result.modelId !== activeProfile.data.gatewayModel ||
        result.provider !== resolvedRoute.provider
      ) {
        throw new Error("Brain embedding provenance does not match its immutable profile.");
      }
      // Indexing is organization-global and has no canonical project/environment
      // attribution. Do not fabricate a tenant meter event for provider usage here.
      return normalize(activeProfile, result.embedding);
    },
  };
}
