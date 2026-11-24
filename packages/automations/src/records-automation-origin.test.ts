import { expect, test } from "bun:test";
import { createHeartbeat, createSchedule, fireHeartbeat, fireSchedule } from "./index.ts";
import {
  agentDeploymentId,
  dependencies,
  ids,
  memoryDatabase,
  scope,
  threadRecord,
} from "./automation.fixture.ts";

test("records the creator and originating tool call, and replays ignore a different creator", async () => {
  const memory = memoryDatabase();
  memory.put(threadRecord(ids[22]!));
  const fixture = dependencies(memory);
  const input = {
    ...scope,
    agentDeploymentId,
    createdBy: { id: agentDeploymentId, type: "agent" as const },
    createdFrom: {
      runId: ids[25]!,
      threadId: ids[22]!,
      toolCallId: ids[26]!,
      toolName: "agent.schedule.remind",
    },
    expression: "rate(1 hour)",
    idempotencyKey: "agent-created-schedule",
    name: "Agent reminder",
    prompt: "Remind the user to stretch",
    threadId: ids[22]!,
  };

  const created = await createSchedule(input, fixture.dependencies);
  const replayed = await createSchedule(
    { ...input, createdBy: { id: ids[27]!, type: "principal" as const } },
    fixture.dependencies,
  );

  expect(created.data).toMatchObject({
    createdBy: { id: "01ARZ3NDEKTSV4RRFFQ69G5F04", type: "agent" },
    createdFrom: {
      runId: "01ARZ3NDEKTSV4RRFFQ69G5F25",
      threadId: "01ARZ3NDEKTSV4RRFFQ69G5F22",
      toolCallId: "01ARZ3NDEKTSV4RRFFQ69G5F26",
      toolName: "agent.schedule.remind",
    },
  });
  expect(replayed.data).toMatchObject({
    createdBy: { id: "01ARZ3NDEKTSV4RRFFQ69G5F04", type: "agent" },
    id: created.data.id,
  });
});

test("records the caller that created a heartbeat", async () => {
  const fixture = dependencies(memoryDatabase());
  const heartbeat = await createHeartbeat(
    {
      ...scope,
      agentDeploymentId,
      createdBy: { id: ids[27]!, type: "service-account" },
      idempotencyKey: "caller-created-heartbeat",
      instructions: "Check production health",
      intervalMs: 60_000,
    },
    fixture.dependencies,
  );

  expect(heartbeat.data).toMatchObject({
    createdBy: { id: "01ARZ3NDEKTSV4RRFFQ69G5F27", type: "service-account" },
  });
});

test("a fired run's idempotency key names the automation and the fire record", async () => {
  const fixture = dependencies(memoryDatabase());
  const schedule = await createSchedule(
    {
      ...scope,
      agentDeploymentId,
      expression: "rate(1 hour)",
      idempotencyKey: "fired-schedule",
      name: "Fired schedule",
      prompt: "Check production health",
    },
    fixture.dependencies,
  );
  const heartbeat = await createHeartbeat(
    {
      ...scope,
      agentDeploymentId,
      idempotencyKey: "fired-heartbeat",
      instructions: "Check production health",
      intervalMs: 60_000,
      skipWhenBusy: false,
    },
    fixture.dependencies,
  );

  const scheduleFire = await fireSchedule(
    { ...scope, fireKey: "2026-07-23T12:00:00Z", scheduleId: schedule.data.id },
    fixture.dependencies,
  );
  const heartbeatFire = await fireHeartbeat(
    { ...scope, agentDeploymentId, fireKey: "manual-fire", heartbeatId: heartbeat.data.id },
    fixture.dependencies,
  );

  expect(fixture.runs).toEqual([
    expect.objectContaining({
      idempotencyKey: `schedule:${schedule.data.id}:${scheduleFire.fire.data.id}`,
    }),
    expect.objectContaining({
      idempotencyKey: `heartbeat:${heartbeat.data.id}:${heartbeatFire.heartbeatRun.data.id}`,
    }),
  ]);
});
