import { describe, expect, it } from "bun:test";
import {
  makeModelPolicyPersistence,
  ExecutionBindingRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { processAgentRun } from "./index.ts";
import {
  EVALUATION_APPROVAL_REJECTION_REASON,
  EVALUATION_WRITE_DENIAL_REASON,
} from "./execution-tool-policy.ts";
import type { AgentRunWorkerDependencies } from "./types.ts";
import {
  fixtures,
  id,
  inMemoryDatabase,
  manifestWithToolRequests,
  workerDependencies,
} from "./agent-run.fixture.ts";
import { bindingId, boundFixture } from "./agent-run-bound.fixture.ts";

function recordsOf<Type extends PlatformRecord["itemType"]>(
  records: Iterable<PlatformRecord>,
  itemType: Type,
) {
  return [...records].filter(
    (record): record is Extract<PlatformRecord, { readonly itemType: Type }> =>
      record.itemType === itemType,
  );
}

describe("bound (preview/evaluation) agent runs", () => {
  for (const source of ["release", "manifest"] as const) {
    it(`executes a ${source}-sourced preview run pinned to its binding`, async () => {
      const fixture = boundFixture({ purpose: "preview", source, toolPolicy: "interactive" });
      // No deployment record is seeded: bound runs must not need one.
      const memory = inMemoryDatabase([
        fixture.binding,
        fixture.thread,
        fixture.userMessage,
        fixture.run,
      ]);
      const { dependencies } = workerDependencies(memory.database);
      const previewDependencies: AgentRunWorkerDependencies = {
        ...dependencies,
        runtime: {
          generateAssistantMessage: async (request) => ({
            assistantMessage: "Preview answer.",
            usage: [
              {
                idempotencyKey: `${request.runId}:preview-model`,
                inputTokens: 3,
                modelId: "openrouter/qwen/qwen3.7-plus",
                occurredAt: "2026-07-22T00:00:01.000Z",
                outputTokens: 2,
                provider: "openrouter",
                quantity: 5,
                source: "model-gateway",
                payer: { kind: "operator" as const },
                type: "model_tokens",
                unit: "tokens",
              },
            ],
          }),
        },
      };

      expect(processAgentRun(fixture.queue, previewDependencies)).resolves.toMatchObject({
        action: "completed",
      });

      const records = memory.records.values();
      const all = [...records];
      const run = recordsOf(all, "run").find((record) => record.data.id === fixture.run.data.id);
      expect(run?.data).toMatchObject({
        executionBindingId: bindingId,
        executionPurpose: "preview",
        status: "completed",
      });
      expect(run?.data.agentDeploymentId).toBeUndefined();

      const invocations = recordsOf(all, "model-invocation");
      expect(invocations).toHaveLength(1);
      expect(invocations[0]!.data).toMatchObject({
        agentManifestHash: fixture.binding.data.contentHash,
        executionBindingId: bindingId,
        executionPurpose: "preview",
        runId: fixture.run.data.id,
        status: "succeeded",
      });
      expect(invocations[0]!.data.agentDeploymentId).toBeUndefined();
      if (source === "release") {
        expect(invocations[0]!.data.agentReleaseId).toBe(fixture.release.data.id);
      } else {
        expect(invocations[0]!.data.agentReleaseId).toBeUndefined();
      }

      const meters = recordsOf(all, "meter-event").filter(
        (record) => record.data.runId === fixture.run.data.id,
      );
      expect(meters.length).toBeGreaterThan(0);
      const modelMeter = meters.find((record) => record.data.metric === "model_tokens");
      expect(modelMeter?.data).toMatchObject({
        dimensions: {
          executionBindingId: bindingId,
          modelId: "openrouter/qwen/qwen3.7-plus",
          purpose: "preview",
        },
        quantity: 5,
      });
      for (const meter of meters) {
        expect(meter.data.dimensions).toMatchObject({
          executionBindingId: bindingId,
          purpose: "preview",
        });
      }
      expect(
        recordsOf(all, "semantic-event")
          .filter((record) => record.data.aggregateId === fixture.run.data.id)
          .map((record) => record.data.eventType),
      ).toContain("run.completed");
    });
  }

  it("refuses to execute a run whose binding has logically expired", async () => {
    const fixture = boundFixture({
      purpose: "preview",
      source: "release",
      toolPolicy: "interactive",
    });
    const expiredBinding = Schema.decodeUnknownSync(ExecutionBindingRecord)(
      withCanonicalRecordKeys({
        data: { ...fixture.binding.data, expiresAt: "2026-07-22T00:00:00.500Z" },
        itemType: "execution-binding" as const,
        ttl: Math.floor(Date.parse("2026-07-22T00:00:00.500Z") / 1_000),
      }),
    );
    const memory = inMemoryDatabase([
      expiredBinding,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const { dependencies } = workerDependencies(memory.database);
    let modelCalls = 0;
    const result = await processAgentRun(fixture.queue, {
      ...dependencies,
      runtime: {
        generateAssistantMessage: async () => {
          modelCalls += 1;
          return { assistantMessage: "Should not run." };
        },
      },
    });

    expect(modelCalls).toBe(0);
    expect(result).toMatchObject({
      action: "skipped",
      run: {
        data: {
          error: { message: "Execution binding has expired and can no longer execute runs." },
          status: "failed",
        },
      },
    });
  });

  it("fails a preview run whose model the environment policy denied after binding creation", async () => {
    const fixture = boundFixture({
      purpose: "preview",
      source: "manifest",
      toolPolicy: "interactive",
    });
    const memory = inMemoryDatabase([
      fixture.binding,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    await makeModelPolicyPersistence(memory.database).create(
      {
        environmentId: fixture.run.data.environmentId,
        organizationId: fixture.run.data.organizationId,
        projectId: fixture.run.data.projectId,
      },
      { includeCuratedModels: false, models: ["openai/o3"], name: "Other model only" },
      { principalId: id(41) },
    );
    const { dependencies } = workerDependencies(memory.database);
    let modelCalls = 0;
    const result = await processAgentRun(fixture.queue, {
      ...dependencies,
      runtime: {
        generateAssistantMessage: async () => {
          modelCalls += 1;
          return { assistantMessage: "Should not run." };
        },
      },
    });

    expect(modelCalls).toBe(0);
    expect(result).toMatchObject({
      action: "skipped",
      run: {
        data: {
          error: {
            message: expect.stringContaining(
              `${fixture.binding.data.manifest.spec.model.id} is not admitted in this environment (model_not_allowed_by_environment_policy)`,
            ),
          },
          executionBindingId: bindingId,
          status: "failed",
        },
      },
    });
  });

  it.each([
    {
      authorized: ["records.read", "records.read-gated"],
      denied: { effect: "read", toolName: "records.read-gated" },
      reason: EVALUATION_APPROVAL_REJECTION_REASON,
    },
    {
      authorized: ["records.read", "records.write"],
      denied: { effect: "write", toolName: "records.write" },
      reason: EVALUATION_WRITE_DENIAL_REASON,
    },
  ] as const)(
    "evaluation bindings deny $denied.toolName after an allowed read",
    async (scenario) => {
      const base = fixtures();
      const manifest = manifestWithToolRequests(base.release.data.manifest, [
        {
          effect: "read",
          idempotencyKey: "tool/read-open",
          input: {},
          inputSummary: "Read open data.",
          requiredScopes: [],
          toolName: "records.read",
        },
        {
          effect: scenario.denied.effect,
          idempotencyKey: "tool/denied",
          input: {},
          inputSummary: "Denied call.",
          requiredScopes: [],
          toolName: scenario.denied.toolName,
        },
      ]);
      const fixture = boundFixture({
        manifest,
        purpose: "evaluation",
        source: "manifest",
        toolPolicy: "evaluation",
      });
      const memory = inMemoryDatabase([
        fixture.binding,
        fixture.thread,
        fixture.userMessage,
        fixture.run,
      ]);
      const { dependencies } = workerDependencies(memory.database);
      const authorized: string[] = [];
      const executed: string[] = [];
      let nextToolCallId = 300;
      const evaluationDependencies: AgentRunWorkerDependencies = {
        ...dependencies,
        runtime: {
          authorizeToolCall: async (request) => {
            authorized.push(request.toolName);
            return request.toolName === "records.read"
              ? { action: "allow", reason: "Open read.", toolCallId: id(nextToolCallId++) }
              : {
                  action: "require-approval",
                  approvalId: id(nextToolCallId++),
                  reason: "Needs a reviewer.",
                  toolCallId: id(nextToolCallId++),
                };
          },
          executeToolCall: async (request) => {
            executed.push(request.toolName);
            return { outputSummary: "Read done.", status: "completed" };
          },
          generateAssistantMessage: async () => ({ assistantMessage: "Evaluation answer." }),
          recordArtifact: async () => undefined,
          resolveToolDefinition: async (toolName) => ({
            effect: toolName === "records.write" ? "write" : "read",
            inputSchema: { additionalProperties: true, type: "object" },
            requiredScopes: [],
            toolName,
          }),
        },
      };

      const result = await processAgentRun(fixture.queue, evaluationDependencies);

      expect(result).toMatchObject({
        run: {
          data: { error: { message: expect.stringContaining(scenario.reason) }, status: "failed" },
        },
      });
      expect(authorized).toEqual([...scenario.authorized]);
      expect(executed).toEqual(["records.read"]);
      const all = [...memory.records.values()];
      expect(recordsOf(all, "approval")).toHaveLength(0);
      expect(
        recordsOf(all, "tool-call").find((record) => record.data.toolName === "records.read")?.data
          .status,
      ).toBe("succeeded");
    },
  );
});
