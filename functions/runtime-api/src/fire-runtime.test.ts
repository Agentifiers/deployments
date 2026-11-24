import { describe, expect, test } from "bun:test";
import type { DynamoDatabaseService, Ulid } from "@deployments-ai/db";
import {
  cachedAutomationFireRuntime,
  findCurrentScheduleRun,
  hasActiveRun,
} from "./fire-runtime.ts";

const environmentId = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const agentDeploymentId = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAZ" as Ulid;
const projectId = "01ARZ3NDEKTSV4RRFFQ69G5FB0" as Ulid;
const currentRunScope = { organizationId, projectId };

function idempotentRunDatabase(input: {
  readonly idempotencyKey: string;
  readonly runId: Ulid;
  readonly threadId: Ulid;
  readonly trigger: "api" | "heartbeat" | "schedule";
  readonly queryRecords?: DynamoDatabaseService["queryRecords"];
}) {
  return {
    getRecord: (table: string) =>
      Promise.resolve(
        table === "events"
          ? ({
              data: { resourceIds: [input.threadId, input.runId], status: "completed" },
              itemType: "idempotency",
            } as never)
          : ({
              data: {
                agentDeploymentId,
                environmentId,
                id: input.runId,
                idempotencyKey: input.idempotencyKey,
                organizationId,
                projectId,
                threadId: input.threadId,
                trigger: input.trigger,
              },
              itemType: "run",
            } as never),
      ),
    queryRecords: input.queryRecords ?? (() => Promise.resolve({ items: [] })),
  } as unknown as DynamoDatabaseService;
}

describe("heartbeat busy-run lookup", () => {
  test("retries dependency initialization after a rejected promise", async () => {
    let attempts = 0;
    const runtime = {
      database: {} as never,
      generateId: async () => environmentId,
      submitRun: async () => ({ runId: environmentId, threadId: environmentId }),
    };
    const create = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("secrets unavailable");
      return runtime;
    };

    expect(cachedAutomationFireRuntime(create)).rejects.toThrow("secrets unavailable");
    expect(cachedAutomationFireRuntime(create)).resolves.toBe(runtime);
    expect(attempts).toBe(2);
  });

  test("queries only the target deployment for each active status", async () => {
    const calls: Array<Readonly<Record<string, unknown>>> = [];
    const database = {
      queryRecords: (_table: string, input: Readonly<Record<string, unknown>>) => {
        calls.push(input);
        const prefix = (input.ExpressionAttributeValues as Record<string, string>)[":prefix"];
        if (prefix !== "RUN#queued#") return Promise.resolve({ items: [] });
        return Promise.resolve({
          items: [
            {
              data: { agentDeploymentId },
              itemType: "run",
            } as never,
          ],
        });
      },
    } as unknown as DynamoDatabaseService;

    expect(hasActiveRun(database, environmentId, agentDeploymentId)).resolves.toBe(true);
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.Limit).toBe(1);
      expect(call).not.toHaveProperty("ExclusiveStartKey");
      expect((call.ExpressionAttributeValues as Record<string, string>)[":pk"]).toBe(
        `ENV#${environmentId}#AGENT-DEPLOYMENT#${agentDeploymentId}`,
      );
    }
  });

  test("reconciles the current heartbeat run after it becomes terminal", async () => {
    const currentRunId = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;
    const currentThreadId = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid;
    const currentRunIdempotencyKey = "heartbeat:completed-fire";
    const database = idempotentRunDatabase({
      idempotencyKey: currentRunIdempotencyKey,
      runId: currentRunId,
      threadId: currentThreadId,
      trigger: "heartbeat",
    });

    expect(
      hasActiveRun(
        database,
        environmentId,
        agentDeploymentId,
        currentRunIdempotencyKey,
        currentRunScope,
      ),
    ).resolves.toEqual({ runId: currentRunId, threadId: currentThreadId });
  });

  test("reconciles the current schedule run by its deterministic idempotency key", async () => {
    const currentRunId = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;
    const currentThreadId = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid;
    const currentRunIdempotencyKey = "schedule:completed-fire";
    const database = idempotentRunDatabase({
      idempotencyKey: currentRunIdempotencyKey,
      runId: currentRunId,
      threadId: currentThreadId,
      trigger: "schedule",
    });

    expect(
      findCurrentScheduleRun(
        database,
        environmentId,
        agentDeploymentId,
        currentRunIdempotencyKey,
        currentRunScope,
      ),
    ).resolves.toEqual({ runId: currentRunId, threadId: currentThreadId });
  });

  test("does not adopt a non-heartbeat run with a colliding idempotency key", async () => {
    const currentRunIdempotencyKey = "heartbeat:caller-collision";
    const database = idempotentRunDatabase({
      idempotencyKey: currentRunIdempotencyKey,
      runId: environmentId,
      threadId: agentDeploymentId,
      trigger: "api",
      queryRecords: (_table: string, input: Readonly<Record<string, unknown>>) => {
        const values = input.ExpressionAttributeValues as Record<string, string>;
        const canonicalPartition = `ENV#${environmentId}#AGENT-DEPLOYMENT#${agentDeploymentId}`;
        if (values[":pk"] !== canonicalPartition || values[":prefix"] !== "RUN#queued#") {
          return Promise.resolve({ items: [] });
        }
        return Promise.resolve({
          items: [
            {
              data: {
                agentDeploymentId,
                id: environmentId,
                idempotencyKey: currentRunIdempotencyKey,
                threadId: agentDeploymentId,
                trigger: "api",
              },
              itemType: "run",
            } as never,
          ],
        });
      },
    });

    expect(
      hasActiveRun(
        database,
        environmentId,
        agentDeploymentId,
        currentRunIdempotencyKey,
        currentRunScope,
      ),
    ).resolves.toBe(true);
  });

  test("falls back to paginated legacy environment run indexes", async () => {
    const calls: Array<Readonly<Record<string, unknown>>> = [];
    let queuedLegacyPages = 0;
    const database = {
      queryRecords: (_table: string, input: Readonly<Record<string, unknown>>) => {
        calls.push(input);
        const values = input.ExpressionAttributeValues as Record<string, string>;
        const canonicalPartition = `ENV#${environmentId}#AGENT-DEPLOYMENT#${agentDeploymentId}`;
        if (values[":pk"] === canonicalPartition) return Promise.resolve({ items: [] });
        if (values[":prefix"] !== "RUN#queued#") return Promise.resolve({ items: [] });
        queuedLegacyPages += 1;
        if (queuedLegacyPages === 1) {
          return Promise.resolve({
            items: [],
            lastEvaluatedKey: { gsi2pk: `ENV#${environmentId}`, gsi2sk: "next" },
          });
        }
        return Promise.resolve({
          items: [{ data: { agentDeploymentId }, itemType: "run" } as never],
        });
      },
    } as unknown as DynamoDatabaseService;

    expect(hasActiveRun(database, environmentId, agentDeploymentId)).resolves.toBe(true);
    expect(calls).toHaveLength(9);
    const legacyCalls = calls.filter(
      (call) =>
        (call.ExpressionAttributeValues as Record<string, string>)[":pk"] ===
        `ENV#${environmentId}`,
    );
    expect(legacyCalls).toHaveLength(5);
    expect(legacyCalls[0]).toMatchObject({
      FilterExpression: "#data.#deployment = :deployment",
      Limit: 100,
    });
    expect(legacyCalls.at(-1)).toHaveProperty("ExclusiveStartKey");
  });
});
