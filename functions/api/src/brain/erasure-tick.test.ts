import { describe, expect, spyOn, test } from "bun:test";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import {
  brainUlid,
  DEFAULT_TABLE_NAMES,
  makeBrainDynamoRepository,
  resumeBrainErasure,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import type { BrainErasureRuntimeDependencies } from "./erasure-runtime.ts";
import { runBrainErasureTick } from "./erasure-tick.ts";
import { at, erasureWorld, minutes, organizationId, type ErasureWorld } from "./erasure.fixture.ts";

const stuck = {
  brainId: "01M3TKGBADCYBG97VHNKANM58Q",
  erasureId: "5V27YRC4MRPJDHJFZ44P3745Q8",
  eventId: "01KYK5W3M7Z4KR6VP8BJTA8ACH",
  grantId: "01KYK5W3M7Z4KR6VP8BJTA8ACG",
  slug: "stuck",
};
const healthy = {
  brainId: "01M3TKGBADCYBG97VHNKANM58R",
  erasureId: "5V27YRC4MRPJDHJFZ44P3745Q9",
  eventId: "01KYK5W3M7Z4KR6VP8BJTA8ACJ",
  grantId: "01KYK5W3M7Z4KR6VP8BJTA8ACK",
  slug: "healthy",
};

function listing(onPrefix: (prefix: string) => void): BrainErasureRuntimeDependencies["s3"] {
  return {
    send: async (command) => {
      const input: object = command.input;
      onPrefix("Prefix" in input && typeof input.Prefix === "string" ? input.Prefix : "");
      return { IsTruncated: false, Versions: [] };
    },
  };
}

const deniesStuckPrefix = listing((prefix) => {
  if (prefix.includes(stuck.brainId)) {
    throw Object.assign(new Error("Access Denied"), { name: "AccessDenied" });
  }
});

/** Ticks whenever the stuck erasure is next due until it stops retrying; returns each delay. */
async function exhaust(world: ErasureWorld) {
  const delays: number[] = [];
  let current = at(0);
  while (world.job(stuck).data.status !== "failed" && delays.length < 20) {
    expect((await world.tick(current, deniesStuckPrefix)).outcomes).toEqual({ failed: 1 });
    const next = new Date(world.job(stuck).data.nextDueAt);
    delays.push((next.getTime() - current.getTime()) / minutes(1));
    current = next;
  }
  return delays;
}

/**
 * Runs one tick whose worker deletes a single record and then hangs like a worker past its
 * Lambda timeout, so the next tick finds the lease expired.
 */
function timesOutAfterOneDeletion(world: ErasureWorld, now: Date) {
  const dependencies = world.dependencies({
    now: () => now,
    workerId: `tick-${now.toISOString()}`,
  });
  const store = dependencies.governanceStore;
  const timedOut = Promise.withResolvers<"timed out">();
  let deleted = false;
  const tick = runBrainErasureTick({
    ...dependencies,
    governanceStore: {
      deleteTenantRecords: async (records, expiresAt) => {
        await store.deleteTenantRecords(records.slice(0, 1), expiresAt);
        deleted = true;
      },
      listBrainRecords: (...args) => {
        if (!deleted) return store.listBrainRecords(...args);
        timedOut.resolve("timed out");
        return new Promise<never>(() => {});
      },
    },
  });
  return Promise.race([tick, timedOut.promise]);
}

describe("Brain erasure worker tick", () => {
  test("completes a healthy erasure while another erasure keeps failing", async () => {
    const world = await erasureWorld([stuck, healthy]);

    expect(await world.tick(at(0), deniesStuckPrefix)).toEqual({
      failedJobs: 0,
      outcomes: { "content-quiescence": 1, failed: 1 },
    });
    expect(await world.tick(at(minutes(6)), deniesStuckPrefix)).toEqual({
      failedJobs: 0,
      outcomes: { completed: 1, failed: 1 },
    });

    expect(world.job(healthy).data.status).toBe("completed");
    expect(world.job(stuck).data.error).toBe("Access Denied");
  });

  test("stops claiming jobs once its claim window has elapsed", async () => {
    const world = await erasureWorld([stuck, healthy]);
    let current = at(0);
    const slowListing = listing(() => {
      current = at(minutes(2));
    });

    const tick = await runBrainErasureTick(
      world.dependencies({ now: () => current, s3: slowListing, workerId: "slow-tick" }),
    );

    expect(tick.outcomes).toEqual({ "content-quiescence": 1 });
    expect(
      [world.job(stuck).data.version, world.job(healthy).data.version].toSorted((a, b) => a - b),
    ).toEqual([0, 2]);
  });

  test("backs off failed attempts and stops retrying at the ceiling", async () => {
    const world = await erasureWorld([stuck]);

    expect(await exhaust(world)).toEqual([5, 10, 20, 40, 60, 60, 60, 0]);
    expect(world.job(stuck).data).toMatchObject({
      error: "Access Denied",
      failedAttempts: 8,
      phase: "draining",
      status: "failed",
    });
    expect(await world.tick(at(minutes(24 * 60)), deniesStuckPrefix)).toEqual({
      failedJobs: 1,
      outcomes: {},
    });
    expect(
      await makeBrainDynamoRepository(world.database).getErasure(
        organizationId,
        stuck.brainId,
        stuck.erasureId,
      ),
    ).toMatchObject({ error: "Access Denied", status: "failed" });
  });

  test("counts a lease lost to a crashed worker toward the ceiling", async () => {
    const world = await erasureWorld([stuck]);
    const pending = world.job(stuck);
    world.dynamo.put(
      "execution",
      withCanonicalRecordKeys({
        ...pending,
        data: {
          ...pending.data,
          failedAttempts: 7,
          leaseExpiresAt: at(-minutes(1)).toISOString(),
          leaseOwner: "crashed-worker",
          status: "running",
          version: 1,
        },
      }),
    );

    expect(await world.tick(at(0))).toEqual({ failedJobs: 1, outcomes: { exhausted: 1 } });
    expect(world.job(stuck).data).toMatchObject({
      error: "The previous Brain erasure worker lease expired before completion.",
      failedAttempts: 8,
      status: "failed",
      version: 2,
    });
  });

  test("backs off to failed when the Brain vanishes while its erasure drains", async () => {
    const world = await erasureWorld([stuck]);
    await world.dynamo.client.send(
      new DeleteCommand({
        Key: { pk: `ORG#${organizationId}`, sk: `BRAIN#${stuck.brainId}` },
        TableName: DEFAULT_TABLE_NAMES.control,
      }),
    );

    expect(await exhaust(world)).toEqual([5, 10, 20, 40, 60, 60, 60, 0]);
    expect(world.job(stuck).data).toMatchObject({
      error: "Brain erasure lost its generation-bound write fence.",
      failedAttempts: 8,
      phase: "draining",
      status: "failed",
    });
    expect(await world.tick(at(minutes(24 * 60)))).toEqual({ failedJobs: 1, outcomes: {} });
  });

  test("counts a failed attempt when the Brain vanishes between the fence read and the claim", async () => {
    const world = await erasureWorld([stuck]);
    const dependencies = world.dependencies({ now: () => at(0), workerId: "tick-a" });
    const repository = dependencies.repository;

    const tick = await runBrainErasureTick({
      ...dependencies,
      repository: {
        ...repository,
        get: async (...args) => {
          const brain = await repository.get(...args);
          await world.dynamo.client.send(
            new DeleteCommand({
              Key: { pk: `ORG#${organizationId}`, sk: `BRAIN#${stuck.brainId}` },
              TableName: DEFAULT_TABLE_NAMES.control,
            }),
          );
          return brain;
        },
      },
    });

    expect(tick).toEqual({ failedJobs: 0, outcomes: { failed: 1 } });
    expect(world.job(stuck).data).toMatchObject({
      error: "Brain erasure lost its generation-bound write fence.",
      failedAttempts: 1,
      nextDueAt: at(minutes(5)).toISOString(),
      status: "pending",
    });
  });

  test("an overlapping tick that loses the claim race ignores the job without logging", async () => {
    const world = await erasureWorld([stuck]);
    const bothClaiming = Promise.withResolvers<void>();
    let fenceReads = 0;
    const racer = (workerId: string) => {
      const dependencies = world.dependencies({ now: () => at(0), workerId });
      const repository = dependencies.repository;
      return runBrainErasureTick({
        ...dependencies,
        repository: {
          ...repository,
          get: async (...args) => {
            fenceReads += 1;
            if (fenceReads === 2) bothClaiming.resolve();
            await bothClaiming.promise;
            return repository.get(...args);
          },
        },
      });
    };
    const errors = spyOn(console, "error");

    const [first, second] = await Promise.all([racer("tick-a"), racer("tick-b")]);
    const logged = errors.mock.calls.map(([message]) => message);
    errors.mockRestore();

    expect({ ...first?.outcomes, ...second?.outcomes }).toEqual({
      "content-quiescence": 1,
      ignored: 1,
    });
    expect(logged).toEqual([]);
    expect(world.job(stuck).data).toMatchObject({
      contentVerificationCount: 1,
      status: "pending",
      version: 2,
    });
  });

  test("an erasure that progresses on every attempt never fails from lost leases", async () => {
    const world = await erasureWorld([stuck]);
    const pending = world.job(stuck);
    world.dynamo.put(
      "execution",
      withCanonicalRecordKeys({
        ...pending,
        data: {
          ...pending.data,
          contentQuiescenceStartedAt: at(-minutes(10)).toISOString(),
          contentVerificationCount: 1,
          failedAttempts: 7,
          version: 1,
        },
      }),
    );
    const outcomes: unknown[] = [];
    const failedAttempts: unknown[] = [];

    for (const offset of [0, 16, 32, 48]) {
      outcomes.push(await timesOutAfterOneDeletion(world, at(minutes(offset))));
      failedAttempts.push(world.job(stuck).data.failedAttempts ?? 0);
    }

    expect(outcomes).toEqual([
      "timed out",
      "timed out",
      "timed out",
      { failedJobs: 0, outcomes: { completed: 1 } },
    ]);
    expect(failedAttempts).toEqual([0, 0, 0, 0]);
    expect(world.job(stuck).data).toMatchObject({ recordsDeleted: 3, status: "completed" });
  });

  test("an operator resume lets an exhausted erasure finish", async () => {
    const world = await erasureWorld([stuck]);
    const resume = (now: Date) =>
      resumeBrainErasure(world.database, {
        brainId: stuck.brainId,
        erasureId: stuck.erasureId,
        now: now.toISOString(),
        organizationId,
      });
    expect(resume(at(0))).rejects.toThrow(
      "Only a failed Brain erasure can be resumed; this one is pending.",
    );
    await exhaust(world);
    const resumedAt = at(minutes(600));

    expect(await resume(resumedAt)).toMatchObject({
      error: "Access Denied",
      nextDueAt: resumedAt.toISOString(),
      phase: "draining",
      status: "pending",
    });
    expect(await world.tick(resumedAt)).toEqual({
      failedJobs: 0,
      outcomes: { "content-quiescence": 1 },
    });
    expect(await world.tick(at(minutes(606)))).toEqual({
      failedJobs: 0,
      outcomes: { completed: 1 },
    });
    expect(world.job(stuck).data).toMatchObject({ recordsDeleted: 3, status: "completed" });
    expect(world.job(stuck).data.error).toBeUndefined();
  });

  test("waits out a Brain search provider drain without counting a failed attempt", async () => {
    const world = await erasureWorld([stuck]);
    const receipt = {
      brainId: brainUlid(stuck.brainId),
      erasureGeneration: 1,
      operationId: brainUlid(stuck.erasureId),
      targets: [],
    };

    expect(await world.tick(at(0))).toEqual({
      failedJobs: 0,
      outcomes: { "content-quiescence": 1 },
    });
    expect(
      await runBrainErasureTick(
        world.dependencies({
          now: () => at(minutes(6)),
          purgeSearch: async () => ({ reason: "provider_mutations_draining", status: "pending" }),
          workerId: "draining-tick",
        }),
      ),
    ).toEqual({ failedJobs: 0, outcomes: { "search-draining": 1 } });
    expect(world.job(stuck).data).toMatchObject({
      error: "Brain erasure is waiting for Brain search provider mutations to drain.",
      nextDueAt: at(minutes(11)).toISOString(),
      phase: "purging",
      status: "pending",
    });
    expect(world.job(stuck).data.failedAttempts).toBeUndefined();

    expect(
      await runBrainErasureTick(
        world.dependencies({
          now: () => at(minutes(11)),
          purgeSearch: async () => ({ receipt, status: "complete" }),
          workerId: "drained-tick",
        }),
      ),
    ).toEqual({ failedJobs: 0, outcomes: { completed: 1 } });
    expect(world.job(stuck).data).toMatchObject({
      recordsDeleted: 3,
      searchReceipt: { brainSearch: receipt },
      status: "completed",
    });
    expect(world.job(stuck).data.error).toBeUndefined();
  });
});
