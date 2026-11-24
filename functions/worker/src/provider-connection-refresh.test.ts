import { describe, expect, test } from "bun:test";
import type { InvokeCommand } from "@aws-sdk/client-lambda";
import { RuntimeToolExecutionKnownFailureError } from "@deployments-ai/agent-runtime";
import type { PlatformRecord } from "@deployments-ai/db";
import {
  OAUTH_REFRESH_REQUEST_KIND,
  type OAuthRefreshRequest,
  type OAuthRefreshResponse,
} from "@deployments-ai/providers";
import { findPlatformToolAdapterDefinition } from "@deployments-ai/tools";
import { createDynamoRuntimeToolResolvers } from "./dynamodb-runtime-tools.ts";
import { createLambdaOAuthRefreshInvoker } from "./oauth-refresh-runtime.ts";
import type { RuntimeCredentialReadInput } from "./runtime-provider-binding.ts";
import {
  authorizedRequest,
  bindingRecords,
  bindingRequest,
  connectionId,
  credentialId,
  environmentId,
  memoryDatabase,
  NOW,
  organizationId,
  projectId,
  providerConnection,
  secretDocument,
  type ProviderConnectionFixtureInput,
} from "./vendor-mcp-runtime.fixture.ts";

const definition = findPlatformToolAdapterDefinition("shopify.products.search")!;

function shopifyConnection(overrides: Partial<ProviderConnectionFixtureInput> = {}) {
  return providerConnection({
    authMethod: "oauth2",
    generation: 3,
    providerKey: "shopify",
    scopes: ["read_products"],
    version: 4,
    ...overrides,
  });
}

function harness(
  options: {
    readonly refresh?: (request: OAuthRefreshRequest) => Promise<OAuthRefreshResponse>;
    readonly refreshAfter?: string;
  } = {},
) {
  const seeded = bindingRecords({
    authMethod: "oauth2",
    connectionScopes: ["read_products"],
    providerKey: "shopify",
    ...(options.refreshAfter ? { refreshAfter: options.refreshAfter } : {}),
    toolNames: [definition.toolName],
  });
  const { database, put } = memoryDatabase(Object.values(seeded));
  const reads: RuntimeCredentialReadInput[] = [];
  const resolvers = createDynamoRuntimeToolResolvers({
    database,
    now: () => NOW,
    readCredential: async (input) => {
      reads.push(input);
      return secretDocument({ accessToken: "shopify-token" }, input.reference.generation);
    },
    ...(options.refresh ? { refreshConnection: options.refresh } : {}),
  });
  const fingerprint = async () =>
    (await resolvers.resolveAuthorizationContext(bindingRequest(definition), definition))
      ?.authorizationFingerprint;
  return { fingerprint, put, reads, resolvers };
}

describe("provider connection authorization fingerprint", () => {
  test("survives token refresh churn but changes with connection authority", async () => {
    const { fingerprint, put } = harness();
    const original = await fingerprint();
    expect(original).toBeString();

    put(
      shopifyConnection({
        generation: 9,
        refreshAfter: "2026-10-02T00:00:00.000Z",
        version: 12,
      }),
    );
    expect(await fingerprint()).toBe(original);

    put(shopifyConnection({ scopes: ["read_products", "write_fulfillments"] }));
    const widened = await fingerprint();
    expect(widened).toBeString();
    expect(widened).not.toBe(original);

    put(shopifyConnection({ oauthIssuer: "https://shop.example" }));
    const reissued = await fingerprint();
    expect(reissued).not.toBe(original);
    expect(reissued).not.toBe(widened);
  });
});

describe("provider-native OAuth refresh", () => {
  test("refreshes an expiring connection before reading the new credential generation", async () => {
    const refreshes: OAuthRefreshRequest[] = [];
    const state: { put?: (record: PlatformRecord) => void } = {};
    const { fingerprint, put, reads, resolvers } = harness({
      refresh: async (request) => {
        refreshes.push(request);
        state.put!(
          shopifyConnection({
            generation: 4,
            refreshAfter: "2026-10-01T14:00:00.000Z",
            version: 5,
          }),
        );
        return {
          reference: { credentialId, generation: 4, store: "dynamodb-kms" },
          status: "refreshed",
        };
      },
      refreshAfter: "2026-10-01T12:01:00.000Z",
    });
    state.put = put;
    const pinned = await fingerprint();

    const credential = await resolvers.resolveProviderCredential(
      authorizedRequest(bindingRequest(definition), {
        authorizationFingerprint: pinned!,
        connectionId,
        externalAccountId: "account-1",
        toolPlanFingerprint: "plan",
      }),
      definition as never,
    );

    expect(refreshes).toEqual([
      {
        connectionId,
        environmentId,
        expectedGeneration: 3,
        kind: OAUTH_REFRESH_REQUEST_KIND,
        organizationId,
        projectId,
        requestedBy: "worker",
      },
    ]);
    expect(reads.map((read) => read.reference.generation)).toEqual([4]);
    expect(credential.fields).toEqual({ accessToken: "shopify-token" });
    expect(credential.authorizationFingerprint).toBe(pinned);
  });

  test("fails as a known failure when the grant must be re-authorized", async () => {
    const { fingerprint, reads, resolvers } = harness({
      refresh: async () => ({
        code: "invalid_grant",
        message: "Refresh token revoked.",
        status: "reauthorization_required",
      }),
      refreshAfter: "2026-10-01T12:00:10.000Z",
    });
    const pinned = await fingerprint();
    expect(
      resolvers.resolveProviderCredential(
        authorizedRequest(bindingRequest(definition), {
          authorizationFingerprint: pinned!,
          connectionId,
          externalAccountId: "account-1",
          toolPlanFingerprint: "plan",
        }),
        definition as never,
      ),
    ).rejects.toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
    expect(reads).toHaveLength(0);
  });
});

describe("Lambda OAuth refresh invoker", () => {
  const request: OAuthRefreshRequest = {
    connectionId,
    environmentId,
    expectedGeneration: 3,
    kind: OAUTH_REFRESH_REQUEST_KIND,
    organizationId,
    projectId,
    requestedBy: "worker",
  };

  test("invokes synchronously and parses the refresh response", async () => {
    const sent: InvokeCommand[] = [];
    const invoke = createLambdaOAuthRefreshInvoker({
      client: {
        send: (async (command: InvokeCommand) => {
          sent.push(command);
          return {
            Payload: new TextEncoder().encode(
              JSON.stringify({
                reference: { credentialId, generation: 4, store: "dynamodb-kms" },
                status: "refreshed",
              }),
            ),
          };
        }) as never,
      },
      functionName: "oauth-refresh",
    });
    expect(invoke(request)).resolves.toEqual({
      reference: { credentialId, generation: 4, store: "dynamodb-kms" },
      status: "refreshed",
    });
    expect(sent[0]?.input).toMatchObject({
      FunctionName: "oauth-refresh",
      InvocationType: "RequestResponse",
    });
    expect(JSON.parse(Buffer.from(sent[0]!.input.Payload as Uint8Array).toString("utf8"))).toEqual(
      request,
    );
  });

  test("treats function errors, transport failures, and invalid payloads as retryable", async () => {
    for (const send of [
      async () => ({ FunctionError: "Unhandled", Payload: new TextEncoder().encode("{}") }),
      async () => {
        throw new Error("socket hang up");
      },
      async () => ({ Payload: new TextEncoder().encode('{"status":"weird"}') }),
    ]) {
      const invoke = createLambdaOAuthRefreshInvoker({
        client: { send: send as never },
        functionName: "oauth-refresh",
      });
      expect(invoke(request)).resolves.toMatchObject({ status: "retryable" });
    }
  });
});
