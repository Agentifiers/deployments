import { describe, expect, it } from "bun:test";
import type { PlatformRecord } from "@deployments-ai/db";
import { makeMemoryPlatform } from "@deployments-ai/memory";
import { fakeMemorySearchProvider } from "../../../packages/memory/src/memory-search-test-fixtures.ts";
import {
  fixedNow,
  memoryDatabase,
} from "../../../packages/memory/src/platform-pagination-reconciliation-fixtures.ts";
import { ids, memoryFixture } from "../../../packages/memory/src/test-fixtures.ts";
import type { MemoryIndexEvent } from "./index-dispatcher.ts";
import { reconcileDueMemoryIndexJobs } from "./operation-reconciler.ts";

const SWEEP_INTERVAL_MS = 5 * 60_000;

describe("memory index retry reconciliation", () => {
  it("stops redispatching a permanently failing index job once its retry budget is spent", async () => {
    const fixture = memoryDatabase();
    let now = fixedNow;
    const rejected = async (): Promise<never> => {
      throw new Error("search rejected");
    };
    const platform = makeMemoryPlatform({
      database: fixture.database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => now,
      searchProvider: fakeMemorySearchProvider({
        delete: rejected,
        synchronizeLifecycle: rejected,
        write: rejected,
      }).provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
      workspaceId: ids.workspace,
    };
    const memory = memoryFixture();
    fixture.put("control", memory);
    const queued = await platform.enqueueIndexJob({
      memory,
      scope,
      synchronizationGeneration: 7,
    });
    const deliver = (event: MemoryIndexEvent) =>
      platform
        .processIndexJob(scope, {
          idempotencyKey: event.detail!.payload!.idempotencyKey!,
          memoryId: memory.data.id,
          targetId: queued.data.targetId!,
        })
        .catch(() => undefined);
    await deliver({
      detail: {
        payload: {
          idempotencyKey: queued.data.idempotencyKey,
          memoryId: memory.data.id,
          targetId: queued.data.targetId!,
        },
      },
    });

    const redispatchedAt: number[] = [];
    const threeDays = 3 * 24 * 60 * 60_000;
    for (let elapsed = SWEEP_INTERVAL_MS; elapsed <= threeDays; elapsed += SWEEP_INTERVAL_MS) {
      now = new Date(fixedNow.getTime() + elapsed);
      const sent: MemoryIndexEvent[] = [];
      await reconcileDueMemoryIndexJobs({
        database: fixture.database,
        dispatch: async (event) => {
          sent.push(event);
        },
        now,
      });
      for (const event of sent) {
        redispatchedAt.push(elapsed);
        await deliver(event);
      }
    }

    const job = [...(fixture.tables.get("execution")?.values() ?? [])].find(
      (record): record is Extract<PlatformRecord, { readonly itemType: "memory-index-job" }> =>
        record.itemType === "memory-index-job",
    );
    expect(job?.data).toMatchObject({
      attempt: 8,
      skipReason: "retries-exhausted",
      status: "failed",
    });
    expect(redispatchedAt.map((elapsed) => elapsed / 60_000)).toEqual([
      5, 10, 15, 25, 50, 140, 485,
    ]);
  });
});
