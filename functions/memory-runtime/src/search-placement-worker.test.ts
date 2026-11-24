import { describe, expect, it } from "bun:test";
import {
  OrganizationRecord,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import type { DefaultMemorySearchConfig } from "./default-search-placement.ts";
import { handleDefaultMemorySearch } from "./search-placement-worker.ts";

const organizationIds = ["01JA0000000000000000000002", "01JA0000000000000000000003"] as Ulid[];
const timestamp = "2026-10-15T12:00:00.000Z";
const config: DefaultMemorySearchConfig = {
  embeddingDimensions: 1536,
  embeddingModel: "bedrock/global.cohere.embed-v4:0",
  openSearchEndpoint: "https://vpc-search-abc123.us-east-2.es.amazonaws.com",
  region: "us-east-2",
};

function organization(id: Ulid) {
  return Schema.decodeUnknownSync(OrganizationRecord)(
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
  ) as PlatformRecord;
}

/** Organizations whose memory placement an operator already configured. */
function configuredInstall() {
  const records = new Map<string, PlatformRecord>();
  for (const id of organizationIds) {
    const value = organization(id);
    records.set(`${value.pk}\0${value.sk}`, value);
    records.set(`ORG#${id}\0MEMORY-SEARCH-PLACEMENT#${id}`, {
      data: { organizationId: id, phase: "active" },
      itemType: "memory-search-placement",
      pk: `ORG#${id}`,
      sk: `MEMORY-SEARCH-PLACEMENT#${id}`,
    } as unknown as PlatformRecord);
  }
  return {
    getRecord: async (_table: string, key: { readonly pk: string; readonly sk: string }) =>
      records.get(`${key.pk}\0${key.sk}`),
    queryRecords: async (_table: string, input: { readonly IndexName?: string }) => ({
      items:
        input.IndexName === "gsi1"
          ? organizationIds.map((id) => records.get(`ORG#${id}\0ORG#${id}`)!)
          : [],
    }),
  } as unknown as DynamoDatabaseService;
}

const dependencies = (database: DynamoDatabaseService) => ({
  config,
  control: {
    registerCatalog: async () => {
      throw new Error("A configured placement must not register a catalog.");
    },
    requestProvisioning: async () => {
      throw new Error("A configured placement must not be provisioned.");
    },
  },
  database,
  dispatch: async () => {},
});

describe("default memory search placement worker", () => {
  it("activates the organization named by an organization.created delivery", async () => {
    const result = await handleDefaultMemorySearch(
      {
        Records: [
          {
            body: JSON.stringify({
              detail: {
                eventType: "organization.created",
                organizationId: organizationIds[0],
                payload: { id: organizationIds[0], status: "active" },
              },
              "detail-type": "organization.created",
            }),
            messageId: "message-1",
          },
          { body: JSON.stringify({ detail: { organizationId: "not-a-ulid" } }), messageId: "bad" },
        ],
      },
      dependencies(configuredInstall()),
    );
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "bad" }] });
  });

  it("activates one page of every organization for an install-wide request", async () => {
    const result = await handleDefaultMemorySearch(
      { organizations: "all" },
      dependencies(configuredInstall()),
    );
    expect(result).toEqual({
      failed: [],
      results: organizationIds.map((organizationId) => ({
        organizationId,
        outcome: "configured",
      })),
    });
  });

  it("activates one organization an operator names", async () => {
    expect(
      await handleDefaultMemorySearch(
        { organizationId: organizationIds[1]! },
        dependencies(configuredInstall()),
      ),
    ).toEqual({ outcome: "configured", phase: "active" });
  });
});
