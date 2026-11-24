import {
  canonicalRecordKeys,
  ensureMemorySearchPlacement,
  memoryRuntimePersistence,
  Ulid,
  type DynamoDatabaseService,
  type PlatformRecord,
} from "@deployments-ai/db";
import {
  AWS_NATIVE_AUTOMATED_SNAPSHOT_RETENTION_HOURS,
  AWS_NATIVE_BACKUP_SAFETY_MARGIN_MINUTES,
  AWS_NATIVE_OPEN_SEARCH_SCHEMA_VERSION,
  type MemorySearchCatalogRegistration,
  type MemorySearchTarget,
} from "@deployments-ai/memory";
import { modelGatewayRouteIdentity, resolveModelRoute } from "@deployments-ai/model-gateway";
import { Schema } from "effect";
import { createHash } from "node:crypto";

type Placement = Extract<PlatformRecord, { readonly itemType: "memory-search-placement" }>;
type Provisioning = Extract<PlatformRecord, { readonly itemType: "memory-search-provisioning" }>;

/** The control-plane steps default activation uses; `makeMemorySearchControlPlane` provides them. */
export interface DefaultMemorySearchControl {
  readonly registerCatalog: (catalog: MemorySearchCatalogRegistration) => Promise<unknown>;
  readonly requestProvisioning: (input: {
    readonly evidenceKeys: readonly string[];
    readonly organizationId: Ulid;
    readonly target: MemorySearchTarget;
  }) => Promise<{ readonly operation: Provisioning }>;
}

/** One organization's default catalog and the AWS-native target provisioned from it. */
export interface DefaultMemorySearchCatalog {
  readonly catalog: MemorySearchCatalogRegistration;
  readonly componentId: Ulid;
  readonly generationId: Ulid;
  readonly profileId: Ulid;
  readonly target: MemorySearchTarget;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DEFAULT_EVIDENCE_KEYS = ["dense", "exact", "lexical", "cleanup"] as const;

/** The install's default memory search target: the stack-owned OpenSearch domain and embedding route. */
export interface DefaultMemorySearchConfig {
  readonly embeddingDimensions: number;
  readonly embeddingModel: string;
  readonly openSearchEndpoint: string;
  readonly region: string;
}

export function defaultMemorySearchConfigFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DefaultMemorySearchConfig {
  const required = (name: string) => {
    const value = environment[name]?.trim();
    if (!value) throw new TypeError(`${name} is required for default memory search activation.`);
    return value;
  };
  const embeddingDimensions = Number(required("DEPLOYMENTS_AI_MEMORY_EMBEDDING_DIMENSIONS"));
  if (!Number.isSafeInteger(embeddingDimensions) || embeddingDimensions <= 0) {
    throw new TypeError("DEPLOYMENTS_AI_MEMORY_EMBEDDING_DIMENSIONS must be a positive integer.");
  }
  return {
    embeddingDimensions,
    embeddingModel: required("DEPLOYMENTS_AI_MEMORY_EMBEDDING_MODEL"),
    openSearchEndpoint: required("DEPLOYMENTS_AI_MEMORY_OPENSEARCH_ENDPOINT"),
    region: required("AWS_REGION"),
  };
}

/**
 * A ULID derived from the organization and `kind`, so retries of one organization's default
 * activation reuse the same immutable catalog records instead of registering new ones.
 */
export function deterministicMemorySearchId(organizationId: Ulid, kind: string) {
  const bytes = createHash("sha256")
    .update(`${organizationId}:default-memory-search:${kind}`)
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

/**
 * The organization's default AWS-native catalog and target. Catalog records are immutable, so
 * the identifiers cover the search domain, embedding model, and dimensions: a changed install
 * default yields a new catalog rather than conflicting with the old one.
 */
export function defaultMemorySearchCatalog(
  organizationId: Ulid,
  config: DefaultMemorySearchConfig,
): DefaultMemorySearchCatalog {
  const domain = new URL(config.openSearchEndpoint).host;
  const variant = `${domain}:${config.embeddingModel}:${config.embeddingDimensions}`;
  const id = (kind: string) => deterministicMemorySearchId(organizationId, `${kind}:${variant}`);
  const profileId = id("embedding-profile");
  const generationId = id("generation");
  const componentId = id("component");
  const location = {
    automatedSnapshotRetentionHours: AWS_NATIVE_AUTOMATED_SNAPSHOT_RETENTION_HOURS,
    backupSafetyMarginMinutes: AWS_NATIVE_BACKUP_SAFETY_MARGIN_MINUTES,
    embeddingDimensions: config.embeddingDimensions,
    openSearchEndpoint: config.openSearchEndpoint,
    openSearchIndex: `memory-${organizationId.toLowerCase()}-v1`,
    region: config.region,
  };
  const target: MemorySearchTarget = {
    componentIds: [componentId],
    embeddingProfileId: profileId,
    location,
    providerId: "aws-native",
    schemaGeneration: AWS_NATIVE_OPEN_SEARCH_SCHEMA_VERSION,
    targetId: id("target"),
  };
  // The runtime re-resolves this exact route for every embedding, so pin what it resolves to.
  const gatewayRoute = modelGatewayRouteIdentity(
    resolveModelRoute({
      fallbackModelIds: [],
      modelId: config.embeddingModel,
      scope: { organizationId },
    }),
  );
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
        dimensions: config.embeddingDimensions,
        distanceMetric: "cosine" as const,
        gatewayModel: config.embeddingModel,
        gatewayRoute,
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

export async function controlRecord<ItemType extends PlatformRecord["itemType"]>(
  database: DynamoDatabaseService,
  itemType: ItemType,
  data: Readonly<Record<string, unknown>>,
) {
  const value = await memoryRuntimePersistence.read(
    database,
    "control",
    canonicalRecordKeys({ data, itemType }, "control"),
    true,
  );
  return value?.itemType === itemType
    ? (value as Extract<PlatformRecord, { readonly itemType: ItemType }>)
    : undefined;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

async function registeredCatalog(
  database: DynamoDatabaseService,
  expected: DefaultMemorySearchCatalog,
) {
  const [profile, generation, component] = await Promise.all([
    controlRecord(database, "memory-embedding-profile", { id: expected.profileId }),
    controlRecord(database, "memory-search-generation", { id: expected.generationId }),
    controlRecord(database, "memory-search-component", { id: expected.componentId }),
  ]);
  if (!profile && !generation && !component) return "absent" as const;
  const wanted = expected.catalog;
  const matches =
    profile?.data.status === "active" &&
    profile.data.dimensions === wanted.profile.dimensions &&
    profile.data.distanceMetric === wanted.profile.distanceMetric &&
    profile.data.gatewayModel === wanted.profile.gatewayModel &&
    profile.data.gatewayRoute === wanted.profile.gatewayRoute &&
    profile.data.normalization === wanted.profile.normalization &&
    profile.data.processingBoundary === wanted.profile.processingBoundary &&
    generation?.data.status === "active" &&
    generation.data.componentKind === "dense" &&
    generation.data.generation === expected.target.schemaGeneration &&
    generation.data.providerId === expected.target.providerId &&
    canonicalJson(generation.data.location) === canonicalJson(expected.target.location) &&
    component?.data.status === "active" &&
    component.data.componentKind === "dense" &&
    component.data.embeddingProfileId === expected.profileId &&
    component.data.generationId === expected.generationId &&
    component.data.providerId === expected.target.providerId &&
    component.data.schemaGeneration === expected.target.schemaGeneration &&
    canonicalJson(component.data.location) === canonicalJson(expected.target.location);
  if (!matches) {
    throw new Error("The default memory search catalog is partial or conflicts with its target.");
  }
  return "registered" as const;
}

async function ensureCatalog(
  database: DynamoDatabaseService,
  control: DefaultMemorySearchControl,
  expected: DefaultMemorySearchCatalog,
) {
  if ((await registeredCatalog(database, expected)) === "registered") return;
  try {
    await control.registerCatalog(expected.catalog);
  } catch (cause) {
    // A concurrent activation of the same organization registered the identical catalog first.
    if ((await registeredCatalog(database, expected)) === "registered") return;
    throw cause;
  }
}

export type DefaultMemorySearchActivation =
  | { readonly outcome: "configured"; readonly phase: Placement["data"]["phase"] }
  | { readonly outcome: "organization-inactive" }
  | { readonly operation: Provisioning; readonly outcome: "requested" };

/**
 * Starts provisioning the organization's default AWS-native memory search target when its
 * placement is still `unconfigured`. Any other phase is an existing operator or default
 * choice and is left unchanged. The provisioning operation is durable: the operation worker
 * prepares the index, verifies evidence, and activates the placement, and the five-minute
 * operation reconciler redispatches it if `dispatch` is lost.
 */
export async function activateDefaultMemorySearch(input: {
  readonly config: DefaultMemorySearchConfig;
  readonly control: DefaultMemorySearchControl;
  readonly database: DynamoDatabaseService;
  readonly dispatch: (operation: Provisioning) => Promise<void>;
  readonly organizationId: Ulid;
}): Promise<DefaultMemorySearchActivation> {
  const { control, database, organizationId } = input;
  const organization = await controlRecord(database, "organization", { id: organizationId });
  if (organization?.data.status !== "active") return { outcome: "organization-inactive" };
  const placement = await ensureMemorySearchPlacement({
    database,
    now: new Date().toISOString(),
    organizationId,
  });
  if (placement.data.phase !== "unconfigured") {
    return { outcome: "configured", phase: placement.data.phase };
  }
  const expected = defaultMemorySearchCatalog(organizationId, input.config);
  await ensureCatalog(database, control, expected);
  let operation: Provisioning;
  try {
    ({ operation } = await control.requestProvisioning({
      evidenceKeys: DEFAULT_EVIDENCE_KEYS,
      organizationId,
      target: expected.target,
    }));
  } catch (cause) {
    const current = await controlRecord(database, "memory-search-placement", { organizationId });
    if (current && current.data.phase !== "unconfigured") {
      return { outcome: "configured", phase: current.data.phase };
    }
    throw cause;
  }
  await input.dispatch(operation);
  return { operation, outcome: "requested" };
}
