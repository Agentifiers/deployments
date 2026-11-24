import { expect, test } from "bun:test";
import { type DynamoDatabaseService, type TransactionOperation } from "@deployments-ai/db";
import { createHeartbeat, createSchedule, fireHeartbeat, fireSchedule } from "./index.ts";
import {
  agentDeploymentId,
  dependencies,
  memoryDatabase,
  scope,
  workspaceRecord,
} from "./automation.fixture.ts";

test("rejects new automation work in an archived workspace", async () => {
  const memory = memoryDatabase();
  memory.put(workspaceRecord(scope.workspaceId, "archived"));

  expect(
    createSchedule(
      {
        ...scope,
        agentDeploymentId,
        expression: "rate(1 hour)",
        idempotencyKey: "archived-workspace-schedule",
        name: "Archived workspace schedule",
        prompt: "Check production health",
      },
      dependencies(memory).dependencies,
    ),
  ).rejects.toMatchObject({ code: "workspace_unavailable" });
});

test("rejects automation creation when the workspace is archived during its transaction", async () => {
  const memory = memoryDatabase();
  const fixture = dependencies(memory);
  let attemptedOperations: readonly TransactionOperation[] = [];
  const database = {
    ...memory.database,
    transactWrite: async (operations: readonly TransactionOperation[]) => {
      attemptedOperations = operations;
      memory.put(workspaceRecord(scope.workspaceId, "archived"));
      throw new Error("workspace condition failed");
    },
  } as DynamoDatabaseService;

  expect(
    createSchedule(
      {
        ...scope,
        agentDeploymentId,
        expression: "rate(1 hour)",
        idempotencyKey: "workspace-archive-race",
        name: "Workspace archive race",
        prompt: "Do not provision this timer",
      },
      { ...fixture.dependencies, database },
    ),
  ).rejects.toMatchObject({ code: "workspace_unavailable" });

  expect(attemptedOperations).toContainEqual(
    expect.objectContaining({
      expressionAttributeValues: { ":active": "active", ":version": 0 },
      kind: "condition-check",
      table: "control",
    }),
  );
  expect(attemptedOperations).toContainEqual(
    expect.objectContaining({
      expressionAttributeValues: { ":ready": "ready", ":running": "running", ":version": 0 },
      kind: "condition-check",
      table: "control",
    }),
  );
  expect(attemptedOperations).toContainEqual(
    expect.objectContaining({
      expressionAttributeValues: {
        ":active": "active",
        ":contentHash": expect.stringMatching(/^sha256:/u),
        ":version": 0,
      },
      kind: "condition-check",
      table: "control",
    }),
  );
  expect(fixture.providerSchedules).toHaveLength(0);
});

test("does not start timer runs after their workspace is archived", async () => {
  const memory = memoryDatabase();
  const fixture = dependencies(memory);
  const schedule = await createSchedule(
    {
      ...scope,
      agentDeploymentId,
      expression: "rate(1 hour)",
      idempotencyKey: "workspace-fire-schedule",
      name: "Workspace schedule",
      prompt: "Check production health",
    },
    fixture.dependencies,
  );
  const heartbeat = await createHeartbeat(
    {
      ...scope,
      agentDeploymentId,
      idempotencyKey: "workspace-fire-heartbeat",
      instructions: "Check production health",
      intervalMs: 60_000,
    },
    fixture.dependencies,
  );
  memory.put(workspaceRecord(scope.workspaceId, "archived"));

  const scheduleFire = await fireSchedule(
    { ...scope, fireKey: "archived-workspace-fire", scheduleId: schedule.data.id },
    fixture.dependencies,
  );
  const heartbeatFire = await fireHeartbeat(
    {
      ...scope,
      agentDeploymentId,
      fireKey: "archived-workspace-fire",
      heartbeatId: heartbeat.data.id,
    },
    fixture.dependencies,
  );

  expect(scheduleFire.fire.data.status).toBe("failed");
  expect(heartbeatFire.heartbeatRun.data).toMatchObject({
    skipReason: "workspace-unavailable",
    status: "skipped",
  });
  expect(fixture.runs).toHaveLength(0);
});
