import { describe, expect, test } from "bun:test";
import {
  BrainProviderMutationClaimRecord,
  BrainSearchPlacementRecord,
  Ulid,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
} from "@deployments-ai/db";
import type {
  BrainSearchProviderClient,
  BrainSearchProviderRegistry,
} from "@deployments-ai/brains";
import { Schema } from "effect";
import { eraseBrainSearchOrganization } from "./search-erasure-main.ts";
import { decodeBrainSearchErasureResult } from "./search-erasure.ts";

const ulid = Schema.decodeUnknownSync(Ulid);
const organizationId = ulid("01JA0000000000000000000002");
const operationId = ulid("01JA0000000000000000000009");
const timestamp = "2026-10-15T12:00:00.000Z";
const target = {
  components: (["dense", "entity", "exact", "lexical"] as const).map((kind, index) => ({
    componentId: ulid(`01JB00000000000000000000${index}0`),
    kind,
  })),
  embeddingProfileId: ulid("01JB0000000000000000000050"),
  location: { openSearchIndex: "brain-example-v1" },
  providerId: "aws-native" as const,
  schemaGeneration: 1,
  targetId: ulid("01JB0000000000000000000060"),
};

const activePlacement = Schema.decodeUnknownSync(BrainSearchPlacementRecord)(
  withCanonicalRecordKeys({
    data: {
      createdAt: timestamp,
      generation: 1,
      organizationId,
      phase: "active",
      readTarget: target,
      updatedAt: timestamp,
      version: 1,
      writeTarget: target,
    },
    itemType: "brain-search-placement" as const,
  }),
);

const activeClaim = Schema.decodeUnknownSync(BrainProviderMutationClaimRecord)(
  withCanonicalRecordKeys({
    data: {
      brainId: ulid("01JC0000000000000000000001"),
      createdAt: timestamp,
      documentId: ulid("01JC0000000000000000000002"),
      jobId: ulid("01JC0000000000000000000003"),
      leaseExpiresAt: "2026-10-15T12:05:00.000Z",
      leaseOwner: "index-worker",
      mutationPriority: 2,
      organizationId,
      projectionGeneration: 1,
      provider: "aws-native",
      schemaGeneration: 1,
      status: "active",
      targetId: target.targetId,
      updatedAt: timestamp,
      version: 0,
    },
    itemType: "brain-provider-mutation-claim" as const,
  }),
);

function database(records: readonly PlatformRecord[]) {
  return {
    getRecord: async (_table: string, key: { readonly pk: string; readonly sk: string }) =>
      records.find((record) => record.pk === key.pk && record.sk === key.sk),
    queryRecords: async (
      _table: string,
      input: {
        readonly ExpressionAttributeValues?: Readonly<Record<string, unknown>>;
        readonly IndexName?: string;
      },
    ) => ({
      items: records.filter(
        (record) =>
          input.IndexName === "gsi2" &&
          record.gsi2pk === input.ExpressionAttributeValues?.[":partition"],
      ),
    }),
  } as unknown as DynamoDatabaseService;
}

const providersNeverResolved: BrainSearchProviderRegistry = {
  resolve: async () => {
    throw new Error("This erasure must not reach the Brain search provider.");
  },
};

describe("Brain search erasure Lambda", () => {
  test("reports draining provider mutations as a pending erasure", async () => {
    expect(
      await eraseBrainSearchOrganization(
        { operationId, organizationId },
        database([activePlacement, activeClaim]),
        providersNeverResolved,
      ),
    ).toEqual({ reason: "provider_mutations_draining", status: "pending" });
  });

  test("completes without a provider purge when the organization has no Brain search placement", async () => {
    expect(
      await eraseBrainSearchOrganization(
        { operationId, organizationId },
        database([]),
        providersNeverResolved,
      ),
    ).toEqual({ receipt: { operationId, targets: [] }, status: "complete" });
  });

  test("returns a receipt with targets that the governance invoker's strict decoder accepts", async () => {
    const purged: string[] = [];
    const registry: BrainSearchProviderRegistry = {
      resolve: async () =>
        ({
          purgeOrganization: async (request: { readonly organizationId: string }) => {
            purged.push(request.organizationId);
            return {
              deleted: true,
              receipt: { absenceVerified: true, index: target.location.openSearchIndex },
            };
          },
        }) as unknown as BrainSearchProviderClient,
    };

    const result = await eraseBrainSearchOrganization(
      { operationId, organizationId },
      database([activePlacement]),
      registry,
    );

    expect({ decoded: decodeBrainSearchErasureResult(result, operationId), purged }).toEqual({
      decoded: {
        receipt: {
          operationId,
          targets: [
            {
              componentReceipts: target.components.map(({ componentId }) => ({
                componentId,
                generationId: target.targetId,
                providerReceipt: {
                  absenceVerified: true,
                  receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
                  store: "opensearch",
                },
              })),
              providerId: "aws-native",
              targetDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
            },
          ],
        },
        status: "complete",
      },
      purged: [organizationId],
    });
  });
});
