import { describe, expect, it } from "bun:test";
import { withCanonicalRecordKeys, type PlatformRecord } from "@deployments-ai/db";
import { fixedNow, memoryDatabase } from "./platform-pagination-reconciliation-fixtures.ts";
import { makeMemoryPlatform } from "./platform.ts";
import { fakeMemorySearchProvider } from "./memory-search-test-fixtures.ts";
import type { MemorySearchProviderClient, MemorySearchTarget } from "./provider.ts";
import { ids, memoryFixture } from "./test-fixtures.ts";

type IndexJob = Extract<PlatformRecord, { readonly itemType: "memory-index-job" }>;

const scope = {
  environmentId: ids.environment,
  organizationId: ids.organization,
  projectId: ids.project,
  workspaceId: ids.workspace,
};
const minutes = (value: number) => value * 60_000;

function indexingHarness(options: { readonly placementFailure?: Error } = {}) {
  const fixture = memoryDatabase();
  const clock = { now: fixedNow };
  const provider = { available: false, writes: 0 };
  const search = fakeMemorySearchProvider();
  const available =
    <Input, Output>(mutate: (input: Input) => Promise<Output>) =>
    async (input: Input) => {
      if (!provider.available) throw new Error("provider unavailable");
      provider.writes += 1;
      return mutate(input);
    };
  const searchProvider: MemorySearchProviderClient = {
    ...search.provider,
    delete: available((input) => search.provider.delete(input)),
    synchronizeLifecycle: available((input) => search.provider.synchronizeLifecycle(input)),
    write: available((input) => search.provider.write(input)),
  };
  const target: MemorySearchTarget = {
    componentIds: [ids.space],
    embeddingProfileId: ids.agent,
    location: { region: "aws-us-east-2" },
    providerId: "aws-native",
    schemaGeneration: 1,
    targetId: ids.toolCall,
  };
  const placementFailure = options.placementFailure;
  const platform = makeMemoryPlatform({
    database: fixture.database,
    embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
    now: () => clock.now,
    ...(placementFailure
      ? {
          searchPlacementResolver: async () => {
            throw placementFailure;
          },
          searchRoutingResolver: async () => ({
            fenceEpoch: 1,
            fenceVersion: 1,
            placementGeneration: 1,
            placementPhase: "active" as const,
            placementVersion: 1,
            read: { providerId: target.providerId, target },
            writes: [{ providerId: target.providerId, target }],
          }),
        }
      : {}),
    searchProvider,
  });
  const memory = memoryFixture();
  fixture.put("control", memory);
  const persisted = (id: string) =>
    [...(fixture.tables.get("execution")?.values() ?? [])].find(
      (record): record is IndexJob =>
        record.itemType === "memory-index-job" && record.data.id === id,
    )!;
  const lifecycleEvents = (id: string) =>
    [...(fixture.tables.get("events")?.values() ?? [])].flatMap((record) =>
      record.itemType === "semantic-event" && record.data.aggregateId === id
        ? [record.data.eventType]
        : [],
    );
  return { clock, fixture, lifecycleEvents, memory, persisted, platform, provider };
}

describe("memory index retry bounds", () => {
  it("backs off exponentially and terminalizes after the attempt budget", async () => {
    const harness = indexingHarness();
    const queued = await harness.platform.enqueueIndexJob({
      memory: harness.memory,
      scope,
      synchronizationGeneration: 7,
    });
    const delivery = {
      idempotencyKey: queued.data.idempotencyKey,
      memoryId: harness.memory.data.id,
    };
    const delays: number[] = [];

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      expect(harness.platform.processIndexJob(scope, delivery)).rejects.toThrow();
      const failed = harness.persisted(queued.data.id);
      expect(failed.data).toMatchObject({ attempt, status: "failed" });
      if (attempt === 8) break;
      expect(failed.data.nextDueAt).toBe(failed.data.retryAt!);
      expect(failed.gsi1pk).toContain("failed");
      delays.push(Date.parse(failed.data.retryAt!) - harness.clock.now.getTime());

      harness.clock.now = new Date(Date.parse(failed.data.retryAt!) - 1);
      expect(harness.platform.processIndexJob(scope, delivery)).resolves.toEqual(failed);
      harness.clock.now = new Date(failed.data.retryAt!);
    }

    expect(delays).toEqual(
      [5, 20, 80, 320, 1_280, 5_120, 20_480].map((seconds) => seconds * 1_000),
    );
    const exhausted = harness.persisted(queued.data.id);
    expect(exhausted.data).toMatchObject({
      attempt: 8,
      error: expect.stringMatching(/\S/u),
      skipReason: "retries-exhausted",
      status: "failed",
    });
    expect(exhausted.data).not.toHaveProperty("nextDueAt");
    expect(exhausted.data).not.toHaveProperty("retryAt");
    expect(exhausted).not.toHaveProperty("gsi1pk");

    harness.clock.now = new Date(fixedNow.getTime() + minutes(60 * 24 * 60));
    harness.provider.available = true;
    expect(harness.platform.processIndexJob(scope, delivery)).resolves.toEqual(exhausted);
    expect(harness.provider.writes).toBe(0);
    const events = harness.lifecycleEvents(queued.data.id);
    expect(events.filter((eventType) => eventType === "memory.index.started")).toHaveLength(8);
    expect(events.filter((eventType) => eventType === "memory.index.failed")).toHaveLength(8);
  });

  it("retries a transient failure after its backoff and then succeeds", async () => {
    const harness = indexingHarness();
    const queued = await harness.platform.enqueueIndexJob({
      memory: harness.memory,
      scope,
      synchronizationGeneration: 7,
    });
    const delivery = {
      idempotencyKey: queued.data.idempotencyKey,
      memoryId: harness.memory.data.id,
    };
    expect(harness.platform.processIndexJob(scope, delivery)).rejects.toThrow();
    const failed = harness.persisted(queued.data.id);

    harness.provider.available = true;
    harness.clock.now = new Date(failed.data.retryAt!);
    const succeeded = await harness.platform.processIndexJob(scope, delivery);

    expect(succeeded.data).toMatchObject({ attempt: 2, status: "succeeded" });
    expect(succeeded.data).not.toHaveProperty("retryAt");
    expect(succeeded.data).not.toHaveProperty("nextDueAt");
    expect(harness.provider.writes).toBe(1);
  });

  it("terminalizes unapproved target configuration after two attempts", async () => {
    const harness = indexingHarness({
      placementFailure: new TypeError(
        "AWS-native OpenSearch endpoint is not the approved memory domain.",
      ),
    });
    const queued = await harness.platform.enqueueIndexJob({
      memory: harness.memory,
      scope,
      synchronizationGeneration: 7,
    });
    const delivery = {
      idempotencyKey: queued.data.idempotencyKey,
      memoryId: harness.memory.data.id,
    };

    expect(harness.platform.processIndexJob(scope, delivery)).rejects.toThrow(TypeError);
    const first = harness.persisted(queued.data.id);
    expect(first.data).toMatchObject({ attempt: 1, retryAt: "2026-07-21T18:00:05.000Z" });
    harness.clock.now = new Date(first.data.retryAt!);
    expect(harness.platform.processIndexJob(scope, delivery)).rejects.toThrow(TypeError);

    const terminal = harness.persisted(queued.data.id);
    expect(terminal.data).toMatchObject({
      attempt: 2,
      error: "AWS-native OpenSearch endpoint is not the approved memory domain.",
      skipReason: "configuration-failure",
      status: "failed",
    });
    expect(terminal).not.toHaveProperty("gsi1pk");
    harness.clock.now = new Date(fixedNow.getTime() + minutes(60 * 24));
    expect(harness.platform.processIndexJob(scope, delivery)).resolves.toEqual(terminal);
  });

  it("terminalizes a job whose final attempt lost its lease", async () => {
    const harness = indexingHarness();
    const queued = await harness.platform.enqueueIndexJob({
      memory: harness.memory,
      scope,
      synchronizationGeneration: 7,
    });
    const { nextDueAt: _nextDueAt, ...queuedData } = queued.data;
    const abandoned = withCanonicalRecordKeys({
      data: {
        ...queuedData,
        attempt: 8,
        leaseExpiresAt: "2026-07-21T17:55:00.000Z",
        leaseOwner: "crashed-worker",
        nextDueAt: "2026-07-21T17:55:00.000Z",
        startedAt: "2026-07-21T17:50:00.000Z",
        status: "running" as const,
        version: queued.data.version + 1,
      },
      itemType: "memory-index-job" as const,
    }) as IndexJob;
    harness.fixture.put("execution", abandoned);
    harness.provider.available = true;

    const terminal = await harness.platform.processIndexJob(scope, {
      idempotencyKey: queued.data.idempotencyKey,
      memoryId: harness.memory.data.id,
    });

    expect(terminal.data).toMatchObject({
      attempt: 8,
      skipReason: "retries-exhausted",
      status: "failed",
    });
    expect(terminal).not.toHaveProperty("gsi1pk");
    expect(harness.provider.writes).toBe(0);
  });

  it("indexes a new memory version after an earlier version exhausted its retries", async () => {
    const harness = indexingHarness();
    const stale = await harness.platform.enqueueIndexJob({
      memory: harness.memory,
      scope,
      synchronizationGeneration: 7,
    });
    const staleDelivery = {
      idempotencyKey: stale.data.idempotencyKey,
      memoryId: harness.memory.data.id,
    };
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      expect(harness.platform.processIndexJob(scope, staleDelivery)).rejects.toThrow();
      const retryAt = harness.persisted(stale.data.id).data.retryAt;
      if (retryAt) harness.clock.now = new Date(retryAt);
    }
    expect(harness.persisted(stale.data.id).data.skipReason).toBe("retries-exhausted");

    const revised = memoryFixture({
      updatedAt: harness.clock.now.toISOString(),
      version: harness.memory.data.version + 1,
    });
    harness.fixture.put("control", revised);
    harness.provider.available = true;
    const fresh = await harness.platform.enqueueIndexJob({
      memory: revised,
      scope,
      synchronizationGeneration: 8,
    });
    const indexed = await harness.platform.processIndexJob(scope, {
      idempotencyKey: fresh.data.idempotencyKey,
      memoryId: revised.data.id,
    });

    expect(fresh.data.id).not.toBe(stale.data.id);
    expect(indexed.data).toMatchObject({ attempt: 1, status: "succeeded" });
    expect(harness.provider.writes).toBe(1);
  });
});

describe("memory reconciliation over failing index jobs", () => {
  async function reconciledMemoryHarness() {
    const harness = indexingHarness();
    const space = await harness.platform.createMemorySpace(scope, { name: "Reconciled" });
    const memory = memoryFixture({ id: ids.memory2, memorySpaceId: space.data.id });
    harness.fixture.put("control", memory);
    const jobs = () =>
      [...(harness.fixture.tables.get("execution")?.values() ?? [])].filter(
        (record): record is IndexJob =>
          record.itemType === "memory-index-job" && record.data.memoryId === memory.data.id,
      );
    const queuedEvents = () =>
      [...(harness.fixture.tables.get("events")?.values() ?? [])].filter(
        (record) =>
          record.itemType === "semantic-event" &&
          record.data.eventType === "memory.index.queued" &&
          record.data.payload.memoryId === memory.data.id,
      );
    const sweep = async (count: number) => {
      for (let index = 0; index < count; index += 1) {
        await harness.platform.reconcile(scope);
        await harness.platform.verifyIndexStates(scope, { limit: 50 });
        for (const job of jobs()) {
          const due =
            job.data.status === "queued" ||
            (job.data.status === "failed" &&
              job.data.retryAt !== undefined &&
              Date.parse(job.data.retryAt) <= harness.clock.now.getTime());
          if (!due) continue;
          await harness.platform
            .processIndexJob(scope, {
              idempotencyKey: job.data.idempotencyKey,
              memoryId: memory.data.id,
              ...(job.data.targetId ? { targetId: job.data.targetId } : {}),
            })
            .catch(() => undefined);
        }
        harness.clock.now = new Date(harness.clock.now.getTime() + minutes(5));
      }
    };
    return { ...harness, jobs, memory, queuedEvents, sweep };
  }

  it("creates one index job for a memory whose indexing keeps failing", async () => {
    const harness = await reconciledMemoryHarness();

    await harness.sweep((2 * 24 * 60) / 5);

    const jobs = harness.jobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toMatchObject({
      attempt: 8,
      skipReason: "retries-exhausted",
      status: "failed",
    });
    expect(harness.queuedEvents()).toHaveLength(1);
    expect(harness.platform.reconcile(scope)).resolves.toMatchObject({ queued: 0 });
    expect(harness.jobs()).toHaveLength(1);
  });

  it("reindexes a changed memory and keeps periodic provider verification", async () => {
    const harness = await reconciledMemoryHarness();
    await harness.sweep((24 * 60) / 5);
    expect(harness.jobs()[0]!.data.skipReason).toBe("retries-exhausted");

    harness.provider.available = true;
    harness.fixture.put(
      "control",
      memoryFixture({
        id: harness.memory.data.id,
        memorySpaceId: harness.memory.data.memorySpaceId,
        updatedAt: harness.clock.now.toISOString(),
        version: harness.memory.data.version + 1,
      }),
    );
    await harness.sweep((12 * 60) / 5);

    const revisedJobs = harness
      .jobs()
      .filter((job) => job.data.expectedMemoryVersion === harness.memory.data.version + 1);
    expect(revisedJobs).toHaveLength(1);
    expect(revisedJobs[0]!.data).toMatchObject({ attempt: 1, status: "succeeded" });

    await harness.sweep((13 * 60) / 5);
    expect(
      harness
        .jobs()
        .filter((job) => job.data.expectedMemoryVersion === harness.memory.data.version + 1),
    ).toHaveLength(2);
  });
});
