import { describe, expect, test } from "bun:test";
import {
  BrainSearchPlacementRecord,
  OrganizationRecord,
  Ulid,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import {
  brainSearchPlacementOrganizationId,
  defaultBrainSearchConfig,
  handleBrainSearchPlacement,
} from "./search-placement-main.ts";

const organizationId = Schema.decodeUnknownSync(Ulid)("01JA0000000000000000000002");
const timestamp = "2026-10-15T12:00:00.000Z";

/** One organization whose Brain placement is active and one whose memory search is not yet. */
function install() {
  const secondId = Schema.decodeUnknownSync(Ulid)("01JA0000000000000000000003");
  const records = [
    ...[organizationId, secondId].map((id) =>
      Schema.decodeUnknownSync(OrganizationRecord)(
        withCanonicalRecordKeys({
          data: {
            createdAt: timestamp,
            id,
            name: id,
            slug: id.toLowerCase(),
            status: "active" as const,
            updatedAt: timestamp,
            version: 1,
          },
          itemType: "organization" as const,
        }),
      ),
    ),
    ...[
      { id: organizationId, phase: "active" as const },
      { id: secondId, phase: "unconfigured" as const },
    ].map(({ id, phase }) =>
      Schema.decodeUnknownSync(BrainSearchPlacementRecord)(
        withCanonicalRecordKeys({
          data: {
            createdAt: timestamp,
            generation: phase === "active" ? 1 : 0,
            organizationId: id,
            phase,
            updatedAt: timestamp,
            version: phase === "active" ? 1 : 0,
            ...(phase === "active"
              ? {
                  readTarget: activeTarget,
                  writeTarget: activeTarget,
                }
              : {}),
          },
          itemType: "brain-search-placement" as const,
        }),
      ),
    ),
  ] as PlatformRecord[];
  const values = new Map(records.map((record) => [`${record.pk}\0${record.sk}`, record]));
  return {
    getRecord: async (_table: string, key: { readonly pk: string; readonly sk: string }) =>
      values.get(`${key.pk}\0${key.sk}`),
    queryRecords: async (_table: string, input: { readonly IndexName?: string }) => ({
      items: input.IndexName === "gsi1" ? records.filter((r) => r.itemType === "organization") : [],
    }),
  } as unknown as DynamoDatabaseService;
}

const activeTarget = {
  components: (["dense", "entity", "exact", "lexical"] as const).map((kind, index) => ({
    componentId: Schema.decodeUnknownSync(Ulid)(`01JB00000000000000000000${index}0`),
    kind,
  })),
  embeddingProfileId: Schema.decodeUnknownSync(Ulid)("01JB0000000000000000000050"),
  location: { openSearchIndex: "brain-example-v1" },
  providerId: "aws-native" as const,
  schemaGeneration: 1,
  targetId: Schema.decodeUnknownSync(Ulid)("01JB0000000000000000000060"),
};

describe("Brain search placement Lambda", () => {
  test("reads the organization from memory.search-placement.activated or an operator request", () => {
    expect(
      brainSearchPlacementOrganizationId({
        detail: { organizationId },
      }),
    ).toBe(organizationId);
    expect(brainSearchPlacementOrganizationId({ organizationId })).toBe(organizationId);
    expect(() => brainSearchPlacementOrganizationId({ detail: {} })).toThrow();
  });

  test("requires the install's Brain search domain", () => {
    expect(
      defaultBrainSearchConfig({
        AWS_REGION: "us-east-2",
        DEPLOYMENTS_AI_BRAIN_OPENSEARCH_ENDPOINT: "https://search.example.com",
      }),
    ).toEqual({ openSearchEndpoint: "https://search.example.com", region: "us-east-2" });
    expect(() => defaultBrainSearchConfig({ AWS_REGION: "us-east-2" })).toThrow(
      "DEPLOYMENTS_AI_BRAIN_OPENSEARCH_ENDPOINT",
    );
  });

  test("activates one page of every organization for an install-wide request", async () => {
    const result = await handleBrainSearchPlacement(
      { organizations: "all" },
      {
        config: { openSearchEndpoint: "https://search.example.com", region: "us-east-2" },
        database: install(),
        generateId: async () => {
          throw new Error("No organization here needs a new target.");
        },
        now: () => timestamp,
        providers: {
          resolve: async () => {
            throw new Error("No organization here needs an index.");
          },
        },
        repository: {
          getDocumentRendition: async () => undefined,
          getDocumentVersion: async () => undefined,
          listByOrganization: async () => {
            throw new Error("The install-wide sweep backfills only organizations it activates.");
          },
          listDocuments: async () => ({ items: [] }),
        },
      },
    );
    expect(result).toEqual({
      failed: [],
      results: [
        { organizationId, outcome: "configured" },
        { organizationId: "01JA0000000000000000000003", outcome: "memory-search-inactive" },
      ],
    });
  });
});
