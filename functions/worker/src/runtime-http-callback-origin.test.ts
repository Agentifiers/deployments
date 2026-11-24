import { describe, expect, test } from "bun:test";
import {
  RuntimeToolExecutionKnownFailureError,
  type RuntimeToolDecision,
} from "@deployments-ai/agent-runtime";
import { dataBoundaryOf, type RunInitiatingCaller } from "@deployments-ai/db";
import type {
  ProviderNativeHttpExecutorOptions,
  ToolAdapterDefinition,
} from "@deployments-ai/tools";
import { fixtures, id, inMemoryDatabase } from "./agent-run.fixture.ts";
import type {
  RuntimeProviderMutationClaim,
  RuntimeProviderMutationClaimStore,
} from "./provider-mutation-claims.ts";
import {
  channelIngressMetadata,
  promptWith,
  runStartedBy,
  SLACK_BINDING_ID,
  SLACK_THREAD_MESSAGE,
} from "./runtime-callback-origin.fixture.ts";
import { createRuntimeHttpCallbackDispatchPersistence } from "./runtime-http-callback-dispatch.ts";
import { controlSnapshot, now, request } from "./runtime-http-callback-dispatch.fixture.ts";
import { createRuntimeToolDependencies, executionPlan } from "./runtime-tools.ts";

type PinnedRequestInput = Parameters<
  NonNullable<ProviderNativeHttpExecutorOptions["pinnedRequest"]>
>[0];

const SLACK_INGRESS: RunInitiatingCaller = {
  sourceId: SLACK_BINDING_ID,
  sourceKind: "channel-binding",
  type: "ingress",
};
const API_CALLER: RunInitiatingCaller = {
  apiCredentialId: id(61),
  serviceAccountId: id(62),
  type: "service-account",
};

function callbackTool(runContext?: readonly "origin"[]): ToolAdapterDefinition {
  return {
    defaultPolicyAction: "allow",
    description: "Write through a callback.",
    effect: "write",
    execution: {
      authorizationHeader: "Bearer callback-secret",
      completionMode: "sync",
      endpointOrigin: "https://callbacks.example.com",
      endpointPath: "/v1/tools/write",
      ...(runContext ? { runContext } : {}),
      type: "http_callback",
    },
    inputSchema: {
      additionalProperties: false,
      properties: { resourceId: { type: "string" } },
      required: ["resourceId"],
      type: "object",
    },
    provider: "github",
    requiredScopes: ["callback:write"],
    status: "active",
    toolAdapterId: id(81),
    toolName: "vertical.callback.write",
  };
}

async function callFrom(
  caller: RunInitiatingCaller,
  metadata: Readonly<Record<string, unknown>> | undefined,
  definition: ToolAdapterDefinition,
  maxRequestBytes?: number,
) {
  const fixture = fixtures();
  const memory = inMemoryDatabase([runStartedBy(caller), promptWith(metadata)]);
  const callbacks: PinnedRequestInput[] = [];
  const mutationClaims: RuntimeProviderMutationClaimStore = {
    begin: async (input) => ({
      action: "execute",
      claim: { input, record: {} as never } as RuntimeProviderMutationClaim,
    }),
    fail: async () => undefined,
    markUnknown: async () => undefined,
    release: async () => undefined,
    succeed: async () => undefined,
  };
  const service = createRuntimeToolDependencies({
    dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
    egressAllowlists: { read: async () => [] },
    executor: {
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 as const }],
      ...(maxRequestBytes === undefined ? {} : { maxRequestBytes }),
      pinnedRequest: async (callbackRequest) => {
        callbacks.push(callbackRequest);
        return Response.json({ ok: true });
      },
    },
    generateId: async () => id(82),
    mutationClaims,
    persistHttpCallbackDispatch: createRuntimeHttpCallbackDispatchPersistence({
      database: memory.database,
      generateId: async () => id(90),
      now: () => now,
    }),
    resolveAuthorizationContext: async () => ({
      authorizationFingerprint: "sha256:authorization-v1",
      callbackControlSnapshot: controlSnapshot(fixture, request(fixture)),
      connectionId: id(80),
      connectorProvider: "github",
      externalAccountId: "vertical-account",
      externalResourceConstraints: { resourceId: "authorized-resource" },
      grantedScopes: ["callback:write"],
    }),
    resolveExtensionToolDefinition: async (toolName) =>
      toolName === definition.toolName ? definition : undefined,
    resolveProviderCredential: async () => {
      throw new Error("provider credential should not be used");
    },
  });
  const { decision: _authorized, ...toolRequest } = request(fixture);
  const decision: RuntimeToolDecision = await service.authorizeToolCall(toolRequest);
  if (decision.action !== "allow") throw new Error(`Expected allow, got ${decision.action}.`);
  const outcome = await service.executeToolCall({ ...toolRequest, decision }).then(
    (result) => ({ result }),
    (failure: unknown) => ({ failure }),
  );
  const evidence = [...memory.records.values()].find(
    (record) => record.itemType === "callback-dispatch-evidence",
  );
  return {
    bodies: callbacks.map((callback) => String(callback.body)),
    evidence: evidence?.itemType === "callback-dispatch-evidence" ? evidence.data : undefined,
    outcome,
  };
}

const SLACK_ORIGIN = {
  channelBindingId: "01ARZ3NDEKTSV4RRFFQ69G0040",
  externalAccountId: "A07BOTAPP01",
  externalChannelId: "C07QK3MV9",
  externalMessageId: "slack:T024BE7LD:C07QK3MV9:1729700123.000200",
  externalThreadKey: "slack:T024BE7LD:thread:C07QK3MV9:1729700000.000100",
  externalWorkspaceId: "T024BE7LD",
  kind: "channel",
  provider: "slack_edge",
  sender: { id: "U02ADA1OVE" },
};
const BODY_WITHOUT_ORIGIN = {
  agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G0007",
  callbackEvidenceId: "01ARZ3NDEKTSV4RRFFQ69G0082",
  effect: "write",
  idempotencyKey: "dai-a09ab5acf3d52616ea76cb0c98a98c078dfdb834e5cb99",
  input: { resourceId: "authorized-resource" },
  inputHash: "sha256:0c7ce9c62818b00ed169bcb572f86ae43c9d8437a9b14107156ca9372f6bdc3b",
  logicalIdempotencyKey: "callback-write-1",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G0001",
  policyAction: "allow",
  requiredScopes: ["callback:write"],
  runId: "01ARZ3NDEKTSV4RRFFQ69G0010",
  threadId: "01ARZ3NDEKTSV4RRFFQ69G0008",
  toolCallId: "01ARZ3NDEKTSV4RRFFQ69G0082",
  toolName: "vertical.callback.write",
  version: 1,
  workspaceId: "01ARZ3NDEKTSV4RRFFQ69G0004",
};

describe("HTTP callback origin", () => {
  test("an opted-in extension called from a Slack thread run receives the channel origin", async () => {
    const slack = await callFrom(
      SLACK_INGRESS,
      channelIngressMetadata(SLACK_THREAD_MESSAGE),
      callbackTool(["origin"]),
    );
    expect(slack.bodies.map((body) => JSON.parse(body))).toEqual([
      {
        agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G0007",
        callbackEvidenceId: "01ARZ3NDEKTSV4RRFFQ69G0082",
        effect: "write",
        idempotencyKey: "dai-a09ab5acf3d52616ea76cb0c98a98c078dfdb834e5cb99",
        input: { resourceId: "authorized-resource" },
        inputHash: "sha256:0c7ce9c62818b00ed169bcb572f86ae43c9d8437a9b14107156ca9372f6bdc3b",
        logicalIdempotencyKey: "callback-write-1",
        organizationId: "01ARZ3NDEKTSV4RRFFQ69G0001",
        origin: {
          channelBindingId: "01ARZ3NDEKTSV4RRFFQ69G0040",
          externalAccountId: "A07BOTAPP01",
          externalChannelId: "C07QK3MV9",
          externalMessageId: "slack:T024BE7LD:C07QK3MV9:1729700123.000200",
          externalThreadKey: "slack:T024BE7LD:thread:C07QK3MV9:1729700000.000100",
          externalWorkspaceId: "T024BE7LD",
          kind: "channel",
          provider: "slack_edge",
          sender: { id: "U02ADA1OVE" },
        },
        policyAction: "allow",
        requiredScopes: ["callback:write"],
        runId: "01ARZ3NDEKTSV4RRFFQ69G0010",
        threadId: "01ARZ3NDEKTSV4RRFFQ69G0008",
        toolCallId: "01ARZ3NDEKTSV4RRFFQ69G0082",
        toolName: "vertical.callback.write",
        version: 1,
        workspaceId: "01ARZ3NDEKTSV4RRFFQ69G0004",
      },
    ]);
    expect<unknown>(slack.evidence?.origin).toEqual(SLACK_ORIGIN);
  });

  test("origin needs both the opt-in and a channel ingress run", async () => {
    const slackPrompt = channelIngressMetadata(SLACK_THREAD_MESSAGE);
    const optedIn = await callFrom(SLACK_INGRESS, slackPrompt, callbackTool(["origin"]));
    const notOptedIn = await callFrom(SLACK_INGRESS, slackPrompt, callbackTool());
    const apiStarted = await callFrom(API_CALLER, undefined, callbackTool(["origin"]));

    expect<unknown>(
      [optedIn, notOptedIn, apiStarted].map(({ bodies, evidence }) => ({
        bodies: bodies.map((body) => JSON.parse(body)),
        evidenceOrigin: evidence?.origin,
      })),
    ).toEqual([
      {
        bodies: [{ ...BODY_WITHOUT_ORIGIN, origin: SLACK_ORIGIN }],
        evidenceOrigin: SLACK_ORIGIN,
      },
      { bodies: [BODY_WITHOUT_ORIGIN], evidenceOrigin: undefined },
      { bodies: [BODY_WITHOUT_ORIGIN], evidenceOrigin: undefined },
    ]);
  });

  test("the request byte cap counts the origin before any evidence is written", async () => {
    const slackPrompt = channelIngressMetadata(SLACK_THREAD_MESSAGE);
    const cap = new TextEncoder().encode(JSON.stringify(BODY_WITHOUT_ORIGIN)).byteLength;
    const withoutOrigin = await callFrom(SLACK_INGRESS, slackPrompt, callbackTool(), cap);
    const withOrigin = await callFrom(SLACK_INGRESS, slackPrompt, callbackTool(["origin"]), cap);

    expect(withoutOrigin.bodies.map((body) => JSON.parse(body))).toEqual([BODY_WITHOUT_ORIGIN]);
    expect<unknown>(withoutOrigin.evidence?.id).toBe("01ARZ3NDEKTSV4RRFFQ69G0082");
    expect(withOrigin.bodies).toEqual([]);
    expect(withOrigin.evidence).toBeUndefined();
    const failure = "failure" in withOrigin.outcome ? withOrigin.outcome.failure : undefined;
    expect(failure).toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
    expect(
      failure instanceof RuntimeToolExecutionKnownFailureError
        ? String(failure.executionCause)
        : failure,
    ).toBe(
      "RuntimeHttpCallbackKnownFailureError: HTTP callback vertical.callback.write request was too large.",
    );
  });

  test("opting in changes the tool plan fingerprint that approvals pin", () => {
    const optedIn = executionPlan(callbackTool(["origin"]), {}).fingerprint;

    expect(executionPlan(callbackTool(["origin"]), {}).fingerprint).toBe(optedIn);
    expect(executionPlan(callbackTool(), {}).fingerprint).not.toBe(optedIn);
  });
});
