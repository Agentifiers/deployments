import { describe, expect, it } from "bun:test";
import {
  MemoryProviderPurgeCheckpointRecord,
  recordMemorySearchIndexDrop,
  withCanonicalRecordKeys,
  type Ulid,
} from "@deployments-ai/db";
import { decodeMemorySearchErasureResult } from "@deployments-ai/governance";
import { Schema } from "effect";
import { awsNativeTargetLocation, makeAwsNativeMemoryProvider } from "./aws-native.ts";
import type { OpenSearchTransport } from "./aws-native-contracts.ts";
import {
  droppedIndexOpenSearch,
  scriptedPurgeOpenSearch,
} from "./aws-native-purge-test-transport.ts";
import { makeMemorySearchErasurePurger, type PseudonymousProviderProof } from "./erasure.ts";
import {
  completedErasure,
  databaseFixture,
  primaryErasureTarget,
  secondaryErasureTarget,
  seedErasurePlacement,
  type ErasureDatabaseFixture,
} from "./erasure-test-fixtures.ts";
import type { MemorySearchProviderRegistry, MemorySearchTarget } from "./provider.ts";
import { ids } from "./test-fixtures.ts";

const SEEDED_AT = "2026-07-28T12:00:00.000Z";
const LIVE_PURGE_PENDING = { reason: "live_purge_running", status: "pending" } as const;
const proof: PseudonymousProviderProof = {
  absenceVerified: true,
  receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
};

const membershipDigest = async (targetId: Ulid) => ({
  digest: `digest-${targetId}`,
  keyVersion: 1,
});

function awsNativeRegistry(
  transports: Readonly<Record<string, OpenSearchTransport>>,
  now: () => Date,
): MemorySearchProviderRegistry {
  return {
    resolve: async (target) => {
      const config = awsNativeTargetLocation(target);
      const openSearch = transports[config.openSearchIndex];
      if (!openSearch) throw new Error(`No scripted OpenSearch for ${config.openSearchIndex}.`);
      return makeAwsNativeMemoryProvider({ config, now, openSearch, target });
    },
  };
}

function returningProvider(receipt: Readonly<Record<string, unknown>>) {
  const unused = scriptedPurgeOpenSearch("memory-v3");
  return {
    resolve: async (target: MemorySearchTarget) => ({
      ...makeAwsNativeMemoryProvider({
        config: awsNativeTargetLocation(target),
        openSearch: unused.transport,
        target,
      }),
      purgeOrganization: async () => ({ deleted: false, receipt }),
    }),
  };
}

async function erasureScenario(
  targets: readonly [MemorySearchTarget, ...MemorySearchTarget[]] = [primaryErasureTarget],
) {
  const fixture = databaseFixture();
  await seedErasurePlacement({ fixture, membershipDigest, targets, timestamp: SEEDED_AT });
  const clock = { now: new Date(SEEDED_AT) };
  const purgerWith = (registry: MemorySearchProviderRegistry) =>
    makeMemorySearchErasurePurger({
      database: fixture.database,
      membershipDigest,
      now: () => clock.now,
      registry,
    });
  return {
    checkpoints: () =>
      fixture.records().filter((record) => record.itemType === "memory-provider-purge-checkpoint"),
    clock,
    fixture,
    purgerWith,
    receipts: () =>
      fixture.records().filter((record) => record.itemType === "memory-erasure-target-receipt"),
  };
}

function seedCheckpoint(
  fixture: ErasureDatabaseFixture,
  values: {
    readonly backupErasureEligibleAt: string;
    readonly providerPurgeStartedAt: string;
    readonly providerReceipt: Readonly<Record<string, unknown>>;
  },
) {
  fixture.apply([
    {
      conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      kind: "put",
      record: Schema.decodeUnknownSync(MemoryProviderPurgeCheckpointRecord)(
        withCanonicalRecordKeys({
          data: {
            ...values,
            createdAt: values.providerPurgeStartedAt,
            operationId: ids.toolCall,
            organizationId: ids.organization,
            providerId: "aws-native",
            targetId: primaryErasureTarget.targetId,
            updatedAt: values.providerPurgeStartedAt,
            version: 0,
          },
          itemType: "memory-provider-purge-checkpoint" as const,
        }),
      ),
    },
  ]);
}

describe("tenant memory erasure on verified live storage", () => {
  it("completes on verified live storage before backups expire", async () => {
    const scenario = await erasureScenario();
    const openSearch = scriptedPurgeOpenSearch("memory-v3");
    const purger = scenario.purgerWith(
      awsNativeRegistry({ "memory-v3": openSearch.transport }, () => scenario.clock.now),
    );

    expect(await purger(ids.organization, ids.toolCall)).toEqual(LIVE_PURGE_PENDING);
    expect(scenario.checkpoints()).toMatchObject([
      { data: { providerReceipt: { providerPurgeState: { stage: "delete-by-query" } } } },
    ]);
    scenario.clock.now = new Date("2026-07-28T12:05:00.000Z");
    expect(await purger(ids.organization, ids.toolCall)).toEqual(LIVE_PURGE_PENDING);
    scenario.clock.now = new Date("2026-07-28T12:10:00.000Z");

    expect(
      decodeMemorySearchErasureResult(await purger(ids.organization, ids.toolCall), ids.toolCall),
    ).toEqual({
      receipt: {
        operationId: ids.toolCall,
        targets: [
          {
            backupErasureEligibleAt: "2026-08-11T13:10:00.000Z",
            componentReceipts: [
              { componentId: ids.space, generationId: ids.memory2, providerReceipt: proof },
            ],
            providerId: "aws-native",
            targetDigest: `digest-${ids.run}`,
          },
        ],
      },
      status: "complete",
    });
    const committed = scenario.fixture.transactions
      .at(-1)!
      .flatMap((operation) =>
        operation.kind === "put" || operation.kind === "delete"
          ? [`${operation.kind}:${operation.record.itemType}`]
          : [],
      );
    expect(committed).toContain("delete:memory-provider-purge-checkpoint");
    expect(committed).toContain("put:memory-erasure-target-receipt");
    expect(scenario.checkpoints()).toHaveLength(0);
    expect(scenario.receipts()).toMatchObject([
      { data: { backupErasureEligibleAt: "2026-08-11T13:10:00.000Z" } },
    ]);
    expect(JSON.stringify(scenario.receipts())).not.toContain(ids.organization);
  });

  it("keeps a running force merge pending", async () => {
    const scenario = await erasureScenario();
    const openSearch = scriptedPurgeOpenSearch("memory-v3");
    openSearch.script.forceMergeTaskComplete = false;
    const purger = scenario.purgerWith(
      awsNativeRegistry({ "memory-v3": openSearch.transport }, () => scenario.clock.now),
    );

    for (const minute of ["00", "05", "10"]) {
      scenario.clock.now = new Date(`2026-07-28T12:${minute}:00.000Z`);
      expect(await purger(ids.organization, ids.toolCall)).toEqual(LIVE_PURGE_PENDING);
    }

    expect(scenario.checkpoints()).toMatchObject([
      {
        data: {
          backupErasureEligibleAt: "2026-08-11T13:00:00.000Z",
          providerReceipt: {
            liveStorageVerified: false,
            providerPurgeState: { stage: "force-merge", taskId: "merge-task" },
          },
        },
      },
    ]);
    expect(scenario.receipts()).toHaveLength(0);
  });

  it("completes at once when the index is already absent", async () => {
    const scenario = await erasureScenario();
    const openSearch = scriptedPurgeOpenSearch("memory-v3");
    openSearch.script.indexAbsent = true;
    const purger = scenario.purgerWith(
      awsNativeRegistry({ "memory-v3": openSearch.transport }, () => scenario.clock.now),
    );

    const result = completedErasure(await purger(ids.organization, ids.toolCall));

    expect(result.targets.map((target) => target.backupErasureEligibleAt)).toEqual([
      "2026-08-11T13:00:00.000Z",
    ]);
    expect(openSearch.requests).toEqual([{ method: "GET", path: "/memory-v3" }]);
    expect(scenario.checkpoints()).toHaveLength(0);
  });

  it("erases an organization whose memory index an operator dropped", async () => {
    const scenario = await erasureScenario();
    await recordMemorySearchIndexDrop(scenario.fixture.database, {
      droppedAt: "2026-07-27T12:00:00.000Z",
      indexes: ["memory-v3"],
      operatorHold: {
        id: "operator/eval-closeout",
        placedAt: "2026-07-26T12:00:00.000Z",
        reason: "manual",
      },
      organizationId: ids.organization,
    });
    const dropped = droppedIndexOpenSearch("memory-v3");
    const purger = scenario.purgerWith(
      awsNativeRegistry({ "memory-v3": dropped.transport }, () => scenario.clock.now),
    );

    expect({
      requests: dropped.requests,
      result: decodeMemorySearchErasureResult(
        await purger(ids.organization, ids.toolCall),
        ids.toolCall,
      ),
    }).toEqual({
      requests: ["GET /memory-v3"],
      result: {
        receipt: {
          operationId: ids.toolCall,
          targets: [
            {
              backupErasureEligibleAt: "2026-08-11T13:00:00.000Z",
              componentReceipts: [
                { componentId: ids.space, generationId: ids.memory2, providerReceipt: proof },
              ],
              providerId: "aws-native",
              targetDigest: `digest-${ids.run}`,
            },
          ],
        },
        status: "complete",
      },
    });
  });

  it.each([
    [
      "delete-by-query",
      "failed",
      "_oZpvMX_Tz6JUzH-t4Gnaw:158208",
      [
        "GET /_tasks/_oZpvMX_Tz6JUzH-t4Gnaw%3A158208",
        "DELETE /.tasks/_doc/_oZpvMX_Tz6JUzH-t4Gnaw%3A158208",
        "GET /memory-v3",
      ],
    ],
    [
      "force-merge",
      "failed",
      "node:7",
      ["GET /_tasks/node%3A7", "DELETE /.tasks/_doc/node%3A7", "GET /memory-v3"],
    ],
    ["delete-by-query", "expired", "node:7", ["GET /_tasks/node%3A7", "GET /memory-v3"]],
    [
      "delete-by-query",
      "completed",
      "node:7",
      ["GET /_tasks/node%3A7", "DELETE /.tasks/_doc/node%3A7", "GET /memory-v3"],
    ],
  ] as const)(
    "finishes a dropped index's %s checkpoint whose saved task %s in one tick",
    async (stage, savedTask, taskId, requests) => {
      const scenario = await erasureScenario();
      seedCheckpoint(scenario.fixture, {
        backupErasureEligibleAt: "2026-11-07T01:10:09.487Z",
        providerPurgeStartedAt: "2026-10-24T00:10:09.487Z",
        providerReceipt: {
          absenceVerified: false,
          backupErasureEligibleAt: "2026-11-07T01:10:09.487Z",
          liveStorageVerified: false,
          openSearch: { taskResubmitted: true },
          providerPurgeStartedAt: "2026-10-24T00:10:09.487Z",
          providerPurgeState: { stage, taskId },
          snapshotInventoryVerified: false,
        },
      });
      scenario.clock.now = new Date("2026-10-24T01:10:11.081Z");
      const dropped = droppedIndexOpenSearch("memory-v3", savedTask);
      const purger = scenario.purgerWith(
        awsNativeRegistry({ "memory-v3": dropped.transport }, () => scenario.clock.now),
      );

      expect({
        requests: dropped.requests,
        result: decodeMemorySearchErasureResult(
          await purger(ids.organization, ids.toolCall),
          ids.toolCall,
        ),
      }).toEqual({
        requests: [...requests],
        result: {
          receipt: {
            operationId: ids.toolCall,
            targets: [
              {
                backupErasureEligibleAt: "2026-11-07T02:10:11.081Z",
                componentReceipts: [
                  { componentId: ids.space, generationId: ids.memory2, providerReceipt: proof },
                ],
                providerId: "aws-native",
                targetDigest: `digest-${ids.run}`,
              },
            ],
          },
          status: "complete",
        },
      });
      expect(scenario.checkpoints()).toHaveLength(0);
    },
  );

  it("resumes a partial run without purging a verified target again", async () => {
    const scenario = await erasureScenario([primaryErasureTarget, secondaryErasureTarget]);
    const primary = scriptedPurgeOpenSearch("memory-v3");
    primary.script.indexAbsent = true;
    const secondary = scriptedPurgeOpenSearch("memory-v3-other");
    const purger = scenario.purgerWith(
      awsNativeRegistry(
        { "memory-v3": primary.transport, "memory-v3-other": secondary.transport },
        () => scenario.clock.now,
      ),
    );

    expect(await purger(ids.organization, ids.toolCall)).toEqual(LIVE_PURGE_PENDING);
    expect(scenario.receipts()).toMatchObject([
      { data: { backupErasureEligibleAt: "2026-08-11T13:00:00.000Z" } },
    ]);
    scenario.clock.now = new Date("2026-07-28T12:05:00.000Z");
    expect(await purger(ids.organization, ids.toolCall)).toEqual(LIVE_PURGE_PENDING);
    scenario.clock.now = new Date("2026-07-28T12:10:00.000Z");
    const completed = completedErasure(await purger(ids.organization, ids.toolCall));

    expect(completed).toEqual({
      operationId: ids.toolCall,
      targets: [
        {
          backupErasureEligibleAt: "2026-08-11T13:00:00.000Z",
          componentReceipts: [
            { componentId: ids.space, generationId: ids.memory2, providerReceipt: proof },
          ],
          providerId: "aws-native",
          targetDigest: `digest-${ids.run}`,
        },
        {
          backupErasureEligibleAt: "2026-08-11T13:10:00.000Z",
          componentReceipts: [
            { componentId: ids.memory, generationId: ids.workspace, providerReceipt: proof },
          ],
          providerId: "aws-native",
          targetDigest: `digest-${ids.thread}`,
        },
      ],
    });
    expect(primary.requests).toHaveLength(1);

    const transactionCount = scenario.fixture.transactions.length;
    const secondaryRequestCount = secondary.requests.length;
    expect(completedErasure(await purger(ids.organization, ids.toolCall))).toEqual(completed);
    expect(scenario.fixture.transactions).toHaveLength(transactionCount);
    expect(primary.requests).toHaveLength(1);
    expect(secondary.requests).toHaveLength(secondaryRequestCount);
  });

  it("resumes a backup-wait checkpoint without OpenSearch calls", async () => {
    const scenario = await erasureScenario();
    seedCheckpoint(scenario.fixture, {
      backupErasureEligibleAt: "2026-08-11T12:40:00.000Z",
      providerPurgeStartedAt: "2026-07-28T11:00:00.000Z",
      providerReceipt: {
        absenceVerified: false,
        backupErasureEligibleAt: "2026-08-11T12:40:00.000Z",
        liveStorageVerified: true,
        openSearch: { taskCompleted: true },
        providerPurgeStartedAt: "2026-07-28T11:00:00.000Z",
        providerPurgeState: {
          liveStorageVerifiedAt: "2026-07-28T11:40:00.000Z",
          stage: "backup-wait",
        },
        snapshotInventoryVerified: true,
      },
    });
    const openSearch = scriptedPurgeOpenSearch("memory-v3");
    const purger = scenario.purgerWith(
      awsNativeRegistry({ "memory-v3": openSearch.transport }, () => scenario.clock.now),
    );

    const result = completedErasure(await purger(ids.organization, ids.toolCall));

    expect(result.targets.map((target) => target.backupErasureEligibleAt)).toEqual([
      "2026-08-11T12:40:00.000Z",
    ]);
    expect(openSearch.requests).toHaveLength(0);
    expect(scenario.checkpoints()).toHaveLength(0);
  });

  it("finishes a delete-by-query checkpoint once live storage is verified", async () => {
    const scenario = await erasureScenario();
    seedCheckpoint(scenario.fixture, {
      backupErasureEligibleAt: "2026-08-11T12:00:00.000Z",
      providerPurgeStartedAt: "2026-07-28T11:00:00.000Z",
      providerReceipt: {
        absenceVerified: false,
        backupErasureEligibleAt: "2026-08-11T12:00:00.000Z",
        liveStorageVerified: false,
        openSearch: { taskSubmitted: true },
        providerPurgeStartedAt: "2026-07-28T11:00:00.000Z",
        providerPurgeState: { stage: "delete-by-query", taskId: "delete-task" },
        snapshotInventoryVerified: false,
      },
    });
    const openSearch = scriptedPurgeOpenSearch("memory-v3");
    const purger = scenario.purgerWith(
      awsNativeRegistry({ "memory-v3": openSearch.transport }, () => scenario.clock.now),
    );

    expect(await purger(ids.organization, ids.toolCall)).toEqual(LIVE_PURGE_PENDING);
    expect(scenario.checkpoints()).toMatchObject([
      {
        data: {
          backupErasureEligibleAt: "2026-08-11T12:00:00.000Z",
          providerReceipt: { providerPurgeState: { stage: "force-merge" } },
          version: 1,
        },
      },
    ]);
    scenario.clock.now = new Date("2026-07-28T12:05:00.000Z");
    const result = completedErasure(await purger(ids.organization, ids.toolCall));

    expect(result.targets.map((target) => target.backupErasureEligibleAt)).toEqual([
      "2026-08-11T13:05:00.000Z",
    ]);
    expect(scenario.checkpoints()).toHaveLength(0);
  });
});

describe("tenant memory erasure rejects inconsistent provider outcomes", () => {
  const startedAt = "2026-07-28T11:00:00.000Z";
  const boundary = "2026-08-11T12:40:00.000Z";
  const backupWait = (values: { readonly boundary: string; readonly startedAt: string }) => ({
    absenceVerified: false,
    backupErasureEligibleAt: values.boundary,
    liveStorageVerified: true,
    providerPurgeStartedAt: values.startedAt,
    providerPurgeState: { liveStorageVerifiedAt: "2026-07-28T11:40:00.000Z", stage: "backup-wait" },
  });
  const cases = [
    {
      error: "aws-native returned an invalid organization purge receipt.",
      name: "live storage verified while a force merge is still running",
      receipt: {
        absenceVerified: false,
        backupErasureEligibleAt: boundary,
        liveStorageVerified: true,
        providerPurgeStartedAt: startedAt,
        providerPurgeState: { stage: "force-merge", taskId: "merge-task" },
      },
    },
    {
      error: "Provider purge retry returned an invalid erasure boundary.",
      name: "a backup boundary earlier than the checkpoint",
      receipt: backupWait({ boundary: "2026-08-11T12:39:59.999Z", startedAt }),
    },
    {
      error: "Provider purge retry returned an invalid erasure boundary.",
      name: "a different purge start",
      receipt: backupWait({ boundary, startedAt: "2026-07-28T11:00:00.001Z" }),
    },
    {
      error: "Provider purge retry returned an invalid erasure boundary.",
      name: "a running purge that extends the boundary",
      receipt: {
        absenceVerified: false,
        backupErasureEligibleAt: "2026-08-11T12:40:00.001Z",
        liveStorageVerified: false,
        providerPurgeStartedAt: startedAt,
        providerPurgeState: { stage: "force-merge", taskId: "merge-task" },
      },
    },
  ];

  for (const { error, name, receipt } of cases) {
    it(`rejects ${name}`, async () => {
      const scenario = await erasureScenario();
      seedCheckpoint(scenario.fixture, {
        backupErasureEligibleAt: boundary,
        providerPurgeStartedAt: startedAt,
        providerReceipt: {
          absenceVerified: false,
          backupErasureEligibleAt: boundary,
          liveStorageVerified: false,
          providerPurgeStartedAt: startedAt,
          providerPurgeState: { stage: "force-merge", taskId: "merge-task" },
        },
      });

      expect(
        scenario.purgerWith(returningProvider(receipt))(ids.organization, ids.toolCall),
      ).rejects.toThrow(error);
      expect(scenario.receipts()).toHaveLength(0);
      expect(scenario.checkpoints()).toMatchObject([
        { data: { backupErasureEligibleAt: boundary, version: 0 } },
      ]);
    });
  }
});
