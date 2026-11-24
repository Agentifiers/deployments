import { describe, expect, it } from "bun:test";
import {
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
} from "@deployments-ai/db";
import { makeMemorySearchControlPlane } from "./control-plane.ts";
import { ids, memoryEmbeddingGatewayRoute } from "./test-fixtures.ts";
import {
  requireCleanProvisioningEvidence,
  verifyProvisioningEvidence,
} from "./control-plane-evidence.ts";
import type { MemorySearchProviderClient, MemorySearchTarget } from "./provider.ts";

function fixtureDatabase(records: readonly PlatformRecord[]) {
  const values = new Map(records.map((record) => [`${record.pk}\0${record.sk}`, record]));
  const put = (record: PlatformRecord) => values.set(`${record.pk}\0${record.sk}`, record);
  return {
    database: {
      getRecord: async (
        _table: string,
        recordKey: { readonly pk: string; readonly sk: string },
      ) => {
        const value = values.get(`${recordKey.pk}\0${recordKey.sk}`);
        return value ? value : undefined;
      },
      transactWrite: async (operations: readonly TransactionOperation[]) => {
        for (const operation of operations) {
          if (operation.kind === "put") put(operation.record);
        }
      },
    } as unknown as DynamoDatabaseService,
    values,
  };
}

const target: MemorySearchTarget = {
  componentIds: [ids.space],
  embeddingProfileId: ids.agent,
  location: { region: "aws-us-east-2" },
  providerId: "aws-native",
  schemaGeneration: 1,
  targetId: ids.run,
};

function records() {
  const timestamp = "2026-07-28T12:00:00.000Z";
  const profile = withCanonicalRecordKeys({
    data: {
      createdAt: timestamp,
      dimensions: 3,
      distanceMetric: "cosine" as const,
      gatewayModel: "openai/text-embedding-3-small",
      gatewayRoute: memoryEmbeddingGatewayRoute,
      id: ids.agent,
      normalization: "l2" as const,
      processingBoundary: "platform-approved" as const,
      status: "active" as const,
      updatedAt: timestamp,
      version: 0,
    },
    itemType: "memory-embedding-profile" as const,
  }) as PlatformRecord;
  const manifest = withCanonicalRecordKeys({
    data: {
      componentLocations: [{ componentId: ids.space }],
      createdAt: timestamp,
      evidenceKeys: ["dense", "exact", "lexical", "cleanup"],
      id: ids.memory2,
      operationId: ids.toolCall,
      organizationId: ids.organization,
      status: "manifested" as const,
      targetId: target.targetId,
      updatedAt: timestamp,
      version: 0,
    },
    itemType: "memory-search-evidence-manifest" as const,
  }) as PlatformRecord;
  const operation = withCanonicalRecordKeys({
    data: {
      actionGeneration: 0,
      createdAt: timestamp,
      evidenceManifestId: ids.memory2,
      eventVersion: 1,
      id: ids.toolCall,
      nextAction: "provision-components",
      nextActionAt: timestamp,
      operationShard: 0,
      organizationId: ids.organization,
      phase: "requested",
      placementGeneration: 1,
      status: "pending" as const,
      target,
      updatedAt: timestamp,
      version: 0,
    },
    itemType: "memory-search-provisioning" as const,
  }) as Extract<PlatformRecord, { readonly itemType: "memory-search-provisioning" }>;
  return { manifest, operation, profile };
}

function evidenceProvider(onDeleteEvidence?: () => void) {
  let row:
    | { readonly id: string; readonly status: "active" | "deleted"; readonly version: number }
    | undefined;
  const evidenceBindings: unknown[] = [];
  const queryEvidence = async (input: { readonly evidence: unknown }) => {
    evidenceBindings.push(input.evidence);
    return row?.status === "active"
      ? [
          {
            contentHash: "hash",
            id: row.id,
            memorySpaceId: row.id,
            memoryVersion: row.version,
            scopeKey: `organization:${ids.organization}`,
            searchKey: `organization:${ids.organization}`,
          },
        ]
      : [];
  };
  const client: MemorySearchProviderClient = {
    capabilities: { dense: true, exact: true, lexical: true, purgeOrganization: true },
    delete: async () => {
      throw new Error("ordinary delete must not process evidence");
    },
    deleteEvidence: async ({ evidence }) => {
      evidenceBindings.push(evidence);
      row = undefined;
      onDeleteEvidence?.();
      return { status: "synchronized" };
    },
    prepare: async () => undefined,
    providerId: "aws-native",
    query: async () => {
      throw new Error("ordinary query must not process evidence");
    },
    queryEvidence,
    queryEvidenceExact: queryEvidence,
    queryEvidenceLexical: queryEvidence,
    reference: () => "evidence-target",
    readiness: async () => ({
      denseReady: true,
      lexicalReady: true,
      ready: true,
      reference: "evidence-target",
      schemaReady: true,
    }),
    synchronizeLifecycle: async () => ({ status: "synchronized" }),
    target,
    write: async () => {
      throw new Error("ordinary write must not process evidence");
    },
    writeEvidence: async ({ evidence, memory }) => {
      evidenceBindings.push(evidence);
      row = { id: memory.data.id, status: "active", version: memory.data.version };
      return { status: "written" };
    },
  };
  return { client, evidenceBindings, row: () => row };
}

describe("memory provisioning evidence", () => {
  it("prepares an active migration without changing its serving target", async () => {
    const recordSet = records();
    const oldTarget = { ...target, targetId: ids.thread };
    const timestamp = "2026-07-28T12:00:00.000Z";
    const placement = withCanonicalRecordKeys({
      data: {
        candidateTarget: target,
        createdAt: timestamp,
        generation: 1,
        operationId: ids.toolCall,
        organizationId: ids.organization,
        phase: "active" as const,
        readTarget: oldTarget,
        updatedAt: timestamp,
        version: 1,
        writeTargets: [oldTarget],
      },
      itemType: "memory-search-placement" as const,
    }) as PlatformRecord;
    const gate = withCanonicalRecordKeys({
      data: {
        createdAt: timestamp,
        drainEpoch: 0,
        organizationId: ids.organization,
        status: "open" as const,
        targetId: target.targetId,
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "memory-provider-mutation-gate" as const,
    }) as PlatformRecord;
    const fixture = fixtureDatabase([...Object.values(recordSet), placement, gate]);
    const provider = evidenceProvider();
    const control = makeMemorySearchControlPlane({
      database: fixture.database,
      embedProvisioningEvidence: async () => ({
        embedding: [1, 0, 0],
        model: "openai/text-embedding-3-small",
        provider: "openai",
      }),
      generateId: async () => ids.memory,
      membershipDigest: async () => ({ digest: target.targetId, keyVersion: 1 }),
      now: () => new Date("2026-07-28T12:05:00.000Z"),
      registry: { resolve: async () => provider.client },
    });

    const prepared = await control.prepareProvisioning(ids.organization, ids.toolCall, 0);

    expect(prepared.data).toMatchObject({
      candidateTarget: { targetId: target.targetId },
      phase: "active",
      readTarget: { targetId: oldTarget.targetId },
      writeTargets: [{ targetId: oldTarget.targetId }],
    });
    expect(
      [...fixture.values.values()].find(
        (record) => record.itemType === "memory-search-provisioning",
      ),
    ).toMatchObject({ data: { actionGeneration: 1, phase: "ready", status: "waiting" } });
  });

  it("does not activate a candidate after an abort supersedes its leased action", async () => {
    const recordSet = records();
    const timestamp = "2026-07-28T12:00:00.000Z";
    const placement = withCanonicalRecordKeys({
      data: {
        candidateTarget: target,
        createdAt: timestamp,
        generation: 1,
        operationId: ids.toolCall,
        organizationId: ids.organization,
        phase: "provisioning" as const,
        updatedAt: timestamp,
        version: 1,
        writeTargets: [],
      },
      itemType: "memory-search-placement" as const,
    }) as PlatformRecord;
    const gate = withCanonicalRecordKeys({
      data: {
        createdAt: timestamp,
        drainEpoch: 0,
        organizationId: ids.organization,
        status: "open" as const,
        targetId: target.targetId,
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "memory-provider-mutation-gate" as const,
    }) as PlatformRecord;
    const fixture = fixtureDatabase([...Object.values(recordSet), placement, gate]);
    const provider = evidenceProvider(() => {
      const aborting = withCanonicalRecordKeys({
        data: {
          ...recordSet.operation.data,
          actionGeneration: 1,
          nextAction: "abort-provisioning" as const,
          phase: "aborting",
          status: "pending" as const,
          updatedAt: "2026-07-28T12:05:00.000Z",
          version: recordSet.operation.data.version + 1,
        },
        itemType: "memory-search-provisioning" as const,
      }) as PlatformRecord;
      fixture.values.set(`${aborting.pk}\0${aborting.sk}`, aborting);
    });
    const control = makeMemorySearchControlPlane({
      database: fixture.database,
      embedProvisioningEvidence: async () => ({
        embedding: [1, 0, 0],
        model: "openai/text-embedding-3-small",
        provider: "openai",
      }),
      generateId: async () => ids.memory,
      membershipDigest: async () => ({ digest: target.targetId, keyVersion: 1 }),
      now: () => new Date("2026-07-28T12:05:00.000Z"),
      registry: { resolve: async () => provider.client },
    });

    expect(control.prepareProvisioning(ids.organization, ids.toolCall, 0)).rejects.toThrow(
      "no longer owns placement",
    );
    expect(fixture.values.get(`${placement.pk}\0${placement.sk}`)).toMatchObject({
      data: { phase: "provisioning" },
    });
  });

  it("rejects embedding output that does not match the immutable profile", async () => {
    const recordSet = records();
    const fixture = fixtureDatabase(Object.values(recordSet));
    const provider = evidenceProvider();

    expect(
      verifyProvisioningEvidence({
        database: fixture.database,
        embed: async () => ({ embedding: [1, 0, 0], model: "wrong-model", provider: "openai" }),
        generateId: async () => ids.memory,
        now: () => new Date("2026-07-28T12:05:00.000Z"),
        operation: recordSet.operation,
        provider: provider.client,
        target,
      }),
    ).rejects.toThrow("immutable profile");
    expect(provider.row()).toBeUndefined();
  });

  it("writes, queries, cleans, and durably gates target activation", async () => {
    const recordSet = records();
    const fixture = fixtureDatabase(Object.values(recordSet));
    const provider = evidenceProvider();
    const clean = await verifyProvisioningEvidence({
      database: fixture.database,
      embed: async () => ({
        embedding: [1, 0, 0],
        model: "openai/text-embedding-3-small",
        provider: "openai",
      }),
      generateId: async () => ids.memory,
      now: () => new Date("2026-07-28T12:05:00.000Z"),
      operation: recordSet.operation,
      provider: provider.client,
      target,
    });

    expect(clean.data.status).toBe("clean");
    expect(clean.data.componentLocations.at(-1)).toMatchObject({ evidenceMemoryId: ids.memory });
    expect(provider.row()).toBeUndefined();
    expect(provider.evidenceBindings).toHaveLength(6);
    expect(provider.evidenceBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operationId: ids.toolCall, targetId: target.targetId }),
      ]),
    );
    expect(
      [...fixture.values.values()].find(
        (record) => record.itemType === "memory-provider-mutation-claim",
      ),
    ).toMatchObject({ data: { status: "applied", targetId: target.targetId } });
    expect(
      requireCleanProvisioningEvidence(fixture.database, recordSet.operation),
    ).resolves.toMatchObject({ data: { status: "clean" } });
  });

  it("cleans expired ambiguous evidence before advancing the durable claim attempt", async () => {
    const recordSet = records();
    const abandoned = withCanonicalRecordKeys({
      data: {
        ambiguityUntil: "2026-07-28T12:04:00.000Z",
        attemptEpoch: 0,
        claimAttemptId: "abandoned-attempt",
        createdAt: "2026-07-28T12:00:00.000Z",
        messageGroup: `provisioning-evidence:${recordSet.operation.data.id}`,
        mutationTuple: `${recordSet.operation.data.id}:${target.targetId}:synthetic-evidence`,
        organizationId: ids.organization,
        status: "ambiguous" as const,
        targetId: target.targetId,
        updatedAt: "2026-07-28T12:00:00.000Z",
        version: 0,
      },
      itemType: "memory-provider-mutation-claim" as const,
    }) as PlatformRecord;
    const fixture = fixtureDatabase([...Object.values(recordSet), abandoned]);
    const provider = evidenceProvider();

    await verifyProvisioningEvidence({
      database: fixture.database,
      embed: async () => ({
        embedding: [1, 0, 0],
        model: "openai/text-embedding-3-small",
        provider: "openai",
      }),
      generateId: async () => ids.memory,
      now: () => new Date("2026-07-28T12:05:00.000Z"),
      operation: recordSet.operation,
      provider: provider.client,
      target,
    });

    expect(
      [...fixture.values.values()].find(
        (record) => record.itemType === "memory-provider-mutation-claim",
      ),
    ).toMatchObject({ data: { attemptEpoch: 1, status: "applied" } });
    expect(provider.row()).toBeUndefined();
  });
});
