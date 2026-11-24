import { describe, expect, test } from "bun:test";
import type { Ulid } from "@deployments-ai/db";
import {
  modelUsageMeterEvent,
  type ModelUsageMeterEvent,
  type ModelUsageScope,
} from "@deployments-ai/model-usage";
import { Effect } from "effect";
import { handleMemoryUsageQueue } from "./usage-worker.ts";

const ids = {
  environment: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
  memory: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
  organization: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
  project: "01ARZ3NDEKTSV4RRFFQ69G5FA6",
  run: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
  workspace: "01ARZ3NDEKTSV4RRFFQ69G5FC4",
};

describe("memory usage worker", () => {
  test("retries a durable reranker usage entry with the organization that paid for it", async () => {
    const calls: unknown[] = [];
    const result = await handleMemoryUsageQueue(
      {
        Records: [
          {
            body: JSON.stringify({
              entry: {
                idempotencyKey: "usage-1",
                modelId: "openrouter/openai/gpt-4o-mini",
                occurredAt: "2026-07-25T00:00:00.000Z",
                payer: { kind: "organization", modelCredentialId: "credential-1" },
                provider: "openrouter",
                quantity: 42,
                runId: ids.run,
                source: "memory-rerank",
                type: "model_tokens",
                unit: "tokens",
              },
              scope: {
                environmentId: ids.environment,
                operationId: ids.memory,
                operationType: "memory-rerank",
                organizationId: ids.organization,
                projectId: ids.project,
              },
            }),
            messageId: "usage-1",
          },
        ],
      },
      {
        recordUsage: async (entry, scope) => {
          calls.push({ entry, scope });
          return {} as never;
        },
      },
    );
    expect(result.batchItemFailures).toEqual([]);
    expect(calls).toEqual([
      expect.objectContaining({
        entry: expect.objectContaining({
          payer: { kind: "organization", modelCredentialId: "credential-1" },
        }),
      }),
    ]);
  });

  test("records a retried operation's usage in the workspace it was enqueued for", async () => {
    const scope: ModelUsageScope = {
      environmentId: ids.environment as Ulid,
      operationId: ids.memory as Ulid,
      operationType: "memory-rerank",
      organizationId: ids.organization as Ulid,
      projectId: ids.project as Ulid,
      workspaceId: ids.workspace as Ulid,
    };
    const written: ModelUsageMeterEvent[] = [];
    const result = await handleMemoryUsageQueue(
      {
        Records: [
          {
            body: JSON.stringify({
              entry: {
                idempotencyKey: "usage-workspace-1",
                modelId: "openrouter/openai/gpt-4o-mini",
                occurredAt: "2026-07-25T00:00:00.000Z",
                payer: { kind: "operator" },
                provider: "openrouter",
                quantity: 42,
                runId: ids.memory,
                source: "memory-rerank",
                type: "model_tokens",
                unit: "tokens",
              },
              reason: "usage persistence failed",
              scope,
            }),
            messageId: "usage-workspace-1",
          },
        ],
      },
      {
        recordUsage: async (entry, retried) => {
          const record = await Effect.runPromise(
            modelUsageMeterEvent(entry, retried, "01ARZ3NDEKTSV4RRFFQ69G5FC5" as Ulid),
          );
          written.push(record);
          return { record, status: "recorded" };
        },
      },
    );

    expect(result.batchItemFailures).toEqual([]);
    expect(written.map((record) => record.data.workspaceId)).toEqual([scope.workspaceId]);
  });

  test("records a retry enqueued before usage said who paid as operator-funded", async () => {
    const calls: { entry: unknown }[] = [];
    const result = await handleMemoryUsageQueue(
      {
        Records: [
          {
            body: JSON.stringify({
              entry: {
                idempotencyKey: "usage-2",
                modelId: "openrouter/openai/gpt-4o-mini",
                occurredAt: "2026-07-25T00:00:00.000Z",
                provider: "openrouter",
                quantity: 42,
                runId: ids.run,
                source: "memory-rerank",
                type: "model_tokens",
                unit: "tokens",
              },
              scope: {
                environmentId: ids.environment,
                operationId: ids.memory,
                operationType: "memory-rerank",
                organizationId: ids.organization,
                projectId: ids.project,
              },
            }),
            messageId: "usage-2",
          },
        ],
      },
      {
        recordUsage: async (entry) => {
          calls.push({ entry });
          return {} as never;
        },
      },
    );
    expect(result.batchItemFailures).toEqual([]);
    expect(calls).toEqual([{ entry: expect.objectContaining({ payer: { kind: "operator" } }) }]);
  });

  test("preserves immutable context for retried run usage", async () => {
    const calls: unknown[] = [];
    const observability = {
      captureMode: "metadata-only",
      runSpanId: "0123456789abcdef",
      sessionId: ids.memory,
      traceId: "0123456789abcdef0123456789abcdef",
    };
    const result = await handleMemoryUsageQueue(
      {
        Records: [
          {
            body: JSON.stringify({
              entry: {
                idempotencyKey: "usage-run-1",
                modelId: "openrouter/openai/gpt-4o-mini",
                occurredAt: "2026-07-25T00:00:00.000Z",
                payer: { kind: "operator" },
                provider: "openrouter",
                quantity: 42,
                runId: ids.run,
                source: "memory-rerank",
                type: "model_tokens",
                unit: "tokens",
              },
              scope: {
                environmentId: ids.environment,
                observability,
                organizationId: ids.organization,
                projectId: ids.project,
                runId: ids.run,
              },
            }),
            messageId: "usage-run-1",
          },
        ],
      },
      {
        recordUsage: async (entry, scope) => {
          calls.push({ entry, scope });
          return {} as never;
        },
      },
    );

    expect(result.batchItemFailures).toEqual([]);
    expect(calls).toEqual([
      expect.objectContaining({ scope: expect.objectContaining({ observability }) }),
    ]);
  });
});
