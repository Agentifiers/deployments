import { describe, expect, it } from "bun:test";
import {
  transactionItemCount,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { createHash } from "node:crypto";
import { awsNativeTargetLocation, makeAwsNativeMemoryProvider } from "./aws-native.ts";
import type { OpenSearchTransport } from "./aws-native-contracts.ts";
import { scriptedPurgeOpenSearch } from "./aws-native-purge-test-transport.ts";
import { makeMemorySearchRegistration } from "./control-plane-registration.ts";
import { makeMemorySearchErasurePurger } from "./erasure.ts";
import {
  completedErasure,
  databaseFixture,
  erasureLocation,
  primaryErasureTarget,
} from "./erasure-test-fixtures.ts";
import type { MemorySearchTarget } from "./provider.ts";
import { ids, memoryEmbeddingGatewayRoute } from "./test-fixtures.ts";

const SEEDED_AT = "2026-07-28T12:00:00.000Z";
const ERASED_AT = "2026-07-29T08:00:00.000Z";
const OWN_INDEX = "memory-01arz3ndektsv4rrffq69g5fa5-v1";
const OWN_COMPONENT = "01ARZ3NDEKTSV4RRFFQ69G5FB1" as Ulid;
const OWN_GENERATION = "01ARZ3NDEKTSV4RRFFQ69G5FB2" as Ulid;
const OWN_TARGET = "01ARZ3NDEKTSV4RRFFQ69G5FB3" as Ulid;
const ownLocation = { ...erasureLocation, openSearchIndex: OWN_INDEX };
const ABANDONED_COMPONENT = "01ARZ3NDEKTSV4RRFFQ69G5FB4" as Ulid;
const ABANDONED_GENERATION = "01ARZ3NDEKTSV4RRFFQ69G5FB5" as Ulid;
const ABANDONED_TARGET = "01ARZ3NDEKTSV4RRFFQ69G5FB6" as Ulid;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SHARED_CATALOG_LEFT = {
  "memory-embedding-profile": 1,
  "memory-erasure-target-receipt": 1,
  "memory-search-component": 1,
  "memory-search-generation": 1,
  "memory-search-generation-live-shard": 0,
  "memory-search-generation-live-target": 0,
  "memory-search-generation-target": 0,
  "memory-search-generation-target-shard": 0,
  "memory-search-physical-owner": 0,
  "memory-search-target-identity": 0,
};

/**
 * Generations that aborted provisionings left at the own index: a component, a generation, a
 * membership and its shard head, and an empty live shard head each.
 */
function staleGenerations(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const suffix = `0${CROCKFORD[index >> 5]}${CROCKFORD[index & 31]}`;
    const componentId = `01ARZ3NDEKTSV4RRFFQ69G7${suffix}` as Ulid;
    const generationId = `01ARZ3NDEKTSV4RRFFQ69G8${suffix}` as Ulid;
    const shard = index % 16;
    const base = { createdAt: SEEDED_AT, updatedAt: SEEDED_AT, version: 0 };
    return [
      {
        data: {
          ...base,
          componentKind: "dense",
          embeddingProfileId: ids.agent,
          generationId,
          id: componentId,
          location: ownLocation,
          providerId: "aws-native",
          schemaGeneration: 1,
          status: "active",
        },
        itemType: "memory-search-component" as const,
      },
      {
        data: {
          ...base,
          componentKind: "dense",
          generation: 1,
          id: generationId,
          location: ownLocation,
          providerId: "aws-native",
          status: "active",
        },
        itemType: "memory-search-generation" as const,
      },
      {
        data: {
          ...base,
          generationId,
          keyVersion: 1,
          membershipShard: shard,
          providerId: "aws-native",
          targetDigest: `stale-${index}`,
        },
        itemType: "memory-search-generation-target" as const,
      },
      {
        data: { ...base, count: 1, generationId, membershipShard: shard, mutationWatermark: 1 },
        itemType: "memory-search-generation-target-shard" as const,
      },
      {
        data: { ...base, count: 0, generationId, liveShard: shard, mutationWatermark: 2 },
        itemType: "memory-search-generation-live-shard" as const,
      },
    ].map((record) => withCanonicalRecordKeys(record as never) as unknown as PlatformRecord);
  }).flat();
}
const ownTarget: MemorySearchTarget = {
  componentIds: [OWN_COMPONENT],
  embeddingProfileId: ids.agent,
  location: ownLocation,
  providerId: "aws-native",
  schemaGeneration: 1,
  targetId: OWN_TARGET,
};

const membershipDigest = async (targetId: Ulid) => ({
  digest: `digest-${targetId}`,
  keyVersion: 1,
});

const CATALOG_TYPES = [
  "memory-embedding-profile",
  "memory-search-component",
  "memory-search-generation",
  "memory-search-generation-target",
  "memory-search-generation-target-shard",
  "memory-search-generation-live-target",
  "memory-search-generation-live-shard",
  "memory-search-physical-owner",
  "memory-search-target-identity",
  "memory-erasure-target-receipt",
] as const;

function indexNotFound(index: string) {
  return Object.assign(new Error("OpenSearch request failed with status 404."), {
    details: { error: { index, type: "index_not_found_exception" }, status: 404 },
    status: 404,
  });
}

/** OpenSearch holding the organization's own index until a DELETE removes it. */
function ownIndexOpenSearch() {
  const requests: string[] = [];
  let present = true;
  const transport: OpenSearchTransport = {
    request: async ({ method, path }) => {
      requests.push(`${method} ${path}`);
      if (path === "/_snapshot/_all") return { "cs-automated-enc": { type: "s3" } };
      if (path !== `/${OWN_INDEX}`) throw new Error(`Unscripted OpenSearch request ${path}`);
      if (!present) throw indexNotFound(OWN_INDEX);
      if (method === "DELETE") {
        present = false;
        return { acknowledged: true };
      }
      return { [OWN_INDEX]: {} };
    },
  };
  return { requests, transport };
}

/**
 * An organization whose placement uses `target`. The shared catalog registers a second component
 * at `memory-v3` with the same embedding profile, so that profile outlives the own index.
 */
async function erasureOf(
  target: MemorySearchTarget,
  openSearch: OpenSearchTransport,
  extra: readonly PlatformRecord[] = [],
  sharedCatalog = true,
) {
  const fixture = databaseFixture();
  const registration = makeMemorySearchRegistration({
    database: fixture.database,
    membershipDigest,
    now: () => new Date(SEEDED_AT),
  });
  await registration.registerCatalog({
    components: [
      {
        componentKind: "dense",
        embeddingProfileId: ids.agent,
        generationId: OWN_GENERATION,
        id: OWN_COMPONENT,
        location: ownLocation,
        providerId: "aws-native",
        schemaGeneration: 1,
      },
      ...(sharedCatalog
        ? [
            {
              componentKind: "dense" as const,
              embeddingProfileId: ids.agent,
              generationId: ids.memory2,
              id: ids.space,
              location: erasureLocation,
              providerId: "aws-native" as const,
              schemaGeneration: 1,
            },
          ]
        : []),
    ],
    generations: [
      {
        componentKind: "dense",
        generation: 1,
        id: OWN_GENERATION,
        location: ownLocation,
        providerId: "aws-native",
      },
      ...(sharedCatalog
        ? [
            {
              componentKind: "dense" as const,
              generation: 1,
              id: ids.memory2,
              location: erasureLocation,
              providerId: "aws-native" as const,
            },
          ]
        : []),
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
  fixture.apply(
    await registration.registrationOperations({
      operationId: ids.toolCall,
      organizationId: ids.organization,
      placementGeneration: 1,
      target,
      timestamp: SEEDED_AT,
    }),
  );
  const gate = fixture
    .records()
    .find((record) => record.itemType === "memory-provider-mutation-gate")!;
  fixture.apply([
    {
      kind: "put",
      previousRecord: gate,
      record: withCanonicalRecordKeys({
        data: {
          ...gate.data,
          operationId: ids.toolCall,
          status: "closed",
          version: gate.data.version + 1,
        },
        itemType: gate.itemType,
      } as never) as unknown as PlatformRecord,
    },
    {
      kind: "put",
      record: withCanonicalRecordKeys({
        data: {
          createdAt: SEEDED_AT,
          generation: 1,
          organizationId: ids.organization,
          phase: "active" as const,
          readTarget: target,
          updatedAt: SEEDED_AT,
          version: 0,
          writeTargets: [target],
        },
        itemType: "memory-search-placement" as const,
      }) as PlatformRecord,
    },
    ...extra.map((record) => ({ kind: "put" as const, record })),
  ]);
  const commits = { count: 0, failAt: 0, items: [] as number[] };
  const clock = { now: Date.parse(ERASED_AT) };
  const database = {
    ...fixture.database,
    transactWriteForErasure: async (operations: readonly TransactionOperation[]) => {
      commits.count += 1;
      if (commits.count === commits.failAt) throw new Error("TransactionCanceledException");
      commits.items.push(transactionItemCount(operations));
      await fixture.database.transactWriteForErasure!(operations, {
        operationId: ids.toolCall,
        organizationId: ids.organization,
      });
    },
  } as DynamoDatabaseService;
  const now = () => new Date(clock.now);
  const purger = makeMemorySearchErasurePurger({
    approvedOpenSearchEndpoint: erasureLocation.openSearchEndpoint,
    database,
    membershipDigest,
    now,
    registry: {
      resolve: async (resolved) =>
        makeAwsNativeMemoryProvider({
          config: awsNativeTargetLocation(resolved),
          now,
          openSearch,
          target: resolved,
        }),
    },
  });
  return {
    catalog: () =>
      Object.fromEntries(
        CATALOG_TYPES.map((itemType) => [
          itemType,
          fixture.records().filter((record) => record.itemType === itemType).length,
        ]),
      ),
    clock,
    commits,
    erase: () => purger(ids.organization, ids.toolCall),
  };
}

function receiptDigest(targetId: Ulid, providerReceipt: Readonly<Record<string, unknown>>) {
  return createHash("sha256")
    .update(`digest-${targetId}`)
    .update(JSON.stringify(providerReceipt))
    .digest("hex");
}

function droppedReceipt(indexDrop: "already-absent" | "dropped") {
  return {
    absenceVerified: false,
    backupErasureEligibleAt: "2026-08-12T09:00:00.000Z",
    liveStorageVerified: true,
    openSearch: { indexAlreadyAbsent: true },
    providerPurgeStartedAt: ERASED_AT,
    providerPurgeState: {
      liveStorageVerifiedAt: ERASED_AT,
      openSearchIndexAbsent: true,
      stage: "backup-wait",
    },
    snapshotInventoryVerified: true,
    indexDrop,
  };
}

const ownErasure = (indexDrop: "already-absent" | "dropped") => [
  {
    backupErasureEligibleAt: "2026-08-12T09:00:00.000Z",
    componentReceipts: [
      {
        componentId: OWN_COMPONENT,
        generationId: OWN_GENERATION,
        providerReceipt: {
          absenceVerified: true as const,
          receiptDigest: receiptDigest(OWN_TARGET, droppedReceipt(indexDrop)),
        },
      },
    ],
    providerId: "aws-native" as const,
    targetDigest: `digest-${OWN_TARGET}`,
  },
];

describe("tenant memory erasure drops the organization's own index", () => {
  it("drops an exclusive index and retires the catalog records that existed only for it", async () => {
    const openSearch = ownIndexOpenSearch();
    const erasure = await erasureOf(ownTarget, openSearch.transport);

    expect(completedErasure(await erasure.erase()).targets).toEqual(ownErasure("dropped"));
    expect({ catalog: erasure.catalog(), requests: openSearch.requests }).toEqual({
      catalog: {
        "memory-embedding-profile": 1,
        "memory-erasure-target-receipt": 1,
        "memory-search-component": 1,
        "memory-search-generation": 1,
        "memory-search-generation-live-shard": 0,
        "memory-search-generation-live-target": 0,
        "memory-search-generation-target": 0,
        "memory-search-generation-target-shard": 0,
        "memory-search-physical-owner": 0,
        "memory-search-target-identity": 0,
      },
      requests: ["GET /_snapshot/_all", `DELETE /${OWN_INDEX}`, `GET /${OWN_INDEX}`],
    });
  });

  it("answers a repeated erasure from its receipts without touching OpenSearch", async () => {
    const openSearch = ownIndexOpenSearch();
    const erasure = await erasureOf(ownTarget, openSearch.transport);
    await erasure.erase();
    openSearch.requests.splice(0);

    expect(completedErasure(await erasure.erase()).targets).toEqual(ownErasure("dropped"));
    expect(openSearch.requests).toEqual([]);
  });

  it("converges when the commit after the drop fails", async () => {
    const openSearch = ownIndexOpenSearch();
    const erasure = await erasureOf(ownTarget, openSearch.transport);
    erasure.commits.failAt = 1;

    expect(await erasure.erase().catch((cause: Error) => cause.message)).toBe(
      "TransactionCanceledException",
    );
    expect(completedErasure(await erasure.erase()).targets).toEqual(ownErasure("already-absent"));
    expect({ catalog: erasure.catalog(), requests: openSearch.requests }).toEqual({
      catalog: {
        "memory-embedding-profile": 1,
        "memory-erasure-target-receipt": 1,
        "memory-search-component": 1,
        "memory-search-generation": 1,
        "memory-search-generation-live-shard": 0,
        "memory-search-generation-live-target": 0,
        "memory-search-generation-target": 0,
        "memory-search-generation-target-shard": 0,
        "memory-search-physical-owner": 0,
        "memory-search-target-identity": 0,
      },
      requests: [
        "GET /_snapshot/_all",
        `DELETE /${OWN_INDEX}`,
        `GET /${OWN_INDEX}`,
        "GET /_snapshot/_all",
        `DELETE /${OWN_INDEX}`,
        `GET /${OWN_INDEX}`,
      ],
    });
  });

  it("purges a shared index without dropping it and keeps its catalog records", async () => {
    const shared = scriptedPurgeOpenSearch("memory-v3");
    const erasure = await erasureOf(primaryErasureTarget, shared.transport);

    await erasure.erase();
    await erasure.erase();
    const receipt = completedErasure(await erasure.erase());

    expect({
      catalog: erasure.catalog(),
      deletes: shared.requests.filter(
        ({ method, path }) => method === "DELETE" && path === "/memory-v3",
      ),
      targets: receipt.targets.map(({ targetDigest }) => targetDigest),
    }).toEqual({
      catalog: {
        "memory-embedding-profile": 1,
        "memory-erasure-target-receipt": 1,
        "memory-search-component": 2,
        "memory-search-generation": 2,
        "memory-search-generation-live-shard": 1,
        "memory-search-generation-live-target": 0,
        "memory-search-generation-target": 1,
        "memory-search-generation-target-shard": 1,
        "memory-search-physical-owner": 0,
        "memory-search-target-identity": 1,
      },
      deletes: [],
      targets: [`digest-${ids.run}`],
    });
  });

  it("retires an unused component that also names the dropped index", async () => {
    const openSearch = ownIndexOpenSearch();
    const erasure = await erasureOf(ownTarget, openSearch.transport, [
      withCanonicalRecordKeys({
        data: {
          componentKind: "dense",
          createdAt: SEEDED_AT,
          embeddingProfileId: ids.agent,
          generationId: ABANDONED_GENERATION,
          id: ABANDONED_COMPONENT,
          location: ownLocation,
          providerId: "aws-native",
          schemaGeneration: 1,
          status: "active",
          updatedAt: SEEDED_AT,
          version: 0,
        },
        itemType: "memory-search-component" as const,
      }) as PlatformRecord,
      withCanonicalRecordKeys({
        data: {
          componentKind: "dense",
          createdAt: SEEDED_AT,
          generation: 1,
          id: ABANDONED_GENERATION,
          location: ownLocation,
          providerId: "aws-native",
          status: "active",
          updatedAt: SEEDED_AT,
          version: 0,
        },
        itemType: "memory-search-generation" as const,
      }) as PlatformRecord,
    ]);

    expect(completedErasure(await erasure.erase()).targets).toEqual(ownErasure("dropped"));
    expect([erasure.catalog()["memory-search-component"], openSearch.requests]).toEqual([
      1,
      ["GET /_snapshot/_all", `DELETE /${OWN_INDEX}`, `GET /${OWN_INDEX}`],
    ]);
  });

  it("keeps an own index whose catalog another target still references and purges it", async () => {
    const live = scriptedPurgeOpenSearch(OWN_INDEX);
    const erasure = await erasureOf(ownTarget, live.transport, [
      withCanonicalRecordKeys({
        data: {
          componentId: OWN_COMPONENT,
          createdAt: SEEDED_AT,
          generationId: OWN_GENERATION,
          liveShard: 4,
          operationId: ids.toolCall,
          organizationId: ids.organization,
          placementGeneration: 1,
          referenceRole: "candidate",
          targetId: ABANDONED_TARGET,
          updatedAt: SEEDED_AT,
          version: 0,
        },
        itemType: "memory-search-generation-live-target" as const,
      }) as PlatformRecord,
    ]);

    await erasure.erase();
    await erasure.erase();
    completedErasure(await erasure.erase());

    expect({
      catalog: erasure.catalog(),
      deletes: live.requests.filter(({ method }) => method === "DELETE").map(({ path }) => path),
    }).toEqual({
      catalog: {
        "memory-embedding-profile": 1,
        "memory-erasure-target-receipt": 1,
        "memory-search-component": 2,
        "memory-search-generation": 2,
        "memory-search-generation-live-shard": 1,
        "memory-search-generation-live-target": 1,
        "memory-search-generation-target": 1,
        "memory-search-generation-target-shard": 1,
        "memory-search-physical-owner": 0,
        "memory-search-target-identity": 1,
      },
      deletes: ["/.tasks/_doc/delete-task", "/.tasks/_doc/merge-task"],
    });
  });

  it("retires 20 stale generations at the index in batches that stay under 100 items", async () => {
    const openSearch = ownIndexOpenSearch();
    const erasure = await erasureOf(ownTarget, openSearch.transport, staleGenerations(20));

    expect(completedErasure(await erasure.erase()).targets).toEqual(ownErasure("dropped"));
    expect({ catalog: erasure.catalog(), items: erasure.commits.items }).toEqual({
      catalog: SHARED_CATALOG_LEFT,
      items: [25, 25, 25, 25, 48],
    });
  });

  it("converges when erasure stops between retirement batches", async () => {
    const openSearch = ownIndexOpenSearch();
    const erasure = await erasureOf(ownTarget, openSearch.transport, staleGenerations(20));
    erasure.commits.failAt = 2;

    expect(await erasure.erase().catch((cause: Error) => cause.message)).toBe(
      "TransactionCanceledException",
    );
    expect(completedErasure(await erasure.erase()).targets).toEqual(ownErasure("already-absent"));
    expect({ catalog: erasure.catalog(), requests: openSearch.requests }).toEqual({
      catalog: SHARED_CATALOG_LEFT,
      requests: [
        "GET /_snapshot/_all",
        `DELETE /${OWN_INDEX}`,
        `GET /${OWN_INDEX}`,
        "GET /_snapshot/_all",
        `DELETE /${OWN_INDEX}`,
        `GET /${OWN_INDEX}`,
      ],
    });
  });

  it("retires the organization's own embedding profile with its index", async () => {
    const openSearch = ownIndexOpenSearch();
    const erasure = await erasureOf(ownTarget, openSearch.transport, [], false);

    completedErasure(await erasure.erase());

    expect(erasure.catalog()).toEqual({
      "memory-embedding-profile": 0,
      "memory-erasure-target-receipt": 1,
      "memory-search-component": 0,
      "memory-search-generation": 0,
      "memory-search-generation-live-shard": 0,
      "memory-search-generation-live-target": 0,
      "memory-search-generation-target": 0,
      "memory-search-generation-target-shard": 0,
      "memory-search-physical-owner": 0,
      "memory-search-target-identity": 0,
    });
  });

  it("keeps the embedding profile while the organization's Brain placement uses it", async () => {
    const openSearch = ownIndexOpenSearch();
    const brainTarget = {
      components: [{ componentId: OWN_COMPONENT, kind: "dense" }],
      embeddingProfileId: ids.agent,
      location: ownLocation,
      providerId: "aws-native",
      schemaGeneration: 1,
      targetId: ABANDONED_TARGET,
    };
    const erasure = await erasureOf(
      ownTarget,
      openSearch.transport,
      [
        withCanonicalRecordKeys({
          data: {
            createdAt: SEEDED_AT,
            generation: 1,
            organizationId: ids.organization,
            phase: "active",
            readTarget: brainTarget,
            updatedAt: SEEDED_AT,
            version: 0,
            writeTarget: brainTarget,
          },
          itemType: "brain-search-placement" as const,
        } as never) as unknown as PlatformRecord,
      ],
      false,
    );

    completedErasure(await erasure.erase());

    expect([erasure.catalog()["memory-embedding-profile"], openSearch.requests]).toEqual([
      1,
      ["GET /_snapshot/_all", `DELETE /${OWN_INDEX}`, `GET /${OWN_INDEX}`],
    ]);
  });

  it("keeps an own index whose generation a component at another index shares and purges it", async () => {
    const live = scriptedPurgeOpenSearch(OWN_INDEX);
    const erasure = await erasureOf(ownTarget, live.transport, [
      withCanonicalRecordKeys({
        data: {
          componentKind: "dense",
          createdAt: SEEDED_AT,
          embeddingProfileId: ids.agent,
          generationId: OWN_GENERATION,
          id: ABANDONED_COMPONENT,
          location: erasureLocation,
          providerId: "aws-native",
          schemaGeneration: 1,
          status: "active",
          updatedAt: SEEDED_AT,
          version: 0,
        },
        itemType: "memory-search-component" as const,
      }) as PlatformRecord,
    ]);

    await erasure.erase();
    await erasure.erase();
    completedErasure(await erasure.erase());

    expect({
      catalog: erasure.catalog(),
      requests: live.requests
        .filter(({ method }) => method !== "GET")
        .map(({ method, path }) => `${method} ${path}`),
    }).toEqual({
      catalog: {
        "memory-embedding-profile": 1,
        "memory-erasure-target-receipt": 1,
        "memory-search-component": 3,
        "memory-search-generation": 2,
        "memory-search-generation-live-shard": 1,
        "memory-search-generation-live-target": 0,
        "memory-search-generation-target": 1,
        "memory-search-generation-target-shard": 1,
        "memory-search-physical-owner": 0,
        "memory-search-target-identity": 1,
      },
      requests: [
        `POST /${OWN_INDEX}/_delete_by_query?conflicts=proceed&refresh=true&wait_for_completion=false`,
        "DELETE /.tasks/_doc/delete-task",
        `POST /${OWN_INDEX}/_forcemerge?max_num_segments=1&flush=true&wait_for_completion=false`,
        "DELETE /.tasks/_doc/merge-task",
        `POST /${OWN_INDEX}/_flush?force=true&wait_if_ongoing=true`,
        `POST /${OWN_INDEX}/_search`,
      ],
    });
  });
});
