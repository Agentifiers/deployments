import { describe, expect, it } from "bun:test";
import {
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
} from "@deployments-ai/db";
import { physicalLocationHash } from "./control-plane-physical-ownership.ts";
import { makeMemorySearchRegistration } from "./control-plane-registration.ts";
import type { MemorySearchTarget } from "./provider.ts";
import { ids, memoryEmbeddingGatewayRoute } from "./test-fixtures.ts";

function databaseFixture() {
  const values = new Map<string, PlatformRecord>();
  const apply = (operations: readonly TransactionOperation[]) => {
    for (const operation of operations) {
      if (operation.kind === "put") {
        values.set(`${operation.record.pk}\0${operation.record.sk}`, operation.record);
      } else if (operation.kind === "delete") {
        values.delete(`${operation.record.pk}\0${operation.record.sk}`);
      }
    }
  };
  return {
    apply,
    database: {
      getRecord: async (_table: string, key: { readonly pk: string; readonly sk: string }) => {
        const value = values.get(`${key.pk}\0${key.sk}`);
        return value;
      },
      transactWrite: async (operations: readonly TransactionOperation[]) => apply(operations),
    } as unknown as DynamoDatabaseService,
    records: () => [...values.values()],
  };
}

describe("memory search live target registration", () => {
  it("canonicalizes equivalent physical OpenSearch origins", () => {
    const first = physicalLocationHash("dense", {
      openSearchEndpoint: "https://search.example",
      openSearchIndex: "memory-v3",
      region: "us-east-2",
    });
    const equivalent = physicalLocationHash("dense", {
      openSearchEndpoint: "https://SEARCH.EXAMPLE:443/",
      openSearchIndex: "MEMORY-V3",
      region: "US-EAST-2",
    });
    expect(equivalent).toBe(first);
    expect(() =>
      physicalLocationHash("dense", {
        openSearchEndpoint: "https://search.example/path",
        openSearchIndex: "memory-v3",
        region: "us-east-2",
      }),
    ).toThrow("canonical HTTPS origin");
  });

  it("registers one target-exclusive OpenSearch component for AWS-native", async () => {
    const fixture = databaseFixture();
    const timestamp = "2026-07-28T12:00:00.000Z";
    const registration = makeMemorySearchRegistration({
      database: fixture.database,
      membershipDigest: async (targetId) => ({ digest: targetId, keyVersion: 1 }),
      now: () => new Date(timestamp),
    });
    const location = {
      automatedSnapshotRetentionHours: 336,
      backupSafetyMarginMinutes: 60,
      embeddingDimensions: 3,
      openSearchEndpoint: "https://search.example",
      openSearchIndex: "memory-v3",
      region: "us-east-2",
    };
    await registration.registerCatalog({
      components: [
        {
          componentKind: "dense",
          embeddingProfileId: ids.agent,
          generationId: ids.memory2,
          id: ids.space,
          location,
          providerId: "aws-native",
          schemaGeneration: 3,
        },
      ],
      generations: [
        {
          componentKind: "dense",
          generation: 3,
          id: ids.memory2,
          location: Object.fromEntries(Object.entries(location).reverse()),
          providerId: "aws-native",
        },
      ],
      profile: {
        dimensions: 3,
        distanceMetric: "cosine",
        gatewayModel: "openai/text-embedding-3-small",
        gatewayRoute: memoryEmbeddingGatewayRoute,
        id: ids.agent,
        normalization: "l2",
        processingBoundary: "aws",
      },
    });
    const target: MemorySearchTarget = {
      componentIds: [ids.space],
      embeddingProfileId: ids.agent,
      location,
      providerId: "aws-native",
      schemaGeneration: 3,
      targetId: ids.run,
    };

    const first = await registration.registrationOperations({
      operationId: ids.toolCall,
      organizationId: ids.organization,
      placementGeneration: 1,
      target,
      timestamp,
    });
    const physicalOwners = first.filter(
      (operation) =>
        operation.kind === "put" && operation.record.itemType === "memory-search-physical-owner",
    );
    expect(physicalOwners).toHaveLength(1);
    expect(physicalOwners[0]).toMatchObject({
      conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      record: {
        data: {
          componentKind: "dense",
          organizationId: ids.organization,
          targetId: ids.run,
        },
      },
    });

    fixture.apply(first);
    expect(
      registration.registrationOperations({
        operationId: ids.toolCall,
        organizationId: ids.thread,
        placementGeneration: 1,
        target: { ...target, targetId: ids.thread },
        timestamp,
      }),
    ).rejects.toThrow("owned by another memory target");
    expect(
      registration.registrationOperations({
        operationId: ids.toolCall,
        organizationId: ids.thread,
        placementGeneration: 1,
        target: { ...target, componentIds: [] },
        timestamp,
      }),
    ).rejects.toThrow("conflicting immutable identity");
  });

  it("promotes candidate references and removes an aborted provisioning target", async () => {
    const fixture = databaseFixture();
    const timestamp = "2026-07-28T12:00:00.000Z";
    const registration = makeMemorySearchRegistration({
      database: fixture.database,
      membershipDigest: async () => ({ digest: "target-membership", keyVersion: 1 }),
      now: () => new Date(timestamp),
    });
    const location = {
      automatedSnapshotRetentionHours: 336,
      backupSafetyMarginMinutes: 60,
      embeddingDimensions: 3,
      openSearchEndpoint: "https://search.example",
      openSearchIndex: "memory-v3",
      region: "us-east-2",
    };
    await registration.registerCatalog({
      components: [
        {
          componentKind: "dense",
          embeddingProfileId: ids.agent,
          generationId: ids.memory2,
          id: ids.space,
          location,
          providerId: "aws-native",
          schemaGeneration: 3,
        },
      ],
      generations: [
        {
          componentKind: "dense",
          generation: 3,
          id: ids.memory2,
          location,
          providerId: "aws-native",
        },
      ],
      profile: {
        dimensions: 3,
        distanceMetric: "cosine",
        gatewayModel: "openai/text-embedding-3-small",
        gatewayRoute: memoryEmbeddingGatewayRoute,
        id: ids.agent,
        normalization: "l2",
        processingBoundary: "aws",
      },
    });
    const target: MemorySearchTarget = {
      componentIds: [ids.space],
      embeddingProfileId: ids.agent,
      location,
      providerId: "aws-native",
      schemaGeneration: 3,
      targetId: ids.run,
    };
    const operations = await registration.registrationOperations({
      operationId: ids.toolCall,
      organizationId: ids.organization,
      placementGeneration: 1,
      target,
      timestamp,
    });
    fixture.apply(operations);

    const placement = withCanonicalRecordKeys({
      data: {
        createdAt: timestamp,
        generation: 2,
        organizationId: ids.organization,
        phase: "active" as const,
        readTarget: target,
        updatedAt: timestamp,
        version: 1,
        writeTargets: [target],
      },
      itemType: "memory-search-placement" as const,
    }) as Extract<PlatformRecord, { readonly itemType: "memory-search-placement" }>;
    fixture.apply(await registration.liveReferenceOperations(placement, ids.toolCall, timestamp));
    expect(
      fixture
        .records()
        .find((record) => record.itemType === "memory-search-generation-live-target"),
    ).toMatchObject({ data: { placementGeneration: 2, referenceRole: "read" } });

    fixture.apply(await registration.removeLiveReferenceOperations(target, timestamp));
    expect(
      fixture
        .records()
        .some((record) => record.itemType === "memory-search-generation-live-target"),
    ).toBe(false);
    expect(await registration.removeLiveReferenceOperations(target, timestamp)).toEqual([]);
  });
});
