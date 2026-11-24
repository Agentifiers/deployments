import { describe, expect, it } from "bun:test";
import type {
  RuntimeModelInvocationAttempt,
  RuntimeUsageEntry,
} from "@deployments-ai/agent-runtime";
import type { PlatformRecord } from "@deployments-ai/db";
import { processAgentRun } from "./index.ts";
import {
  customerRunPins,
  abandonedRunWithLease,
  fixtures,
  inMemoryDatabase,
  releaseWithManifest,
  workerDependencies,
} from "./agent-run.fixture.ts";
import { persistModelInvocationAtProviderBoundary } from "./model-invocations.ts";
import type { AgentRunWorkerDependencies } from "./types.ts";

const recoveryCases = [
  {
    name: "reclassifies after a successful private selection without orphaning the run",
    prior: [{ kind: "response-depth", status: "succeeded", fallbackAttempt: 0 }],
    action: "completed",
    newCalls: 2,
  },
  {
    name: "does not spend assistant fallback slots on an exhausted private selection",
    prior: [
      { kind: "response-depth", status: "failed", fallbackAttempt: 0 },
      { kind: "response-depth", status: "failed", fallbackAttempt: 1 },
    ],
    action: "completed",
    newCalls: 2,
  },
  {
    name: "recovers failed assistant progress alongside a successful private selection",
    prior: [
      { kind: "response-depth", status: "succeeded", fallbackAttempt: 0 },
      { kind: "assistant", status: "failed", fallbackAttempt: 0 },
    ],
    action: "completed",
    newCalls: 2,
  },
  {
    name: "still refuses to replay an orphaned assistant response after private selection",
    prior: [
      { kind: "response-depth", status: "succeeded", fallbackAttempt: 0 },
      { kind: "assistant", status: "succeeded", fallbackAttempt: 0 },
    ],
    action: "skipped",
    newCalls: 0,
  },
] as const;

describe("response depth retry accounting", () => {
  for (const scenario of recoveryCases) {
    it(scenario.name, async () => {
      const fixture = fixtures();
      const abandoned = abandonedRunWithLease(fixture);
      const release = releaseWithManifest(fixture.release, {
        ...fixture.release.data.manifest,
        spec: {
          ...fixture.release.data.manifest.spec,
          runtime: {
            modelInputTokenBudget: 8_192,
            modelOutputTokenReserve: 1_024,
            responseDepthPolicy: {
              classifierInstructions: "Select default or detailed.",
              detailedInstructions: "Develop the requested answer.",
              minimumWords: 1,
              maximumWords: 100,
            },
          },
        },
      });
      const memory = inMemoryDatabase([
        release,
        fixture.deployment,
        fixture.thread,
        fixture.userMessage,
        abandoned.run,
        abandoned.lease,
      ]);
      const base = workerDependencies(memory.database);
      for (const previous of scenario.prior) {
        const invocationId = `${abandoned.run.data.id}:execution:${abandoned.run.data.version}:${previous.kind}:0`;
        const attemptId = `${invocationId}:run-attempt:${abandoned.run.data.attempt}:fallback:${previous.fallbackAttempt}`;
        const usageEntry: RuntimeUsageEntry = {
          costUsdMicros: 5,
          idempotencyKey: `${attemptId}:usage`,
          inputTokens: 5,
          modelId: "openrouter/test",
          occurredAt: "2026-07-22T00:00:00.500Z",
          outputTokens: 2,
          provider: "openrouter",
          quantity: 7,
          runId: abandoned.run.data.id,
          source: "model-gateway",
          startedAt: "2026-07-22T00:00:00.250Z",
          payer: { kind: "operator" as const },
          type: "model_tokens",
          unit: "tokens",
        };
        const attempt: RuntimeModelInvocationAttempt = {
          actualModelId: "openrouter/test",
          agentDefinitionId: release.data.agentDefinitionId,
          ...customerRunPins(abandoned.run.data),
          agentManifestHash: release.data.contentHash,
          agentReleaseId: release.data.id,
          attemptId,
          captureMode: abandoned.run.data.captureMode,
          completedAt: "2026-07-22T00:00:00.500Z",
          costUsdMicros: 5,
          environmentId: abandoned.run.data.environmentId,
          ...(previous.status === "failed" ? { errorClass: "Error" } : {}),
          fallbackAttempt: previous.fallbackAttempt,
          internalEvaluator: false,
          invocationId,
          invocationKind: previous.kind,
          modelCallIndex: 0,
          organizationId: abandoned.run.data.organizationId,
          parentSpanId: abandoned.run.data.spanId,
          projectId: abandoned.run.data.projectId,
          requestedModelId: "openrouter/test",
          runAttempt: abandoned.run.data.attempt,
          runExecutionVersion: abandoned.run.data.version,
          runId: abandoned.run.data.id,
          spanId: "fedcba9876543210",
          startedAt: "2026-07-22T00:00:00.250Z",
          status: previous.status,
          streaming: false,
          threadId: abandoned.run.data.threadId,
          totalTokens: 7,
          traceId: abandoned.run.data.traceId,
          usageEntry,
          usageIdempotencyKey: usageEntry.idempotencyKey,
          ...(abandoned.run.data.workspaceId
            ? { workspaceId: abandoned.run.data.workspaceId }
            : {}),
        };
        await persistModelInvocationAtProviderBoundary(
          base.dependencies,
          fixture.queue,
          abandoned.run,
          abandoned.lease,
          attempt,
        );
      }
      let newCalls = 0;
      const dependencies: AgentRunWorkerDependencies = {
        ...base.dependencies,
        runningClaimTimeoutMs: 100,
        runtime: {
          generateAssistantMessage: async (request) => {
            newCalls += 1;
            return {
              assistantMessage: request.modelCallId.includes(":response-depth:")
                ? "default"
                : "Recovered assistant answer.",
              usage: [
                {
                  costUsdMicros: 2,
                  idempotencyKey: `${request.modelCallId}:usage`,
                  inputTokens: 2,
                  modelId: request.modelId,
                  occurredAt: "2026-07-22T00:00:02.000Z",
                  outputTokens: 1,
                  provider: "openrouter",
                  quantity: 3,
                  runId: request.runId,
                  source: "model-gateway",
                  startedAt: "2026-07-22T00:00:01.000Z",
                  payer: { kind: "operator" as const },
                  type: "model_tokens",
                  unit: "tokens",
                },
              ],
            };
          },
        },
      };

      expect(await processAgentRun(fixture.queue, dependencies)).toMatchObject({
        action: scenario.action,
        run: { data: { status: scenario.action === "completed" ? "completed" : "failed" } },
      });
      expect(newCalls).toBe(scenario.newCalls);
      const records = [...memory.records.values()];
      const modelUsage = records.filter(
        (record): record is Extract<PlatformRecord, { readonly itemType: "meter-event" }> =>
          record.itemType === "meter-event" && record.data.metric === "model_tokens",
      );
      expect(modelUsage.reduce((total, record) => total + record.data.quantity, 0)).toBe(
        scenario.prior.length * 7 + scenario.newCalls * 3,
      );
      expect(
        modelUsage.reduce(
          (total, record) => total + Number(record.data.dimensions?.costUsdMicros ?? 0),
          0,
        ),
      ).toBe(scenario.prior.length * 5 + scenario.newCalls * 2);
      expect(new Set(modelUsage.map((record) => record.data.idempotencyKey)).size).toBe(
        scenario.prior.length + scenario.newCalls,
      );
      expect(
        records
          .filter(
            (record): record is Extract<PlatformRecord, { readonly itemType: "message" }> =>
              record.itemType === "message" && record.data.role === "assistant",
          )
          .map((record) => record.data.body),
      ).toEqual(scenario.action === "completed" ? ["Recovered assistant answer."] : []);
    });
  }
});
