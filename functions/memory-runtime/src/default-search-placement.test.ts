import { describe, expect, it } from "bun:test";
import {
  MemorySearchMutationFenceRecord,
  MemorySearchPlacementRecord,
  OrganizationRecord,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { makeMemorySearchControlPlane } from "@deployments-ai/memory";
import { resolveModelRoute } from "@deployments-ai/model-gateway";
import { Schema } from "effect";
import {
  activateDefaultMemorySearch,
  defaultMemorySearchCatalog,
  defaultMemorySearchConfigFromEnv,
  type DefaultMemorySearchConfig,
} from "./default-search-placement.ts";
import { memoryEmbeddingRouteRequest } from "./embedding-profile.ts";

const organizationId = "01JA0000000000000000000002" as Ulid;
const timestamp = "2026-10-15T12:00:00.000Z";
const config: DefaultMemorySearchConfig = {
  embeddingDimensions: 1536,
  embeddingModel: "bedrock/global.cohere.embed-v4:0",
  openSearchEndpoint: "https://vpc-search-abc123.us-east-2.es.amazonaws.com",
  region: "us-east-2",
};

type Provisioning = Extract<PlatformRecord, { readonly itemType: "memory-search-provisioning" }>;

/** Applies transactions atomically with create-only puts and version-fenced replacements. */
function transactionalDatabase(initial: readonly PlatformRecord[]) {
  const values = new Map(initial.map((record) => [`${record.pk}\0${record.sk}`, record]));
  const recordKey = (record: { readonly pk: string; readonly sk: string }) =>
    `${record.pk}\0${record.sk}`;
  const database = {
    getRecord: async (_table: string, key: { readonly pk: string; readonly sk: string }) =>
      values.get(recordKey(key)),
    transactWrite: async (operations: readonly TransactionOperation[]) => {
      for (const operation of operations) {
        if (operation.kind === "put") {
          const current = values.get(recordKey(operation.record));
          const previous = operation.previousRecord;
          if (
            previous ? JSON.stringify(current) !== JSON.stringify(previous) : current !== undefined
          ) {
            throw new Error("TransactionCanceledException: ConditionalCheckFailed");
          }
        } else if (operation.kind === "condition-check" && !values.has(recordKey(operation.key))) {
          throw new Error("TransactionCanceledException: ConditionalCheckFailed");
        }
      }
      for (const operation of operations) {
        if (operation.kind === "put") values.set(recordKey(operation.record), operation.record);
        if (operation.kind === "delete") values.delete(recordKey(operation.record));
      }
    },
  } as unknown as DynamoDatabaseService;
  return {
    database,
    record: <ItemType extends PlatformRecord["itemType"]>(itemType: ItemType) =>
      [...values.values()].filter(
        (record): record is Extract<PlatformRecord, { readonly itemType: ItemType }> =>
          record.itemType === itemType,
      ),
  };
}

/** The records `organization.create` writes in its transaction. */
function createdOrganization(status: "active" | "disabled" = "active") {
  return [
    Schema.decodeUnknownSync(OrganizationRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: timestamp,
          id: organizationId,
          name: "Example",
          slug: "example",
          status,
          updatedAt: timestamp,
          version: 1,
        },
        itemType: "organization" as const,
      }),
    ),
    Schema.decodeUnknownSync(MemorySearchPlacementRecord)(
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
    ),
    Schema.decodeUnknownSync(MemorySearchMutationFenceRecord)(
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
    ),
  ] as PlatformRecord[];
}

function controlPlane(database: DynamoDatabaseService) {
  let sequence = 0;
  return makeMemorySearchControlPlane({
    database,
    generateId: async () => `01JB${String((sequence += 1)).padStart(22, "0")}` as Ulid,
    membershipDigest: async (targetId) => ({ digest: targetId, keyVersion: 1 }),
    now: () => new Date(timestamp),
  });
}

describe("default memory search activation", () => {
  it("derives a stable catalog for the install's search domain and embedding route", () => {
    const first = defaultMemorySearchCatalog(organizationId, config);
    expect(defaultMemorySearchCatalog(organizationId, config)).toEqual(first);
    expect(first.target).toMatchObject({
      componentIds: [first.componentId],
      embeddingProfileId: first.profileId,
      location: {
        embeddingDimensions: 1536,
        openSearchEndpoint: config.openSearchEndpoint,
        openSearchIndex: `memory-${organizationId.toLowerCase()}-v1`,
        region: "us-east-2",
      },
      providerId: "aws-native",
    });
    expect(first.catalog.profile).toMatchObject({
      dimensions: 1536,
      distanceMetric: "cosine",
      gatewayModel: config.embeddingModel,
      processingBoundary: "platform-approved",
    });
    const changed = defaultMemorySearchCatalog(organizationId, {
      ...config,
      openSearchEndpoint: "https://vpc-search-def456.us-east-2.es.amazonaws.com",
    });
    expect(changed.profileId).not.toBe(first.profileId);
    expect(changed.target.targetId).not.toBe(first.target.targetId);
  });

  it("pins the route the runtime re-resolves for every embedding", () => {
    const { catalog } = defaultMemorySearchCatalog(organizationId, config);
    const profile = {
      data: { ...catalog.profile, createdAt: timestamp, status: "active", updatedAt: timestamp },
      itemType: "memory-embedding-profile",
    } as Extract<PlatformRecord, { readonly itemType: "memory-embedding-profile" }>;
    const route = resolveModelRoute(memoryEmbeddingRouteRequest(profile, { organizationId }));
    expect(route).toMatchObject({
      modelId: config.embeddingModel,
      provider: "bedrock",
      routeScopeRef: `organization:${organizationId}`,
    });
  });

  it("starts durable provisioning for a newly created organization", async () => {
    const fixture = transactionalDatabase(createdOrganization());
    const dispatched: Provisioning[] = [];
    const result = await activateDefaultMemorySearch({
      config,
      control: controlPlane(fixture.database),
      database: fixture.database,
      dispatch: async (operation) => {
        dispatched.push(operation);
      },
      organizationId,
    });
    const expected = defaultMemorySearchCatalog(organizationId, config);
    expect(result.outcome).toBe("requested");
    expect(fixture.record("memory-search-placement")[0]?.data).toMatchObject({
      candidateTarget: { targetId: expected.target.targetId },
      phase: "provisioning",
    });
    expect(fixture.record("memory-embedding-profile").map((record) => record.data.id)).toEqual([
      expected.profileId,
    ]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.data).toMatchObject({
      nextAction: "provision-components",
      organizationId,
      status: "pending",
      target: { targetId: expected.target.targetId },
    });
    expect(fixture.record("memory-search-provisioning")).toHaveLength(1);
  });

  it("creates the envelope for an organization that predates it, then provisions", async () => {
    const [organization] = createdOrganization();
    const fixture = transactionalDatabase([organization as PlatformRecord]);
    const result = await activateDefaultMemorySearch({
      config,
      control: controlPlane(fixture.database),
      database: fixture.database,
      dispatch: async () => {},
      organizationId,
    });
    expect(result.outcome).toBe("requested");
    expect(fixture.record("memory-search-placement")[0]?.data.phase).toBe("provisioning");
    expect(fixture.record("memory-search-mutation-fence")[0]?.data).toMatchObject({
      epoch: 0,
      status: "open",
    });
  });

  it("leaves a configured placement alone, so redelivery is a no-op", async () => {
    const fixture = transactionalDatabase(createdOrganization());
    const dispatched: Provisioning[] = [];
    const activate = () =>
      activateDefaultMemorySearch({
        config,
        control: controlPlane(fixture.database),
        database: fixture.database,
        dispatch: async (operation) => {
          dispatched.push(operation);
        },
        organizationId,
      });
    await activate();
    expect(await activate()).toEqual({ outcome: "configured", phase: "provisioning" });
    expect(dispatched).toHaveLength(1);
    expect(fixture.record("memory-search-provisioning")).toHaveLength(1);
  });

  it("reuses a catalog an interrupted earlier attempt registered", async () => {
    const fixture = transactionalDatabase(createdOrganization());
    await controlPlane(fixture.database).registerCatalog(
      defaultMemorySearchCatalog(organizationId, config).catalog,
    );
    const result = await activateDefaultMemorySearch({
      config,
      control: controlPlane(fixture.database),
      database: fixture.database,
      dispatch: async () => {},
      organizationId,
    });
    expect(result.outcome).toBe("requested");
    expect(fixture.record("memory-embedding-profile")).toHaveLength(1);
  });

  it("skips an organization that is no longer active", async () => {
    const fixture = transactionalDatabase(createdOrganization("disabled"));
    const result = await activateDefaultMemorySearch({
      config,
      control: controlPlane(fixture.database),
      database: fixture.database,
      dispatch: async () => {
        throw new Error("must not dispatch");
      },
      organizationId,
    });
    expect(result).toEqual({ outcome: "organization-inactive" });
    expect(fixture.record("memory-search-placement")[0]?.data.phase).toBe("unconfigured");
  });

  it("reads the install default from the runtime environment", () => {
    expect(
      defaultMemorySearchConfigFromEnv({
        AWS_REGION: config.region,
        DEPLOYMENTS_AI_MEMORY_EMBEDDING_DIMENSIONS: "1536",
        DEPLOYMENTS_AI_MEMORY_EMBEDDING_MODEL: config.embeddingModel,
        DEPLOYMENTS_AI_MEMORY_OPENSEARCH_ENDPOINT: config.openSearchEndpoint,
      }),
    ).toEqual(config);
    expect(() =>
      defaultMemorySearchConfigFromEnv({
        AWS_REGION: config.region,
        DEPLOYMENTS_AI_MEMORY_EMBEDDING_DIMENSIONS: "1536",
        DEPLOYMENTS_AI_MEMORY_EMBEDDING_MODEL: config.embeddingModel,
      }),
    ).toThrow("DEPLOYMENTS_AI_MEMORY_OPENSEARCH_ENDPOINT");
  });
});
