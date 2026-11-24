import { describe, expect, test } from "bun:test";
import type { DynamoDatabaseService, TransactionOperation } from "@deployments-ai/db";
import { processAgentRun } from "./index.ts";
import { fixtures, inMemoryDatabase, workerDependencies } from "./agent-run.fixture.ts";

function cancellationRaceDatabase(
  memory: ReturnType<typeof inMemoryDatabase>,
  options: { readonly failModelInvocationOnce?: boolean },
): DynamoDatabaseService {
  const transactWrite = memory.database.transactWrite;
  let failModelInvocation = options.failModelInvocationOnce ?? false;
  let cancelBeforeFailure = true;
  return {
    ...memory.database,
    transactWrite: async (operations, clientRequestToken) => {
      if (failModelInvocation && includesRecord(operations, "model-invocation")) {
        failModelInvocation = false;
        throw new Error("simulated model invocation persistence failure");
      }
      if (cancelBeforeFailure && includesRunStatus(operations, "failed")) {
        cancelBeforeFailure = false;
        memory.cancelRunningRun();
      }
      return await transactWrite(operations, clientRequestToken);
    },
  };
}

function includesRecord(operations: readonly TransactionOperation[], itemType: "model-invocation") {
  return operations.some(
    (operation) => operation.kind === "put" && operation.record.itemType === itemType,
  );
}

function includesRunStatus(operations: readonly TransactionOperation[], status: "failed") {
  return operations.some(
    (operation) =>
      operation.kind === "put" &&
      operation.record.itemType === "run" &&
      operation.record.data.status === status,
  );
}

describe("agent run cancellation reconciliation", () => {
  test("persists a captured provider attempt when cancellation wins failed claim release", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const database = cancellationRaceDatabase(memory, { failModelInvocationOnce: true });
    const base = workerDependencies(database);

    expect(processAgentRun(fixture.queue, base.dependencies)).resolves.toMatchObject({
      action: "skipped",
      run: { data: { status: "canceled" } },
    });

    expect(
      [...memory.records.values()].find(
        (record) => record.itemType === "model-invocation" && record.data.status === "succeeded",
      ),
    ).toBeDefined();
  });

  test("strips invalid provider usage when cancellation wins failed claim release", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const database = cancellationRaceDatabase(memory, {});
    const base = workerDependencies(database);
    const dependencies = {
      ...base.dependencies,
      runtime: {
        ...base.dependencies.runtime,
        generateAssistantMessage: async () => ({
          assistantMessage: "Provider returned invalid usage metadata.",
          usage: [
            {
              idempotencyKey: "invalid-provider-usage",
              modelId: "openrouter/test",
              occurredAt: 2,
              provider: "openrouter",
              quantity: -1,
              source: "model-gateway",
              payer: { kind: "operator" as const },
              type: "model_tokens" as const,
              unit: "tokens",
            },
          ],
        }),
      },
    };

    expect(processAgentRun(fixture.queue, dependencies)).resolves.toMatchObject({
      action: "skipped",
      run: { data: { status: "canceled" } },
    });

    const invocation = [...memory.records.values()].find(
      (record) => record.itemType === "model-invocation",
    );
    expect(invocation).toBeDefined();
    expect(invocation?.data).not.toHaveProperty("totalTokens");
    expect(
      [...memory.records.values()].find(
        (record) =>
          record.itemType === "meter-event" &&
          record.data.idempotencyKey === "invalid-provider-usage",
      ),
    ).toBeUndefined();
  });
});
