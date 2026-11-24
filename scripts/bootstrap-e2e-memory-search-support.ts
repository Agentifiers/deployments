import {
  MemorySearchMutationFenceRecord,
  MemorySearchPlacementRecord,
  Ulid,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import {
  AWS_NATIVE_AUTOMATED_SNAPSHOT_RETENTION_HOURS,
  AWS_NATIVE_BACKUP_SAFETY_MARGIN_MINUTES,
  AWS_NATIVE_OPEN_SEARCH_SCHEMA_VERSION,
  type MemorySearchTarget,
} from "@deployments-ai/memory";
import { modelGatewayRouteIdentity } from "@deployments-ai/model-gateway";
import { createHash } from "node:crypto";
import { Schema } from "effect";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const EMBEDDING_MODEL = "openrouter/openai/text-embedding-3-small";

export function deterministicE2eMemoryId(organizationId: typeof Ulid.Type, kind: string) {
  const bytes = createHash("sha256")
    .update(`${organizationId}:e2e-memory-search:${kind}`)
    .digest()
    .subarray(0, 10);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let suffix = "";
  for (let index = 0; index < 16; index += 1) {
    suffix = CROCKFORD[Number(value & 31n)]! + suffix;
    value >>= 5n;
  }
  return Schema.decodeUnknownSync(Ulid)(`${organizationId.slice(0, 10)}${suffix}`);
}

export function e2eMemorySearchEnvelope(organizationId: typeof Ulid.Type, timestamp: string) {
  const placement = Schema.decodeUnknownSync(MemorySearchPlacementRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: timestamp,
        generation: 0,
        organizationId,
        phase: "unconfigured" as const,
        updatedAt: timestamp,
        version: 0,
        writeTargets: [],
      },
      itemType: "memory-search-placement" as const,
    }),
  );
  const fence = Schema.decodeUnknownSync(MemorySearchMutationFenceRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: timestamp,
        epoch: 0,
        organizationId,
        status: "open" as const,
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "memory-search-mutation-fence" as const,
    }),
  );
  return { fence, placement };
}

export function e2eMemorySearchCatalog(
  organizationId: typeof Ulid.Type,
  openSearchEndpoint: string,
  region: string,
) {
  // Catalog records are immutable, so each search domain gets its own deterministic catalog and
  // target: re-running against one domain is idempotent, and a replaced domain migrates.
  const domain = new URL(openSearchEndpoint).host;
  const id = (kind: string) => deterministicE2eMemoryId(organizationId, `${kind}:${domain}`);
  const profileId = id("embedding-profile");
  const generationId = id("generation");
  const componentId = id("component");
  const targetId = id("target");
  const location = {
    automatedSnapshotRetentionHours: AWS_NATIVE_AUTOMATED_SNAPSHOT_RETENTION_HOURS,
    backupSafetyMarginMinutes: AWS_NATIVE_BACKUP_SAFETY_MARGIN_MINUTES,
    embeddingDimensions: 1536,
    openSearchEndpoint,
    openSearchIndex: `memory-${organizationId.toLowerCase()}-v1`,
    region,
  };
  const target: MemorySearchTarget = {
    componentIds: [componentId],
    embeddingProfileId: profileId,
    location,
    providerId: "aws-native",
    schemaGeneration: AWS_NATIVE_OPEN_SEARCH_SCHEMA_VERSION,
    targetId,
  };
  return {
    catalog: {
      components: [
        {
          componentKind: "dense" as const,
          embeddingProfileId: profileId,
          generationId,
          id: componentId,
          location,
          providerId: "aws-native" as const,
          schemaGeneration: AWS_NATIVE_OPEN_SEARCH_SCHEMA_VERSION,
        },
      ],
      generations: [
        {
          componentKind: "dense" as const,
          generation: AWS_NATIVE_OPEN_SEARCH_SCHEMA_VERSION,
          id: generationId,
          location,
          providerId: "aws-native" as const,
        },
      ],
      profile: {
        dimensions: 1536,
        distanceMetric: "cosine" as const,
        gatewayModel: EMBEDDING_MODEL,
        gatewayRoute: modelGatewayRouteIdentity({
          bifrostModelId: EMBEDDING_MODEL,
          fallbackModelIds: [],
          modelId: EMBEDDING_MODEL,
          provider: "openrouter",
          providerModelId: "openai/text-embedding-3-small",
          requestedModelId: EMBEDDING_MODEL,
          routeScopeRef: `organization:${organizationId}`,
        }),
        id: profileId,
        normalization: "l2" as const,
        processingBoundary: "platform-approved" as const,
      },
    },
    componentId,
    generationId,
    profileId,
    target,
  };
}

/** Whether `current` already serves the expected target's OpenSearch domain, index, and region. */
export function e2eMemoryTargetLocationMatches(
  current: MemorySearchTarget,
  expected: MemorySearchTarget,
) {
  const origin = (target: MemorySearchTarget) => {
    const endpoint = target.location.openSearchEndpoint;
    return typeof endpoint === "string" ? new URL(endpoint).origin : undefined;
  };
  return (
    current.providerId === expected.providerId &&
    origin(current) === origin(expected) &&
    current.location.openSearchIndex === expected.location.openSearchIndex &&
    current.location.region === expected.location.region
  );
}

export function e2eMemoryCatalogMatches(
  records: readonly PlatformRecord[],
  expected: ReturnType<typeof e2eMemorySearchCatalog>,
) {
  const canonicalJson = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    return `{${Object.entries(value as Readonly<Record<string, unknown>>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  };
  const profile = records.find((record) => record.itemType === "memory-embedding-profile");
  const generation = records.find((record) => record.itemType === "memory-search-generation");
  const component = records.find((record) => record.itemType === "memory-search-component");
  return (
    profile?.itemType === "memory-embedding-profile" &&
    profile.data.id === expected.profileId &&
    profile.data.status === "active" &&
    profile.data.dimensions === expected.catalog.profile.dimensions &&
    profile.data.distanceMetric === expected.catalog.profile.distanceMetric &&
    profile.data.gatewayModel === expected.catalog.profile.gatewayModel &&
    profile.data.gatewayRoute === expected.catalog.profile.gatewayRoute &&
    profile.data.normalization === expected.catalog.profile.normalization &&
    profile.data.processingBoundary === expected.catalog.profile.processingBoundary &&
    generation?.itemType === "memory-search-generation" &&
    generation.data.id === expected.generationId &&
    generation.data.status === "active" &&
    generation.data.componentKind === "dense" &&
    generation.data.generation === expected.target.schemaGeneration &&
    generation.data.providerId === expected.target.providerId &&
    canonicalJson(generation.data.location) === canonicalJson(expected.target.location) &&
    component?.itemType === "memory-search-component" &&
    component.data.id === expected.componentId &&
    component.data.status === "active" &&
    component.data.componentKind === "dense" &&
    component.data.embeddingProfileId === expected.profileId &&
    component.data.generationId === expected.generationId &&
    component.data.providerId === expected.target.providerId &&
    component.data.schemaGeneration === expected.target.schemaGeneration &&
    canonicalJson(component.data.location) === canonicalJson(expected.target.location)
  );
}
