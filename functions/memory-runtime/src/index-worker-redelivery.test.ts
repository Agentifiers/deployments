import { describe, expect, it } from "bun:test";
import { makeMemoryPlatform } from "@deployments-ai/memory";
import { standingInstallation } from "@deployments-ai/organization-admission/testing";
import { fakeMemorySearchProvider } from "../../../packages/memory/src/memory-search-test-fixtures.ts";
import {
  fixedNow,
  memoryDatabase,
} from "../../../packages/memory/src/platform-pagination-reconciliation-fixtures.ts";
import { ids, memoryFixture } from "../../../packages/memory/src/test-fixtures.ts";
import { handleMemoryIndexQueue } from "./index-worker.ts";

const QUEUE_VISIBILITY_TIMEOUT_SECONDS = 720;
const scope = {
  environmentId: ids.environment,
  organizationId: ids.organization,
  projectId: ids.project,
  workspaceId: ids.workspace,
};

async function indexOneMemory(options: { readonly failingWrites: number }) {
  const fixture = memoryDatabase();
  let now = fixedNow;
  let failingWrites = options.failingWrites;
  const search = fakeMemorySearchProvider();
  const conflictFirst =
    <Input, Output>(mutate: (input: Input) => Promise<Output>) =>
    async (input: Input) => {
      if (failingWrites > 0) {
        failingWrites -= 1;
        throw new Error("TransactionConflict");
      }
      return mutate(input);
    };
  const platform = makeMemoryPlatform({
    database: fixture.database,
    embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
    now: () => now,
    searchProvider: {
      ...search.provider,
      delete: conflictFirst((input) => search.provider.delete(input)),
      synchronizeLifecycle: conflictFirst((input) => search.provider.synchronizeLifecycle(input)),
      write: conflictFirst((input) => search.provider.write(input)),
    },
  });
  const memory = memoryFixture();
  fixture.put("control", memory);
  const queued = await platform.enqueueIndexJob({ memory, scope, synchronizationGeneration: 7 });
  const body = JSON.stringify({
    detail: {
      ...scope,
      payload: { idempotencyKey: queued.data.idempotencyKey, memoryId: memory.data.id },
    },
  });

  const receivedAtSeconds: number[] = [];
  let visibleAt = fixedNow.getTime();
  for (let receiveCount = 1; receiveCount <= 10; receiveCount += 1) {
    now = new Date(visibleAt);
    receivedAtSeconds.push((visibleAt - fixedNow.getTime()) / 1_000);
    let visibilitySeconds = QUEUE_VISIBILITY_TIMEOUT_SECONDS;
    const { batchItemFailures } = await handleMemoryIndexQueue(
      {
        Records: [
          {
            attributes: { ApproximateReceiveCount: String(receiveCount) },
            body,
            messageId: "message-1",
            receiptHandle: `receipt-${receiveCount}`,
          },
        ],
      },
      {
        changeVisibility: async (receiptHandle, seconds) => {
          expect(receiptHandle).toBe(`receipt-${receiveCount}`);
          visibilitySeconds = seconds;
        },
        now: () => now,
        platform,
        random: () => 1,
        standing: standingInstallation({ organizationId: ids.organization }).repository,
      },
    );
    if (batchItemFailures.length === 0) break;
    visibleAt += visibilitySeconds * 1_000;
  }
  const job = [...(fixture.tables.get("execution")?.values() ?? [])].find(
    (record) => record.itemType === "memory-index-job",
  );
  return {
    indexed: search.rows.has(memory.data.id),
    jobStatus: job?.itemType === "memory-index-job" ? job.data.status : undefined,
    receivedAtSeconds,
  };
}

describe("memory index queue redelivery", () => {
  it("retries a failed index attempt within seconds instead of the queue visibility timeout", async () => {
    expect(await indexOneMemory({ failingWrites: 1 })).toEqual({
      indexed: true,
      jobStatus: "succeeded",
      receivedAtSeconds: [0, 2, 5],
    });
  });

  it("keeps a job whose retry is not yet due on the queue until it is due", async () => {
    expect(await indexOneMemory({ failingWrites: 2 })).toEqual({
      indexed: true,
      jobStatus: "succeeded",
      receivedAtSeconds: [0, 2, 5, 13, 25],
    });
  });
});
