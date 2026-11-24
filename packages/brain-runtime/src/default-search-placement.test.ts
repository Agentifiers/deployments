import { describe, expect, test } from "bun:test";
import type {
  BrainSearchProviderClient,
  BrainSearchProviderRegistry,
} from "@deployments-ai/brains";
import {
  BrainSearchPlacementRecord,
  MemoryEmbeddingProfileRecord,
  MemorySearchPlacementRecord,
  OrganizationRecord,
  Ulid,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { activateDefaultBrainSearch } from "./default-search-placement.ts";

const ids = Array.from(
  { length: 20 },
  (_, index) => `01JC000000000000000000${String(index).padStart(4, "0")}`,
).map((value) => Schema.decodeUnknownSync(Ulid)(value));
const [organizationId, profileId, memoryTargetId, memoryComponentId] = ids as [
  Ulid,
  Ulid,
  Ulid,
  Ulid,
];
const timestamp = "2026-10-15T12:00:00.000Z";
const config = {
  openSearchEndpoint: "https://vpc-search-abc123.us-east-2.es.amazonaws.com",
  region: "us-east-2",
};

function decode<Value>(schema: Schema.Codec<Value, unknown>, value: unknown) {
  return Schema.decodeUnknownSync(schema)(withCanonicalRecordKeys(value as never));
}

function installRecords(memoryPhase: "active" | "unconfigured") {
  const memoryTarget = {
    componentIds: [memoryComponentId],
    embeddingProfileId: profileId,
    location: { openSearchIndex: `memory-${organizationId.toLowerCase()}-v1` },
    providerId: "aws-native" as const,
    schemaGeneration: 3,
    targetId: memoryTargetId,
  };
  return [
    decode(OrganizationRecord, {
      data: {
        createdAt: timestamp,
        id: organizationId,
        name: "Example",
        slug: "example",
        status: "active",
        updatedAt: timestamp,
        version: 1,
      },
      itemType: "organization",
    }),
    decode(BrainSearchPlacementRecord, {
      data: {
        createdAt: timestamp,
        generation: 0,
        organizationId,
        phase: "unconfigured",
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "brain-search-placement",
    }),
    decode(MemorySearchPlacementRecord, {
      data: {
        createdAt: timestamp,
        generation: memoryPhase === "active" ? 2 : 0,
        organizationId,
        phase: memoryPhase,
        updatedAt: timestamp,
        version: memoryPhase === "active" ? 2 : 0,
        ...(memoryPhase === "active"
          ? { readTarget: memoryTarget, writeTargets: [memoryTarget] }
          : { writeTargets: [] }),
      },
      itemType: "memory-search-placement",
    }),
    decode(MemoryEmbeddingProfileRecord, {
      data: {
        createdAt: timestamp,
        dimensions: 1536,
        distanceMetric: "cosine",
        gatewayModel: "bedrock/global.cohere.embed-v4:0",
        gatewayRoute: "{}",
        id: profileId,
        normalization: "l2",
        processingBoundary: "platform-approved",
        status: "active",
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "memory-embedding-profile",
    }),
  ] as PlatformRecord[];
}

function fixture(records: readonly PlatformRecord[]) {
  const values = new Map(records.map((record) => [`${record.pk}\0${record.sk}`, record]));
  const transactions: TransactionOperation[][] = [];
  const steps: string[] = [];
  const database = {
    getRecord: async (_table: string, key: { readonly pk: string; readonly sk: string }) =>
      values.get(`${key.pk}\0${key.sk}`),
    transactWrite: async (operations: readonly TransactionOperation[]) => {
      steps.push("activate");
      transactions.push([...operations]);
      for (const operation of operations) {
        if (operation.kind === "put") {
          const current = values.get(`${operation.record.pk}\0${operation.record.sk}`);
          if (JSON.stringify(current) !== JSON.stringify(operation.previousRecord)) {
            throw new Error("TransactionCanceledException: ConditionalCheckFailed");
          }
        }
      }
      for (const operation of operations) {
        if (operation.kind === "put") {
          values.set(`${operation.record.pk}\0${operation.record.sk}`, operation.record);
        }
      }
    },
  } as unknown as DynamoDatabaseService;
  const provider = (ready: boolean) =>
    ({
      capabilities: { components: ["dense", "entity", "exact", "lexical"], hybrid: true },
      inspect: async () => {
        steps.push("inspect");
        return {
          components: (["dense", "entity", "exact", "lexical"] as const).map((kind) => ({
            kind,
            ready,
          })),
          ready,
        };
      },
      prepare: async () => {
        steps.push("prepare");
      },
    }) as unknown as BrainSearchProviderClient;
  let sequence = 4;
  return {
    activate: (ready = true, backfillConfigured = false) =>
      activateDefaultBrainSearch({
        backfillConfigured,
        config,
        database,
        generateId: async () => ids[sequence++]!,
        now: () => timestamp,
        organizationId,
        providers: {
          resolve: async () => provider(ready),
        } satisfies BrainSearchProviderRegistry,
        repository: {
          getDocumentRendition: async () => undefined,
          getDocumentVersion: async () => undefined,
          listByOrganization: async () => {
            steps.push("backfill");
            return { items: [] };
          },
          listDocuments: async () => ({ items: [] }),
        },
      }),
    placement: () =>
      values.get(`ORG#${organizationId}\0BRAIN-SEARCH-PLACEMENT#${organizationId}`) as Extract<
        PlatformRecord,
        { readonly itemType: "brain-search-placement" }
      >,
    steps,
    transactions,
  };
}

describe("default Brain search activation", () => {
  test("prepares the index, then activates it with the memory embedding profile", async () => {
    const install = fixture(installRecords("active"));
    const result = await install.activate();
    expect(result.outcome).toBe("activated");
    expect(install.steps).toEqual(["prepare", "inspect", "activate", "backfill"]);
    expect(install.placement().data).toMatchObject({
      phase: "active",
      readTarget: {
        embeddingProfileId: profileId,
        location: {
          openSearchEndpoint: config.openSearchEndpoint,
          openSearchIndex: `brain-${organizationId.toLowerCase()}-v1`,
          region: config.region,
        },
        providerId: "aws-native",
      },
    });
    const event = install.transactions[0]!.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "semantic-event",
    );
    expect(event?.kind === "put" ? event.record.data : undefined).toMatchObject({
      actor: { type: "system" },
    });
  });

  test("waits for memory search to become active", async () => {
    const install = fixture(installRecords("unconfigured"));
    expect(await install.activate()).toEqual({ outcome: "memory-search-inactive" });
    expect(install.steps).toEqual([]);
    expect(install.placement().data.phase).toBe("unconfigured");
  });

  test("never moves reads to an index that is not hybrid-ready", async () => {
    const install = fixture(installRecords("active"));
    expect(install.activate(false)).rejects.toThrow("did not become hybrid-ready");
    expect(install.placement().data.phase).toBe("unconfigured");
  });

  test("leaves an already configured placement unchanged", async () => {
    const install = fixture(installRecords("active"));
    await install.activate();
    install.steps.length = 0;
    expect(await install.activate()).toEqual({ outcome: "configured", phase: "active" });
    expect(install.steps).toEqual([]);
  });

  test("finishes the backfill for an active placement when asked for one organization", async () => {
    const install = fixture(installRecords("active"));
    await install.activate();
    install.steps.length = 0;
    expect(await install.activate(true, true)).toEqual({
      outcome: "configured",
      phase: "active",
      queued: 0,
    });
    expect(install.steps).toEqual(["backfill"]);
  });
});
