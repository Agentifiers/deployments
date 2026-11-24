import { type DynamoDatabaseService, type TransactionOperation } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { agentDeploymentId, dependencies, memoryDatabase, scope } from "./automation.fixture.ts";
import { createSchedule, fireSchedule } from "./index.ts";

describe("automation control plane", () => {
  test("does not reactivate a one-shot timer after it fires from active pending state", async () => {
    const memory = memoryDatabase();
    const fixture = dependencies(memory);
    let failEnable = true;
    fixture.dependencies.timerProvider = {
      delete: async () => {},
      upsert: async (schedule) => {
        fixture.providerSchedules.push(schedule);
        if ((schedule as { readonly enabled?: boolean }).enabled !== false && failEnable) {
          failEnable = false;
          throw new Error("scheduler activation unavailable");
        }
      },
    };
    const input = {
      ...scope,
      agentDeploymentId,
      expression: "at(2026-07-24T12:00:00)",
      idempotencyKey: "pending-schedule-activation",
      name: "Pending activation",
      prompt: "Check production health once",
    };

    expect(createSchedule(input, fixture.dependencies)).rejects.toThrow(
      "scheduler activation unavailable",
    );
    const pending = [...memory.records.values()].find((record) => record.itemType === "schedule");
    expect(pending).toMatchObject({
      data: { schedule: { timerActivationPending: true }, status: "active", version: 1 },
    });
    if (!pending || pending.itemType !== "schedule") {
      throw new Error("Pending schedule was not persisted.");
    }
    const fired = await fireSchedule(
      {
        ...scope,
        fireKey: "2026-07-24T12:00:00Z",
        scheduleId: pending.data.id,
        scheduleVersion: Number(pending.data.schedule.timerVersion),
      },
      fixture.dependencies,
    );
    expect(fired.fire.data.status).toBe("accepted");

    const retried = await createSchedule(input, fixture.dependencies);

    expect(retried.data.status).toBe("archived");
    expect(retried.data.schedule).not.toHaveProperty("timerActivationPending");
    expect(fixture.providerSchedules).toMatchObject([{ enabled: true }]);
  });

  test("keeps run idempotency stable when activation advances before fire retry", async () => {
    const memory = memoryDatabase();
    const fixture = dependencies(memory);
    let failEnable = true;
    fixture.dependencies.timerProvider = {
      delete: async () => {},
      upsert: async (schedule) => {
        fixture.providerSchedules.push(schedule);
        if ((schedule as { readonly enabled?: boolean }).enabled !== false && failEnable) {
          failEnable = false;
          throw new Error("scheduler activation unavailable");
        }
      },
    };
    const input = {
      ...scope,
      agentDeploymentId,
      expression: "at(2026-07-24T12:00:00)",
      idempotencyKey: "activation-fire-race",
      name: "Activation fire race",
      prompt: "Check production health once",
    };
    expect(createSchedule(input, fixture.dependencies)).rejects.toThrow(
      "scheduler activation unavailable",
    );
    const pending = [...memory.records.values()].find((record) => record.itemType === "schedule");
    if (!pending || pending.itemType !== "schedule") throw new Error("Expected pending schedule.");
    let failFireCommit = true;
    const originalTransactWrite = memory.database.transactWrite;
    const flakyDatabase = {
      ...memory.database,
      transactWrite: (operations: readonly TransactionOperation[], token?: string) => {
        if (
          failFireCommit &&
          operations.some(
            (operation) =>
              operation.kind === "put" && operation.record.itemType === "schedule-fire",
          )
        ) {
          failFireCommit = false;
          return Promise.reject(new Error("fire commit response lost"));
        }
        return originalTransactWrite(operations, token);
      },
    } as DynamoDatabaseService;
    const fireInput = {
      ...scope,
      fireKey: "2026-07-24T12:00:00Z",
      scheduleId: pending.data.id,
      scheduleVersion: Number(pending.data.schedule.timerVersion),
    };

    expect(
      fireSchedule(fireInput, { ...fixture.dependencies, database: flakyDatabase }),
    ).rejects.toThrow("fire commit response lost");
    await createSchedule(input, fixture.dependencies);
    await fireSchedule(fireInput, fixture.dependencies);

    expect(fixture.runs).toHaveLength(2);
    const runKeys = (fixture.runs as Array<{ readonly idempotencyKey: string }>).map(
      (run) => run.idempotencyKey,
    );
    expect(runKeys[1]).toBe(runKeys[0]);
    expect(runKeys[0]).not.toContain(":v");
  });
});
