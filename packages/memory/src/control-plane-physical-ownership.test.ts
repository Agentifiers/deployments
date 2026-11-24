import { describe, expect, it } from "bun:test";
import {
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
} from "@deployments-ai/db";
import {
  physicalLocationHash,
  physicalOwnerRegistrationOperation,
  physicalOwnerRemovalOperation,
} from "./control-plane-physical-ownership.ts";
import { ids } from "./test-fixtures.ts";

const timestamp = "2026-07-28T12:00:00.000Z";

function records(componentKind: "dense" | "lexical", schemaGeneration = 1) {
  const location =
    componentKind === "dense"
      ? {
          openSearchEndpoint: "https://memory.us-east-2.es.amazonaws.com",
          openSearchIndex: "memory-v3",
          region: "us-east-2",
        }
      : {
          openSearchEndpoint: "https://memory.us-east-2.es.amazonaws.com",
          openSearchIndex: "lexical-v1",
          region: "us-east-2",
        };
  const component = withCanonicalRecordKeys({
    data: {
      componentKind,
      createdAt: timestamp,
      generationId: ids.environment,
      id: ids.space,
      location,
      providerId: "aws-native" as const,
      schemaGeneration,
      status: "active" as const,
      updatedAt: timestamp,
      version: 0,
    },
    itemType: "memory-search-component" as const,
  }) as Extract<PlatformRecord, { readonly itemType: "memory-search-component" }>;
  const owner = withCanonicalRecordKeys({
    data: {
      componentKind,
      componentId: component.data.id,
      createdAt: timestamp,
      organizationId: ids.organization,
      physicalLocationHash: physicalLocationHash(componentKind, location),
      referenceCount: 1,
      targetId: ids.run,
      updatedAt: timestamp,
      version: 0,
    },
    itemType: "memory-search-physical-owner" as const,
  }) as Extract<PlatformRecord, { readonly itemType: "memory-search-physical-owner" }>;
  return { component, owner };
}

function database(owner: PlatformRecord) {
  return {
    getRecord: async () => owner,
  } as unknown as DynamoDatabaseService;
}

describe("memory physical component ownership", () => {
  it("allows targets in one organization to share a cataloged lexical component", async () => {
    const { component, owner } = records("lexical");
    expect(
      physicalOwnerRegistrationOperation({
        component,
        database: database(owner),
        organizationId: ids.organization,
        targetId: ids.thread,
        timestamp,
      }),
    ).resolves.toMatchObject({
      kind: "put",
      record: { data: { referenceCount: 2 } },
    });
  });

  it("keeps dense component ownership target-exclusive", async () => {
    const { component, owner } = records("dense");
    expect(
      physicalOwnerRegistrationOperation({
        component,
        database: database(owner),
        organizationId: ids.organization,
        targetId: ids.thread,
        timestamp,
      }),
    ).rejects.toThrow("owned by another memory target");
  });

  it("keeps embedding-bearing AWS-native lexical components target-exclusive", async () => {
    const { component, owner } = records("lexical", 2);
    expect(
      physicalOwnerRegistrationOperation({
        component,
        database: database(owner),
        organizationId: ids.organization,
        targetId: ids.thread,
        timestamp,
      }),
    ).rejects.toThrow("owned by another memory target");
  });

  it("releases lexical ownership only after its final target is removed", () => {
    const { component, owner } = records("lexical");
    const shared = withCanonicalRecordKeys({
      data: { ...owner.data, referenceCount: 2 },
      itemType: "memory-search-physical-owner" as const,
    }) as typeof owner;

    expect(
      physicalOwnerRemovalOperation({
        component,
        organizationId: ids.organization,
        owner: shared,
        targetId: ids.thread,
        timestamp,
      }),
    ).toMatchObject({ kind: "put", record: { data: { referenceCount: 1 } } });
    expect(
      physicalOwnerRemovalOperation({
        component,
        organizationId: ids.organization,
        owner,
        targetId: ids.run,
        timestamp,
      }),
    ).toEqual({ kind: "delete", record: owner });
  });
});
