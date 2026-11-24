import { describe, expect, test } from "bun:test";

import type {
  RuntimeToolAllowedDecision,
  RuntimeToolDecision,
  RuntimeToolRequest,
} from "@deployments-ai/agent-runtime";
import {
  RuntimeToolExecutionKnownFailureError,
  RuntimeToolPreparationRetryableError,
} from "@deployments-ai/agent-runtime";
import { dataBoundaryOf, type Ulid } from "@deployments-ai/db";
import type {
  ProviderNativeHttpExecutorOptions,
  ToolAdapterDefinition,
} from "@deployments-ai/tools";

import type {
  RuntimeProviderMutationClaim,
  RuntimeProviderMutationClaimStore,
} from "./provider-mutation-claims.ts";
import {
  RuntimeHttpCallbackKnownFailureError,
  RuntimeHttpCallbackOutcomeUnknownError,
} from "./runtime-http-callback.ts";
import { RuntimeHttpCallbackDispatchPermanentError } from "./runtime-http-callback-dispatch.ts";
import {
  createRuntimeToolDependencies,
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

const PUBLIC_DNS = async () => [{ address: "93.184.216.34", family: 4 as const }];
const EXECUTION_BINDING = {
  authorizationFingerprint: "sha256:github-account-1:resources-v1",
  connectionId: "01J00000000000000000000019" as Ulid,
  externalAccountId: "github-account-1",
  toolPlanFingerprint: "test-tool-plan",
} as const;
type PinnedRequestInput = Parameters<
  NonNullable<ProviderNativeHttpExecutorOptions["pinnedRequest"]>
>[0];

function request(toolRequest: RuntimeToolRequest): RuntimeToolBindingRequest {
  return { ...ids, ...toolRequest, policyAction: "allow" };
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

describe("worker runtime tool binding", () => {
  test("executes synchronous persisted callbacks with constraints and a bounded artifact", async () => {
    const toolCallId = "01J00000000000000000000026" as Ulid;
    const definition: ToolAdapterDefinition = {
      defaultPolicyAction: "allow",
      description: "Read a vertical callback.",
      effect: "read",
      execution: {
        authorizationHeader: "Bearer callback-secret",
        completionMode: "sync",
        endpointOrigin: "https://callbacks.example.com",
        endpointPath: "/v1/tools/read?tenant=vertical",
        type: "http_callback",
      },
      inputSchema: {
        additionalProperties: false,
        properties: {
          payload: { type: "string" },
          resourceId: { type: "string" },
        },
        required: ["payload", "resourceId"],
        type: "object",
      },
      provider: "github",
      requiredScopes: ["callback:read"],
      status: "active",
      toolAdapterId: "01J00000000000000000000025" as Ulid,
      toolName: "vertical.callback.read",
    };
    const callbackRequests: PinnedRequestInput[] = [];
    let callbackResponse = JSON.stringify({ result: "a response longer than the artifact" });
    let callbackStatusCleanupFails = false;
    let authorizationReads = 0;
    let dispatchEvidenceWrites = 0;
    let dispatchEvidenceFailure: unknown;
    const callbackEvidenceId = "01J00000000000000000000029" as Ulid;
    const dependencies = createRuntimeToolDependencies({
      dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
      egressAllowlists: { read: async () => [] },
      executor: {
        dnsLookup: PUBLIC_DNS,
        pinnedRequest: async (callbackRequest) => {
          expect(dispatchEvidenceWrites).toBe(callbackRequests.length + 1);
          callbackRequests.push(callbackRequest);
          if (callbackStatusCleanupFails) {
            return new Response(
              new ReadableStream<Uint8Array>({
                cancel() {
                  return Promise.reject(new Error("simulated cancellation failure"));
                },
              }),
              { status: 400 },
            );
          }
          return new Response(callbackResponse, {
            headers: { "content-type": "application/json" },
            status: 200,
          });
        },
      },
      generateId: generatedIds(
        toolCallId,
        "01J00000000000000000000028" as Ulid,
        "01J0000000000000000000002A" as Ulid,
        "01J0000000000000000000002B" as Ulid,
      ),
      maxArtifactCharacters: 24,
      persistHttpCallbackDispatch: async (callbackRequest, effectiveInput) => {
        if (dispatchEvidenceFailure) throw dispatchEvidenceFailure;
        dispatchEvidenceWrites += 1;
        if (callbackRequest.idempotencyKey === "vertical-callback-invalid-input") {
          return { evidenceId: callbackEvidenceId };
        }
        expect(callbackRequest.decision.executionBinding.inputHash).toMatch(
          /^sha256:[0-9a-f]{64}$/u,
        );
        expect(effectiveInput).toEqual({
          payload: "hello",
          resourceId: "authorized-resource",
        });
        return { evidenceId: callbackEvidenceId };
      },
      resolveAuthorizationContext: async () => {
        authorizationReads += 1;
        return {
          ...EXECUTION_BINDING,
          connectorProvider: "github",
          externalResourceConstraints: { resourceId: "authorized-resource" },
          grantedScopes: ["callback:read"],
        };
      },
      resolveExtensionToolDefinition: async (toolName) =>
        toolName === definition.toolName ? definition : undefined,
      resolveProviderCredential: async () => {
        throw new Error("provider credential should not be used");
      },
    });
    const scopedRequest = request({
      effect: "read",
      idempotencyKey: "vertical-callback-read",
      input: { payload: "hello", resourceId: "caller-resource" },
      inputSummary: "Read callback",
      requiredScopes: ["callback:read"],
      toolName: definition.toolName,
    });

    const decision = allowedDecision(await dependencies.authorizeToolCall(scopedRequest));
    expect(decision.executionBinding).toMatchObject({ toolAdapterId: definition.toolAdapterId });
    const result = await dependencies.executeToolCall({ ...scopedRequest, decision });
    await dependencies.executeToolCall({ ...scopedRequest, decision });
    const otherRunRequest = {
      ...scopedRequest,
      runId: "01J00000000000000000000009" as Ulid,
    };
    const otherRunDecision = allowedDecision(await dependencies.authorizeToolCall(otherRunRequest));
    await dependencies.executeToolCall({ ...otherRunRequest, decision: otherRunDecision });

    expect(authorizationReads).toBe(5);
    expect(dispatchEvidenceWrites).toBe(3);
    expect(callbackRequests).toHaveLength(3);
    expect(callbackRequests[0]).toMatchObject({
      headers: {
        authorization: "Bearer callback-secret",
        "content-type": "application/json",
      },
      method: "POST",
      url: "https://callbacks.example.com/v1/tools/read?tenant=vertical",
    });
    expect(JSON.parse(String(callbackRequests[0]!.body))).toEqual({
      agentDeploymentId: ids.agentDeploymentId,
      callbackEvidenceId,
      effect: "read",
      idempotencyKey: providerMutationRequestIdempotencyKey(ids.runId, "vertical-callback-read"),
      input: { payload: "hello", resourceId: "authorized-resource" },
      inputHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      logicalIdempotencyKey: "vertical-callback-read",
      organizationId: ids.organizationId,
      policyAction: "allow",
      requiredScopes: ["callback:read"],
      runId: ids.runId,
      threadId: ids.threadId,
      toolCallId,
      toolName: "vertical.callback.read",
      version: 1,
    });
    expect(JSON.parse(String(callbackRequests[1]!.body)).idempotencyKey).toBe(
      JSON.parse(String(callbackRequests[0]!.body)).idempotencyKey,
    );
    expect(JSON.parse(String(callbackRequests[2]!.body)).idempotencyKey).not.toBe(
      JSON.parse(String(callbackRequests[0]!.body)).idempotencyKey,
    );
    // The artifact is capped at 24 characters; the model-visible result keeps the full body.
    expect(result.outputSummary).toBe(
      JSON.stringify({ result: "a response longer than the artifact" }),
    );
    expect(result.artifacts?.[0]).toMatchObject({
      contentType: "text/plain; charset=utf-8",
      metadata: {
        responseStatus: 200,
        source: "extension.http_callback",
        truncated: true,
      },
      type: "report",
    });
    const oversizedRequest = {
      ...scopedRequest,
      idempotencyKey: "vertical-callback-oversized",
      input: { payload: "x".repeat(256 * 1_024), resourceId: "caller-resource" },
    };
    const oversizedDecision = allowedDecision(
      await dependencies.authorizeToolCall(oversizedRequest),
    );
    const writesBeforeOversizedRequest = dispatchEvidenceWrites;
    expect(
      dependencies.executeToolCall({ ...oversizedRequest, decision: oversizedDecision }),
    ).rejects.toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
    expect(dispatchEvidenceWrites).toBe(writesBeforeOversizedRequest);
    const invalidInputRequest = {
      ...scopedRequest,
      idempotencyKey: "vertical-callback-invalid-input",
      input: { resourceId: "caller-resource" },
    };
    const invalidInputDecision = allowedDecision(
      await dependencies.authorizeToolCall(invalidInputRequest),
    );
    const writesBeforeInvalidInput = dispatchEvidenceWrites;
    expect(
      dependencies.executeToolCall({ ...invalidInputRequest, decision: invalidInputDecision }),
    ).rejects.toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
    expect(dispatchEvidenceWrites).toBe(writesBeforeInvalidInput);
    callbackResponse = JSON.stringify({ echoedAuthorization: "Bearer callback-secret" });
    try {
      await dependencies.executeToolCall({ ...scopedRequest, decision });
      throw new Error("Expected callback credential echo to fail.");
    } catch (cause) {
      expect(cause).toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
      expect((cause as Error).cause).toBeInstanceOf(RuntimeHttpCallbackKnownFailureError);
    }
    callbackStatusCleanupFails = true;
    try {
      await dependencies.executeToolCall({ ...scopedRequest, decision });
      throw new Error("Expected callback rejection to fail.");
    } catch (cause) {
      expect(cause).toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
      expect((cause as Error).cause).toBeInstanceOf(RuntimeHttpCallbackKnownFailureError);
      expect((cause as Error).cause).toMatchObject({
        message: "HTTP callback vertical.callback.read returned HTTP 400.",
      });
    }
    dispatchEvidenceFailure = new RuntimeHttpCallbackDispatchPermanentError(
      "approval provenance expired",
    );
    expect(dependencies.executeToolCall({ ...scopedRequest, decision })).rejects.toBeInstanceOf(
      RuntimeToolExecutionKnownFailureError,
    );
    dispatchEvidenceFailure = new Error("DynamoDB unavailable");
    expect(dependencies.executeToolCall({ ...scopedRequest, decision })).rejects.toBeInstanceOf(
      RuntimeToolPreparationRetryableError,
    );
  });

  test("keeps callback credentials out of public plan fingerprints", async () => {
    const definition = (
      authorizationHeader: string,
      credentialGeneration: number,
      adapterId: string,
    ): ToolAdapterDefinition => ({
      auditMetadata: {
        persistedAdapter: {
          credentialId: `credential-for-${adapterId}`,
          id: adapterId,
          version: 0,
        },
      },
      defaultPolicyAction: "allow",
      description: "Read a vertical callback.",
      effect: "read",
      execution: {
        authorizationHeader,
        completionMode: "sync",
        credentialGeneration,
        endpointOrigin: "https://callbacks.example.com",
        endpointPath: "/v1/tools/read",
        type: "http_callback",
      },
      inputSchema: { type: "object" },
      provider: "github",
      requiredScopes: [],
      status: "active",
      toolName: "vertical.callback.fingerprint",
    });
    let authorizationHeader = "Bearer first-secret";
    let credentialGeneration = 1;
    let adapterId = "adapter-1";
    let includeProvider = true;
    const dependencies = createRuntimeToolDependencies({
      dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
      egressAllowlists: { read: async () => [] },
      generateId: generatedIds(
        "01J00000000000000000000030" as Ulid,
        "01J00000000000000000000031" as Ulid,
        "01J00000000000000000000033" as Ulid,
        "01J00000000000000000000035" as Ulid,
        "01J00000000000000000000036" as Ulid,
      ),
      persistHttpCallbackDispatch: async (callbackRequest) => ({
        evidenceId: callbackRequest.decision.toolCallId,
      }),
      resolveAuthorizationContext: async () => ({
        ...EXECUTION_BINDING,
        connectorProvider: "github",
        grantedScopes: [],
      }),
      resolveExtensionToolDefinition: async () => {
        const resolved = definition(authorizationHeader, credentialGeneration, adapterId);
        if (includeProvider) return resolved;
        const { provider, ...providerless } = resolved;
        void provider;
        return providerless;
      },
      resolveProviderCredential: async () => {
        throw new Error("provider credential should not be used");
      },
    });
    const callbackRequest = request({
      effect: "read",
      idempotencyKey: "vertical-callback-fingerprint",
      input: {},
      inputSummary: "Read callback",
      requiredScopes: [],
      toolName: "vertical.callback.fingerprint",
    });

    const first = allowedDecision(await dependencies.authorizeToolCall(callbackRequest));
    authorizationHeader = "Bearer second-secret";
    const second = allowedDecision(
      await dependencies.authorizeToolCall({
        ...callbackRequest,
        runId: "01J00000000000000000000032" as Ulid,
      }),
    );
    expect(first.executionBinding?.toolPlanFingerprint).toBe(
      second.executionBinding?.toolPlanFingerprint,
    );
    adapterId = "adapter-2";
    const replaced = allowedDecision(
      await dependencies.authorizeToolCall({
        ...callbackRequest,
        runId: "01J00000000000000000000036" as Ulid,
      }),
    );
    expect(replaced.executionBinding?.toolPlanFingerprint).not.toBe(
      first.executionBinding?.toolPlanFingerprint,
    );
    credentialGeneration = 2;
    const rotated = allowedDecision(
      await dependencies.authorizeToolCall({
        ...callbackRequest,
        runId: "01J00000000000000000000033" as Ulid,
      }),
    );
    expect(rotated.executionBinding?.toolPlanFingerprint).not.toBe(
      first.executionBinding?.toolPlanFingerprint,
    );
    includeProvider = false;
    expect(
      dependencies.authorizeToolCall({
        ...callbackRequest,
        runId: "01J00000000000000000000034" as Ulid,
      }),
    ).resolves.toMatchObject({ action: "deny" });
  });

  test("quarantines ambiguous callback mutation outcomes after dispatch", async () => {
    const toolCallId = "01J00000000000000000000027" as Ulid;
    const definition: ToolAdapterDefinition = {
      defaultPolicyAction: "allow",
      description: "Mutate through a vertical callback.",
      effect: "write",
      execution: {
        authorizationHeader: "Bearer callback-secret",
        completionMode: "sync",
        endpointOrigin: "https://callbacks.example.com",
        endpointPath: "/v1/tools/write",
        type: "http_callback",
      },
      inputSchema: {
        additionalProperties: false,
        properties: { value: { type: "string" } },
        required: ["value"],
        type: "object",
      },
      provider: "github",
      providerOutboundMutation: true,
      requiredScopes: ["callback:write"],
      status: "active",
      toolName: "vertical.callback.write",
    };
    let failedClaims = 0;
    let echoCredential = false;
    let replayMutation = false;
    let releasedClaims = 0;
    let requests = 0;
    let unknownClaims = 0;
    let dispatchEvidenceWrites = 0;
    const mutationClaims: RuntimeProviderMutationClaimStore = {
      begin: async (input) =>
        replayMutation
          ? {
              action: "replay",
              result: { outputSummary: "persisted mutation", status: "completed" },
            }
          : {
              action: "execute",
              claim: { input, record: {} as never } as RuntimeProviderMutationClaim,
            },
      fail: async () => {
        failedClaims += 1;
      },
      markUnknown: async () => {
        unknownClaims += 1;
      },
      release: async () => {
        releasedClaims += 1;
      },
      succeed: async () => {
        throw new Error("failed dispatch must not succeed");
      },
    };
    const dependencies = createRuntimeToolDependencies({
      dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
      egressAllowlists: { read: async () => [] },
      executor: {
        dnsLookup: PUBLIC_DNS,
        pinnedRequest: async () => {
          requests += 1;
          if (echoCredential) {
            return new Response(JSON.stringify({ authorization: "Bearer callback-secret" }), {
              headers: { "content-type": "application/json" },
              status: 200,
            });
          }
          return new Response("", {
            headers: { location: "https://callbacks.example.com/v1/tools/redirected" },
            status: 307,
          });
        },
      },
      generateId: generatedIds(toolCallId),
      mutationClaims,
      persistHttpCallbackDispatch: async (callbackRequest) => {
        dispatchEvidenceWrites += 1;
        return { evidenceId: callbackRequest.decision.toolCallId };
      },
      resolveAuthorizationContext: async () => ({
        ...EXECUTION_BINDING,
        connectorProvider: "github",
        grantedScopes: ["callback:write"],
      }),
      resolveExtensionToolDefinition: async (toolName) =>
        toolName === definition.toolName ? definition : undefined,
      resolveProviderCredential: async () => {
        throw new Error("provider credential should not be used");
      },
    });
    const scopedRequest = request({
      effect: "write",
      idempotencyKey: "vertical-callback-write",
      input: { value: "updated" },
      inputSummary: "Write callback",
      requiredScopes: ["callback:write"],
      toolName: definition.toolName,
    });

    const decision = allowedDecision(await dependencies.authorizeToolCall(scopedRequest));
    expect(
      dependencies.executeToolCall({ ...scopedRequest, decision, effect: "read" }),
    ).rejects.toBeInstanceOf(RuntimeHttpCallbackOutcomeUnknownError);
    expect(requests).toBe(1);
    expect(unknownClaims).toBe(1);
    expect(failedClaims).toBe(0);
    expect(releasedClaims).toBe(0);
    echoCredential = true;
    expect(dependencies.executeToolCall({ ...scopedRequest, decision })).rejects.toBeInstanceOf(
      RuntimeHttpCallbackOutcomeUnknownError,
    );
    expect(requests).toBe(2);
    expect(unknownClaims).toBe(2);
    expect(failedClaims).toBe(0);
    expect(releasedClaims).toBe(0);
    expect(dispatchEvidenceWrites).toBe(2);

    replayMutation = true;
    expect(dependencies.executeToolCall({ ...scopedRequest, decision })).resolves.toEqual({
      outputSummary: "persisted mutation",
      status: "completed",
    });
    expect(dispatchEvidenceWrites).toBe(2);
    expect(requests).toBe(2);
  });
});
