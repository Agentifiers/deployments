import { describe, expect, test } from "bun:test";

import type {
  RuntimeToolAllowedDecision,
  RuntimeToolDecision,
} from "@deployments-ai/agent-runtime";
import { dataBoundaryOf, type BoundExecutionPurpose, type Ulid } from "@deployments-ai/db";
import type {
  ProviderNativeHttpExecutorOptions,
  ToolAdapterDefinition,
} from "@deployments-ai/tools";

import type {
  RuntimeProviderMutationClaim,
  RuntimeProviderMutationClaimStore,
} from "./provider-mutation-claims.ts";
import {
  EVALUATION_APPROVAL_REJECTION_REASON,
  EVALUATION_WRITE_DENIAL_REASON,
  boundRunToolAuthorization,
} from "./execution-tool-policy.ts";
import type { AuthorizedRuntimeToolBindingRequest } from "./runtime-tool-planning.ts";
import { createRuntimeToolDependencies, type RuntimeToolBindingRequest } from "./runtime-tools.ts";

const ids = {
  agentDefinitionId: "01J00000000000000000000001" as Ulid,
  agentReleaseId: "01J00000000000000000000003" as Ulid,
  environmentId: "01J00000000000000000000004" as Ulid,
  executionBindingId: "01J0000000000000000000000B" as Ulid,
  organizationId: "01J00000000000000000000005" as Ulid,
  projectId: "01J00000000000000000000006" as Ulid,
  runId: "01J00000000000000000000007" as Ulid,
  threadId: "01J00000000000000000000008" as Ulid,
};

type PinnedRequestInput = Parameters<
  NonNullable<ProviderNativeHttpExecutorOptions["pinnedRequest"]>
>[0];

function callbackTool(
  effect: ToolAdapterDefinition["effect"],
  defaultPolicyAction: ToolAdapterDefinition["defaultPolicyAction"] = "allow",
): ToolAdapterDefinition {
  return {
    defaultPolicyAction,
    description: "Call a vertical callback.",
    effect,
    execution: {
      authorizationHeader: "Bearer callback-secret",
      completionMode: "sync",
      endpointOrigin: "https://callbacks.example.com",
      endpointPath: `/v1/tools/${effect}`,
      type: "http_callback",
    },
    inputSchema: {
      additionalProperties: false,
      properties: { resourceId: { type: "string" } },
      required: ["resourceId"],
      type: "object",
    },
    provider: "github",
    requiredScopes: [`callback:${effect}`],
    status: "active",
    toolAdapterId: "01J00000000000000000000025" as Ulid,
    toolName: `vertical.callback.${effect}`,
  };
}

function harness(definition: ToolAdapterDefinition) {
  const callbackRequests: PinnedRequestInput[] = [];
  const dispatched: AuthorizedRuntimeToolBindingRequest[] = [];
  let nextId = 0x30;
  const generateId = async () =>
    `01J000000000000000000000${(nextId++).toString(16).toUpperCase()}` as Ulid;
  const mutationClaims: RuntimeProviderMutationClaimStore = {
    begin: async (input) => ({
      action: "execute",
      claim: { input, record: {} as never } as RuntimeProviderMutationClaim,
    }),
    fail: async () => {},
    markUnknown: async () => {},
    release: async () => {},
    succeed: async () => {},
  };
  const dependencies = createRuntimeToolDependencies({
    dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
    egressAllowlists: { read: async () => [] },
    executor: {
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 as const }],
      pinnedRequest: async (callbackRequest) => {
        callbackRequests.push(callbackRequest);
        return new Response(JSON.stringify({ result: "ok" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      },
    },
    generateId,
    mutationClaims,
    persistHttpCallbackDispatch: async (callbackRequest) => {
      dispatched.push(callbackRequest);
      return { evidenceId: callbackRequest.decision.toolCallId };
    },
    resolveAuthorizationContext: async () => ({
      authorizationFingerprint: "sha256:github-account-1:resources-v1",
      connectionId: "01J00000000000000000000019" as Ulid,
      connectorProvider: "github",
      externalAccountId: "github-account-1",
      externalResourceConstraints: {},
      grantedScopes: [...(definition.requiredScopes ?? [])],
    }),
    resolveExtensionToolDefinition: async (toolName) =>
      toolName === definition.toolName ? definition : undefined,
    resolveProviderCredential: async () => {
      throw new Error("provider credential should not be used");
    },
  });
  return { callbackRequests, dependencies, dispatched };
}

function boundRequest(
  definition: ToolAdapterDefinition,
  executionPurpose: BoundExecutionPurpose,
): RuntimeToolBindingRequest {
  return {
    ...ids,
    effect: definition.effect,
    executionPurpose,
    idempotencyKey: `${executionPurpose}-callback`,
    input: { resourceId: "resource-1" },
    inputSummary: "Call the vertical callback.",
    policyAction: "allow",
    requiredScopes: [...(definition.requiredScopes ?? [])],
    toolName: definition.toolName,
  };
}

function allowed(decision: RuntimeToolDecision): RuntimeToolAllowedDecision {
  if (decision.action !== "allow") throw new Error(`Expected allow, got ${decision.action}.`);
  return decision;
}

describe("HTTP callback tools for bound runs", () => {
  test("preview runs dispatch write callbacks identified by their execution binding", async () => {
    const definition = callbackTool("write");
    const { callbackRequests, dependencies, dispatched } = harness(definition);
    const request = boundRequest(definition, "preview");

    const decision = allowed(await dependencies.authorizeToolCall(request));
    await dependencies.executeToolCall({ ...request, decision });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      executionBindingId: ids.executionBindingId,
      executionPurpose: "preview",
    });
    expect(callbackRequests).toHaveLength(1);
    const body = JSON.parse(String(callbackRequests[0]!.body));
    expect(body).toMatchObject({
      executionBindingId: ids.executionBindingId,
      executionPurpose: "preview",
      runId: ids.runId,
    });
    expect(body).not.toHaveProperty("agentDeploymentId");
  });

  test("evaluation runs deny write callbacks before any dispatch", async () => {
    const definition = callbackTool("write");
    const { callbackRequests, dependencies, dispatched } = harness(definition);
    const authorize = boundRunToolAuthorization(dependencies.authorizeToolCall, "evaluation");

    expect(authorize(boundRequest(definition, "evaluation"))).resolves.toMatchObject({
      action: "deny",
      reason: EVALUATION_WRITE_DENIAL_REASON,
    });
    expect(dispatched).toHaveLength(0);
    expect(callbackRequests).toHaveLength(0);
  });

  test("evaluation runs reject approval-gated read callbacks instead of pausing", async () => {
    const definition = callbackTool("read", "require_approval");
    const { callbackRequests, dependencies, dispatched } = harness(definition);
    const authorize = boundRunToolAuthorization(dependencies.authorizeToolCall, "evaluation");

    expect(authorize(boundRequest(definition, "evaluation"))).resolves.toMatchObject({
      action: "deny",
      reason: EVALUATION_APPROVAL_REJECTION_REASON,
    });
    expect(dispatched).toHaveLength(0);
    expect(callbackRequests).toHaveLength(0);
  });
});
