import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { makeDynamoDatabase } from "./dynamo-database.ts";
import { Ulid } from "./ids.ts";
import { readOrganizationErasureRemnants } from "./organization-erasure-remnants.ts";
import { withCanonicalRecordKeys } from "./records/index.ts";
import { fakeDynamoDocumentClient } from "./testing/dynamo-document-client.fixture.ts";

const organizationId = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G6006");
const timestamp = "2026-10-23T12:00:00.000Z";
const placement = {
  createdAt: timestamp,
  generation: 0,
  organizationId,
  phase: "unconfigured" as const,
  updatedAt: timestamp,
  version: 0,
};

const items = {
  brainPlacement: withCanonicalRecordKeys({
    data: placement,
    itemType: "brain-search-placement" as const,
  }),
  memoryPlacement: withCanonicalRecordKeys({
    data: { ...placement, writeTargets: [] },
    itemType: "memory-search-placement" as const,
  }),
  organization: withCanonicalRecordKeys({
    data: {
      createdAt: timestamp,
      id: organizationId,
      name: "Acme",
      slug: "acme",
      status: "active",
      updatedAt: timestamp,
      version: 1,
    },
    itemType: "organization" as const,
  }),
};

function read(stored: readonly object[]) {
  const dynamo = fakeDynamoDocumentClient();
  for (const item of stored) dynamo.put("control", item);
  return readOrganizationErasureRemnants(makeDynamoDatabase(dynamo.client), organizationId);
}

describe("organization erasure remnants", () => {
  test("reads the organization record and each search placement", async () => {
    expect([
      await read([]),
      await read([items.organization]),
      await read([items.brainPlacement]),
      await read([items.memoryPlacement]),
    ]).toEqual([
      { organizationExists: false, searchPlacementExists: false },
      { organizationExists: true, searchPlacementExists: false },
      { organizationExists: false, searchPlacementExists: true },
      { organizationExists: false, searchPlacementExists: true },
    ]);
  });
});
