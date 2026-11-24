import { expect, test } from "bun:test";
import {
  HeartbeatRecord,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type TransactionOperation,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { createHeartbeat } from "./index.ts";
import { agentDeploymentId, dependencies, memoryDatabase, scope } from "./automation.fixture.ts";

test("finalizes activation after a heartbeat fire advances the pending version", async () => {
  const memory = memoryDatabase();
  const fixture = dependencies(memory);
  const originalTransactWrite = memory.database.transactWrite;
  let failFirstFinalization = true;
  const database = {
    ...memory.database,
    transactWrite: (operations: readonly TransactionOperation[], token?: string) => {
      const finalizesHeartbeat = operations.some(
        (operation) =>
          operation.kind === "put" &&
          operation.record.itemType === "heartbeat" &&
          operation.record.data.status === "active" &&
          operation.record.data.schedule.timerActivationPending !== true,
      );
      if (failFirstFinalization && finalizesHeartbeat) {
        failFirstFinalization = false;
        return Promise.reject(new Error("heartbeat version advanced during activation"));
      }
      return originalTransactWrite(operations, token);
    },
  } as DynamoDatabaseService;
  fixture.dependencies.database = database;
  fixture.dependencies.timerProvider = {
    delete: async () => {},
    upsert: async (timer) => {
      fixture.providerSchedules.push(timer);
      if (fixture.providerSchedules.length !== 1) return;
      const pending = [...memory.records.values()].find(
        (record) => record.itemType === "heartbeat",
      );
      if (!pending || pending.itemType !== "heartbeat") throw new Error("Expected heartbeat.");
      memory.put(
        Schema.decodeUnknownSync(HeartbeatRecord)(
          withCanonicalRecordKeys({
            data: {
              ...pending.data,
              lastRunAt: "2026-07-24T12:00:00.000Z",
              version: pending.data.version + 1,
            },
            itemType: "heartbeat" as const,
          }),
        ),
      );
    },
  };

  const heartbeat = await createHeartbeat(
    {
      ...scope,
      agentDeploymentId,
      idempotencyKey: "pending-version-race",
      instructions: "Check production health",
      intervalMs: 60_000,
    },
    fixture.dependencies,
  );

  expect(heartbeat.data.schedule).not.toHaveProperty("timerActivationPending");
  expect(heartbeat.data.version).toBe(4);
  expect(fixture.providerSchedules).toHaveLength(2);
});
