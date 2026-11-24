import { describe, expect, it } from "bun:test";
import { modelGatewayGenerationPort } from "@deployments-ai/agent-runtime";
import type { PlatformRecord } from "@deployments-ai/db";
import {
  makeModelGateway,
  type ModelGatewayService,
  type OpenAiCompatibleChatCompletionMessage,
  type ReasoningDetail,
} from "@deployments-ai/model-gateway";
import { processAgentRun, resolveRunApproval } from "./index.ts";
import {
  fixtures,
  id,
  inMemoryDatabase,
  manifestWithRuntime,
  releaseWithManifest,
  workerDependencies,
} from "./agent-run.fixture.ts";
import type { AgentReleaseRecordValue, AgentRunWorkerDependencies } from "./types.ts";
import { createWorkerDrain } from "./worker-drain.ts";

const OPUS = "openrouter/anthropic/claude-opus-5.5";

interface ChatBody {
  readonly messages: readonly OpenAiCompatibleChatCompletionMessage[];
}

const thinking = (generation: number) =>
  ({
    format: "anthropic-claude-v1",
    index: 0,
    signature: `c2lnbmF0dXJl${generation}`,
    text: `Plan generation ${generation}.`,
    type: "reasoning.text",
  }) satisfies ReasoningDetail;

function scriptedOpus(toolGenerations: number) {
  const bodies: ChatBody[] = [];
  const gateway = makeModelGateway({
    baseUrl: "https://gateway.invalid",
    credentials: async () => "test-token",
  });
  const usage = { completion_tokens: 10, prompt_tokens: 100, total_tokens: 110 };
  const respond = (body: ChatBody) => {
    const generation = body.messages.filter((message) => message.role === "tool").length;
    const message =
      generation < toolGenerations
        ? {
            content: "",
            reasoning_details: [thinking(generation)],
            role: "assistant",
            tool_calls: [
              {
                function: { arguments: '{"resource":"notes"}', name: "runtime_tool_0" },
                id: `toolu_0${generation}`,
                type: "function",
              },
            ],
          }
        : { content: "Notes published.", role: "assistant" };
    return Response.json({
      choices: [{ finish_reason: message.tool_calls ? "tool_calls" : "stop", message }],
      id: `response-${generation}`,
      model: "anthropic/claude-opus-5.5",
      usage,
    });
  };
  const service: ModelGatewayService = {
    ...gateway,
    chatCompletion: (request) =>
      gateway.chatCompletion({
        ...request,
        fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
          if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
          const body = JSON.parse(init.body) as ChatBody;
          bodies.push(body);
          return respond(body);
        }) as typeof fetch,
      }),
  };
  return { bodies, generateAssistantMessage: modelGatewayGenerationPort(service) };
}

function replayedReasoning(bodies: readonly ChatBody[]) {
  return bodies.map((body) =>
    body.messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.reasoning_details),
  );
}

function opusRelease(release: AgentReleaseRecordValue) {
  const { manifest } = release.data;
  return releaseWithManifest(
    release,
    manifestWithRuntime(
      {
        ...manifest,
        spec: {
          ...manifest.spec,
          capabilities: {
            tools: [
              { authorization: "none", name: "notes.write", required: false, requiredScopes: [] },
            ],
          },
          model: { ...manifest.spec.model, fallbackIds: [], id: OPUS },
        },
      },
      {
        modelInputTokenBudget: 100_000,
        modelOutputTokenReserve: 1_024,
        modelTools: ["notes.write"],
      },
    ),
  );
}

function storedReasoning(records: Iterable<PlatformRecord>) {
  return [...records]
    .filter(
      (record): record is Extract<PlatformRecord, { readonly itemType: "generation-reasoning" }> =>
        record.itemType === "generation-reasoning",
    )
    .map((record) => [record.data.modelCallIndex, record.data.reasoningDetails] as const)
    .toSorted(([left], [right]) => left - right);
}

const notesTool = {
  executeToolCall: async () => ({ outputSummary: "Notes written.", status: "completed" as const }),
  recordArtifact: async () => undefined,
  resolveToolDefinition: async (toolName: string) => ({
    description: "Write notes.",
    effect: "write" as const,
    inputSchema: {
      additionalProperties: false,
      properties: { resource: { type: "string" } },
      type: "object",
    },
    requiredScopes: [],
    toolName,
  }),
};

describe("reasoning replay across executions", () => {
  it("replays generation 0's reasoning after an approval pause resumes the run", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      opusRelease(fixture.release),
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const base = workerDependencies(memory.database);
    const opus = scriptedOpus(1);
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: {
        ...notesTool,
        authorizeToolCall: async () => ({
          action: "require-approval",
          approvalId: id(72),
          reason: "Writing notes needs approval.",
          toolCallId: id(71),
        }),
        generateAssistantMessage: opus.generateAssistantMessage,
      },
    };

    const paused = await processAgentRun(fixture.queue, dependencies);

    expect(paused).toMatchObject({ action: "paused", status: "waiting-for-approval" });
    expect(storedReasoning(memory.records.values())).toEqual([[0, [thinking(0)]]]);
    const resolved = await resolveRunApproval(
      {
        approvalId: id(72),
        decision: "approved",
        environmentId: fixture.queue.environmentId,
        organizationId: fixture.queue.organizationId,
        projectId: fixture.queue.projectId,
        resolvedByPrincipalId: id(73),
        runId: fixture.queue.runId,
        threadId: fixture.queue.threadId,
      },
      {
        appendThreadEvent: base.dependencies.appendThreadEvent!,
        database: memory.database,
        enqueueRun: async () => undefined,
        generateId: base.dependencies.generateId,
        now: base.dependencies.now!,
      },
    );
    if (!resolved.queueMessage) throw new Error("The approved run was not requeued.");

    const completed = await processAgentRun(resolved.queueMessage, dependencies);

    expect(completed.action).toBe("completed");
    expect(replayedReasoning(opus.bodies)).toEqual([[], [[thinking(0)]]]);
  });

  it("replays earlier generations' reasoning after a host-drain checkpoint", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      opusRelease(fixture.release),
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const base = workerDependencies(memory.database);
    const opus = scriptedOpus(3);
    const drain = createWorkerDrain({
      now: () => base.dependencies.now!().getTime(),
      schedule: () => () => undefined,
      timeoutMs: 100_000,
    });
    let executions = 0;
    let authorizations = 0;
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      hostDrain: drain,
      runtime: {
        ...notesTool,
        authorizeToolCall: async () => ({
          action: "allow",
          reason: "Writing notes is allowed.",
          toolCallId: id(300 + authorizations++),
        }),
        executeToolCall: async () => {
          if (++executions === 2) drain.start();
          return { outputSummary: "Notes written.", status: "completed" };
        },
        generateAssistantMessage: opus.generateAssistantMessage,
      },
    };
    const { hostDrain: _drain, ...replacement } = dependencies;

    const checkpointed = await processAgentRun(fixture.queue, dependencies);

    expect(checkpointed).toMatchObject({ action: "requeued" });
    expect(storedReasoning(memory.records.values())).toEqual([
      [0, [thinking(0)]],
      [1, [thinking(1)]],
    ]);

    const completed = await processAgentRun(fixture.queue, replacement);

    expect(completed.action).toBe("completed");
    expect(replayedReasoning(opus.bodies)).toEqual([
      [],
      [[thinking(0)]],
      [[thinking(0)], [thinking(1)]],
      [[thinking(0)], [thinking(1)], [thinking(2)]],
    ]);
    expect(storedReasoning(memory.records.values())).toEqual([
      [0, [thinking(0)]],
      [1, [thinking(1)]],
    ]);
  });
});
