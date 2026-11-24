import { expect, test } from "bun:test";
import { ScheduleRecord, withCanonicalRecordKeys } from "@deployments-ai/db";
import { Schema } from "effect";
import {
  createHeartbeat,
  createSchedule,
  fireHeartbeat,
  fireSchedule,
  getHeartbeat,
  getSchedule,
} from "./index.ts";
import {
  agentDeploymentId,
  dependencies,
  ids,
  memoryDatabase,
  scope,
  threadRecord,
} from "./automation.fixture.ts";
import { finishTimerProvisioning } from "./timer-provisioning.ts";

const scheduleInput = {
  ...scope,
  agentDeploymentId,
  expression: "rate(1 hour)",
  idempotencyKey: "thread-bound-schedule",
  name: "Thread-bound schedule",
  prompt: "Follow up in this conversation.",
  threadId: ids[22]!,
};

test("requires pinned automation threads to belong to the deployment workspace", async () => {
  const missingMemory = memoryDatabase();
  expect(
    createSchedule(scheduleInput, dependencies(missingMemory).dependencies),
  ).rejects.toMatchObject({ code: "not_found" });

  const foreignDeploymentMemory = memoryDatabase();
  foreignDeploymentMemory.put(
    threadRecord(scheduleInput.threadId, { agentDeploymentId: ids[25]! }),
  );
  expect(
    createSchedule(scheduleInput, dependencies(foreignDeploymentMemory).dependencies),
  ).rejects.toMatchObject({ code: "scope_mismatch" });

  const foreignWorkspaceMemory = memoryDatabase();
  foreignWorkspaceMemory.put(threadRecord(scheduleInput.threadId, { workspaceId: ids[26]! }));
  expect(
    createSchedule(scheduleInput, dependencies(foreignWorkspaceMemory).dependencies),
  ).rejects.toMatchObject({ code: "scope_mismatch" });

  const archivedMemory = memoryDatabase();
  archivedMemory.put(threadRecord(scheduleInput.threadId, { archived: true }));
  expect(
    createSchedule(scheduleInput, dependencies(archivedMemory).dependencies),
  ).rejects.toMatchObject({ code: "thread_archived" });
});

test("pins both schedules and heartbeats to an active owned thread", async () => {
  const memory = memoryDatabase();
  memory.put(threadRecord(scheduleInput.threadId));
  const fixture = dependencies(memory);

  const schedule = await createSchedule(scheduleInput, fixture.dependencies);
  const heartbeat = await createHeartbeat(
    {
      ...scope,
      agentDeploymentId,
      idempotencyKey: "thread-bound-heartbeat",
      instructions: "Decide whether a natural proactive message belongs here.",
      intervalMs: 60_000,
      threadId: scheduleInput.threadId,
    },
    fixture.dependencies,
  );

  expect(schedule.data.threadId).toBe(scheduleInput.threadId);
  expect(heartbeat.data.threadId).toBe(scheduleInput.threadId);
  const threadConditions = memory.transactions
    .flat()
    .filter(
      (operation) =>
        operation.kind === "condition-check" &&
        operation.key.pk === threadRecord(scheduleInput.threadId).pk &&
        operation.key.sk === threadRecord(scheduleInput.threadId).sk,
    );
  expect(threadConditions).toHaveLength(4);
  expect(threadConditions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        expressionAttributeValues: { ":archived": false, ":version": 0 },
        kind: "condition-check",
        table: "execution",
      }),
    ]),
  );
});

test.each(["schedule", "heartbeat"] as const)(
  "does not finish retrying %s provisioning after its thread is archived",
  async (kind) => {
    const memory = memoryDatabase();
    memory.put(threadRecord(scheduleInput.threadId));
    const fixture = dependencies(memory);
    const provider = fixture.dependencies.timerProvider!;
    let rejectProvisioning = true;
    const retryingDependencies = {
      ...fixture.dependencies,
      timerProvider: {
        delete: provider.delete,
        upsert: async (input: Parameters<typeof provider.upsert>[0]) => {
          if (rejectProvisioning) {
            rejectProvisioning = false;
            throw new Error("timer unavailable");
          }
          await provider.upsert(input);
        },
      },
    };
    const create = () =>
      kind === "schedule"
        ? createSchedule(scheduleInput, retryingDependencies)
        : createHeartbeat(
            {
              ...scope,
              agentDeploymentId,
              idempotencyKey: "archived-provisioning-heartbeat",
              instructions: "Decide whether a natural proactive message belongs here.",
              intervalMs: 60_000,
              threadId: scheduleInput.threadId,
            },
            retryingDependencies,
          );

    expect(create()).rejects.toThrow("timer unavailable");
    memory.put(threadRecord(scheduleInput.threadId, { archived: true }));

    expect(create()).rejects.toMatchObject({ code: "thread_archived" });
    expect(fixture.providerSchedules).toHaveLength(0);
  },
);

test.each([false, true])(
  "preserves timer state when control revalidation fails with activation pending=%s",
  async (activationPending) => {
    const memory = memoryDatabase();
    memory.put(threadRecord(scheduleInput.threadId));
    const fixture = dependencies(memory);
    const schedule = await createSchedule(scheduleInput, fixture.dependencies);
    const { timerActivationPending: _pending, ...baseSchedule } = schedule.data.schedule;
    const pending = Schema.decodeUnknownSync(ScheduleRecord)(
      withCanonicalRecordKeys({
        data: {
          ...schedule.data,
          schedule: activationPending
            ? { ...baseSchedule, timerActivationPending: true }
            : baseSchedule,
          status: activationPending ? "active" : "provisioning",
          version: schedule.data.version + 1,
        },
        itemType: "schedule" as const,
      }),
    );
    memory.put(pending);

    expect(
      finishTimerProvisioning(pending, fixture.dependencies, async () => {
        throw new Error("thread archived during activation recovery");
      }),
    ).rejects.toThrow("thread archived during activation recovery");
    expect(fixture.providerDeletes).not.toContain(schedule.data.id);
  },
);

test("derives an omitted automation workspace from the pinned thread", async () => {
  const memory = memoryDatabase();
  memory.put(threadRecord(scheduleInput.threadId));
  const fixture = dependencies(memory);
  const { workspaceId: _workspaceId, ...scheduleWithoutWorkspace } = scheduleInput;

  const schedule = await createSchedule(scheduleWithoutWorkspace, fixture.dependencies);
  const heartbeat = await createHeartbeat(
    {
      ...scheduleWithoutWorkspace,
      idempotencyKey: "derived-workspace-heartbeat",
      instructions: "Decide whether a natural proactive message belongs here.",
      intervalMs: 60_000,
    },
    fixture.dependencies,
  );

  expect(schedule.data.workspaceId).toBe(scope.workspaceId);
  expect(heartbeat.data.workspaceId).toBe(scope.workspaceId);
});

test("does not start pinned automations after their thread is archived", async () => {
  const memory = memoryDatabase();
  memory.put(threadRecord(scheduleInput.threadId));
  const fixture = dependencies(memory);
  const schedule = await createSchedule(scheduleInput, fixture.dependencies);
  const heartbeat = await createHeartbeat(
    {
      ...scope,
      agentDeploymentId,
      idempotencyKey: "archived-thread-heartbeat",
      instructions: "Decide whether a natural proactive message belongs here.",
      intervalMs: 60_000,
      threadId: scheduleInput.threadId,
    },
    fixture.dependencies,
  );
  memory.put(threadRecord(scheduleInput.threadId, { archived: true }));

  const scheduleFire = await fireSchedule(
    { ...scope, fireKey: "archived-thread", scheduleId: schedule.data.id },
    fixture.dependencies,
  );
  const heartbeatFire = await fireHeartbeat(
    {
      ...scope,
      agentDeploymentId,
      fireKey: "archived-thread",
      heartbeatId: heartbeat.data.id,
    },
    fixture.dependencies,
  );
  const persistedSchedule = await getSchedule(
    { ...scope, scheduleId: schedule.data.id },
    fixture.dependencies,
  );
  const persistedHeartbeat = await getHeartbeat(
    { ...scope, heartbeatId: heartbeat.data.id },
    fixture.dependencies,
  );

  expect(scheduleFire.fire.data.status).toBe("failed");
  expect(heartbeatFire.heartbeatRun.data).toMatchObject({
    skipReason: "thread-unavailable",
    status: "skipped",
  });
  expect(fixture.runs).toHaveLength(0);
  expect(persistedSchedule.data.status).toBe("archived");
  expect(persistedHeartbeat.data.status).toBe("archived");
  expect(fixture.providerDeletes).toEqual(
    expect.arrayContaining([schedule.data.id, heartbeat.data.id]),
  );
});
