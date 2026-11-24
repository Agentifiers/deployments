import { describe, expect, test } from "bun:test";
import type { BrainOpenSearchTransport } from "@deployments-ai/brains";
import { makeDynamoDatabase, Ulid, withCanonicalRecordKeys } from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { Schema } from "effect";
import { dropErasedOrganizationBrainIndex } from "./erased-search-index-drop.ts";

const organizationId = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G6006");
const ownIndex = "brain-01arz3ndektsv4rrffq69g6006-v1";
const timestamp = "2026-10-23T12:00:00.000Z";

const records = {
  brainPlacement: withCanonicalRecordKeys({
    data: {
      createdAt: timestamp,
      generation: 0,
      organizationId,
      phase: "unconfigured" as const,
      updatedAt: timestamp,
      version: 0,
    },
    itemType: "brain-search-placement" as const,
  }),
  memoryPlacement: withCanonicalRecordKeys({
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

function domain(items: readonly object[], indexes: readonly string[] = [ownIndex]) {
  const dynamo = fakeDynamoDocumentClient();
  for (const item of items) dynamo.put("control", item);
  const live = new Set(indexes);
  const requests: string[] = [];
  const openSearch: BrainOpenSearchTransport = {
    request: async ({ method, path }) => {
      requests.push(`${method} ${path}`);
      const index = decodeURIComponent(path.slice(1));
      if (method !== "DELETE" || !live.delete(index)) {
        throw Object.assign(new Error("Brain OpenSearch request failed with status 404."), {
          status: 404,
          type: "index_not_found_exception",
        });
      }
      return { acknowledged: true };
    },
  };
  const drop = (index = ownIndex) =>
    dropErasedOrganizationBrainIndex({
      database: makeDynamoDatabase(dynamo.client),
      index,
      openSearch,
      organizationId,
    });
  return { drop, live, requests };
}

describe("drop-erased-organization-search-index", () => {
  test("drops the erased organization's own index, and a second call is a no-op", async () => {
    const search = domain([]);

    expect([await search.drop(), await search.drop(), search.requests, [...search.live]]).toEqual([
      { index: ownIndex, outcome: "dropped" },
      { index: ownIndex, outcome: "already-absent" },
      [`DELETE /${ownIndex}`, `DELETE /${ownIndex}`],
      [],
    ]);
  });

  test("refuses an organization that still exists", async () => {
    const search = domain([records.organization]);

    expect([await search.drop(), search.requests]).toEqual([
      { index: ownIndex, outcome: "refused", reason: "organization-exists" },
      [],
    ]);
  });

  test("refuses an organization with a Brain or a memory search placement", async () => {
    const brain = domain([records.brainPlacement]);
    const memory = domain([records.memoryPlacement]);

    expect([await brain.drop(), await memory.drop(), brain.requests, memory.requests]).toEqual([
      { index: ownIndex, outcome: "refused", reason: "search-placement-exists" },
      { index: ownIndex, outcome: "refused", reason: "search-placement-exists" },
      [],
      [],
    ]);
  });

  test("refuses any name other than the organization's own index", async () => {
    const crafted = [
      "brain-*",
      "brain-01arz3ndektsv4rrffq69g6006-*",
      `${ownIndex},brain-01arz3ndektsv4rrffq69g6007-v1`,
      "brain-01ARZ3NDEKTSV4RRFFQ69G6006-v1",
      "BRAIN-01ARZ3NDEKTSV4RRFFQ69G6006-V1",
      "brain-01arz3ndektsv4rrffq69g6007-v1",
      "memory-01arz3ndektsv4rrffq69g6006-v1",
      `${ownIndex}/_doc`,
      "",
    ];
    const search = domain([], crafted);

    const answers = await Promise.all(crafted.map((index) => search.drop(index)));

    expect([answers, search.requests]).toEqual([
      crafted.map(
        (index) => ({ index, outcome: "refused", reason: "not-organization-index" }) as const,
      ),
      [],
    ]);
  });
});
