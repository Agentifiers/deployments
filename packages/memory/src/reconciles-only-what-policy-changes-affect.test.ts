import { describe, expect, it } from "bun:test";
import {
  DatabaseError,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { ids, memoryFixture } from "./test-fixtures.ts";
import { makeMemoryPlatform } from "./platform.ts";
import type { MemoryPlatformScope } from "./platform-types.ts";
import {
  fixedNow,
  indexedUlid,
  memoryDatabase,
} from "./platform-pagination-reconciliation-fixtures.ts";
import { fakeMemorySearchProvider } from "./memory-search-test-fixtures.ts";

const repositoryRoot = new URL("../../../", import.meta.url);
const environmentScope = {
  environmentId: ids.environment,
  organizationId: ids.organization,
  projectId: ids.project,
};
const otherWorkspace = "01ARZ3NDEKTSV4RRFFQ69G5FAC" as Ulid;
const siblingEnvironment = "01ARZ3NDEKTSV4RRFFQ69G5FAD" as Ulid;

async function reconcileTriggers(path: string) {
  const text = await Bun.file(new URL(path, repositoryRoot)).text();
  const declaration = text.match(/^\s*memory-reconcile\s*=\s*(\[[^\]]*\])/m);
  if (!declaration?.[1]) throw new Error(`${path} declares no memory-reconcile event list.`);
  return JSON.parse(declaration[1]) as string[];
}

const passVersion = (record: PlatformRecord | undefined) =>
  record?.itemType === "memory-index-verification-pass" ? record.data.version : undefined;

function harness() {
  const { database: store, put, queries, tables } = memoryDatabase();
  let currentTime = fixedNow;
  let interceptIndexJobWrite: (() => Promise<void>) | undefined;
  const database: DynamoDatabaseService = {
    ...store,
    // Enforces the verification pass's conditional put as DynamoDB does; the fake skips conditions.
    // The check reads the table synchronously so no other write lands between it and the put.
    transactWrite: async (operations, clientRequestToken) => {
      const intercept = interceptIndexJobWrite;
      if (
        intercept &&
        operations.some(
          (operation) =>
            operation.kind === "put" && operation.record.itemType === "memory-index-job",
        )
      ) {
        interceptIndexJobWrite = undefined;
        await intercept();
      }
      for (const operation of operations) {
        if (
          operation.kind !== "put" ||
          operation.record.itemType !== "memory-index-verification-pass"
        ) {
          continue;
        }
        const stored = tables
          .get("control")
          ?.get(`${operation.record.pk}\u0000${operation.record.sk}`);
        if (passVersion(stored) !== passVersion(operation.previousRecord)) {
          throw new DatabaseError({
            cause: undefined,
            message: "The verification pass moved.",
            operation: "transact-write",
            reason: "conflict",
            table: "control",
          });
        }
      }
      return store.transactWrite(operations, clientRequestToken);
    },
  };
  const platformAt = (offsetMs: number) =>
    makeMemoryPlatform({
      database,
      embedding: async () => ({
        embedding: [0.1, 0.2, 0.3],
        model: "test",
        provider: "test",
      }),
      now: () => new Date(currentTime.getTime() + offsetMs),
      searchProvider: fakeMemorySearchProvider().provider,
    });
  const platform = platformAt(0);
  const records = (table: string) => [...(tables.get(table)?.values() ?? [])];
  const events = () =>
    records("events").flatMap((record) => (record.itemType === "semantic-event" ? [record] : []));

  async function processQueuedJobs() {
    const queued = records("execution").flatMap((record) =>
      record.itemType === "memory-index-job" && record.data.status === "queued" ? [record] : [],
    );
    for (const job of queued) {
      const memory = records("control").find(
        (record): record is PlatformRecord & { itemType: "memory" } =>
          record.itemType === "memory" && record.data.id === job.data.memoryId,
      );
      if (!memory) throw new Error(`Index job ${job.data.id} names no stored memory.`);
      await platform.processIndexJob(
        {
          environmentId: memory.data.environmentId,
          organizationId: memory.data.organizationId,
          projectId: memory.data.projectId,
          ...(memory.data.workspaceId ? { workspaceId: memory.data.workspaceId } : {}),
        },
        {
          idempotencyKey: job.data.idempotencyKey,
          memoryId: job.data.memoryId,
        },
      );
    }
  }

  /** Follows the sweep through its continuation events, as the reconcile queue does. */
  async function sweep(scope: MemoryPlatformScope) {
    let page = await platform.reconcile(scope);
    let queued = page.queued;
    while (page.nextCursor) {
      const cursor = page.nextCursor;
      const continuation = events().findLast(
        (event) =>
          event.data.eventType === "memory.reconcile.continuation" &&
          event.data.payload.cursor === cursor,
      );
      if (!continuation) throw new Error("Expected a continuation event for the next page.");
      page = await platform.reconcile(scope, { cursor });
      queued += page.queued;
    }
    return queued;
  }

  return {
    advance: (milliseconds: number) => {
      currentTime = new Date(currentTime.getTime() + milliseconds);
    },
    events,
    /** Runs `intercept` before the next transaction that writes an index job, then writes it. */
    interceptNextIndexJobWrite: (intercept: () => Promise<void>) => {
      interceptIndexJobWrite = intercept;
    },
    now: () => currentTime,
    platform,
    platformAt,
    processQueuedJobs,
    put,
    queries,
    records,
    sweep,
  };
}

const day = 24 * 60 * 60_000;
const minute = 60_000;

describe("memory reconciliation after policy changes", () => {
  it("starts a reconcile only when a policy write changes effective retention or sensitivity", async () => {
    const triggers = await reconcileTriggers("infrastructure/modules/memory-runtime/queues.tf");
    expect(await reconcileTriggers("infrastructure/environments/local/main.tf")).toEqual(triggers);
    const { events, platform } = harness();
    const started = () =>
      events()
        .filter((event) => triggers.includes(event.data.eventType))
        .map((event) => event.data.payload.workspaceId ?? "environment");

    await platform.upsertPolicy(environmentScope, { retentionDays: 30 });
    expect(started()).toEqual(["environment"]);

    await platform.upsertPolicy(environmentScope, {
      activeRecallEnabled: true,
      activeRecallRolloutPercent: 50,
      processingConfig: {
        memoryRetrieval: {
          contextTokenBudget: 2_000,
          strategy: "hybrid-rerank-v1",
          topK: 12,
        },
      },
    });
    expect(started()).toEqual(["environment"]);

    await platform.upsertPolicy(environmentScope, { retentionDays: 45 });
    await platform.upsertPolicy(environmentScope, { sensitivityMode: "strict" });
    expect(started()).toEqual(["environment", "environment", "environment"]);

    await platform.upsertPolicy(environmentScope, { retentionDays: 7, scope: "organization" });
    const workspaceScope = { ...environmentScope, workspaceId: ids.workspace };
    await platform.upsertPolicy(workspaceScope, {
      retentionDays: 45,
      scope: "workspace",
      sensitivityMode: "strict",
      workspaceId: ids.workspace,
    });
    expect(started()).toEqual(["environment", "environment", "environment"]);

    await platform.upsertPolicy(workspaceScope, {
      scope: "workspace",
      sensitivityMode: "standard",
      workspaceId: ids.workspace,
    });
    expect(started()).toEqual(["environment", "environment", "environment", ids.workspace]);
  });

  it("re-indexes only the memories whose retention a policy change moves", async () => {
    const { advance, platform, processQueuedJobs, put, records, sweep } = harness();
    const spaceA = await platform.createMemorySpace(
      { ...environmentScope, workspaceId: ids.workspace },
      { name: "Own retention" },
    );
    const spaceB = await platform.createMemorySpace(
      { ...environmentScope, workspaceId: otherWorkspace },
      { name: "Environment retention" },
    );
    await platform.upsertPolicy(environmentScope, { retentionDays: 10 });
    await platform.upsertPolicy(
      { ...environmentScope, workspaceId: ids.workspace },
      { retentionDays: 30, scope: "workspace", workspaceId: ids.workspace },
    );
    put("control", memoryFixture({ id: ids.memory, memorySpaceId: spaceA.data.id }));
    put(
      "control",
      memoryFixture({
        id: ids.memory2,
        memorySpaceId: spaceB.data.id,
        searchKey: `workspace:${otherWorkspace}`,
        workspaceId: otherWorkspace,
      }),
    );
    expect(await sweep(environmentScope)).toBe(2);
    await processQueuedJobs();
    expect(await sweep(environmentScope)).toBe(0);
    advance(2 * day);

    await platform.upsertPolicy(environmentScope, { retentionDays: 20 });

    expect(await sweep(environmentScope)).toBe(1);
    const memories = records("control").flatMap((record) =>
      record.itemType === "memory"
        ? [[record.data.id, record.data.version, record.data.retentionExpiresAt]]
        : [],
    );
    expect(memories).toEqual([
      [ids.memory, 4, "2026-08-20T12:00:00.000Z"],
      [ids.memory2, 5, "2026-08-10T12:00:00.000Z"],
    ]);
  });

  it("re-verifies unchanged memories only through the schedule's oldest-first rotation", async () => {
    const { advance, platform, processQueuedJobs, put, records, sweep } = harness();
    const scope = { ...environmentScope, workspaceId: ids.workspace };
    const space = await platform.createMemorySpace(scope, { name: "Unchanged" });
    // Five batches of 50 indexed a minute apart. The oldest batch has the highest IDs, so oldest-first
    // order differs from both ID order and newest-first order.
    const batches = Array.from({ length: 5 }, (_, batch) =>
      Array.from({ length: 50 }, (_, index) => indexedUlid(20_000 + (4 - batch) * 50 + index)),
    );
    for (const batch of batches) {
      for (const id of batch) put("control", memoryFixture({ id, memorySpaceId: space.data.id }));
      expect(await sweep(scope)).toBe(50);
      await processQueuedJobs();
      advance(minute);
    }
    advance(2 * day);

    expect(await sweep(scope)).toBe(0);

    const queuedIds = () =>
      records("execution")
        .flatMap((record) =>
          record.itemType === "memory-index-job" && record.data.status === "queued"
            ? [record.data.memoryId]
            : [],
        )
        .sort();
    const verifiedPerTick: string[][] = [];
    for (let tick = 0; tick < 7; tick += 1) {
      await platform.verifyIndexStates(scope, { limit: 50 });
      verifiedPerTick.push(queuedIds());
      await processQueuedJobs();
    }
    expect(verifiedPerTick).toEqual([...batches.map((batch) => [...batch].sort()), [], []]);
    const jobsPerMemory = new Map<string, number>();
    for (const record of records("execution")) {
      if (record.itemType !== "memory-index-job") continue;
      jobsPerMemory.set(record.data.memoryId, (jobsPerMemory.get(record.data.memoryId) ?? 0) + 1);
    }
    expect([jobsPerMemory.size, new Set(jobsPerMemory.values())]).toEqual([250, new Set([2])]);
  });

  it("re-verifies memories whose jobs exhausted their retries once their backoff passes, and keeps rotating meanwhile", async () => {
    const { advance, now, platform, processQueuedJobs, put, records, sweep } = harness();
    const scope = { ...environmentScope, workspaceId: ids.workspace };
    const space = await platform.createMemorySpace(scope, { name: "Outage" });
    const failing = Array.from({ length: 50 }, (_, index) => indexedUlid(30_000 + index));
    const healthy = Array.from({ length: 50 }, (_, index) => indexedUlid(30_100 + index));
    const add = async (memoryIds: readonly Ulid[]) => {
      for (const id of memoryIds) {
        put("control", memoryFixture({ id, memorySpaceId: space.data.id }));
      }
      await sweep(scope);
      await processQueuedJobs();
    };
    await add(failing);
    advance(60 * minute);
    await add(healthy);
    advance(2 * day);

    expect((await platform.verifyIndexStates(scope, { limit: 50 })).queued).toBe(50);
    for (const record of records("execution")) {
      if (record.itemType !== "memory-index-job" || record.data.status !== "queued") continue;
      put(
        "execution",
        withCanonicalRecordKeys({
          data: {
            ...record.data,
            attempt: 8,
            skipReason: "retries-exhausted",
            status: "failed" as const,
            updatedAt: now().toISOString(),
          },
          itemType: "memory-index-job" as const,
        }) as PlatformRecord,
      );
    }
    const jobs = () =>
      records("execution").flatMap((record) =>
        record.itemType === "memory-index-job" ? [record] : [],
      );
    const outageJobs = new Set(jobs().map((job) => job.data.id));
    const freshJobs = () => {
      const fresh = jobs().filter((job) => !outageJobs.has(job.data.id));
      return {
        failing: fresh.filter((job) => failing.includes(job.data.memoryId)).length,
        healthy: fresh.filter((job) => healthy.includes(job.data.memoryId)).length,
        memories: new Set(fresh.map((job) => job.data.memoryId)).size,
      };
    };
    const tick = async () => {
      await platform.verifyIndexStates(scope, { limit: 50 });
      advance(5 * minute);
    };

    for (let run = 0; run < 5; run += 1) await tick();
    expect(freshJobs()).toEqual({ failing: 0, healthy: 50, memories: 50 });

    advance(6 * 60 * minute);
    for (let run = 0; run < 5; run += 1) await tick();
    expect(freshJobs()).toEqual({ failing: 50, healthy: 50, memories: 100 });
  });

  it("re-verifies the scheduled environment while an unscheduled sibling holds 600 older index states", async () => {
    const { advance, platform, processQueuedJobs, put, queries, records, sweep } = harness();
    const scope = { ...environmentScope, workspaceId: ids.workspace };
    const siblingScope = { ...scope, environmentId: siblingEnvironment };
    const siblingSpace = await platform.createMemorySpace(siblingScope, { name: "Unscheduled" });
    for (let index = 0; index < 600; index += 1) {
      put(
        "control",
        memoryFixture({
          environmentId: siblingEnvironment,
          id: indexedUlid(40_000 + index),
          memorySpaceId: siblingSpace.data.id,
        }),
      );
    }
    expect(await sweep(siblingScope)).toBe(600);
    await processQueuedJobs();
    advance(60 * minute);
    const space = await platform.createMemorySpace(scope, { name: "Scheduled" });
    const scheduled = [indexedUlid(41_000), indexedUlid(41_001), indexedUlid(41_002)];
    for (const id of scheduled) {
      put("control", memoryFixture({ id, memorySpaceId: space.data.id }));
    }
    expect(await sweep(scope)).toBe(3);
    await processQueuedJobs();
    advance(2 * day);

    const indexStateQueries = () =>
      queries.filter((query) => query.input.IndexName === "gsi2").length;
    const queuedPerRun: number[] = [];
    const queriesPerRun: number[] = [];
    for (let run = 0; run < 5; run += 1) {
      const before = indexStateQueries();
      queuedPerRun.push((await platform.verifyIndexStates(scope, { limit: 1 })).queued);
      queriesPerRun.push(indexStateQueries() - before);
      advance(5 * minute);
    }

    expect(queuedPerRun).toEqual([0, 1, 1, 1, 0]);
    expect(queriesPerRun).toEqual([5, 3, 1, 1, 1]);
    const verified = records("execution").flatMap((record) =>
      record.itemType === "memory-index-job" && record.data.status === "queued"
        ? [record.data.memoryId]
        : [],
    );
    expect(verified).toEqual(scheduled);
  });

  async function scheduledScope(memoryCount: number) {
    const test = harness();
    const scope = { ...environmentScope, workspaceId: ids.workspace };
    const space = await test.platform.createMemorySpace(scope, { name: "Scheduled" });
    for (let index = 0; index < memoryCount; index += 1) {
      test.put(
        "control",
        memoryFixture({ id: indexedUlid(50_000 + index), memorySpaceId: space.data.id }),
      );
    }
    expect(await test.sweep(scope)).toBe(memoryCount);
    await test.processQueuedJobs();
    test.advance(2 * day);
    const verificationJobsPerMemory = () => {
      const counts = new Map<string, number>();
      for (const record of test.records("execution")) {
        if (record.itemType !== "memory-index-job" || record.data.status !== "queued") continue;
        counts.set(record.data.memoryId, (counts.get(record.data.memoryId) ?? 0) + 1);
      }
      return [counts.size, new Set(counts.values())];
    };
    return { ...test, scope, verificationJobsPerMemory };
  }

  it("queues each memory once when two runs of one scope start 1 ms apart", async () => {
    const { platform, platformAt, scope, verificationJobsPerMemory } = await scheduledScope(50);

    const runs = await Promise.all([
      platform.verifyIndexStates(scope, { limit: 50 }),
      platformAt(1).verifyIndexStates(scope, { limit: 50 }),
    ]);

    expect(runs.map((run) => run.queued)).toEqual([50, 0]);
    expect(verificationJobsPerMemory()).toEqual([50, new Set([1])]);
  });

  it("queues each memory once when a second run starts while the first is queuing the end of a pass", async () => {
    const { interceptNextIndexJobWrite, platform, platformAt, scope, verificationJobsPerMemory } =
      await scheduledScope(3);
    const queuing = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    interceptNextIndexJobWrite(() => {
      queuing.resolve();
      return released.promise;
    });

    const first = platform.verifyIndexStates(scope, { limit: 50 });
    await queuing.promise;
    const second = await platformAt(1_000).verifyIndexStates(scope, { limit: 50 });
    released.resolve();

    expect([(await first).queued, second.queued]).toEqual([3, 0]);
    expect(verificationJobsPerMemory()).toEqual([3, new Set([1])]);
  });

  it("re-verifies a claimed slice in the next pass when its run dies before queuing", async () => {
    const { advance, interceptNextIndexJobWrite, platform, scope, verificationJobsPerMemory } =
      await scheduledScope(100);
    interceptNextIndexJobWrite(async () => {
      throw new Error("reconcile Lambda timed out");
    });

    const crash = await platform.verifyIndexStates(scope, { limit: 50 }).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    expect(crash).toBe("reconcile Lambda timed out");
    const queuedPerRun: number[] = [];
    for (let run = 0; run < 5; run += 1) {
      advance(5 * minute);
      queuedPerRun.push((await platform.verifyIndexStates(scope, { limit: 50 })).queued);
    }

    expect(queuedPerRun).toEqual([50, 0, 0, 50, 0]);
    expect(verificationJobsPerMemory()).toEqual([100, new Set([1])]);
  });
});
