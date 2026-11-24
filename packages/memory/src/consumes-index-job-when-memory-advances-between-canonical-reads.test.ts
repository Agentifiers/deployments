import { describe, expect, it } from "bun:test";
import type { DynamoDatabaseService } from "@deployments-ai/db";
import { makeMemoryPlatform } from "./platform.ts";
import type { MemorySearchProviderClient, MemorySearchTarget } from "./provider.ts";
import { fixedNow, memoryDatabase } from "./platform-pagination-reconciliation-fixtures.ts";
import { ids, memoryFixture } from "./test-fixtures.ts";
import { fakeMemorySearchProvider } from "./memory-search-test-fixtures.ts";

describe("memory index job canonical fencing", () => {
  it("consumes a job when memory advances between the platform and service reads", async () => {
    const fixture = memoryDatabase();
    let watchedKey: { readonly pk: string; readonly sk: string } | undefined;
    let watchedReads = 0;
    let approved = memoryFixture();
    const database: DynamoDatabaseService = {
      ...fixture.database,
      getRecord: async (table, key, consistentRead) => {
        const record = await fixture.database.getRecord(table, key, consistentRead);
        if (
          table === "control" &&
          watchedKey?.pk === key.pk &&
          watchedKey.sk === key.sk &&
          watchedReads++ === 0
        ) {
          fixture.put("control", approved);
        }
        return record;
      },
    };
    let embeddingCalls = 0;
    let providerMutations = 0;
    const target: MemorySearchTarget = {
      componentIds: [ids.space],
      embeddingProfileId: ids.agent,
      location: { region: "us-east-2" },
      providerId: "aws-native",
      schemaGeneration: 1,
      targetId: ids.toolCall,
    };
    const provider: MemorySearchProviderClient = {
      capabilities: {
        dense: true,
        exact: true,
        lexical: true,
        purgeOrganization: true,
      },
      delete: async () => {
        providerMutations += 1;
        return { status: "synchronized" };
      },
      providerId: "aws-native",
      query: async () => [],
      reference: () => "aws-native-test",
      synchronizeLifecycle: async () => {
        providerMutations += 1;
        return { status: "synchronized" };
      },
      target,
      write: async () => {
        providerMutations += 1;
        return { status: "written" };
      },
    };
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => {
        embeddingCalls += 1;
        return { embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" };
      },
      now: () => fixedNow,
      searchPlacementResolver: async () => ({
        fenceEpoch: 1,
        fenceVersion: 1,
        placementGeneration: 1,
        placementPhase: "active",
        placementVersion: 1,
        read: provider,
        writes: [provider],
      }),
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
      workspaceId: ids.workspace,
    };
    const space = await platform.createMemorySpace(scope, {
      kind: "workspace",
      name: "Canonical read race",
      workspaceId: ids.workspace,
    });
    const pending = memoryFixture({
      memorySpaceId: space.data.id,
      reviewStatus: "pending",
      version: 0,
    });
    approved = memoryFixture({
      memorySpaceId: space.data.id,
      reviewStatus: "approved",
      version: 1,
    });
    watchedKey = { pk: pending.pk, sk: pending.sk };
    fixture.put("control", pending);
    const job = await platform.enqueueIndexJob({
      memory: pending,
      scope,
      synchronizationGeneration: 1,
    });

    const consumed = await platform.processIndexJob(scope, {
      idempotencyKey: job.data.idempotencyKey,
      memoryId: pending.data.id,
    });

    expect(consumed.data.status).toBe("succeeded");
    expect(consumed.data.skipReason).toBe("stale-memory-version");
    expect(embeddingCalls).toBe(0);
    expect(providerMutations).toBe(0);
    expect(watchedReads).toBe(2);
    expect(
      [...(fixture.tables.get("control")?.values() ?? [])].find(
        (record) => record.itemType === "memory-provider-mutation-claim",
      ),
    ).toMatchObject({ data: { status: "failed" } });
  });
});
