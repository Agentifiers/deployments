import { describe, expect, test } from "bun:test";

import type {
  RuntimeToolAllowedDecision,
  RuntimeToolDecision,
  RuntimeToolExecutionResult,
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
  authorizationFingerprint: "sha256:shopify-account-1:resources-v1",
  connectionId: "01J00000000000000000000019" as Ulid,
  externalAccountId: "shopify-account-1",
  toolPlanFingerprint: "test-tool-plan",
} as const;
const SHOP_RESOURCE = { oauthResource: "https://deployments-ai.myshopify.com" } as const;
const READ_SCOPES = ["read_products"];
const WRITE_SCOPES = ["write_fulfillments"];
const FULFILLMENT_RULES = {
  rules: [
    {
      action: "allow" as const,
      reason: "Release policy allows fulfillment creation.",
      toolName: "shopify.fulfillments.create",
    },
  ],
};
const SHOPIFY_TOKEN = "shopify-runtime-secret-token-123456";

function fulfillmentInput(message: string) {
  return {
    variables: {
      fulfillment: {
        lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: "gid://shopify/FulfillmentOrder/1" }],
      },
      message,
    },
  };
}

function fulfillmentRequest(idempotencyKey: string) {
  return request({
    effect: "write",
    idempotencyKey,
    input: fulfillmentInput("Fulfillment"),
    inputSummary: "Create a Shopify fulfillment",
    requiredScopes: WRITE_SCOPES,
    toolName: "shopify.fulfillments.create",
  });
}

function productSearchRequest(idempotencyKey: string) {
  return request({
    effect: "read",
    idempotencyKey,
    input: { query: "title:Widget" },
    inputSummary: "Search products",
    requiredScopes: READ_SCOPES,
    toolName: "shopify.products.search",
  });
}
type PinnedRequestInput = Parameters<
  NonNullable<ProviderNativeHttpExecutorOptions["pinnedRequest"]>
>[0];

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

describe("worker runtime tool binding", () => {
  test("executes an allowed provider-native call with a freshly revalidated credential", async () => {
    const toolCallId = "01J00000000000000000000017" as Ulid;
    const requests: PinnedRequestInput[] = [];
    let credentialReads = 0;
    const dependencies = createRuntimeToolDependencies({
      dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
      egressAllowlists: { read: async () => [] },
      executor: {
        dnsLookup: PUBLIC_DNS,
        pinnedRequest: async (providerRequest) => {
          requests.push(providerRequest);
          return new Response(JSON.stringify({ items: [{ id: 1 }] }), {
            headers: { "content-type": "application/json" },
            status: 200,
          });
        },
      },
      generateId: generatedIds(toolCallId),
      maxArtifactCharacters: 400,
      resolveAuthorizationContext: async () => ({
        ...EXECUTION_BINDING,
        connectorProvider: "shopify",
        grantedScopes: READ_SCOPES,
      }),
      resolveProviderCredential: async () => {
        credentialReads += 1;
        return {
          ...EXECUTION_BINDING,
          externalAccountId: "shopify-account-1",
          fields: { accessToken: SHOPIFY_TOKEN },
          grantedScopes: READ_SCOPES,
          provider: "shopify",
          resourceDefaults: SHOP_RESOURCE,
        };
      },
    });
    const scopedRequest = productSearchRequest("shopify-read-1");
    const decision = await dependencies.authorizeToolCall(scopedRequest);
    expect(decision.action).toBe("allow");

    const result = await dependencies.executeToolCall({
      ...scopedRequest,
      decision: allowedDecision(decision),
    });

    expect(credentialReads).toBe(1);
    expect(requests).toHaveLength(1);
    expect(result.status).toBe("completed");
    expect(result.outputSummary).toContain("1 item(s) returned");
    expect(result.artifacts?.[0]).toMatchObject({
      contentType: "application/json",
      fileName: `${providerMutationRequestIdempotencyKey(ids.runId, "shopify-read-1")}-shopify-products-search.json`,
      label: "shopify provider API response",
      type: "report",
    });
  });

  test("fails execution when credential scopes were revoked after authorization", async () => {
    const toolCallId = "01J00000000000000000000018" as Ulid;
    let providerRequests = 0;
    const dependencies = createRuntimeToolDependencies({
      dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
      egressAllowlists: { read: async () => [] },
      executor: {
        dnsLookup: PUBLIC_DNS,
        pinnedRequest: async () => {
          providerRequests += 1;
          return new Response("{}");
        },
      },
      generateId: generatedIds(toolCallId),
      resolveAuthorizationContext: async () => ({
        ...EXECUTION_BINDING,
        connectorProvider: "shopify",
        grantedScopes: READ_SCOPES,
      }),
      resolveProviderCredential: async () => ({
        ...EXECUTION_BINDING,
        externalAccountId: "shopify-account-1",
        fields: { accessToken: SHOPIFY_TOKEN },
        grantedScopes: ["read_orders"],
        provider: "shopify",
        resourceDefaults: SHOP_RESOURCE,
      }),
    });
    const scopedRequest = productSearchRequest("shopify-read-revoked");
    const decision = await dependencies.authorizeToolCall(scopedRequest);

    expect(
      dependencies.executeToolCall({
        ...scopedRequest,
        decision: allowedDecision(decision),
      }),
    ).rejects.toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
    expect(providerRequests).toBe(0);
  });

  test("rejects a different credential account binding after authorization", async () => {
    const toolCallId = "01J00000000000000000000020" as Ulid;
    let providerRequests = 0;
    const dependencies = createRuntimeToolDependencies({
      dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
      egressAllowlists: { read: async () => [] },
      executor: {
        dnsLookup: PUBLIC_DNS,
        pinnedRequest: async () => {
          providerRequests += 1;
          return new Response("{}");
        },
      },
      generateId: generatedIds(toolCallId),
      resolveAuthorizationContext: async () => ({
        ...EXECUTION_BINDING,
        connectorProvider: "shopify",
        grantedScopes: READ_SCOPES,
      }),
      resolveProviderCredential: async () => ({
        authorizationFingerprint: "sha256:shopify-account-2:resources-v1",
        connectionId: "01J00000000000000000000021",
        externalAccountId: "shopify-account-2",
        fields: { accessToken: "shopify-other-secret-token-123456" },
        grantedScopes: READ_SCOPES,
        provider: "shopify",
        resourceDefaults: SHOP_RESOURCE,
      }),
    });
    const scopedRequest = productSearchRequest("shopify-read-account-change");
    const decision = await dependencies.authorizeToolCall(scopedRequest);

    expect(
      dependencies.executeToolCall({
        ...scopedRequest,
        decision: allowedDecision(decision),
      }),
    ).rejects.toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
    expect(providerRequests).toBe(0);
  });

  test("uses the typed mutation plan instead of request effect metadata", async () => {
    const toolCallId = "01J00000000000000000000022" as Ulid;
    const order: string[] = [];
    let completedResult: RuntimeToolExecutionResult | undefined;
    const mutationClaims: RuntimeProviderMutationClaimStore = {
      begin: async (input) => {
        order.push("claim");
        expect(input.effect).toBe("write");
        if (completedResult) return { action: "replay", result: completedResult };
        return {
          action: "execute",
          claim: { input, record: {} as never } as RuntimeProviderMutationClaim,
        };
      },
      fail: async () => {
        order.push("fail");
      },
      markUnknown: async () => {
        order.push("unknown");
      },
      release: async () => {
        order.push("release");
      },
      succeed: async (_claim, result) => {
        order.push("succeed");
        completedResult = result;
      },
    };
    const dependencies = createRuntimeToolDependencies({
      dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
      egressAllowlists: { read: async () => [] },
      executor: {
        dnsLookup: PUBLIC_DNS,
        pinnedRequest: async (providerRequest) => {
          order.push("request");
          expect(JSON.parse(String(providerRequest.body))).toMatchObject({
            variables: { message: expect.stringContaining("https://artifacts.example/signed") },
          });
          return new Response(
            JSON.stringify({
              echoedText: "Prepared fulfillment https://artifacts.example/signed?secret=one",
              id: "fulfillment-123",
            }),
            {
              headers: { "content-type": "application/json" },
              status: 201,
            },
          );
        },
      },
      generateId: generatedIds(toolCallId),
      mutationClaims,
      prepareProviderInput: async (_request, _definition) => {
        order.push("prepare");
        return {
          input: fulfillmentInput(
            "Prepared fulfillment https://artifacts.example/signed?secret=one",
          ),
          persistCanonicalHandoffResponse: true,
        };
      },
      resolveAuthorizationContext: async () => ({
        ...EXECUTION_BINDING,
        connectorProvider: "shopify",
        grantedScopes: WRITE_SCOPES,
        policyRules: FULFILLMENT_RULES,
      }),
      resolveProviderCredential: async () => {
        order.push("credential");
        return {
          ...EXECUTION_BINDING,
          fields: { accessToken: SHOPIFY_TOKEN },
          grantedScopes: WRITE_SCOPES,
          provider: "shopify",
          resourceDefaults: SHOP_RESOURCE,
        };
      },
    });
    const scopedRequest = fulfillmentRequest("shopify-fulfillment-claim-order");
    const decision = await dependencies.authorizeToolCall(scopedRequest);
    if (decision.action !== "allow") throw new Error("Expected tool authorization to allow.");

    const executionRequest = { ...scopedRequest, decision, effect: "read" as const };
    const first = await dependencies.executeToolCall(executionRequest);
    const second = await dependencies.executeToolCall(executionRequest);

    expect(first).toEqual(second);
    expect(String(first.artifacts?.[0]?.content)).not.toContain("secret=one");
    expect(first.outputSummary).not.toContain("secret=one");
    expect(order).toEqual(["claim", "credential", "prepare", "request", "succeed", "claim"]);
  });

  test("releases mutation claims when credential preparation fails before dispatch", async () => {
    const toolCallId = "01J00000000000000000000023" as Ulid;
    let credentialAttempts = 0;
    let requests = 0;
    let releases = 0;
    const mutationClaims: RuntimeProviderMutationClaimStore = {
      begin: async (input) => ({
        action: "execute",
        claim: { input, record: {} as never } as RuntimeProviderMutationClaim,
      }),
      fail: async () => {
        throw new Error("must not persist a known failure");
      },
      markUnknown: async () => {
        throw new Error("must not quarantine an undispatched request");
      },
      release: async () => {
        releases += 1;
      },
      succeed: async () => {},
    };
    const dependencies = createRuntimeToolDependencies({
      dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
      egressAllowlists: { read: async () => [] },
      executor: {
        dnsLookup: PUBLIC_DNS,
        pinnedRequest: async () => {
          requests += 1;
          return new Response(JSON.stringify({ id: "fulfillment-123" }), { status: 201 });
        },
      },
      generateId: generatedIds(toolCallId),
      mutationClaims,
      resolveAuthorizationContext: async () => ({
        ...EXECUTION_BINDING,
        connectorProvider: "shopify",
        grantedScopes: WRITE_SCOPES,
        policyRules: FULFILLMENT_RULES,
      }),
      resolveProviderCredential: async () => {
        credentialAttempts += 1;
        if (credentialAttempts === 1) throw new Error("credential vault unavailable");
        return {
          ...EXECUTION_BINDING,
          fields: { accessToken: SHOPIFY_TOKEN },
          grantedScopes: WRITE_SCOPES,
          provider: "shopify",
          resourceDefaults: SHOP_RESOURCE,
        };
      },
    });
    const scopedRequest = fulfillmentRequest("shopify-fulfillment-retry-preparation");
    const decision = await dependencies.authorizeToolCall(scopedRequest);
    if (decision.action !== "allow") throw new Error("Expected tool authorization to allow.");

    expect(dependencies.executeToolCall({ ...scopedRequest, decision })).rejects.toBeInstanceOf(
      RuntimeToolPreparationRetryableError,
    );
    expect(dependencies.executeToolCall({ ...scopedRequest, decision })).resolves.toMatchObject({
      status: "completed",
    });
    expect(releases).toBe(1);
    expect(requests).toBe(1);
  });

  test("releases prepared handoff reservations with retryable provider responses", async () => {
    const toolCallId = "01J00000000000000000000025" as Ulid;
    let claimReleases = 0;
    let reservationReleases = 0;
    const mutationClaims: RuntimeProviderMutationClaimStore = {
      begin: async (input) => ({
        action: "execute",
        claim: { input, record: {} as never } as RuntimeProviderMutationClaim,
      }),
      fail: async () => {
        throw new Error("retryable responses must not persist known failure");
      },
      markUnknown: async () => {
        throw new Error("retryable responses must not become unknown");
      },
      release: async () => {
        claimReleases += 1;
      },
      succeed: async () => {},
    };
    const dependencies = createRuntimeToolDependencies({
      dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
      egressAllowlists: { read: async () => [] },
      executor: {
        dnsLookup: PUBLIC_DNS,
        pinnedRequest: async () => new Response(null, { status: 429 }),
      },
      generateId: generatedIds(toolCallId),
      mutationClaims,
      prepareProviderInput: async () => ({
        input: fulfillmentInput("Prepared fulfillment"),
        releaseOnRetry: async () => {
          reservationReleases += 1;
        },
      }),
      resolveAuthorizationContext: async () => ({
        ...EXECUTION_BINDING,
        connectorProvider: "shopify",
        grantedScopes: WRITE_SCOPES,
        policyRules: FULFILLMENT_RULES,
      }),
      resolveProviderCredential: async () => ({
        ...EXECUTION_BINDING,
        fields: { accessToken: SHOPIFY_TOKEN },
        grantedScopes: WRITE_SCOPES,
        provider: "shopify",
        resourceDefaults: SHOP_RESOURCE,
      }),
    });
    const scopedRequest = fulfillmentRequest("shopify-handoff-retry");
    const decision = allowedDecision(await dependencies.authorizeToolCall(scopedRequest));

    expect(dependencies.executeToolCall({ ...scopedRequest, decision })).rejects.toBeInstanceOf(
      RuntimeToolPreparationRetryableError,
    );
    expect(reservationReleases).toBe(1);
    expect(claimReleases).toBe(1);
  });

  test("persists permanent credential preparation failures without retrying", async () => {
    const toolCallId = "01J00000000000000000000024" as Ulid;
    let failedClaims = 0;
    let releasedClaims = 0;
    const mutationClaims: RuntimeProviderMutationClaimStore = {
      begin: async (input) => ({
        action: "execute",
        claim: { input, record: {} as never } as RuntimeProviderMutationClaim,
      }),
      fail: async () => {
        failedClaims += 1;
      },
      markUnknown: async () => {
        throw new Error("must not quarantine an undispatched request");
      },
      release: async () => {
        releasedClaims += 1;
      },
      succeed: async () => {},
    };
    const dependencies = createRuntimeToolDependencies({
      dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
      egressAllowlists: { read: async () => [] },
      generateId: generatedIds(toolCallId),
      mutationClaims,
      resolveAuthorizationContext: async () => ({
        ...EXECUTION_BINDING,
        connectorProvider: "shopify",
        grantedScopes: WRITE_SCOPES,
        policyRules: FULFILLMENT_RULES,
      }),
      resolveProviderCredential: async () => {
        throw new RuntimeToolExecutionKnownFailureError(
          "shopify.fulfillments.create",
          new Error("Provider authorization was revoked."),
        );
      },
    });
    const scopedRequest = fulfillmentRequest("shopify-fulfillment-revoked-credential");
    const decision = await dependencies.authorizeToolCall(scopedRequest);
    if (decision.action !== "allow") throw new Error("Expected tool authorization to allow.");

    expect(dependencies.executeToolCall({ ...scopedRequest, decision })).rejects.toBeInstanceOf(
      RuntimeToolExecutionKnownFailureError,
    );
    expect(failedClaims).toBe(1);
    expect(releasedClaims).toBe(0);
  });

  test("resolves and executes an arbitrary persisted MCP read tool", async () => {
    const toolCallId = "01J00000000000000000000025" as Ulid;
    const definition: ToolAdapterDefinition = {
      auditMetadata: { mcpToolName: "search-customer-records" },
      defaultPolicyAction: "allow",
      description: "Search customer records.",
      effect: "read",
      execution: {
        mcpServerId: "01J00000000000000000000028",
        remoteToolName: "search-customer-records",
        type: "mcp",
      },
      inputSchema: {
        additionalProperties: false,
        properties: { query: { type: "string" } },
        required: ["query"],
        type: "object",
      },
      provider: "mcp",
      requiredScopes: ["customer:read"],
      status: "active",
      toolName: "vertical.customer.search",
    };
    let remoteToolName: string | undefined;
    const dependencies = createRuntimeToolDependencies({
      dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
      egressAllowlists: { read: async () => [] },
      executeMcpTool: async (_runtimeRequest, _adapter, name) => {
        remoteToolName = name;
        return { outputSummary: "One customer", status: "completed" };
      },
      generateId: generatedIds(toolCallId),
      resolveAuthorizationContext: async () => {
        throw new Error("provider resolver should not be used");
      },
      resolveExtensionToolDefinition: async (toolName, context) => {
        expect(context.environmentId).toBe(ids.environmentId);
        return toolName === definition.toolName ? definition : undefined;
      },
      resolveMcpAuthorizationContext: async () => ({
        ...EXECUTION_BINDING,
        connectorProvider: "mcp",
        grantedScopes: ["customer:read"],
      }),
      resolveProviderCredential: async () => {
        throw new Error("provider credential should not be used");
      },
    });
    const scopedRequest = request({
      effect: "read",
      idempotencyKey: "vertical-customer-search",
      input: { query: "Ada" },
      inputSummary: "Search customers",
      requiredScopes: ["customer:read"],
      toolName: definition.toolName,
    });

    const decision = allowedDecision(await dependencies.authorizeToolCall(scopedRequest));
    expect(dependencies.executeToolCall({ ...scopedRequest, decision })).resolves.toMatchObject({
      outputSummary: "One customer",
      status: "completed",
    });
    expect(remoteToolName).toBe("search-customer-records");
  });
});
