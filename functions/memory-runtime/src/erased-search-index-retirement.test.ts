import { PlatformRecord, Ulid, withCanonicalRecordKeys } from "@deployments-ai/db";
import { evaluationMemoryDatabase } from "@deployments-ai/db/evaluation-testing";
import { memorySearchTargetIdentity, physicalLocationHash } from "@deployments-ai/memory";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { defaultMemorySearchCatalog } from "./default-search-placement.ts";
import { retireErasedOrganizationSearchIndex } from "./erased-search-index-retirement.ts";

const decodeUlid = Schema.decodeUnknownSync(Ulid);
const ERASED = decodeUlid("01M5DPY44RZS1S6VFWDW0YNTBS");
const LIVE = decodeUlid("01M5DPY50RN3AA86MA1KM7FXD4");
const OPERATION = decodeUlid("01ARZ3NDEKTSV4RRFFQ69G6015");
const ENDPOINT = "https://vpc-search-abc123.us-east-2.es.amazonaws.com";
const ERASED_INDEX = "memory-01m5dpy44rzs1s6vfwdw0yntbs-v1";
const CREATED = "2026-10-20T22:29:29.844Z";
const config = {
  embeddingDimensions: 1536,
  embeddingModel: "bedrock/global.cohere.embed-v4:0",
  openSearchEndpoint: ENDPOINT,
  region: "us-east-2",
};

const record = (itemType: PlatformRecord["itemType"], data: Readonly<Record<string, unknown>>) =>
  Schema.decodeUnknownSync(PlatformRecord)(
    withCanonicalRecordKeys({
      data: { createdAt: CREATED, updatedAt: CREATED, version: 0, ...data },
      itemType,
    } as never),
  );

/**
 * The catalog that default activation registered for an organization, as erasure left it: live
 * references and the physical owner removed, everything else in place. Membership sits in shard 11
 * because the retirement reads every shard.
 */
function catalogOf(organizationId: Ulid, options: { readonly live?: boolean } = {}) {
  const { catalog, componentId, generationId, target } = defaultMemorySearchCatalog(
    organizationId,
    config,
  );
  const digest = `digest-${target.targetId}`;
  const shard = 11;
  return [
    record("memory-embedding-profile", { ...catalog.profile, status: "active" }),
    record("memory-search-component", { ...catalog.components[0], status: "active" }),
    record("memory-search-generation", { ...catalog.generations[0], status: "active" }),
    record("memory-search-target-identity", {
      identityHash: memorySearchTargetIdentity(target),
      targetId: target.targetId,
    }),
    record("memory-search-generation-target", {
      generationId,
      keyVersion: 1,
      membershipShard: shard,
      providerId: "aws-native",
      targetDigest: digest,
    }),
    record("memory-search-generation-target-shard", {
      count: 1,
      generationId,
      membershipShard: shard,
      mutationWatermark: 1,
    }),
    record("memory-search-generation-live-shard", {
      count: options.live ? 1 : 0,
      generationId,
      liveShard: shard,
      mutationWatermark: 2,
      version: 1,
    }),
    ...(options.live
      ? [
          record("memory-search-generation-live-target", {
            componentId,
            generationId,
            liveShard: shard,
            operationId: OPERATION,
            organizationId,
            placementGeneration: 1,
            referenceRole: "read",
            targetId: target.targetId,
          }),
          record("memory-search-physical-owner", {
            componentId,
            componentKind: "dense",
            organizationId,
            physicalLocationHash: physicalLocationHash("dense", target.location),
            referenceCount: 1,
            targetId: target.targetId,
          }),
        ]
      : []),
  ];
}

function installation(
  extra: readonly PlatformRecord[] = [],
  erased: readonly PlatformRecord[] = catalogOf(ERASED),
) {
  const memory = evaluationMemoryDatabase([
    ...erased,
    ...catalogOf(LIVE, { live: true }),
    record("organization", {
      id: LIVE,
      name: "Live",
      slug: "live",
      status: "active",
      version: 1,
    }),
    ...extra,
  ]);
  const requests: string[] = [];
  const commits = { count: 0, failAt: 0 };
  const database = {
    ...memory.database,
    transactWrite: async (...args: Parameters<typeof memory.database.transactWrite>) => {
      commits.count += 1;
      if (commits.count === commits.failAt) throw new Error("TransactionCanceledException");
      await memory.database.transactWrite(...args);
    },
  };
  let present = true;
  return {
    commits,
    catalog: (organizationId: Ulid) =>
      memory
        .all()
        .filter((stored) => JSON.stringify(stored).includes(organizationId.slice(0, 10)))
        .map((stored) => stored.itemType)
        .toSorted(),
    requests,
    retire: (organizationId: Ulid, index: string) =>
      retireErasedOrganizationSearchIndex({
        approvedEndpoint: ENDPOINT,
        database,
        index,
        openSearch: {
          request: async ({ method, path }) => {
            requests.push(`${method} ${path}`);
            if (path === "/_snapshot/_all") return { "cs-automated-enc": { type: "s3" } };
            if (!present) {
              throw Object.assign(new Error("OpenSearch request failed with status 404."), {
                details: { error: { type: "index_not_found_exception" }, status: 404 },
                status: 404,
              });
            }
            present = false;
            return { acknowledged: true };
          },
        },
        organizationId,
        region: "us-east-2",
      }),
  };
}

const NOTHING_RETIRED = {
  "memory-embedding-profile": 0,
  "memory-search-component": 0,
  "memory-search-generation": 0,
  "memory-search-generation-live-shard": 0,
  "memory-search-generation-live-target": 0,
  "memory-search-generation-target": 0,
  "memory-search-generation-target-shard": 0,
  "memory-search-physical-owner": 0,
  "memory-search-target-identity": 0,
};

/**
 * Generations that aborted provisionings left at the erased organization's index with its default
 * profile, so the retirement needs more than one batch.
 */
function staleGenerations(count: number) {
  const { location, embeddingProfileId } = defaultMemorySearchCatalog(ERASED, config).target;
  return Array.from({ length: count }, (_, index) => {
    const componentId = decodeUlid(`${ERASED.slice(0, 10)}0000000000000C0${index}`);
    const generationId = decodeUlid(`${ERASED.slice(0, 10)}0000000000000G0${index}`);
    return [
      record("memory-search-component", {
        componentKind: "dense",
        embeddingProfileId,
        generationId,
        id: componentId,
        location,
        providerId: "aws-native",
        schemaGeneration: 3,
        status: "active",
      }),
      record("memory-search-generation", {
        componentKind: "dense",
        generation: 3,
        id: generationId,
        location,
        providerId: "aws-native",
        status: "active",
      }),
      record("memory-search-generation-target", {
        generationId,
        keyVersion: 1,
        membershipShard: index,
        providerId: "aws-native",
        targetDigest: `stale-${index}`,
      }),
      record("memory-search-generation-target-shard", {
        count: 1,
        generationId,
        membershipShard: index,
        mutationWatermark: 1,
      }),
      record("memory-search-generation-live-shard", {
        count: 0,
        generationId,
        liveShard: index,
        mutationWatermark: 2,
      }),
    ];
  }).flat();
}

const LIVE_CATALOG: PlatformRecord["itemType"][] = [
  "memory-embedding-profile",
  "memory-search-component",
  "memory-search-generation",
  "memory-search-generation-live-shard",
  "memory-search-generation-live-target",
  "memory-search-generation-target",
  "memory-search-generation-target-shard",
  "memory-search-physical-owner",
  "memory-search-target-identity",
  "organization",
];

describe("retiring an erased organization's memory index", () => {
  test("drops the index and retires exactly the catalog records that existed only for it", async () => {
    const memory = installation();

    expect(await memory.retire(ERASED, ERASED_INDEX)).toEqual({
      index: ERASED_INDEX,
      indexDrop: "dropped",
      outcome: "retired",
      retired: {
        "memory-embedding-profile": 1,
        "memory-search-component": 1,
        "memory-search-generation": 1,
        "memory-search-generation-live-shard": 1,
        "memory-search-generation-live-target": 0,
        "memory-search-generation-target": 1,
        "memory-search-generation-target-shard": 1,
        "memory-search-physical-owner": 0,
        "memory-search-target-identity": 1,
      },
    });
    expect({
      erased: memory.catalog(ERASED),
      live: memory.catalog(LIVE),
      requests: memory.requests,
    }).toEqual({
      erased: [],
      live: LIVE_CATALOG,
      requests: ["GET /_snapshot/_all", `DELETE /${ERASED_INDEX}`],
    });
  });

  test("a second call finds nothing left", async () => {
    const memory = installation();
    await memory.retire(ERASED, ERASED_INDEX);

    expect(await memory.retire(ERASED, ERASED_INDEX)).toEqual({
      index: ERASED_INDEX,
      indexDrop: "already-absent",
      outcome: "retired",
      retired: {
        "memory-embedding-profile": 0,
        "memory-search-component": 0,
        "memory-search-generation": 0,
        "memory-search-generation-live-shard": 0,
        "memory-search-generation-live-target": 0,
        "memory-search-generation-target": 0,
        "memory-search-generation-target-shard": 0,
        "memory-search-physical-owner": 0,
        "memory-search-target-identity": 0,
      },
    });
    expect(memory.catalog(ERASED)).toEqual([]);
  });

  test("refuses an organization that still exists or still has a memory search placement", async () => {
    const existing = installation();
    const placed = installation([
      record("memory-search-placement", {
        generation: 1,
        organizationId: ERASED,
        phase: "unconfigured",
        writeTargets: [],
      }),
    ]);

    expect([
      await existing.retire(LIVE, "memory-01m5dpy50rn3aa86ma1km7fxd4-v1"),
      await placed.retire(ERASED, ERASED_INDEX),
      existing.requests,
      placed.requests,
      placed.catalog(ERASED).length,
    ]).toEqual([
      {
        index: "memory-01m5dpy50rn3aa86ma1km7fxd4-v1",
        outcome: "refused",
        reason: "organization-exists",
      },
      { index: ERASED_INDEX, outcome: "refused", reason: "search-placement-exists" },
      [],
      [],
      8,
    ]);
  });

  test("refuses any name that is not exactly the organization's own index", async () => {
    const memory = installation();
    const names = [
      "memory-*",
      `${ERASED_INDEX},memory-01m5dpy50rn3aa86ma1km7fxd4-v1`,
      "memory-01m5dpy50rn3aa86ma1km7fxd4-v1",
      "memory-v3",
    ];

    expect(await Promise.all(names.map((index) => memory.retire(ERASED, index)))).toEqual(
      names.map((index) => ({ index, outcome: "refused", reason: "not-organization-index" })),
    );
    expect(memory.requests).toEqual([]);
  });

  test("refuses records that a live reference or a physical owner still uses", async () => {
    const referenced = installation(
      catalogOf(ERASED, { live: true }).filter(
        (stored) =>
          stored.itemType === "memory-search-generation-live-target" ||
          stored.itemType === "memory-search-physical-owner",
      ),
    );
    const owned = installation(
      catalogOf(ERASED, { live: true }).filter(
        (stored) => stored.itemType === "memory-search-physical-owner",
      ),
    );

    expect([
      await referenced.retire(ERASED, ERASED_INDEX),
      await owned.retire(ERASED, ERASED_INDEX),
      referenced.requests,
      owned.requests,
      owned.catalog(ERASED).length,
    ]).toEqual([
      { index: ERASED_INDEX, outcome: "refused", reason: "live-reference" },
      { index: ERASED_INDEX, outcome: "refused", reason: "physical-owner" },
      [],
      [],
      8,
    ]);
  });

  test("retires the profile that memory erasure kept for the organization's Brain search", async () => {
    const memory = installation(
      [],
      catalogOf(ERASED).filter((stored) => stored.itemType === "memory-embedding-profile"),
    );

    expect(await memory.retire(ERASED, ERASED_INDEX)).toEqual({
      index: ERASED_INDEX,
      indexDrop: "dropped",
      outcome: "retired",
      retired: { ...NOTHING_RETIRED, "memory-embedding-profile": 1 },
    });
    expect(memory.catalog(ERASED)).toEqual([]);
  });

  test("a run that stops between batches leaves the profile for the next run", async () => {
    const memory = installation(staleGenerations(4));
    memory.commits.failAt = 2;

    expect(await memory.retire(ERASED, ERASED_INDEX).catch((cause: Error) => cause.message)).toBe(
      "TransactionCanceledException",
    );
    expect(await memory.retire(ERASED, ERASED_INDEX)).toEqual({
      index: ERASED_INDEX,
      indexDrop: "already-absent",
      outcome: "retired",
      retired: {
        ...NOTHING_RETIRED,
        "memory-embedding-profile": 1,
        "memory-search-generation": 1,
      },
    });
    expect(memory.catalog(ERASED)).toEqual([]);
  });
});
