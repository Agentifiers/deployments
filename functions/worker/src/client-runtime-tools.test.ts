import { describe, expect, test } from "bun:test";
import { RuntimeToolExecutionKnownFailureError } from "@deployments-ai/agent-runtime";
import { dataBoundaryOf, type Ulid } from "@deployments-ai/db";
import type { ToolAdapterDefinition } from "@deployments-ai/tools";
import { createRuntimeToolService } from "./runtime-tool-authorization.ts";

const id = (suffix: string) => `01J000000000000000000000${suffix}` as Ulid;
const baseRequest = {
  agentDefinitionId: id("01"),
  agentDeploymentId: id("02"),
  agentReleaseId: id("03"),
  environmentId: id("04"),
  idempotencyKey: "client-tool",
  inputSummary: "Read the local weather.",
  organizationId: id("05"),
  projectId: id("06"),
  requiredScopes: [],
  runId: id("07"),
  threadId: id("08"),
};
const outputSchema = {
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
  toolAdapterId: id("10"),
  toolName: "weather.local",
} as const satisfies ToolAdapterDefinition;

function service() {
  let callbacks = 0;
  const runtime = createRuntimeToolService({
    dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
    egressAllowlists: { read: async () => [] },
    builtinExecutors: {},
    generateId: async () => id("09"),
    resolveAuthorizationContext: async () => {
      callbacks += 1;
      return undefined;
    },
    resolveExtensionToolDefinition: async (toolName) =>
      toolName === clientTool.toolName ? clientTool : undefined,
    resolveProviderCredential: async () => {
      throw new Error("Client tools must not load provider credentials.");
    },
  });
  return { callbacks: () => callbacks, runtime };
}

async function authorized(runtime: ReturnType<typeof service>["runtime"]) {
  const decision = await runtime.authorizeToolCall({
    ...baseRequest,
    effect: "read",
    toolName: clientTool.toolName,
  });
  if (decision.action !== "allow") throw new Error("Expected an allowed client tool.");
  return decision;
}

describe("client-executed extension tools", () => {
  test("authorize without a provider connection and pause with the tool call as correlation", async () => {
    const { callbacks, runtime } = service();
    const decision = await authorized(runtime);
    const before = Date.now();

    const result = await runtime.executeToolCall({
      ...baseRequest,
      decision,
      effect: "read",
      input: { city: "Oslo" },
      toolName: clientTool.toolName,
    });

    expect(callbacks()).toBe(0);
    expect(result).toMatchObject({
      client: { outputSchema },
      externalOperationId: decision.toolCallId,
      status: "running",
    });
    const expiresAt = Date.parse(result.client!.expiresAt);
    expect(expiresAt - before).toBeGreaterThanOrEqual(60_000);
    expect(expiresAt - before).toBeLessThan(70_000);
  });

  test("rejects input that does not match the declared input schema", async () => {
    const { runtime } = service();
    const decision = await authorized(runtime);
    expect(
      runtime.executeToolCall({
        ...baseRequest,
        decision,
        effect: "read",
        input: { town: "Oslo" },
        toolName: clientTool.toolName,
      }),
    ).rejects.toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
  });

  test("refuses to pause workflow executions that have no interactive caller", async () => {
    const { runtime } = service();
    const decision = await authorized(runtime);
    expect(
      runtime.executeToolCall({
        ...baseRequest,
        decision,
        effect: "read",
        executionKind: "workflow",
        input: { city: "Oslo" },
        toolName: clientTool.toolName,
      }),
    ).rejects.toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
  });
});
