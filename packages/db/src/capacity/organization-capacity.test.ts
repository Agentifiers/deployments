import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { TransactionOperation } from "../client-types.ts";
import { evaluationMemoryDatabase } from "../evaluations/memory-database.fixture.ts";
import { Ulid } from "../ids.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import { RunRecord, type RunStatus } from "../records/conversations.ts";
import { makeOrganizationCapacity } from "./organization-capacity.ts";

const ORG_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const PROJECT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAW");
const ENVIRONMENT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAX");
const RUN_IDS = [
  "01ARZ3NDEKTSV4RRFFQ69G5FB0",
  "01ARZ3NDEKTSV4RRFFQ69G5FB1",
  "01ARZ3NDEKTSV4RRFFQ69G5FB2",
].map((id) => Schema.decodeUnknownSync(Ulid)(id));

type RunValue = typeof RunRecord.Type;

function run(index: number, status: RunStatus, version: number, executionSlot?: number): RunValue {
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: PROJECT_ID,
        agentReleaseId: PROJECT_ID,
        attempt: 1,
        captureMode: "metadata-only",
        createdAt: "2026-07-20T00:00:00.000Z",
        environmentId: ENVIRONMENT_ID,
        ...(executionSlot === undefined ? {} : { executionSlot }),
        executor: "platform",
        id: RUN_IDS[index]!,
        idempotencyKey: `run/request-${index}`,
        organizationId: ORG_ID,
        priority: 1,
        projectId: PROJECT_ID,
        redactionPolicyVersion: 1,
        schemaVersion: 1,
        spanId: "0123456789abcdef",
        status,
        threadId: PROJECT_ID,
        traceId: "0123456789abcdef0123456789abcdef",
        trigger: "api",
        updatedAt: `2026-07-20T00:00:0${version}.000Z`,
        version,
      },
      itemType: "run",
    }),
  );
}

function heldSlots(records: readonly PlatformRecord[]) {
  return records
    .flatMap((record) =>
      record.itemType === "unique-claim" &&
      record.data.namespace === `organization:${ORG_ID}:run-execution-slot`
        ? [`${record.data.value}:${record.data.ownerId}`]
        : [],
    )
    .sort();
}

function harness(initialRuns: readonly RunValue[]) {
  const memory = evaluationMemoryDatabase(initialRuns);
  const capacity = makeOrganizationCapacity(memory.database, () => 0);
  const transition = (previous: RunValue, next: RunValue) =>
    memory.database.transactWrite([{ kind: "put", previousRecord: previous, record: next }]);
  const claim = (queued: RunValue, limit: number) =>
    capacity.acquire({
      commit: async (slot) => {
        const running = run(
          RUN_IDS.indexOf(queued.data.id),
          "running",
          queued.data.version + 1,
          slot,
        );
        await transition(queued, running);
        return running;
      },
      holderId: queued.data.id,
      limit,
      organizationId: ORG_ID,
      resource: "run-execution",
    });
  return { capacity, claim, memory, transition };
}

describe("organization run capacity", () => {
  test("admits runs up to the limit and refuses the next one without writing", async () => {
    const queued = [run(0, "queued", 1), run(1, "queued", 1), run(2, "queued", 1)];
    const { claim, memory } = harness(queued);

    const first = await claim(queued[0]!, 2);
    const second = await claim(queued[1]!, 2);
    const writesBefore = memory.transactions.length;
    const third = await claim(queued[2]!, 2);

    expect([first.kind, second.kind]).toEqual(["acquired", "acquired"]);
    expect(third).toEqual({ inUse: 2, kind: "at-capacity", limit: 2 });
    expect(memory.transactions).toHaveLength(writesBefore);
    expect(heldSlots(memory.all())).toEqual([`0:${RUN_IDS[0]}`, `1:${RUN_IDS[1]}`]);
  });

  test.each([
    "completed",
    "failed",
    "canceled",
    "queued",
    "waiting-for-approval",
    "waiting-for-tool",
  ] as const)(
    "releases the slot in the same transaction when a running run becomes %s",
    async (status) => {
      const queued = [run(0, "queued", 1), run(1, "queued", 1)];
      const { claim, memory, transition } = harness(queued);
      const acquired = await claim(queued[0]!, 1);
      if (acquired.kind !== "acquired") throw new Error("expected the first run to be admitted");

      expect(await claim(queued[1]!, 1)).toEqual({ inUse: 1, kind: "at-capacity", limit: 1 });
      await transition(acquired.value, run(0, status, 3, 0));

      expect(heldSlots(memory.all())).toEqual([]);
      expect((await claim(queued[1]!, 1)).kind).toBe("acquired");
    },
  );

  test("keeps the claim while a running run is rewritten with its slot", async () => {
    const queued = [run(0, "queued", 1)];
    const { claim, memory, transition } = harness(queued);
    const acquired = await claim(queued[0]!, 1);
    if (acquired.kind !== "acquired") throw new Error("expected the run to be admitted");

    await transition(acquired.value, run(0, "running", 3, acquired.slot));

    const heartbeat = memory.transactions.at(-1) ?? [];
    expect(heartbeat.filter((operation) => operation.kind !== "condition-check").length).toBe(1);
    expect(heldSlots(memory.all())).toEqual([`0:${RUN_IDS[0]}`]);
  });

  test("admits nothing while a lowered limit is still exceeded", async () => {
    const queued = [run(0, "queued", 1), run(1, "queued", 1), run(2, "queued", 1)];
    const { claim, transition } = harness(queued);
    const admitted = [await claim(queued[0]!, 3), await claim(queued[1]!, 3)];
    if (admitted.some((result) => result.kind !== "acquired")) throw new Error("expected admits");

    expect(await claim(queued[2]!, 1)).toEqual({ inUse: 2, kind: "at-capacity", limit: 1 });
    const [first] = admitted;
    if (first?.kind !== "acquired") throw new Error("expected admits");
    await transition(first.value, run(0, "completed", 3, first.slot));
    expect(await claim(queued[2]!, 1)).toEqual({ inUse: 1, kind: "at-capacity", limit: 1 });
  });

  test("lets exactly one of two concurrent claims take the last slot", async () => {
    const queued = [run(0, "queued", 1), run(1, "queued", 1)];
    const { claim, memory } = harness(queued);

    const results = await Promise.all([claim(queued[0]!, 1), claim(queued[1]!, 1)]);

    expect(results.map((result) => result.kind).sort()).toEqual(["acquired", "at-capacity"]);
    expect(heldSlots(memory.all())).toHaveLength(1);
  });

  test("rejects a running run written without a slot", async () => {
    const queued = run(0, "queued", 1);
    const { transition } = harness([queued]);

    const failure = await transition(queued, run(0, "running", 2)).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(failure).toMatchObject({
      cause: `run:${RUN_IDS[0]} holds run-execution capacity without a slot.`,
    });
  });

  test("deletes the claim with a deleted running run", async () => {
    const queued = run(0, "queued", 1);
    const { claim, memory } = harness([queued]);
    const acquired = await claim(queued, 1);
    if (acquired.kind !== "acquired") throw new Error("expected the run to be admitted");

    const deletion: TransactionOperation = { kind: "delete", record: acquired.value };
    await memory.database.transactWrite([deletion]);

    expect(heldSlots(memory.all())).toEqual([]);
  });
});
