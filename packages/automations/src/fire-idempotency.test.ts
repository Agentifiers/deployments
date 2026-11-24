import { expect, test } from "bun:test";
import { type DynamoDatabaseService, type TransactionOperation } from "@deployments-ai/db";
import {
  createHeartbeat,
  createSchedule,
  fireHeartbeat,
  fireSchedule,
  updateSchedule,
} from "./index.ts";
import {
  agentDeploymentId,
  dependencies,
  ids,
  memoryDatabase,
  scope,
  threadRecord,
} from "./automation.fixture.ts";

test("fire replays preserve the original run result", async () => {
  const memory = memoryDatabase();
  memory.put(threadRecord(ids[22]!));
  memory.put(threadRecord(ids[23]!));
  const fixture = dependencies(memory);
  const schedule = await createSchedule(
    {
      ...scope,
      agentDeploymentId,
      expression: "rate(1 hour)",
      idempotencyKey: "schedule-fire-replay",
      name: "Schedule fire replay",
      prompt: "Check production health",
      threadId: ids[22]!,
    },
    fixture.dependencies,
  );
  const heartbeat = await createHeartbeat(
    {
      ...scope,
      agentDeploymentId,
      idempotencyKey: "heartbeat-fire-replay",
      instructions: "Check production health",
      intervalMs: 60_000,
      threadId: ids[23]!,
    },
    fixture.dependencies,
  );

  const firstSchedule = await fireSchedule(
    { ...scope, fireKey: "schedule-fire", scheduleId: schedule.data.id },
    fixture.dependencies,
  );
  const replayedSchedule = await fireSchedule(
    { ...scope, fireKey: "schedule-fire", scheduleId: schedule.data.id },
    fixture.dependencies,
  );
  const firstHeartbeat = await fireHeartbeat(
    {
      ...scope,
      agentDeploymentId,
      fireKey: "heartbeat-fire",
      heartbeatId: heartbeat.data.id,
    },
    fixture.dependencies,
  );
  const replayedHeartbeat = await fireHeartbeat(
    {
      ...scope,
      agentDeploymentId,
      fireKey: "heartbeat-fire",
      heartbeatId: heartbeat.data.id,
    },
    fixture.dependencies,
  );

  expect(replayedSchedule).toMatchObject({ duplicate: true, run: firstSchedule.run });
  expect(replayedHeartbeat).toMatchObject({ duplicate: true, run: firstHeartbeat.run });
  expect(replayedSchedule.fire.data.threadId).toBe(firstSchedule.run?.threadId);
  expect(replayedHeartbeat.heartbeatRun.data.threadId).toBe(firstHeartbeat.run?.threadId);
  expect(fixture.runs).toEqual([
    expect.objectContaining({ threadId: ids[22]!, trigger: "schedule" }),
    expect.objectContaining({ threadId: ids[23]!, trigger: "heartbeat" }),
  ]);
});

test("heartbeat retries replay their current run before mutable skip gates", async () => {
  const memory = memoryDatabase();
  const fixture = dependencies(memory);
  const heartbeat = await createHeartbeat(
    {
      ...scope,
      agentDeploymentId,
      idempotencyKey: "heartbeat-current-run",
      instructions: "Check production health",
      intervalMs: 60_000,
      skipWhenBusy: false,
    },
    fixture.dependencies,
  );
  const currentRun = { runId: ids[20]!, threadId: ids[21]! };
  let currentRunIdempotencyKey: string | undefined;

  const fired = await fireHeartbeat(
    {
      ...scope,
      agentDeploymentId,
      fireKey: "reconciled-heartbeat-fire",
      hasActiveRun: async (_deploymentId, idempotencyKey, _workspaceId, includeOtherActiveRuns) => {
        currentRunIdempotencyKey = idempotencyKey;
        expect(includeOtherActiveRuns).toBe(false);
        return currentRun;
      },
      heartbeatId: heartbeat.data.id,
      scheduleVersion: heartbeat.data.version + 1,
    },
    fixture.dependencies,
  );

  expect(currentRunIdempotencyKey).toStartWith(`heartbeat:${heartbeat.data.id}:`);
  expect(fired).toMatchObject({ duplicate: false, run: currentRun });
  expect(fired.heartbeatRun.data).toMatchObject({
    runId: currentRun.runId,
    status: "accepted",
    threadId: currentRun.threadId,
  });
  expect(fixture.runs).toHaveLength(1);
  expect(fixture.runs[0]).toMatchObject({ idempotencyKey: currentRunIdempotencyKey });
});

test("schedule retries reuse their submitted run before mutable schedule and thread gates", async () => {
  const memory = memoryDatabase();
  const thread = threadRecord(ids[22]!);
  memory.put(thread);
  const fixture = dependencies(memory);
  const schedule = await createSchedule(
    {
      ...scope,
      agentDeploymentId,
      expression: "rate(1 hour)",
      idempotencyKey: "schedule-current-run",
      name: "Schedule current run",
      prompt: "Reconcile the already submitted run.",
      threadId: thread.data.id,
    },
    fixture.dependencies,
  );
  const originalTransactWrite = memory.database.transactWrite;
  let failFirePersistence = true;
  const database = {
    ...memory.database,
    transactWrite: (operations: readonly TransactionOperation[], token?: string) => {
      if (
        failFirePersistence &&
        operations.some(
          (operation) => operation.kind === "put" && operation.record.itemType === "schedule-fire",
        )
      ) {
        failFirePersistence = false;
        return Promise.reject(new Error("schedule fire persistence unavailable"));
      }
      return originalTransactWrite(operations, token);
    },
  } as DynamoDatabaseService;
  const fireInput = {
    ...scope,
    fireKey: "reconciled-schedule-fire",
    scheduleId: schedule.data.id,
  };

  expect(fireSchedule(fireInput, { ...fixture.dependencies, database })).rejects.toThrow(
    "schedule fire persistence unavailable",
  );
  await updateSchedule(
    {
      ...scope,
      prompt: "This edited prompt must not be resubmitted for the same fire.",
      scheduleId: schedule.data.id,
    },
    fixture.dependencies,
  );
  memory.put(threadRecord(thread.data.id, { archived: true }));
  const currentRun = { runId: ids[20]!, threadId: ids[21]! };
  const replay = await fireSchedule(
    {
      ...fireInput,
      findCurrentRun: async () => currentRun,
    },
    {
      ...fixture.dependencies,
      submitRun: async () => {
        throw new Error("idempotency_conflict");
      },
    },
  );

  expect(replay).toMatchObject({ duplicate: false, run: currentRun });
  expect(replay.fire.data).toMatchObject({
    runId: currentRun.runId,
    status: "accepted",
    threadId: currentRun.threadId,
  });
  expect(fixture.runs).toHaveLength(1);
  expect(fixture.runs[0]).toMatchObject({ content: "Reconcile the already submitted run." });
});
