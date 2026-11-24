import { describe, expect, test } from "bun:test";
import { brainUlid } from "@deployments-ai/db";
import {
  transactionCanceledError,
  type FakeDynamoDocumentClient,
} from "@deployments-ai/db/dynamo-testing";
import { processBrainErasure } from "./erasure-runtime.ts";
import { at, erasureWorld, minutes, organizationId } from "./erasure.fixture.ts";
import type { BrainSearchErasureResult } from "./search-erasure.ts";

const brainId = "01M3TKGBADCYBG97VHNKANM58Q";
const erasureId = "5V27YRC4MRPJDHJFZ44P3745Q8";
const brainSearchErased = {
  receipt: {
    brainId: brainUlid(brainId),
    erasureGeneration: 1,
    operationId: brainUlid(erasureId),
    targets: [],
  },
  status: "complete",
} satisfies BrainSearchErasureResult;

async function erasingBrain() {
  const ids = {
    brainId,
    erasureId,
    eventId: "01KYK5W3M7Z4KR6VP8BJTA8ACH",
    grantId: "01KYK5W3M7Z4KR6VP8BJTA8ACG",
    slug: "engineering",
  };
  const world = await erasureWorld([ids]);
  const job = () => world.job(ids);
  const searchPurges: string[] = [];
  const run = (
    now: Date,
    workerId: string,
    purgeSearch: () => Promise<BrainSearchErasureResult> = async () => brainSearchErased,
  ) =>
    processBrainErasure(
      job(),
      world.dependencies({
        now: () => now,
        purgeSearch: async () => {
          searchPurges.push(workerId);
          return purgeSearch();
        },
        workerId,
      }),
    );
  return { dynamo: world.dynamo, job, run, searchPurges };
}

function erasedEvents(dynamo: FakeDynamoDocumentClient) {
  return dynamo
    .items("events")
    .filter((item) => item.pk === `ORG#${organizationId}#AGGREGATE#brain-erasure#${erasureId}`);
}

// Everything that names the Brain is gone except the erasure job and its own inventory locator.
function expectBrainErased(dynamo: FakeDynamoDocumentClient) {
  const brainOwned = (item: Readonly<Record<string, unknown>>) => {
    const text = JSON.stringify(item);
    return text.includes(brainId) && !text.includes("brain-erasure-job");
  };
  expect(dynamo.items("control").filter(brainOwned)).toEqual([]);
  expect(dynamo.items("events").filter(brainOwned)).toEqual([]);
}

describe("Brain erasure against conditional DynamoDB persistence", () => {
  test("drains, purges, verifies, and completes with the erasure's first semantic event", async () => {
    const state = await erasingBrain();

    expect((await state.run(at(0), "worker-a")).outcome).toBe("content-quiescence");
    const result = await state.run(at(minutes(6)), "worker-a");

    expect(result.outcome).toBe("completed");
    expect(state.job().data).toMatchObject({
      contentVerificationCount: 2,
      phase: "verifying",
      recordsDeleted: 3,
      searchReceipt: { brainSearch: brainSearchErased.receipt },
      status: "completed",
    });
    expect(state.job().data.leaseOwner).toBeUndefined();
    expect(erasedEvents(state.dynamo)).toMatchObject([
      {
        data: { aggregateVersion: 1, eventType: "brain.erased" },
        sk: "SEMANTIC-EVENT#0000000000000001",
      },
    ]);
    expectBrainErased(state.dynamo);
    expect((await state.run(at(minutes(20)), "worker-b")).outcome).toBe("ignored");
  });

  test("retries a server-cancelled completion with changed parameters to completion", async () => {
    const state = await erasingBrain();
    let contended = true;
    const contend = () =>
      state.dynamo.failNextTransaction(
        (input) =>
          contended &&
          input.TransactItems?.some((item) => item.Put?.Item?.itemType === "semantic-event") ===
            true,
        () => {
          contend();
          return transactionCanceledError([
            "None",
            "None",
            "None",
            "None",
            "None",
            "None",
            "ThrottlingError",
          ]);
        },
      );
    contend();

    await state.run(at(0), "worker-a");
    expect(state.run(at(minutes(6)), "worker-a")).rejects.toThrow();
    contended = false;
    expect(state.job().data).toMatchObject({
      failedAttempts: 1,
      nextDueAt: at(minutes(11)).toISOString(),
      phase: "verifying",
      status: "pending",
    });

    const retried = await state.run(at(minutes(12)), "worker-b");

    expect(retried.outcome).toBe("completed");
    expect(state.job().data).toMatchObject({ recordsDeleted: 3, status: "completed" });
    expect(state.job().data.error).toBeUndefined();
    expect(state.searchPurges).toEqual(["worker-a"]);
    expect(erasedEvents(state.dynamo)).toHaveLength(1);
    expectBrainErased(state.dynamo);
  });

  test("lets a lease successor finish when the expired holder fails afterwards", async () => {
    const state = await erasingBrain();
    await state.run(at(0), "worker-a");
    const holderReachedSearch = Promise.withResolvers<void>();
    const holderResumed = Promise.withResolvers<void>();
    const holder = state.run(at(minutes(6)), "worker-a", async () => {
      holderReachedSearch.resolve();
      await holderResumed.promise;
      return brainSearchErased;
    });
    await holderReachedSearch.promise;

    const successor = await state.run(at(minutes(22)), "worker-b", async () => {
      holderResumed.resolve();
      await holder.catch(() => undefined);
      return brainSearchErased;
    });

    expect(holder).rejects.toThrow();
    expect(successor.outcome).toBe("completed");
    expect(state.job().data).toMatchObject({ status: "completed" });
    expect(erasedEvents(state.dynamo)).toHaveLength(1);
    expectBrainErased(state.dynamo);
  });
});
