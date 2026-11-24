import { expect, test } from "bun:test";
import {
  ScheduleRecord,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type TransactionOperation,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { createSchedule, fireSchedule, getSchedule } from "./index.ts";
import { agentDeploymentId, dependencies, memoryDatabase, scope } from "./automation.fixture.ts";
import { finishTimerProvisioning } from "./timer-provisioning.ts";

test("archives a one-shot schedule after its fire is durably recorded", async () => {
  const memory = memoryDatabase();
  const fixture = dependencies(memory);
  const schedule = await createSchedule(
    {
      ...scope,
      agentDeploymentId,
      expression: "at(2026-07-23T13:00:00)",
      idempotencyKey: "one-shot-lifecycle",
      name: "One-shot follow-up",
      prompt: "Send the promised follow-up now.",
    },
    fixture.dependencies,
  );

  const first = await fireSchedule(
    {
      ...scope,
      fireKey: "2026-07-23T13:00:00.000Z",
      scheduleId: schedule.data.id,
    },
    fixture.dependencies,
  );
  const replay = await fireSchedule(
    {
      ...scope,
      fireKey: "2026-07-23T13:00:00.000Z",
      scheduleId: schedule.data.id,
    },
    fixture.dependencies,
  );
  const persisted = await getSchedule(
    { ...scope, scheduleId: schedule.data.id },
    fixture.dependencies,
  );

  expect(first).toMatchObject({
    duplicate: false,
    fire: { data: { status: "accepted" } },
  });
  expect(replay).toMatchObject({ duplicate: true, run: first.run });
  expect(persisted.data.status).toBe("archived");
  expect(fixture.runs).toHaveLength(1);
  expect(fixture.providerDeletes).toContain(schedule.data.id);
});

test("does not archive a recurring schedule that replaces a one-shot during its fire", async () => {
  const memory = memoryDatabase();
  const fixture = dependencies(memory);
  const oneShot = await createSchedule(
    {
      ...scope,
      agentDeploymentId,
      expression: "at(2026-07-23T13:00:00)",
      idempotencyKey: "one-shot-replaced-during-fire",
      name: "Replace during fire",
      prompt: "Send the promised follow-up now.",
    },
    fixture.dependencies,
  );
  const recurring = Schema.decodeUnknownSync(ScheduleRecord)(
    withCanonicalRecordKeys({
      data: {
        ...oneShot.data,
        schedule: {
          ...oneShot.data.schedule,
          expression: "rate(1 hour)",
          timerVersion: Number(oneShot.data.schedule.timerVersion) + 1,
        },
        updatedAt: "2026-07-23T12:59:59.000Z",
        version: oneShot.data.version + 1,
      },
      itemType: "schedule" as const,
    }),
  );
  const originalTransactWrite = memory.database.transactWrite;
  const racingDatabase = {
    ...memory.database,
    transactWrite: async (operations: readonly TransactionOperation[], token?: string) => {
      await originalTransactWrite(operations, token);
      if (
        operations.some(
          (operation) => operation.kind === "put" && operation.record.itemType === "schedule-fire",
        )
      ) {
        memory.put(recurring);
      }
    },
  } as DynamoDatabaseService;

  await fireSchedule(
    {
      ...scope,
      fireKey: "2026-07-23T13:00:00.000Z",
      scheduleId: oneShot.data.id,
    },
    { ...fixture.dependencies, database: racingDatabase },
  );
  const persisted = await getSchedule(
    { ...scope, scheduleId: oneShot.data.id },
    fixture.dependencies,
  );

  expect(persisted.data).toMatchObject({
    schedule: { expression: "rate(1 hour)" },
    status: "active",
    version: recurring.data.version,
  });
  expect(fixture.providerDeletes).not.toContain(oneShot.data.id);
});

test("archives a fired one-shot after a concurrent metadata-only update", async () => {
  const memory = memoryDatabase();
  const fixture = dependencies(memory);
  const oneShot = await createSchedule(
    {
      ...scope,
      agentDeploymentId,
      expression: "at(2026-07-23T13:00:00)",
      idempotencyKey: "one-shot-metadata-race",
      name: "Original name",
      prompt: "Send the promised follow-up now.",
    },
    fixture.dependencies,
  );
  const renamed = Schema.decodeUnknownSync(ScheduleRecord)(
    withCanonicalRecordKeys({
      data: {
        ...oneShot.data,
        name: "Updated while firing",
        updatedAt: "2026-07-23T12:59:59.000Z",
        version: oneShot.data.version + 1,
      },
      itemType: "schedule" as const,
    }),
  );
  const originalTransactWrite = memory.database.transactWrite;
  const racingDatabase = {
    ...memory.database,
    transactWrite: async (operations: readonly TransactionOperation[], token?: string) => {
      await originalTransactWrite(operations, token);
      if (
        operations.some(
          (operation) => operation.kind === "put" && operation.record.itemType === "schedule-fire",
        )
      ) {
        memory.put(renamed);
      }
    },
  } as DynamoDatabaseService;

  await fireSchedule(
    {
      ...scope,
      fireKey: "2026-07-23T13:00:00.000Z",
      scheduleId: oneShot.data.id,
    },
    { ...fixture.dependencies, database: racingDatabase },
  );
  const persisted = await getSchedule(
    { ...scope, scheduleId: oneShot.data.id },
    fixture.dependencies,
  );

  expect(persisted.data).toMatchObject({
    name: "Updated while firing",
    status: "archived",
    version: renamed.data.version + 1,
  });
  expect(fixture.providerDeletes).toContain(oneShot.data.id);
});

test("does not archive a newer one-shot when replaying an older manual fire", async () => {
  const memory = memoryDatabase();
  const fixture = dependencies(memory);
  const recurring = await createSchedule(
    {
      ...scope,
      agentDeploymentId,
      expression: "rate(1 hour)",
      idempotencyKey: "manual-fire-before-one-shot",
      name: "Recurring before one-shot",
      prompt: "Send the current follow-up.",
    },
    fixture.dependencies,
  );
  const first = await fireSchedule(
    { ...scope, fireKey: "manual-fire", scheduleId: recurring.data.id },
    fixture.dependencies,
  );
  const oneShot = Schema.decodeUnknownSync(ScheduleRecord)(
    withCanonicalRecordKeys({
      data: {
        ...recurring.data,
        schedule: {
          ...recurring.data.schedule,
          expression: "at(2026-07-23T14:00:00)",
          timerVersion: Number(recurring.data.schedule.timerVersion) + 1,
        },
        updatedAt: "2026-07-23T13:30:00.000Z",
        version: recurring.data.version + 1,
      },
      itemType: "schedule" as const,
    }),
  );
  memory.put(oneShot);

  const replay = await fireSchedule(
    { ...scope, fireKey: "manual-fire", scheduleId: recurring.data.id },
    fixture.dependencies,
  );
  const persisted = await getSchedule(
    { ...scope, scheduleId: recurring.data.id },
    fixture.dependencies,
  );

  expect(first.fire.data.scheduleVersion).toBe(Number(recurring.data.schedule.timerVersion));
  expect(replay.duplicate).toBe(true);
  expect(persisted.data).toMatchObject({
    schedule: { expression: "at(2026-07-23T14:00:00)" },
    status: "active",
  });
  expect(fixture.providerDeletes).not.toContain(recurring.data.id);
});

test("terminalizes a one-shot whose provisioning retry occurs after its UTC deadline", async () => {
  const memory = memoryDatabase();
  const fixture = dependencies(memory);
  const baseProvider = fixture.dependencies.timerProvider!;
  let clock = new Date("2026-07-23T12:00:00.000Z");
  let provisioningUnavailable = true;
  const retryingDependencies = {
    ...fixture.dependencies,
    now: () => clock,
    timerProvider: {
      delete: baseProvider.delete,
      upsert: async (input: Parameters<typeof baseProvider.upsert>[0]) => {
        if (provisioningUnavailable) throw new Error("scheduler unavailable");
        await baseProvider.upsert(input);
      },
    },
  };
  const input = {
    ...scope,
    agentDeploymentId,
    expression: "at(2026-07-23T12:01:00)",
    idempotencyKey: "expired-provisioning-retry",
    name: "Expiring reminder",
    prompt: "Do not silently install this reminder in the past.",
  };

  expect(createSchedule(input, retryingDependencies)).rejects.toThrow("scheduler unavailable");
  clock = new Date("2026-07-23T12:02:00.000Z");
  provisioningUnavailable = false;
  const retried = await createSchedule(input, retryingDependencies);

  expect(retried.data.status).toBe("archived");
  expect(fixture.providerSchedules).toHaveLength(0);
  expect(fixture.providerDeletes.filter((id) => id === retried.data.id)).toHaveLength(1);
});

test("terminalizes a one-shot whose provisioning retry occurs after its local deadline", async () => {
  const memory = memoryDatabase();
  const fixture = dependencies(memory);
  const baseProvider = fixture.dependencies.timerProvider!;
  let clock = new Date("2026-07-23T19:00:00.000Z");
  let provisioningUnavailable = true;
  const retryingDependencies = {
    ...fixture.dependencies,
    now: () => clock,
    timerProvider: {
      delete: baseProvider.delete,
      upsert: async (input: Parameters<typeof baseProvider.upsert>[0]) => {
        if (provisioningUnavailable) throw new Error("scheduler unavailable");
        await baseProvider.upsert(input);
      },
    },
  };
  const input = {
    ...scope,
    agentDeploymentId,
    expression: "at(2026-07-23T12:01:00)",
    idempotencyKey: "expired-local-provisioning-retry",
    name: "Expiring local reminder",
    prompt: "Do not silently install this local reminder in the past.",
    timezone: "America/Phoenix",
  };

  expect(createSchedule(input, retryingDependencies)).rejects.toThrow("scheduler unavailable");
  clock = new Date("2026-07-23T19:02:00.000Z");
  provisioningUnavailable = false;
  const retried = await createSchedule(input, retryingDependencies);

  expect(retried.data.status).toBe("archived");
  expect(fixture.providerSchedules).toHaveLength(0);
  expect(fixture.providerDeletes.filter((id) => id === retried.data.id)).toHaveLength(1);
});

test("rechecks the one-shot deadline after fire-history I/O and before provider enablement", async () => {
  const memory = memoryDatabase();
  const fixture = dependencies(memory);
  let clock = new Date("2026-07-23T12:00:00.000Z");
  const active = await createSchedule(
    {
      ...scope,
      agentDeploymentId,
      expression: "at(2026-07-23T12:01:00)",
      idempotencyKey: "deadline-crossed-during-validation",
      name: "Near-deadline reminder",
      prompt: "Do not enable after validation crosses the deadline.",
      timezone: "UTC",
    },
    { ...fixture.dependencies, now: () => clock },
  );
  const provisioning = Schema.decodeUnknownSync(ScheduleRecord)(
    withCanonicalRecordKeys({
      data: {
        ...active.data,
        status: "provisioning" as const,
        version: active.data.version + 1,
      },
      itemType: "schedule" as const,
    }),
  );
  memory.put(provisioning);
  fixture.providerSchedules.length = 0;
  clock = new Date("2026-07-23T12:00:30.000Z");
  const baseDatabase = fixture.dependencies.database;
  const crossingDatabase = {
    ...baseDatabase,
    queryRecords: async (...args: Parameters<DynamoDatabaseService["queryRecords"]>) => {
      const result = await baseDatabase.queryRecords(...args);
      clock = new Date("2026-07-23T12:01:01.000Z");
      return result;
    },
  } as DynamoDatabaseService;

  const result = await finishTimerProvisioning(
    provisioning,
    { ...fixture.dependencies, database: crossingDatabase, now: () => clock },
    async () => {
      clock = new Date("2026-07-23T12:00:59.000Z");
      return [];
    },
  );

  expect(result.data.status).toBe("archived");
  expect(fixture.providerSchedules).toHaveLength(0);
  expect(fixture.providerDeletes).toContain(active.data.id);
});
