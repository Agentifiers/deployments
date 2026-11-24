import { describe, expect, it } from "bun:test";
import type { AgentManifestV1 } from "@deployments-ai/agent-manifest";
import type { RuntimeModelGenerationRequest } from "@deployments-ai/agent-runtime";
import { dataBoundaryOf, type PlatformRecord } from "@deployments-ai/db";
import type { ToolAdapterDefinition } from "@deployments-ai/tools";
import { createRuntimeAgentDelegationBuiltinExecutors } from "./agent-delegation-runtime-tools.ts";
import {
  deploymentOwnedBuiltin,
  EVALUATION_CLIENT_TOOL_DENIAL_REASON,
} from "./execution-tool-policy.ts";
import { processAgentRun } from "./index.ts";
import type { RuntimeProviderMutationClaimStore } from "./provider-mutation-claims.ts";
import { createRuntimeToolService } from "./runtime-tool-authorization.ts";
import { createRuntimeScheduleBuiltinExecutors } from "./schedule-runtime-tools.ts";
import type { AgentRunWorkerDependencies } from "./types.ts";
import {
  id,
  inMemoryDatabase,
  manifestWithToolRequests,
  workerDependencies,
} from "./agent-run.fixture.ts";
import { bindingId, boundFixture } from "./agent-run-bound.fixture.ts";

type Purpose = "evaluation" | "preview";

const DEPLOYMENT_REQUIRED =
  "requires a deployed agent and is unavailable to preview and evaluation runs.";

const deploymentOwnedCalls = [
  {
    capability: "Agent delegation",
    input: { prompt: "Summarize the ticket.", targetAgentId: id(70) },
    toolName: "agent.delegate",
  },
  {
    capability: "Scheduling",
    input: { expression: "rate(1 day)", kind: "interval", name: "Daily", prompt: "Check in." },
    toolName: "agent.schedule.create",
  },
  {
    capability: "Scheduling",
    input: { delayMinutes: 30, name: "Follow up", prompt: "Follow up." },
    toolName: "agent.schedule.remind",
  },
  {
    capability: "Scheduling",
    input: { scheduledJobId: id(71) },
    toolName: "agent.schedule.archive",
  },
] as const;

function withModelTool(manifest: AgentManifestV1, toolName: string): AgentManifestV1 {
  return {
    ...manifest,
    spec: {
      ...manifest.spec,
      capabilities: {
        tools: [
          ...(manifest.spec.capabilities?.tools ?? []),
          { name: toolName, required: false, requiredScopes: [] },
        ],
      },
      runtime: { ...manifest.spec.runtime, modelTools: [toolName] },
    },
  };
}

function recordsOf<Type extends PlatformRecord["itemType"]>(
  records: Iterable<PlatformRecord>,
  itemType: Type,
) {
  return [...records].filter(
    (record): record is Extract<PlatformRecord, { readonly itemType: Type }> =>
      record.itemType === itemType,
  );
}

/** A bound run whose model calls one tool once, then answers from whatever result it received. */
function boundRunHarness(options: {
  readonly extensionTool?: ToolAdapterDefinition;
  readonly manifest: (base: AgentManifestV1) => AgentManifestV1;
  readonly modelToolCall?: { readonly input: Record<string, unknown>; readonly toolName: string };
  readonly purpose: Purpose;
}) {
  const toolPolicy = options.purpose === "evaluation" ? "evaluation" : "interactive";
  const base = boundFixture({ purpose: options.purpose, source: "manifest", toolPolicy });
  const fixture = boundFixture({
    manifest: options.manifest(base.binding.data.manifest),
    purpose: options.purpose,
    source: "manifest",
    toolPolicy,
  });
  const memory = inMemoryDatabase([
    fixture.binding,
    fixture.thread,
    fixture.userMessage,
    fixture.run,
  ]);
  const worker = workerDependencies(memory.database);
  const sideEffects: string[] = [];
  const mutationClaims: RuntimeProviderMutationClaimStore = {
    begin: async () => {
      sideEffects.push("mutation-claim");
      throw new Error("Bound-run denials must not begin a mutation claim.");
    },
    fail: async () => undefined,
    markUnknown: async () => undefined,
    release: async () => undefined,
    succeed: async () => undefined,
  };
  const generations: RuntimeModelGenerationRequest[] = [];
  const scheduledExpirations: unknown[] = [];
  const dependencies: AgentRunWorkerDependencies = {
    ...worker.dependencies,
    runtime: {
      ...createRuntimeToolService({
        dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
        egressAllowlists: { read: async () => [] },
        builtinExecutors: {
          ...createRuntimeAgentDelegationBuiltinExecutors({
            database: memory.database,
            enqueueRun: async () => void sideEffects.push("enqueue-run"),
            generateId: worker.dependencies.generateId,
          }),
          ...createRuntimeScheduleBuiltinExecutors({
            database: memory.database,
            generateId: worker.dependencies.generateId,
            timerProvider: {
              delete: async () => void sideEffects.push("timer-delete"),
              upsert: async () => void sideEffects.push("timer-upsert"),
            },
          }),
        },
        generateId: worker.dependencies.generateId,
        mutationClaims,
        resolveAuthorizationContext: async () => {
          throw new Error("Built-in and client tools must not resolve provider authorization.");
        },
        resolveExtensionToolDefinition: async (toolName) =>
          toolName === options.extensionTool?.toolName ? options.extensionTool : undefined,
        resolveProviderCredential: async () => {
          throw new Error("Built-in and client tools must not load provider credentials.");
        },
      }),
      generateAssistantMessage: async (request) => {
        generations.push(request);
        return options.modelToolCall && request.completedToolCalls.length === 0
          ? {
              assistantMessage: "",
              toolCalls: [{ ...options.modelToolCall, modelToolCallId: "model-call-1" }],
            }
          : { assistantMessage: "Continuing without that capability." };
      },
      recordArtifact: async () => undefined,
    },
    scheduleClientToolExpiration: async (input) => void scheduledExpirations.push(input),
  };
  return { dependencies, fixture, generations, memory, scheduledExpirations, sideEffects };
}

describe("deployment-owned tools in bound runs", () => {
  for (const purpose of ["preview", "evaluation"] as const) {
    it.each([...deploymentOwnedCalls])(
      `returns a model-visible failure for $toolName in a ${purpose} run, which then completes`,
      async ({ capability, input, toolName }) => {
        const harness = boundRunHarness({
          manifest: (manifest) => withModelTool(manifest, toolName),
          modelToolCall: { input, toolName },
          purpose,
        });
        const { fixture } = harness;

        const result = await processAgentRun(fixture.queue, harness.dependencies);

        expect(result).toMatchObject({
          action: "completed",
          run: { data: { executionBindingId: bindingId, status: "completed" } },
        });
        expect(harness.generations).toHaveLength(2);
        const denial = `Tool ${toolName} failed: ${capability} ${DEPLOYMENT_REQUIRED}`;
        expect(harness.generations[1]!.completedToolCalls).toEqual([
          expect.objectContaining({
            output: { denied: true, reason: `${capability} ${DEPLOYMENT_REQUIRED}` },
            outputSummary: denial,
            toolName,
          }),
        ]);
        const all = [...harness.memory.records.values()];
        expect(
          recordsOf(all, "tool-call").find((record) => record.data.toolName === toolName)?.data,
        ).toMatchObject({ outputSummary: denial });
        expect(recordsOf(all, "approval")).toHaveLength(0);
        expect(recordsOf(all, "schedule")).toHaveLength(0);
        expect(recordsOf(all, "run").map((record) => record.data.id)).toEqual([
          fixture.run.data.id,
        ]);
        expect(harness.sideEffects).toEqual([]);
      },
    );
  }
});

describe("client tools in evaluation runs", () => {
  for (const effect of ["read", "write"] as const) {
    it(`denies a ${effect}-effect client tool with the client-tool reason instead of pausing`, async () => {
      const clientTool = {
        defaultPolicyAction: "allow",
        description: "Reads the weather from the caller's device.",
        effect,
        execution: { timeoutMs: 60_000, type: "client" },
        inputSchema: {
          properties: { city: { type: "string" } },
          required: ["city"],
          type: "object",
        },
        providerOutboundMutation: false,
        requiredScopes: [],
        status: "active",
        toolAdapterId: id(90),
        toolName: "weather.local",
      } as const satisfies ToolAdapterDefinition;
      const harness = boundRunHarness({
        extensionTool: clientTool,
        manifest: (manifest) =>
          manifestWithToolRequests(manifest, [
            {
              effect,
              idempotencyKey: "tool/weather-1",
              input: { city: "Oslo" },
              inputSummary: "Read the local weather.",
              requiredScopes: [],
              toolName: clientTool.toolName,
            },
          ]),
        purpose: "evaluation",
      });

      const result = await processAgentRun(harness.fixture.queue, harness.dependencies);

      expect(result).toMatchObject({
        run: {
          data: {
            error: { message: expect.stringContaining(EVALUATION_CLIENT_TOOL_DENIAL_REASON) },
            status: "failed",
          },
        },
      });
      const all = [...harness.memory.records.values()];
      expect(
        recordsOf(all, "run").some((record) => record.data.status === "waiting-for-tool"),
      ).toBe(false);
      expect(recordsOf(all, "tool-call").some((record) => record.data.status === "running")).toBe(
        false,
      );
      expect(harness.scheduledExpirations).toEqual([]);
      expect(harness.generations).toHaveLength(0);
    });
  }
});

describe("deployment-owned executor preflight", () => {
  const pins = {
    customer: { agentDefinitionId: id(5), agentDeploymentId: id(4), agentReleaseId: id(6) },
    preview: { executionBindingId: bindingId, executionPurpose: "preview" as const },
  };
  for (const [run, expected] of [
    ["customer", { begins: 1, executions: 1, summary: "Reminder created." }],
    ["preview", { begins: 0, executions: 0, summary: "agent.schedule.remind failed" }],
  ] as const) {
    it(`${run} runs ${expected.executions ? "claim and execute" : "skip the claim and executor"}`, async () => {
      let begins = 0;
      let executions = 0;
      const service = createRuntimeToolService({
        dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
        egressAllowlists: { read: async () => [] },
        builtinExecutors: {
          "agent.schedule.remind": deploymentOwnedBuiltin(async () => {
            executions += 1;
            return { outputSummary: "Reminder created.", status: "completed" };
          }),
        },
        generateId: async () => id(80),
        mutationClaims: {
          begin: async (input) => {
            begins += 1;
            return { action: "execute", claim: { input, record: {} } as never };
          },
          fail: async () => undefined,
          markUnknown: async () => undefined,
          release: async () => undefined,
          succeed: async () => undefined,
        },
        resolveAuthorizationContext: async () => undefined,
        resolveProviderCredential: async () => {
          throw new Error("Built-ins must not load provider credentials.");
        },
      });
      const request = {
        ...pins[run],
        effect: "write" as const,
        environmentId: id(3),
        idempotencyKey: "remind-1",
        input: { delayMinutes: 5, name: "Nudge", prompt: "Nudge me." },
        inputSummary: "Remind later.",
        organizationId: id(1),
        projectId: id(2),
        requiredScopes: [],
        runId: id(7),
        threadId: id(8),
        toolName: "agent.schedule.remind",
      };
      const decision = await service.authorizeToolCall(request);
      if (decision.action !== "allow") throw new Error(`Expected allow, got ${decision.action}.`);

      const result = await service.executeToolCall({ ...request, decision });

      expect(result.outputSummary).toContain(expected.summary);
      expect({ begins, executions }).toEqual({
        begins: expected.begins,
        executions: expected.executions,
      });
    });
  }
});
