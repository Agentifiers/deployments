import { expect, test } from "bun:test";
import {
  ScheduleRecord,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type TransactionOperation,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { createSchedule } from "./index.ts";
import { agentDeploymentId, dependencies, memoryDatabase, scope } from "./automation.fixture.ts";
import { finishTimerProvisioning } from "./timer-provisioning.ts";

test("concurrent provisioning retries only publish enabled timers", async () => {
  const memory = memoryDatabase();
  const fixture = dependencies(memory);
  let enableCalls = 0;
  let startFirstEnable!: () => void;
  let releaseFirstEnable!: () => void;
  const firstEnableStarted = new Promise<void>((resolve) => (startFirstEnable = resolve));
  const firstEnableReleased = new Promise<void>((resolve) => (releaseFirstEnable = resolve));
  fixture.dependencies.timerProvider = {
    delete: async () => {},
    upsert: async (schedule) => {
      fixture.providerSchedules.push(schedule);
      enableCalls += 1;
      if (enableCalls === 1) {
        startFirstEnable();
        await firstEnableReleased;
      }
    },
  };
  const input = {
    ...scope,
    agentDeploymentId,
    expression: "rate(1 hour)",
    idempotencyKey: "concurrent-timer-provisioning",
    name: "Concurrent timer provisioning",
    prompt: "Check production health",
  };

  const first = createSchedule(input, fixture.dependencies);
  await firstEnableStarted;
  const second = createSchedule(input, fixture.dependencies);
  await second;
  releaseFirstEnable();
  await first;

  expect(
    fixture.providerSchedules.map(
      (schedule) => (schedule as { readonly enabled: boolean }).enabled,
    ),
  ).toEqual([true, true]);
});

test("a failed concurrent provisioner does not delete a timer another provisioner finalized", async () => {
  const memory = memoryDatabase();
  const fixture = dependencies(memory);
  const baseProvider = fixture.dependencies.timerProvider!;
  let enableCalls = 0;
  let startFirstEnable!: () => void;
  let releaseFirstEnable!: () => void;
  const firstEnableStarted = new Promise<void>((resolve) => (startFirstEnable = resolve));
  const firstEnableReleased = new Promise<void>((resolve) => (releaseFirstEnable = resolve));
  fixture.dependencies.timerProvider = {
    delete: baseProvider.delete,
    upsert: async (schedule) => {
      enableCalls += 1;
      if (enableCalls === 1) {
        startFirstEnable();
        await firstEnableReleased;
        throw new Error("first provisioner lost scheduler access");
      }
      await baseProvider.upsert(schedule);
    },
  };
  const input = {
    ...scope,
    agentDeploymentId,
    expression: "rate(1 hour)",
    idempotencyKey: "failed-concurrent-timer-provisioning",
    name: "Failed concurrent timer provisioning",
    prompt: "Keep the timer owned by the successful provisioner.",
  };

  const first = createSchedule(input, fixture.dependencies);
  await firstEnableStarted;
  expect(createSchedule(input, fixture.dependencies)).resolves.toMatchObject({
    data: { status: "active" },
  });
  releaseFirstEnable();
  expect(first).rejects.toThrow("first provisioner lost scheduler access");

  expect(fixture.providerSchedules).toHaveLength(1);
  expect(fixture.providerDeletes).toHaveLength(0);
});

test("checks current controls durably before enabling a provider timer", async () => {
  const memory = memoryDatabase();
  const fixture = dependencies(memory);
  const schedule = await createSchedule(
    {
      ...scope,
      agentDeploymentId,
      expression: "rate(1 hour)",
      idempotencyKey: "control-change-before-timer-activation",
      name: "Control change before activation",
      prompt: "Do not enable after the current controls reject activation.",
    },
    fixture.dependencies,
  );
  fixture.providerSchedules.length = 0;
  const pending = Schema.decodeUnknownSync(ScheduleRecord)(
    withCanonicalRecordKeys({
      data: {
        ...schedule.data,
        schedule: { ...schedule.data.schedule, timerActivationPending: true },
        version: schedule.data.version + 1,
      },
      itemType: "schedule" as const,
    }),
  );
  memory.put(pending);
  const baseDatabase = fixture.dependencies.database;
  const rejectedControl = {
    conditionExpression: "attribute_exists(pk)",
    key: { pk: "CONTROL", sk: "REJECT-ACTIVATION" },
    kind: "condition-check",
    table: "control",
  } as const satisfies TransactionOperation;
  const database = {
    ...baseDatabase,
    transactWrite: (operations: readonly TransactionOperation[]) => {
      if (operations.some((operation) => operation === rejectedControl)) {
        return Promise.reject(new Error("automation controls changed before activation"));
      }
      return baseDatabase.transactWrite(operations);
    },
  } as DynamoDatabaseService;

  expect(
    finishTimerProvisioning(pending, { ...fixture.dependencies, database }, async () => [
      rejectedControl,
    ]),
  ).rejects.toThrow("automation controls changed before activation");

  expect(fixture.providerSchedules).toHaveLength(0);
  expect(
    [...memory.records.values()].find((record) => record.itemType === "schedule"),
  ).toMatchObject({
    data: { schedule: { timerActivationPending: true }, status: "active" },
  });
});

test("preserves an enabled timer when final persistence committed but reconciliation is unavailable", async () => {
  const memory = memoryDatabase();
  const fixture = dependencies(memory);
  const baseDatabase = fixture.dependencies.database;
  let ambiguous = false;
  let injectAmbiguousFinalization = true;
  const database = {
    ...baseDatabase,
    getRecord: (...args: Parameters<DynamoDatabaseService["getRecord"]>) =>
      ambiguous
        ? Promise.reject(new Error("reconciliation unavailable"))
        : baseDatabase.getRecord(...args),
    transactWrite: (operations: readonly TransactionOperation[]) => {
      const finalizesActivation = operations.some(
        (operation) =>
          operation.kind === "put" &&
          operation.record.itemType === "schedule" &&
          operation.record.data.status === "active" &&
          operation.record.data.schedule.timerActivationPending !== true,
      );
      if (!injectAmbiguousFinalization || !finalizesActivation) {
        return baseDatabase.transactWrite(operations);
      }
      injectAmbiguousFinalization = false;
      return baseDatabase.transactWrite(operations).then(() => {
        ambiguous = true;
        throw new Error("transaction response lost");
      });
    },
  } as DynamoDatabaseService;
  const input = {
    ...scope,
    agentDeploymentId,
    expression: "rate(1 hour)",
    idempotencyKey: "ambiguous-timer-finalization",
    name: "Ambiguous finalization",
    prompt: "Keep the enabled timer after an ambiguous commit.",
  };

  expect(createSchedule(input, { ...fixture.dependencies, database })).rejects.toThrow(
    "persistence outcome could not be reconciled",
  );
  expect(fixture.providerDeletes).toHaveLength(0);
  expect(fixture.providerSchedules).toHaveLength(1);

  ambiguous = false;
  expect(createSchedule(input, fixture.dependencies)).resolves.toMatchObject({
    data: { status: "active" },
  });
  expect(fixture.providerSchedules).toHaveLength(1);
});
