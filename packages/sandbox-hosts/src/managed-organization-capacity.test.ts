import {
  capacityClaimNamespace,
  DatabaseError,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
  makeIdGenerator,
  makeUniqueClaimRecord,
  tableForItemType,
  UniqueClaimRecord,
} from "@deployments-ai/db";
import { evaluationMemoryDatabase } from "@deployments-ai/db/evaluation-testing";
import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import type {
  CreateSandboxInput,
  SandboxCapacityRecovery,
  SandboxCapacityRejection,
  SandboxLease,
  SandboxProvider,
} from "./index.ts";
import { makeSandboxManager } from "./sandbox-manager.fixture.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB3" as Ulid;
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB4" as Ulid;
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB5" as Ulid;
const AGENT_DEPLOYMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB6" as Ulid;
const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB7" as Ulid;
const OTHER_RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB8" as Ulid;
const SLOT_NAMESPACE = `organization:${ORGANIZATION_ID}:active-sandbox-slot`;
const STARTED_AT = Date.parse("2026-10-01T00:00:00.000Z");

const createInput: CreateSandboxInput = {
  executionTargetId: AGENT_DEPLOYMENT_ID,
  executionTargetKind: "agent-deployment",
  environmentId: ENVIRONMENT_ID,
  isolationMode: "run-ephemeral",
  observability: {
    captureMode: "metadata-only",
    runSpanId: "0123456789abcdef",
    sessionId: RUN_ID,
    traceId: "0123456789abcdef0123456789abcdef",
  },
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  runId: RUN_ID,
};

function capacityDatabase(runningRuns: readonly Ulid[]) {
  const memory = evaluationMemoryDatabase(
    runningRuns.map((runId, slot) =>
      Schema.decodeUnknownSync(UniqueClaimRecord)(
        makeUniqueClaimRecord(
          {
            namespace: capacityClaimNamespace(ORGANIZATION_ID, "run-execution"),
            ownerId: runId,
            ownerItemType: "run",
            ownerPk: `THREAD#${runId}`,
            ownerSk: `RUN#${runId}`,
            ownerTable: "execution",
            value: String(slot),
          },
          "2026-10-01T00:00:00.000Z",
        ),
      ),
    ),
  );
  const storeKey = (record: PlatformRecord) =>
    `${tableForItemType(record.itemType)}\u0000${record.pk}\u0000${record.sk}`;
  const database: DynamoDatabaseService = {
    ...memory.database,
    deleteRecord: async (record) => {
      memory.records.delete(storeKey(record));
    },
    putRecord: async (record, conditionExpression) => {
      if (conditionExpression && memory.records.has(storeKey(record))) {
        throw new DatabaseError({
          cause: "ConditionalCheckFailedException",
          message: "Conditional put rejected.",
          operation: "put",
          reason: "conflict",
          table: tableForItemType(record.itemType),
        });
      }
      memory.records.set(storeKey(record), record);
    },
  };
  const slotClaims = () =>
    memory
      .all()
      .flatMap((record) =>
        record.itemType === "unique-claim" && record.data.namespace === SLOT_NAMESPACE
          ? [{ ownerId: record.data.ownerId, value: record.data.value }]
          : [],
      )
      .sort((left, right) => left.value.localeCompare(right.value));
  const leaseCount = () =>
    memory.all().filter((record) => record.itemType === "sandbox-lease").length;
  const leaseStatus = (id: string) =>
    memory
      .all()
      .flatMap((record) =>
        record.itemType === "sandbox-lease" && record.data.id === id ? [record.data.status] : [],
      )[0];
  return { database, leaseCount, leaseStatus, slotClaims };
}

interface CappedManagerOptions {
  readonly failedCreates?: number;
  readonly failedDestroys?: number;
  readonly leaseMs?: number;
  readonly runningRuns?: readonly Ulid[];
}

function recordingProvider(options: CappedManagerOptions, now: () => number) {
  const calls = { create: 0, destroyed: [] as string[], resume: 0 };
  let destroyAttempts = 0;
  const leaseFor = (input: CreateSandboxInput): SandboxLease => ({
    executionTargetId: input.executionTargetId,
    executionTargetKind: input.executionTargetKind,
    environmentId: input.environmentId,
    externalSandboxId: `microvm-${input.allocationId}`,
    isolationMode: input.isolationMode,
    ...(options.leaseMs === undefined ? {} : { leaseExpiresAt: now() + options.leaseMs }),
    organizationId: input.organizationId,
    projectId: input.projectId,
    provider: "aws_lambda_microvm",
    ...(input.runId ? { runId: input.runId } : {}),
    status: "ready",
  });
  const provider: SandboxProvider = {
    name: "aws_lambda_microvm",
    checkpoint: async () => ({
      checkpointRef: "checkpoint",
      createdAt: Date.now(),
      provider: "aws_lambda_microvm",
    }),
    create: async (input) => {
      calls.create += 1;
      if (calls.create <= (options.failedCreates ?? 0)) {
        throw new Error("The provider refused the allocation.");
      }
      return leaseFor(input);
    },
    destroy: async ({ lease }) => {
      destroyAttempts += 1;
      if (destroyAttempts <= (options.failedDestroys ?? 0)) {
        throw new Error("The provider refused the destroy.");
      }
      calls.destroyed.push(lease.externalSandboxId);
    },
    download: async () => new ReadableStream<Uint8Array>(),
    exec: async () => ({ durationMs: 1, exitCode: 0, stderr: "", stdout: "" }),
    resume: async ({ lease }) => {
      calls.resume += 1;
      return { ...lease, status: "ready" };
    },
    upload: async () => undefined,
  };
  return { calls, provider };
}

function cappedManager(limit: number, options: CappedManagerOptions = {}) {
  let clock = STARTED_AT;
  const store = capacityDatabase(options.runningRuns ?? [RUN_ID]);
  const { calls, provider } = recordingProvider(options, () => clock);
  const recoveries: SandboxCapacityRecovery[] = [];
  const rejections: SandboxCapacityRejection[] = [];
  const manager = makeSandboxManager(provider, store.database, makeIdGenerator(), {
    now: () => clock,
    onSandboxCapacityRejected: (rejection) => rejections.push(rejection),
    onStaleCapacityRecovered: (recovery) => recoveries.push(recovery),
    organizationSandboxLimit: async (organizationId) => {
      if (organizationId !== ORGANIZATION_ID) throw new Error("Unexpected organization.");
      return limit;
    },
  });
  const create = (input: Partial<CreateSandboxInput> = {}) =>
    Effect.runPromise(manager.create({ ...createInput, ...input }));
  const advance = (milliseconds: number) => {
    clock += milliseconds;
  };
  return { advance, calls, create, manager, recoveries, rejections, store };
}

const capacityError = (limit: number, inUse: number) => ({
  _tag: "SandboxCapacityError",
  inUse,
  limit,
  message: `The organization reached its limit of ${limit} active sandboxes.`,
  organizationId: ORGANIZATION_ID,
});

describe("organization active-sandbox capacity", () => {
  test("refuses the create beyond the cap before calling the provider", async () => {
    const { calls, create, rejections, store } = cappedManager(2);
    const first = await create();
    const second = await create();

    expect(create()).rejects.toMatchObject(capacityError(2, 2));
    expect(create()).rejects.toMatchObject(capacityError(2, 2));

    expect(calls.create).toBe(2);
    expect(store.leaseCount()).toBe(2);
    expect(store.slotClaims()).toEqual(
      [first, second]
        .map((sandbox) => ({
          ownerId: sandbox.record.data.id,
          value: String(sandbox.record.data.capacitySlot),
        }))
        .sort((left, right) => left.value.localeCompare(right.value)),
    );
    expect(store.slotClaims().map((claim) => claim.value)).toEqual(["0", "1"]);
    expect(rejections).toEqual([
      { inUse: 2, limit: 2, organizationId: ORGANIZATION_ID, requestingRunId: RUN_ID },
      { inUse: 2, limit: 2, organizationId: ORGANIZATION_ID, requestingRunId: RUN_ID },
    ]);
  });

  test("frees the slot when the provider refuses the allocation", async () => {
    const { calls, create, store } = cappedManager(1, { failedCreates: 1 });

    expect(create()).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "create",
    });
    expect(store.slotClaims()).toEqual([]);
    const next = await create();

    expect(calls.create).toBe(2);
    expect(store.slotClaims()).toEqual([{ ownerId: next.record.data.id, value: "0" }]);
  });

  test("frees the slot when a sandbox is destroyed", async () => {
    const { calls, create, manager, store } = cappedManager(1);
    const first = await create();
    expect(create()).rejects.toMatchObject(capacityError(1, 1));

    await Effect.runPromise(manager.destroy(first));
    expect(store.slotClaims()).toEqual([]);
    const next = await create();

    expect(calls.create).toBe(2);
    expect(store.slotClaims()).toEqual([{ ownerId: next.record.data.id, value: "0" }]);
  });

  test("frees the slot on suspend and refuses a resume at the cap before the provider", async () => {
    const { calls, create, manager, store } = cappedManager(1);
    const first = await create();

    const suspended = await Effect.runPromise(manager.checkpoint(first));
    expect(suspended.record.data).toMatchObject({ computeUsageActive: false, status: "suspended" });
    expect(store.slotClaims()).toEqual([]);

    const second = await create();
    expect(Effect.runPromise(manager.resume(suspended))).rejects.toMatchObject(capacityError(1, 1));
    expect(calls.resume).toBe(0);
    expect(store.slotClaims()).toEqual([{ ownerId: second.record.data.id, value: "0" }]);

    await Effect.runPromise(manager.destroy(second));
    const resumed = await Effect.runPromise(manager.resume(suspended));

    expect(calls.resume).toBe(1);
    expect(resumed.record.data).toMatchObject({ capacitySlot: 0, status: "ready" });
    expect(store.slotClaims()).toEqual([{ ownerId: first.record.data.id, value: "0" }]);
  });

  test("refuses every create when the cap is zero", async () => {
    const { calls, create, rejections, store } = cappedManager(0);

    expect(create()).rejects.toMatchObject(capacityError(0, 0));
    expect(create()).rejects.toMatchObject(capacityError(0, 0));

    expect(calls.create).toBe(0);
    expect(store.leaseCount()).toBe(0);
    expect(rejections).toEqual([
      { inUse: 0, limit: 0, organizationId: ORGANIZATION_ID, requestingRunId: RUN_ID },
      { inUse: 0, limit: 0, organizationId: ORGANIZATION_ID, requestingRunId: RUN_ID },
    ]);
  });

  test("destroys an expired holder at the cap and creates in its slot", async () => {
    const test = cappedManager(1, { leaseMs: 60_000 });
    const expired = await test.create();
    test.advance(120_000);

    const next = await test.create();

    expect(test.calls.create).toBe(2);
    expect(test.calls.destroyed).toEqual([expired.lease.externalSandboxId]);
    expect(test.store.leaseStatus(expired.record.data.id)).toBe("destroyed");
    expect(test.store.slotClaims()).toEqual([{ ownerId: next.record.data.id, value: "0" }]);
    expect(test.recoveries).toEqual([
      {
        inUse: 1,
        leaseId: expired.record.data.id,
        limit: 1,
        organizationId: ORGANIZATION_ID,
        reason: "lease-expired",
        requestingRunId: RUN_ID,
      },
    ]);
    expect(test.rejections).toEqual([]);
  });

  test("destroys a run-ephemeral holder whose run no longer holds an execution slot", async () => {
    const test = cappedManager(1, { runningRuns: [OTHER_RUN_ID] });
    const orphaned = await test.create();

    const next = await test.create({ runId: OTHER_RUN_ID });

    expect(test.calls.destroyed).toEqual([orphaned.lease.externalSandboxId]);
    expect(test.store.leaseStatus(orphaned.record.data.id)).toBe("destroyed");
    expect(test.store.slotClaims()).toEqual([{ ownerId: next.record.data.id, value: "0" }]);
    expect(test.recoveries.map(({ leaseId, reason }) => ({ leaseId, reason }))).toEqual([
      { leaseId: orphaned.record.data.id, reason: "run-not-running" },
    ]);
  });

  test("retries the destroy of a holder left in error by a failed destroy", async () => {
    const test = cappedManager(1, { failedDestroys: 1 });
    const failed = await test.create();
    expect(Effect.runPromise(test.manager.destroy(failed))).rejects.toMatchObject({
      _tag: "SandboxOperationError",
    });
    expect(test.store.leaseStatus(failed.record.data.id)).toBe("error");

    const next = await test.create();

    expect(test.calls.destroyed).toEqual([failed.lease.externalSandboxId]);
    expect(test.store.leaseStatus(failed.record.data.id)).toBe("destroyed");
    expect(test.store.slotClaims()).toEqual([{ ownerId: next.record.data.id, value: "0" }]);
    expect(test.recoveries.map(({ reason }) => reason)).toEqual(["destroy-failed"]);
  });

  test("refuses at the cap without a provider call while every holder is live", async () => {
    const test = cappedManager(1, { leaseMs: 3_600_000 });
    const live = await test.create();
    test.advance(60_000);

    expect(test.create()).rejects.toMatchObject(capacityError(1, 1));

    expect(test.calls).toEqual({ create: 1, destroyed: [], resume: 0 });
    expect(test.store.leaseStatus(live.record.data.id)).toBe("ready");
    expect(test.recoveries).toEqual([]);
    expect(test.rejections).toEqual([
      { inUse: 1, limit: 1, organizationId: ORGANIZATION_ID, requestingRunId: RUN_ID },
    ]);
  });

  test("never destroys an unexpired thread-persistent holder, even when its run stopped", async () => {
    const test = cappedManager(1, { leaseMs: 3_600_000, runningRuns: [OTHER_RUN_ID] });
    const workspace = await test.create({ isolationMode: "thread-persistent" });
    test.advance(60_000);

    expect(test.create({ runId: OTHER_RUN_ID })).rejects.toMatchObject(capacityError(1, 1));

    expect(test.calls).toEqual({ create: 1, destroyed: [], resume: 0 });
    expect(test.store.leaseStatus(workspace.record.data.id)).toBe("ready");
    expect(test.store.slotClaims()).toEqual([{ ownerId: workspace.record.data.id, value: "0" }]);
    expect(test.recoveries).toEqual([]);
  });
});
