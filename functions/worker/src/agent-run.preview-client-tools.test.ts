import { describe, expect, it } from "bun:test";
import {
  dataBoundaryOf,
  ExecutionBindingRecord,
  tableForItemType,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import type { ToolAdapterDefinition } from "@deployments-ai/tools";
import { Schema } from "effect";
import { expireClientToolCall } from "./client-tool-expiration.ts";
import { processAgentRun, resolveRunToolResult } from "./index.ts";
import { createRuntimeToolService } from "./runtime-tool-authorization.ts";
import type { AgentRunQueueMessage, AgentRunWorkerDependencies } from "./types.ts";
import {
  id,
  inMemoryDatabase,
  manifestWithToolRequests,
  storeKey,
  workerDependencies,
} from "./agent-run.fixture.ts";
import { bindingId, boundFixture } from "./agent-run-bound.fixture.ts";

const outputSchema = {
  additionalProperties: false,
  properties: { temperature: { type: "number" } },
  required: ["temperature"],
  type: "object",
};
const clientTool = {
  defaultPolicyAction: "allow",
  description: "Reads the weather from the caller's device.",
  effect: "read",
  execution: { timeoutMs: 60_000, type: "client" },
  inputSchema: {
    properties: { city: { type: "string" } },
    required: ["city"],
    type: "object",
  },
  outputSchema,
  providerOutboundMutation: false,
  requiredScopes: [],
  status: "active",
  toolAdapterId: id(90),
  toolName: "weather.local",
} as const satisfies ToolAdapterDefinition;

/** A preview run whose agent calls the client-executed `weather.local` tool. */
function pausedPreviewHarness() {
  const base = boundFixture({ purpose: "preview", source: "manifest", toolPolicy: "interactive" });
  const fixture = boundFixture({
    manifest: manifestWithToolRequests(base.binding.data.manifest, [
      {
        effect: "read",
        idempotencyKey: "tool/weather-1",
        input: { city: "Oslo" },
        inputSummary: "Read the local weather.",
        requiredScopes: [],
        toolName: clientTool.toolName,
      },
    ]),
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
  const worker = workerDependencies(memory.database);
  const scheduled: unknown[] = [];
  const enqueued: AgentRunQueueMessage[] = [];
  const generations: unknown[] = [];
  const dependencies: AgentRunWorkerDependencies = {
    ...worker.dependencies,
    runtime: {
      ...createRuntimeToolService({
        dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
        egressAllowlists: { read: async () => [] },
        builtinExecutors: {},
        generateId: worker.dependencies.generateId,
        resolveAuthorizationContext: async () => {
          throw new Error("Client tools must not resolve provider authorization.");
        },
        resolveExtensionToolDefinition: async (toolName) =>
          toolName === clientTool.toolName ? clientTool : undefined,
        resolveProviderCredential: async () => {
          throw new Error("Client tools must not load provider credentials.");
        },
      }),
      generateAssistantMessage: async (request) => {
        generations.push(request);
        return { assistantMessage: "It is 21.5 degrees in Oslo." };
      },
      recordArtifact: async () => undefined,
    },
    scheduleClientToolExpiration: async (input) => void scheduled.push(input),
  };
  const resolution = (now: () => Date) => ({
    appendThreadEvent: worker.dependencies.appendThreadEvent!,
    database: memory.database,
    enqueueRun: async ({ message }: { readonly message: AgentRunQueueMessage }) =>
      void enqueued.push(message),
    generateId: worker.dependencies.generateId,
    now,
  });
  const clientToolCall = () =>
    [...memory.records.values()].find(
      (record): record is Extract<PlatformRecord, { readonly itemType: "tool-call" }> =>
        record.itemType === "tool-call" && record.data.toolName === clientTool.toolName,
    );
  return {
    clientToolCall,
    dependencies,
    enqueued,
    fixture,
    generations,
    memory,
    resolution,
    scheduled,
  };
}

describe("client tools in preview runs", () => {
  it("pauses a preview run on a client tool and resumes it with the structured output", async () => {
    const harness = pausedPreviewHarness();
    const { fixture } = harness;

    expect(processAgentRun(fixture.queue, harness.dependencies)).resolves.toMatchObject({
      action: "paused",
      status: "waiting-for-tool",
    });

    const paused = harness.clientToolCall();
    expect(paused?.data).toMatchObject({
      executionType: "client",
      input: { city: "Oslo" },
      outputSchema,
      status: "running",
    });
    const expiresAt = paused?.data.expiresAt;
    expect(expiresAt).toBeDefined();
    expect(harness.scheduled).toEqual([
      expect.objectContaining({
        expiresAt,
        runId: fixture.run.data.id,
        toolCallId: paused?.data.id,
      }),
    ]);
    expect(harness.generations).toHaveLength(0);

    const resolved = await resolveRunToolResult(
      {
        environmentId: fixture.run.data.environmentId,
        organizationId: fixture.run.data.organizationId,
        outcome: "completed",
        output: { temperature: 21.5 },
        outputSummary: "Local weather read.",
        projectId: fixture.run.data.projectId,
        runId: fixture.run.data.id,
        threadId: fixture.run.data.threadId,
        toolCallId: paused!.data.id,
      },
      harness.resolution(() => new Date("2026-07-22T00:00:30.000Z")),
    );
    expect(resolved.toolCall.data).toMatchObject({
      output: { temperature: 21.5 },
      status: "succeeded",
    });
    expect(resolved.run.data).toMatchObject({ executionBindingId: bindingId, status: "queued" });
    expect(harness.enqueued).toHaveLength(1);

    expect(processAgentRun(harness.enqueued[0]!, harness.dependencies)).resolves.toMatchObject({
      action: "completed",
    });
    expect(harness.generations).toHaveLength(1);
  });

  it("fails the preview run when its client tool expires after the binding expired", async () => {
    const harness = pausedPreviewHarness();
    const { fixture } = harness;
    await processAgentRun(fixture.queue, harness.dependencies);
    const paused = harness.clientToolCall()!;
    const deadline = Date.parse(paused.data.expiresAt!);
    const expiredBinding = Schema.decodeUnknownSync(ExecutionBindingRecord)(
      withCanonicalRecordKeys({
        data: { ...fixture.binding.data, expiresAt: new Date(deadline - 1_000).toISOString() },
        itemType: "execution-binding" as const,
        ttl: Math.floor((deadline - 1_000) / 1_000),
      }),
    );
    harness.memory.records.set(
      storeKey(tableForItemType(expiredBinding.itemType), expiredBinding.pk, expiredBinding.sk),
      expiredBinding,
    );
    const command = {
      environmentId: fixture.run.data.environmentId,
      organizationId: fixture.run.data.organizationId,
      projectId: fixture.run.data.projectId,
      runId: fixture.run.data.id,
      threadId: fixture.run.data.threadId,
      toolCallId: paused.data.id,
    };
    const afterDeadline = harness.resolution(() => new Date(deadline + 1_000));

    const outcome = await expireClientToolCall(command, afterDeadline);
    const redelivered = await expireClientToolCall(command, afterDeadline);

    expect(outcome.status).toBe("expired");
    if (outcome.status !== "expired") throw new Error("Expected expiry.");
    expect(outcome.result.toolCall.data.status).toBe("failed");
    expect(outcome.result.run.data).toMatchObject({
      error: { message: "Client tool did not return a result before it expired." },
      status: "failed",
    });
    expect(redelivered.status).toBe("expired");
    expect(harness.enqueued).toHaveLength(0);
  });
});
