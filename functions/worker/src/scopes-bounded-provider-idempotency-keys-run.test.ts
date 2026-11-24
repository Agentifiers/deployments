import { describe, expect, test } from "bun:test";

import type {
  RuntimeToolAllowedDecision,
  RuntimeToolDecision,
  RuntimeToolRequest,
} from "@deployments-ai/agent-runtime";
import { RuntimeToolExecutionKnownFailureError } from "@deployments-ai/agent-runtime";
import { dataBoundaryOf, type Ulid } from "@deployments-ai/db";
import type { ToolAdapterDefinition } from "@deployments-ai/tools";
import type {
  RuntimeProviderMutationClaim,
  RuntimeProviderMutationClaimStore,
} from "./provider-mutation-claims.ts";

import {
  createRuntimeToolDependencies,
  DEFAULT_RUNTIME_PROVIDER_ARTIFACT_MAX_CHARACTERS,
  providerMutationRequestIdempotencyKey,
  type RuntimeToolBindingRequest,
} from "./runtime-tools.ts";

const ids = {
  agentDefinitionId: "01J00000000000000000000001" as Ulid,
  agentDeploymentId: "01J00000000000000000000002" as Ulid,
  agentReleaseId: "01J00000000000000000000003" as Ulid,
  environmentId: "01J00000000000000000000004" as Ulid,
  organizationId: "01J00000000000000000000005" as Ulid,
  projectId: "01J00000000000000000000006" as Ulid,
  runId: "01J00000000000000000000007" as Ulid,
  threadId: "01J00000000000000000000008" as Ulid,
};

const EXECUTION_BINDING = {
  authorizationFingerprint: "sha256:shopify-account-1:resources-v1",
  connectionId: "01J00000000000000000000019" as Ulid,
  externalAccountId: "shopify-account-1",
  toolPlanFingerprint: "test-tool-plan",
} as const;

/** Tenant extension MCP adapter, as synced into a workspace tool-adapter record. */
const MCP_DEFINITION: ToolAdapterDefinition = {
  auditMetadata: { mcpToolName: "list-dataflows" },
  defaultPolicyAction: "allow",
  description: "List analytics dataflows.",
  effect: "read",
  execution: {
    mcpServerId: "01J00000000000000000000028",
    remoteToolName: "list-dataflows",
    type: "mcp",
  },
  inputSchema: { additionalProperties: false, properties: {}, type: "object" },
  provider: "mcp",
  requiredScopes: ["dataflows:read"],
  status: "active",
  toolName: "analytics.dataflows.list",
};

async function resolveExtensionToolDefinition(toolName: string) {
  return toolName === MCP_DEFINITION.toolName ? MCP_DEFINITION : undefined;
}

function request(toolRequest: RuntimeToolRequest): RuntimeToolBindingRequest {
  return { ...ids, ...toolRequest };
}

function generatedIds(...values: Ulid[]) {
  const remaining = [...values];
  return async () => {
    const value = remaining.shift();
    if (!value) throw new Error("Test exhausted generated IDs.");
    return value;
  };
}

function allowedDecision(decision: RuntimeToolDecision): RuntimeToolAllowedDecision {
  if (decision.action !== "allow") throw new Error("Expected tool authorization to allow.");
  return decision;
}

const passthroughMutationClaims: RuntimeProviderMutationClaimStore = {
  begin: async () => ({ action: "execute", claim: {} as RuntimeProviderMutationClaim }),
  fail: async () => undefined,
  markUnknown: async () => undefined,
  release: async () => undefined,
  succeed: async () => undefined,
};

describe("worker runtime tool binding", () => {
  test("scopes bounded provider idempotency keys to the run", () => {
    const first = providerMutationRequestIdempotencyKey(ids.runId, "logical-tool-key");
    expect(first).toBe(providerMutationRequestIdempotencyKey(ids.runId, "logical-tool-key"));
    expect(first).not.toBe(
      providerMutationRequestIdempotencyKey(
        "01J00000000000000000000009" as Ulid,
        "logical-tool-key",
      ),
    );
    expect(first).toHaveLength(50);
    expect(DEFAULT_RUNTIME_PROVIDER_ARTIFACT_MAX_CHARACTERS).toBe(48_000);
  });

  test("resolves runtime definitions from the canonical tool catalog", async () => {
    const dependencies = createRuntimeToolDependencies({
      dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
      egressAllowlists: { read: async () => [] },
      generateId: generatedIds("01J00000000000000000000009" as Ulid),
      resolveAuthorizationContext: async () => undefined,
      resolveProviderCredential: async () => {
        throw new Error("not used");
      },
    });

    expect(dependencies.resolveToolDefinition("shopify.products.search")).resolves.toMatchObject({
      description: expect.any(String),
      effect: "read",
      requiredScopes: ["read_products"],
      toolName: "shopify.products.search",
    });
    expect(dependencies.resolveToolDefinition("missing.tool")).resolves.toBeUndefined();
  });

  test("resolves tenant extension MCP definitions only within a run context", async () => {
    const dependencies = createRuntimeToolDependencies({
      dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
      egressAllowlists: { read: async () => [] },
      generateId: generatedIds("01J00000000000000000000009" as Ulid),
      resolveAuthorizationContext: async () => undefined,
      resolveExtensionToolDefinition,
      resolveProviderCredential: async () => {
        throw new Error("not used");
      },
    });

    expect(dependencies.resolveToolDefinition(MCP_DEFINITION.toolName, ids)).resolves.toMatchObject(
      {
        description: expect.any(String),
        effect: "read",
        inputSchema: { additionalProperties: false, type: "object" },
        requiredScopes: ["dataflows:read"],
        toolName: MCP_DEFINITION.toolName,
      },
    );
    expect(dependencies.resolveToolDefinition(MCP_DEFINITION.toolName)).resolves.toBeUndefined();
    expect(dependencies.resolveToolDefinition("missing.tool")).resolves.toBeUndefined();
  });

  test("authorizes and executes registered memory reads without provider or MCP resolution", async () => {
    const toolCallId = "01J00000000000000000000020" as Ulid;
    let authorizationReads = 0;
    let executions = 0;
    const dependencies = createRuntimeToolDependencies({
      dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
      egressAllowlists: { read: async () => [] },
      builtinExecutors: {
        "agent.memory.search": async (runtimeRequest) => {
          executions += 1;
          expect(runtimeRequest.input).toEqual({ query: "change window" });
          return { outputSummary: "Tuesday at 10:00", status: "completed" };
        },
      },
      generateId: generatedIds(toolCallId),
      resolveAuthorizationContext: async () => {
        authorizationReads += 1;
        throw new Error("provider authorization should not be used");
      },
      resolveMcpAuthorizationContext: async () => {
        authorizationReads += 1;
        throw new Error("MCP authorization should not be used");
      },
      resolveProviderCredential: async () => {
        throw new Error("provider credential should not be used");
      },
    });
    const toolRequest = request({
      effect: "read",
      idempotencyKey: "memory-search-1",
      input: { query: "change window" },
      inputSummary: "Search memory",
      requiredScopes: [],
      toolName: "agent.memory.search",
    });
    const decision = await dependencies.authorizeToolCall(toolRequest);
    const allowed = allowedDecision(decision);

    expect(allowed).toMatchObject({
      action: "allow",
      reason: "Tool adapter agent.memory.search defaults to allow.",
      toolCallId,
    });
    expect(allowed.executionBinding?.toolPlanFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    const execution = await dependencies.executeToolCall({ ...toolRequest, decision: allowed });
    expect(execution).toEqual({
      outputSummary: "Tuesday at 10:00",
      status: "completed",
    });
    expect(authorizationReads).toBe(0);
    expect(executions).toBe(1);
  });

  test("keeps memory writes approval-gated and executes them after approval", async () => {
    const toolCallId = "01J00000000000000000000021" as Ulid;
    const approvalId = "01J00000000000000000000022" as Ulid;
    let executions = 0;
    const dependencies = createRuntimeToolDependencies({
      dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
      egressAllowlists: { read: async () => [] },
      builtinExecutors: {
        "agent.memory.save": async () => {
          executions += 1;
          return { outputSummary: "Saved memory", status: "completed" };
        },
      },
      generateId: generatedIds(toolCallId, approvalId),
      mutationClaims: passthroughMutationClaims,
      resolveAuthorizationContext: async () => {
        throw new Error("provider authorization should not be used");
      },
      resolveProviderCredential: async () => {
        throw new Error("provider credential should not be used");
      },
    });
    const toolRequest = request({
      effect: "write",
      idempotencyKey: "memory-save-1",
      input: { content: "Use the Tuesday change window." },
      inputSummary: "Save memory",
      requiredScopes: [],
      toolName: "agent.memory.save",
    });
    const decision = await dependencies.authorizeToolCall(toolRequest);

    expect(decision).toMatchObject({
      action: "require-approval",
      approvalId,
      reason: "Tool adapter agent.memory.save defaults to require_approval.",
      toolCallId,
    });
    expect(decision.executionBinding?.toolPlanFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    const executionBinding = decision.executionBinding;
    if (!executionBinding) throw new Error("Expected a pinned built-in execution binding.");
    expect(executions).toBe(0);
    expect(
      dependencies.executeToolCall({
        ...toolRequest,
        decision: {
          action: "allow",
          executionBinding: {
            ...executionBinding,
            toolPlanFingerprint: "stale-tool-plan",
          },
          reason: decision.reason,
          toolCallId,
        },
      }),
    ).rejects.toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
    expect(executions).toBe(0);
    const execution = await dependencies.executeToolCall({
      ...toolRequest,
      decision: {
        action: "allow",
        executionBinding,
        reason: decision.reason,
        toolCallId,
      },
    });
    expect(execution).toMatchObject({ outputSummary: "Saved memory", status: "completed" });
    expect(executions).toBe(1);
  });

  test("denies unregistered built-ins and classifies built-in input failures", async () => {
    const unregisteredId = "01J00000000000000000000023" as Ulid;
    const failingId = "01J00000000000000000000024" as Ulid;
    const dependencies = createRuntimeToolDependencies({
      dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
      egressAllowlists: { read: async () => [] },
      builtinExecutors: {
        "agent.memory.search": async () => {
          throw new TypeError("Memory tool input requires query.");
        },
      },
      generateId: generatedIds(unregisteredId, failingId),
      resolveAuthorizationContext: async () => undefined,
      resolveProviderCredential: async () => {
        throw new Error("not used");
      },
    });
    expect(
      dependencies.authorizeToolCall(
        request({
          effect: "read",
          idempotencyKey: "browser-read-1",
          inputSummary: "Capture DOM",
          requiredScopes: [],
          toolName: "browser.dom_snapshot.capture",
        }),
      ),
    ).resolves.toMatchObject({
      action: "deny",
      reason: "Runtime tool browser.dom_snapshot.capture has no worker execution binding.",
      toolCallId: unregisteredId,
    });
    const memoryRequest = request({
      effect: "read",
      idempotencyKey: "memory-search-invalid",
      input: {},
      inputSummary: "Search memory",
      requiredScopes: [],
      toolName: "agent.memory.search",
    });
    const decision = allowedDecision(await dependencies.authorizeToolCall(memoryRequest));
    expect(dependencies.executeToolCall({ ...memoryRequest, decision })).rejects.toMatchObject({
      executionCause: expect.objectContaining({
        message: "Memory tool input requires query.",
      }),
      name: "RuntimeToolExecutionKnownFailureError",
    });
  });

  test("retries failed built-in reads without hiding ambiguous write outcomes", async () => {
    const readFailure = new Error("Memory search is temporarily unavailable.");
    const writeFailure = new Error("Memory save outcome is unknown.");
    const dependencies = createRuntimeToolDependencies({
      dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
      egressAllowlists: { read: async () => [] },
      builtinExecutors: {
        "agent.memory.save": async () => {
          throw writeFailure;
        },
        "agent.memory.search": async () => {
          throw readFailure;
        },
      },
      generateId: generatedIds(
        "01J00000000000000000000025" as Ulid,
        "01J00000000000000000000026" as Ulid,
        "01J00000000000000000000027" as Ulid,
      ),
      mutationClaims: passthroughMutationClaims,
      resolveAuthorizationContext: async () => undefined,
      resolveProviderCredential: async () => {
        throw new Error("not used");
      },
    });
    const readRequest = request({
      effect: "read",
      idempotencyKey: "memory-search-retry",
      input: { query: "change window" },
      inputSummary: "Search memory",
      requiredScopes: [],
      toolName: "agent.memory.search",
    });
    const readDecision = allowedDecision(await dependencies.authorizeToolCall(readRequest));
    expect(
      dependencies.executeToolCall({ ...readRequest, decision: readDecision }),
    ).rejects.toMatchObject({
      name: "RuntimeToolPreparationRetryableError",
      preparationCause: readFailure,
    });

    const writeRequest = request({
      effect: "write",
      idempotencyKey: "memory-save-unknown",
      input: { content: "Use the Tuesday change window." },
      inputSummary: "Save memory",
      requiredScopes: [],
      toolName: "agent.memory.save",
    });
    const writeDecision = await dependencies.authorizeToolCall(writeRequest);
    if (writeDecision.action !== "require-approval") {
      throw new Error("Expected memory save to require approval.");
    }
    const writeExecutionBinding = writeDecision.executionBinding;
    if (!writeExecutionBinding) throw new Error("Expected a pinned built-in execution binding.");
    expect(
      dependencies.executeToolCall({
        ...writeRequest,
        decision: {
          action: "allow",
          executionBinding: writeExecutionBinding,
          reason: writeDecision.reason,
          toolCallId: writeDecision.toolCallId,
        },
      }),
    ).rejects.toBe(writeFailure);
  });

  test("authorizes and dispatches MCP-backed tools through the remote execution binding", async () => {
    const toolCallId = "01J00000000000000000000009" as Ulid;
    let executedTool: string | undefined;
    const dependencies = createRuntimeToolDependencies({
      dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
      egressAllowlists: { read: async () => [] },
      executeMcpTool: async (_request, _definition, mcpToolName) => {
        executedTool = mcpToolName;
        return { outputSummary: "Two dataflows", status: "completed" };
      },
      generateId: generatedIds(toolCallId),
      resolveAuthorizationContext: async () => {
        throw new Error("provider resolver should not be used");
      },
      resolveExtensionToolDefinition,
      resolveMcpAuthorizationContext: async () => ({
        ...EXECUTION_BINDING,
        connectorProvider: "mcp",
        grantedScopes: ["dataflows:read"],
      }),
      resolveProviderCredential: async () => {
        throw new Error("provider credential should not be used");
      },
    });
    const toolRequest = request({
      effect: "read",
      idempotencyKey: "mcp-list-1",
      inputSummary: "List analytics dataflows",
      requiredScopes: ["dataflows:read"],
      toolName: MCP_DEFINITION.toolName,
    });
    const decision = await dependencies.authorizeToolCall(toolRequest);
    const allowed = allowedDecision(decision);

    expect(allowed).toMatchObject({
      action: "allow",
      executionBinding: {
        authorizationFingerprint: EXECUTION_BINDING.authorizationFingerprint,
        connectionId: EXECUTION_BINDING.connectionId,
        externalAccountId: EXECUTION_BINDING.externalAccountId,
      },
      reason: `Tool adapter ${MCP_DEFINITION.toolName} defaults to allow.`,
      toolCallId,
    });
    expect(allowed.executionBinding?.toolPlanFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    const execution = await dependencies.executeToolCall({ ...toolRequest, decision: allowed });
    expect(execution).toMatchObject({ outputSummary: "Two dataflows", status: "completed" });
    expect(executedTool).toBe("list-dataflows");
  });

  test("rejects stale plans while preserving legacy MCP continuation validation", async () => {
    const toolCallId = "01J00000000000000000000009" as Ulid;
    const dependencies = createRuntimeToolDependencies({
      dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
      egressAllowlists: { read: async () => [] },
      executeMcpTool: async () => ({ status: "completed" }),
      generateId: generatedIds(toolCallId),
      resolveAuthorizationContext: async () => undefined,
      resolveExtensionToolDefinition,
      resolveMcpAuthorizationContext: async () => ({
        ...EXECUTION_BINDING,
        connectorProvider: "mcp",
        grantedScopes: ["dataflows:read"],
      }),
      resolveProviderCredential: async () => {
        throw new Error("not used");
      },
    });
    const authorizedRequest = request({
      effect: "read",
      idempotencyKey: "mcp-list-2",
      inputSummary: "List analytics dataflows",
      requiredScopes: ["dataflows:read"],
      toolName: MCP_DEFINITION.toolName,
    });
    const decision = await dependencies.authorizeToolCall(authorizedRequest);
    const allowed = allowedDecision(decision);
    const legacyBinding = {
      authorizationFingerprint: allowed.executionBinding!.authorizationFingerprint,
      connectionId: allowed.executionBinding!.connectionId,
      externalAccountId: allowed.executionBinding!.externalAccountId,
    };

    expect(
      dependencies.executeToolCall({
        ...authorizedRequest,
        decision: { ...allowed, executionBinding: legacyBinding },
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(
      dependencies.executeToolCall({
        ...authorizedRequest,
        decision: { ...allowed, executionBinding: legacyBinding },
        requiredScopes: [],
      }),
    ).rejects.toMatchObject({
      executionCause: expect.objectContaining({
        message: expect.stringContaining("legacy plan changed"),
      }),
    });

    expect(
      dependencies.executeToolCall({
        ...authorizedRequest,
        decision: {
          ...allowed,
          executionBinding: {
            ...allowed.executionBinding!,
            toolPlanFingerprint: "stale-tool-plan",
          },
        },
      }),
    ).rejects.toMatchObject({
      executionCause: expect.objectContaining({ message: expect.stringContaining("plan changed") }),
    });
  });

  test("honors catalog approval defaults without loading provider credentials", async () => {
    let credentialReads = 0;
    const toolCallId = "01J00000000000000000000010" as Ulid;
    const approvalId = "01J00000000000000000000011" as Ulid;
    const dependencies = createRuntimeToolDependencies({
      dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
      egressAllowlists: { read: async () => [] },
      generateId: generatedIds(toolCallId, approvalId),
      resolveAuthorizationContext: async () => ({
        ...EXECUTION_BINDING,
        connectorProvider: "sendgrid",
        grantedScopes: [],
      }),
      resolveProviderCredential: async () => {
        credentialReads += 1;
        throw new Error("credential should not be loaded during authorization");
      },
    });

    const approvalDecision = await dependencies.authorizeToolCall(
      request({
        effect: "write",
        idempotencyKey: "sendgrid-email-1",
        input: { body: { from: { email: "sender@example.com" }, subject: "Interview complete" } },
        inputSummary: "Send an email",
        requiredScopes: [],
        toolName: "sendgrid.email.send",
      }),
    );
    expect(approvalDecision).toMatchObject({
      action: "require-approval",
      approvalId,
      executionBinding: {
        authorizationFingerprint: EXECUTION_BINDING.authorizationFingerprint,
        connectionId: EXECUTION_BINDING.connectionId,
        externalAccountId: EXECUTION_BINDING.externalAccountId,
      },
      reason: "Tool adapter sendgrid.email.send defaults to require_approval.",
      toolCallId,
    });
    expect(approvalDecision.executionBinding?.toolPlanFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(credentialReads).toBe(0);
  });

  test("allows explicit policy rules to override a catalog default", async () => {
    const toolCallId = "01J00000000000000000000012" as Ulid;
    const dependencies = createRuntimeToolDependencies({
      dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
      egressAllowlists: { read: async () => [] },
      generateId: generatedIds(toolCallId),
      resolveAuthorizationContext: async () => ({
        ...EXECUTION_BINDING,
        connectorProvider: "shopify",
        grantedScopes: ["write_fulfillments"],
        policyRules: {
          rules: [
            {
              action: "allow",
              reason: "Release policy allows fulfillment creation.",
              toolName: "shopify.fulfillments.create",
            },
          ],
        },
      }),
      resolveProviderCredential: async () => {
        throw new Error("not used");
      },
    });

    expect(
      dependencies.authorizeToolCall(
        request({
          effect: "write",
          idempotencyKey: "shopify-fulfillment-1",
          input: { variables: { fulfillment: { trackingInfo: { number: "1Z" } } } },
          inputSummary: "Create a Shopify fulfillment",
          requiredScopes: ["write_fulfillments"],
          toolName: "shopify.fulfillments.create",
        }),
      ),
    ).resolves.toMatchObject({
      action: "allow",
      executionBinding: {
        authorizationFingerprint: EXECUTION_BINDING.authorizationFingerprint,
        connectionId: EXECUTION_BINDING.connectionId,
        externalAccountId: EXECUTION_BINDING.externalAccountId,
      },
      reason: "Release policy allows fulfillment creation.",
      toolCallId,
    });
  });

  test("denies archived, unbound, mismatched-provider, and insufficient-scope tools", async () => {
    const generated = generatedIds(
      "01J00000000000000000000013" as Ulid,
      "01J00000000000000000000014" as Ulid,
      "01J00000000000000000000015" as Ulid,
      "01J00000000000000000000016" as Ulid,
    );
    let authorizationReads = 0;
    const dependencies = createRuntimeToolDependencies({
      dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
      egressAllowlists: { read: async () => [] },
      generateId: generated,
      resolveAuthorizationContext: async (toolRequest) => {
        authorizationReads += 1;
        return {
          ...EXECUTION_BINDING,
          connectorProvider: toolRequest.idempotencyKey === "wrong-provider" ? "twilio" : "shopify",
          grantedScopes: [],
        };
      },
      resolveProviderCredential: async () => {
        throw new Error("not used");
      },
    });

    const archived = await dependencies.authorizeToolCall(
      request({
        effect: "read",
        idempotencyKey: "archived",
        inputSummary: "Search Zendesk tickets",
        requiredScopes: ["read"],
        toolName: "zendesk.tickets.search",
      }),
    );
    expect(archived.action).toBe("deny");
    expect(archived.reason).toContain("not active");

    const unbound = await dependencies.authorizeToolCall(
      request({
        effect: "read",
        idempotencyKey: "unbound",
        input: { url: "https://example.com" },
        inputSummary: "Capture a page",
        requiredScopes: [],
        toolName: "browser.screenshot.capture",
      }),
    );
    expect(unbound.action).toBe("deny");
    expect(unbound.reason).toContain("no worker execution binding");

    const mismatched = await dependencies.authorizeToolCall(
      request({
        effect: "read",
        idempotencyKey: "wrong-provider",
        input: { query: "title:Widget" },
        inputSummary: "Search products",
        requiredScopes: ["read_products"],
        toolName: "shopify.products.search",
      }),
    );
    expect(mismatched.action).toBe("deny");
    expect(mismatched.reason).toContain("accepted provider");

    const insufficient = await dependencies.authorizeToolCall(
      request({
        effect: "read",
        idempotencyKey: "insufficient",
        input: { query: "title:Widget" },
        inputSummary: "Search products",
        requiredScopes: ["read_products"],
        toolName: "shopify.products.search",
      }),
    );
    expect(insufficient.action).toBe("deny");
    expect(insufficient.reason).toBe("Required connector scopes have not been granted.");
    expect(authorizationReads).toBe(2);
  });
});
