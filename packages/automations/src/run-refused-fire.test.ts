import { ConversationError } from "@deployments-ai/conversations";
import { tableForItemType, type TransactionOperation } from "@deployments-ai/db";
import { expect, test } from "bun:test";
import {
  AutomationError,
  createHeartbeat,
  createSchedule,
  fireHeartbeat,
  fireSchedule,
  type AutomationDependencies,
} from "./index.ts";
import { agentDeploymentId, dependencies, memoryDatabase, scope } from "./automation.fixture.ts";

const REFUSALS = [
  { code: "budget_exhausted", skipReason: "budget-exhausted" },
  { code: "organization_suspended", skipReason: "organization-suspended" },
] as const;

function refusing(base: AutomationDependencies, code: string): AutomationDependencies {
  return {
    ...base,
    submitRun: async () => {
      throw new AutomationError(code, "The run was refused.");
    },
  };
}

function eventPayloads(transactions: readonly TransactionOperation[][], eventType: string) {
  return transactions
    .flat()
    .flatMap((operation) =>
      operation.kind === "put" &&
      operation.record.itemType === "semantic-event" &&
      operation.record.data.eventType === eventType
        ? [operation.record.data.payload]
        : [],
    );
}

for (const { code, skipReason } of REFUSALS) {
  test(`records a schedule fire refused with ${code} as skipped and keeps the schedule active`, async () => {
    const memory = memoryDatabase();
    const schedule = await createSchedule(
      {
        ...scope,
        agentDeploymentId,
        expression: "rate(1 hour)",
        idempotencyKey: `refused-schedule-${code}`,
        name: "Refused schedule",
        prompt: "Check production health",
      },
      dependencies(memory).dependencies,
    );
    const refusingDependencies = refusing(dependencies(memory).dependencies, code);

    const fired = await fireSchedule(
      { ...scope, fireKey: "refused", scheduleId: schedule.data.id },
      refusingDependencies,
    );
    const replayed = await fireSchedule(
      { ...scope, fireKey: "refused", scheduleId: schedule.data.id },
      refusingDependencies,
    );
    const stored = await memory.database.getRecord(tableForItemType(schedule.itemType), schedule);

    expect(fired.run).toBeUndefined();
    expect(fired.fire.data.status).toBe("failed");
    expect(replayed).toMatchObject({ duplicate: true });
    expect(eventPayloads(memory.transactions, "schedule.skipped")).toEqual([
      expect.objectContaining({ skipReason, status: "failed" }),
    ]);
    expect(stored?.itemType === "schedule" && stored.data.status).toBe("active");
  });

  test(`records a heartbeat refused with ${code} as skipped and keeps the heartbeat active`, async () => {
    const memory = memoryDatabase();
    const heartbeat = await createHeartbeat(
      {
        ...scope,
        agentDeploymentId,
        idempotencyKey: `refused-heartbeat-${code}`,
        instructions: "Check production health",
        intervalMs: 60_000,
      },
      dependencies(memory).dependencies,
    );

    const fired = await fireHeartbeat(
      { ...scope, agentDeploymentId, fireKey: "refused", heartbeatId: heartbeat.data.id },
      refusing(dependencies(memory).dependencies, code),
    );
    const stored = await memory.database.getRecord(tableForItemType(heartbeat.itemType), heartbeat);

    expect(fired.run).toBeUndefined();
    expect(fired.heartbeatRun.data).toMatchObject({ skipReason, status: "skipped" });
    expect(stored?.itemType === "heartbeat" && stored.data.status).toBe("active");
  });
}

test("propagates other run submission failures", async () => {
  const memory = memoryDatabase();
  const schedule = await createSchedule(
    {
      ...scope,
      agentDeploymentId,
      expression: "rate(1 hour)",
      idempotencyKey: "failing-schedule",
      name: "Failing schedule",
      prompt: "Check production health",
    },
    dependencies(memory).dependencies,
  );

  expect(
    fireSchedule(
      { ...scope, fireKey: "failing", scheduleId: schedule.data.id },
      {
        ...dependencies(memory).dependencies,
        submitRun: async () => {
          throw new AutomationError("deployment_unavailable", "Agent deployment is not runnable.");
        },
      },
    ),
  ).rejects.toMatchObject({ code: "deployment_unavailable" });
});

function recordsSkip(transactions: readonly TransactionOperation[][]) {
  return transactions
    .flat()
    .some((operation) => operation.kind === "put" && "skipReason" in operation.record.data);
}

const UNREADABLE_STANDING = [
  new ConversationError("organization_standing_unavailable", "Standing could not be read."),
  new AutomationError("organization_standing_unavailable", "Standing could not be read."),
];

for (const unavailable of UNREADABLE_STANDING) {
  test(`propagates an unreadable standing (${unavailable.name}) so a schedule fire retries`, async () => {
    const memory = memoryDatabase();
    const schedule = await createSchedule(
      {
        ...scope,
        agentDeploymentId,
        expression: "rate(1 hour)",
        idempotencyKey: `unreadable-schedule-${unavailable.name}`,
        name: "Unreadable standing schedule",
        prompt: "Check production health",
      },
      dependencies(memory).dependencies,
    );

    const failure = await fireSchedule(
      { ...scope, fireKey: "unreadable", scheduleId: schedule.data.id },
      {
        ...dependencies(memory).dependencies,
        submitRun: async () => {
          throw unavailable;
        },
      },
    ).catch((cause: unknown) => cause);

    expect([failure === unavailable, recordsSkip(memory.transactions)]).toEqual([true, false]);
  });

  test(`propagates an unreadable standing (${unavailable.name}) so a heartbeat fire retries`, async () => {
    const memory = memoryDatabase();
    const heartbeat = await createHeartbeat(
      {
        ...scope,
        agentDeploymentId,
        idempotencyKey: `unreadable-heartbeat-${unavailable.name}`,
        instructions: "Check production health",
        intervalMs: 60_000,
      },
      dependencies(memory).dependencies,
    );

    const failure = await fireHeartbeat(
      { ...scope, agentDeploymentId, fireKey: "unreadable", heartbeatId: heartbeat.data.id },
      {
        ...dependencies(memory).dependencies,
        submitRun: async () => {
          throw unavailable;
        },
      },
    ).catch((cause: unknown) => cause);

    expect([failure === unavailable, recordsSkip(memory.transactions)]).toEqual([true, false]);
  });
}
