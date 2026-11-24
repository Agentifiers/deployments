import { describe, expect, it } from "bun:test";
import type { PlatformRecord } from "@deployments-ai/db";
import { makeMemoryPlatform } from "@deployments-ai/memory";
import { standingInstallation } from "@deployments-ai/organization-admission/testing";
import { memoryContentHash } from "../../../packages/memory/src/governance.ts";
import type { CanonicalMemoryRecord } from "../../../packages/memory/src/memory-record.ts";
import { fakeMemorySearchProvider } from "../../../packages/memory/src/memory-search-test-fixtures.ts";
import {
  fixedNow,
  memoryDatabase,
} from "../../../packages/memory/src/platform-pagination-reconciliation-fixtures.ts";
import { ids, memoryFixture } from "../../../packages/memory/src/test-fixtures.ts";
import type { MemoryIndexEvent } from "./index-dispatcher.ts";
import { handleMemoryIndexQueue } from "./index-worker.ts";
import { reconcileDueMemoryIndexJobs } from "./operation-reconciler.ts";

const SWEEP_INTERVAL_MS = 5 * 60_000;
const scope = {
  environmentId: ids.environment,
  organizationId: ids.organization,
  projectId: ids.project,
  workspaceId: ids.workspace,
};

interface GroupMessage {
  readonly body: string;
  readonly id: string;
  receiveCount: number;
  visibleAt: number;
}

type IndexJob = Extract<PlatformRecord, { readonly itemType: "memory-index-job" }>;

/**
 * Drives one memory's FIFO message group: the search provider is down until a newer version of
 * the memory is written, so the first job keeps failing until then. SQS delivers only the group's
 * head and only once it is visible; the operation reconciler sweeps every five minutes.
 */
async function newerVersionIndexing(options: {
  readonly runUntilSeconds?: number;
  readonly writeAtSeconds: number;
}) {
  const fixture = memoryDatabase();
  const start = fixedNow.getTime();
  const writeAt = start + options.writeAtSeconds * 1_000;
  let now = fixedNow;
  const search = fakeMemorySearchProvider();
  const whenUp =
    <Input, Output>(mutate: (input: Input) => Promise<Output>) =>
    async (input: Input) => {
      if (now.getTime() < writeAt) throw new Error("search provider unavailable");
      return mutate(input);
    };
  const platform = makeMemoryPlatform({
    database: fixture.database,
    embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
    now: () => now,
    searchProvider: {
      ...search.provider,
      delete: whenUp((input) => search.provider.delete(input)),
      synchronizeLifecycle: whenUp((input) => search.provider.synchronizeLifecycle(input)),
      write: whenUp((input) => search.provider.write(input)),
    },
  });
  const group: GroupMessage[] = [];
  const send = (event: MemoryIndexEvent) => {
    group.push({
      body: JSON.stringify(event),
      id: `message-${group.length + 1}`,
      receiveCount: 0,
      visibleAt: now.getTime(),
    });
  };
  const enqueue = async (memory: CanonicalMemoryRecord, generation: number) => {
    fixture.put("control", memory);
    const job = await platform.enqueueIndexJob({
      memory,
      scope,
      synchronizationGeneration: generation,
    });
    send({
      detail: {
        ...scope,
        payload: {
          idempotencyKey: job.data.idempotencyKey,
          memoryId: memory.data.id,
          targetId: job.data.targetId!,
        },
      },
    });
    return job;
  };

  const older = await enqueue(memoryFixture(), 7);
  const newerBody = "Use the production change window on Thursdays.";
  let written = false;
  let nextSweep = start + SWEEP_INTERVAL_MS;
  let indexedAt: number | undefined;
  const end = start + (options.runUntilSeconds ?? options.writeAtSeconds + 3_600) * 1_000;
  while (true) {
    const head = group[0];
    const nextAt = Math.min(
      written ? Number.POSITIVE_INFINITY : writeAt,
      nextSweep,
      head ? Math.max(head.visibleAt, now.getTime()) : Number.POSITIVE_INFINITY,
    );
    if (nextAt > end) break;
    now = new Date(nextAt);
    if (!written && nextAt === writeAt) {
      written = true;
      await enqueue(
        memoryFixture({
          body: newerBody,
          contentHash: memoryContentHash(newerBody),
          updatedAt: now.toISOString(),
          version: 4,
        }),
        8,
      );
      continue;
    }
    if (nextAt === nextSweep) {
      nextSweep += SWEEP_INTERVAL_MS;
      await reconcileDueMemoryIndexJobs({
        database: fixture.database,
        dispatch: async (event) => send(event),
        now,
      });
      continue;
    }
    head!.receiveCount += 1;
    let visibilitySeconds: number | undefined;
    const { batchItemFailures } = await handleMemoryIndexQueue(
      {
        Records: [
          {
            attributes: { ApproximateReceiveCount: String(head!.receiveCount) },
            body: head!.body,
            messageId: head!.id,
            receiptHandle: `${head!.id}-${head!.receiveCount}`,
          },
        ],
      },
      {
        changeVisibility: async (_receiptHandle, seconds) => {
          visibilitySeconds = seconds;
        },
        now: () => now,
        platform,
        random: () => 1,
        standing: standingInstallation({ organizationId: ids.organization }).repository,
      },
    );
    if (batchItemFailures.length === 0) group.shift();
    else head!.visibleAt = now.getTime() + visibilitySeconds! * 1_000;
    if (indexedAt === undefined && search.rows.get(ids.memory)?.memoryVersion === 4) {
      indexedAt = now.getTime();
      if (options.runUntilSeconds === undefined) break;
    }
  }
  const olderJob = [...(fixture.tables.get("execution")?.values() ?? [])].find(
    (record): record is IndexJob =>
      record.itemType === "memory-index-job" && record.data.id === older.data.id,
  )!;
  return {
    indexedAfterSeconds: indexedAt === undefined ? undefined : (indexedAt - writeAt) / 1_000,
    indexedVersion: search.rows.get(ids.memory)?.memoryVersion,
    olderJob: {
      attempt: olderJob.data.attempt,
      skipReason: olderJob.data.skipReason,
      status: olderJob.data.status,
    },
  };
}

describe("memory index queue group with a failing job", () => {
  it("indexes a newer version written during the failing job's long retry wait at once", async () => {
    expect(
      await newerVersionIndexing({ runUntilSeconds: 12 * 60 * 60, writeAtSeconds: 2 * 60 * 60 }),
    ).toEqual({
      indexedAfterSeconds: 0,
      indexedVersion: 4,
      olderJob: { attempt: 7, skipReason: "stale-content-hash", status: "succeeded" },
    });
  });

  it("indexes a newer version within five minutes wherever the failing job is in its schedule", async () => {
    const latencies: (number | undefined)[] = [];
    for (let writeAtSeconds = 1; writeAtSeconds <= 28_000; writeAtSeconds += 433) {
      latencies.push((await newerVersionIndexing({ writeAtSeconds })).indexedAfterSeconds);
    }
    expect(latencies).toHaveLength(65);
    expect(latencies.filter((seconds) => seconds !== 0)).toEqual([4, 291]);
  });
});
