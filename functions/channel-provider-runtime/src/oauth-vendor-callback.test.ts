import { describe, expect, test } from "bun:test";
import { providerOAuthMaterialFromCredentialValues } from "@deployments-ai/credential-vault";
import { ProviderApplicationRecord, withCanonicalRecordKeys } from "@deployments-ai/db";
import { Schema } from "effect";

import { handleOAuthApi } from "./oauth-callbacks.ts";
import {
  ATTEMPT_ID,
  CIMD_CLIENT_ID,
  formBody,
  header,
  jsonResponse,
  NOTION_ENDPOINT,
  NOW,
  oauthHarness,
  PKCE_VERIFIER,
  PUBLIC_ORIGIN,
  putRecord,
  SCOPE,
  SLACK_APPLICATION_ID,
  SLACK_ENDPOINT,
  RETURN_TO,
  SLACK_RESOURCE,
  seedVendorAttempt,
  STATE,
  ulid,
  type OAuthHarness,
} from "./oauth-test-support.ts";

const NOTION_ISSUER = "https://mcp.notion.example";

function callbackEvent(provider: string, query: Readonly<Record<string, string>>) {
  return {
    pathParameters: { provider },
    queryStringParameters: { state: STATE, ...query },
    requestContext: {
      http: { method: "GET", path: `/public/provider-connections/oauth/callback/${provider}` },
    },
  };
}

function authorizedConnection(harness: OAuthHarness) {
  const operations = harness.authorizations[0] ?? [];
  const put = operations.find(
    (operation) => operation.kind === "put" && operation.record.itemType === "provider-connection",
  );
  if (!put || put.kind !== "put" || put.record.itemType !== "provider-connection") {
    throw new Error("No provider connection was persisted.");
  }
  return put.record;
}

describe("vendor MCP client metadata document", () => {
  test("publishes the environment CIMD with every vendor MCP callback", async () => {
    const harness = oauthHarness();
    const result = await handleOAuthApi(
      {
        requestContext: {
          http: { method: "GET", path: "/public/provider-connections/oauth/client-metadata.json" },
        },
      },
      harness.dependencies,
    );
    expect(result.statusCode).toBe(200);
    expect(result.headers).toEqual({
      "cache-control": "public, max-age=300",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(result.body))).toEqual({
      application_type: "web",
      client_id: CIMD_CLIENT_ID,
      client_name: "Deployments.ai",
      client_uri: "https://deployments.ai",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [
        `${PUBLIC_ORIGIN}/public/provider-connections/oauth/callback/notion`,
        `${PUBLIC_ORIGIN}/public/provider-connections/oauth/callback/slack-mcp`,
      ],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  test("is not served when the public origin is unset", async () => {
    const harness = oauthHarness([], {});
    const result = await handleOAuthApi(
      {
        requestContext: {
          http: { method: "GET", path: "/public/provider-connections/oauth/client-metadata.json" },
        },
      },
      harness.dependencies,
    );
    expect(result.statusCode).toBe(404);
  });
});

describe("vendor MCP authorization callback", () => {
  const issCases = [
    { iss: NOTION_ISSUER, outcome: "accept", supported: true },
    { iss: undefined, outcome: "reject", supported: true },
    { iss: "https://attacker.example", outcome: "reject", supported: true },
    { iss: `${NOTION_ISSUER}/`, outcome: "reject", supported: true },
    { iss: undefined, outcome: "accept", supported: false },
    { iss: NOTION_ISSUER, outcome: "accept", supported: false },
    { iss: "https://attacker.example", outcome: "reject", supported: false },
  ] as const;

  for (const { iss, outcome, supported } of issCases) {
    test(`${outcome}s iss=${iss ?? "<absent>"} when support=${supported}, before reading the provider error`, async () => {
      const harness = oauthHarness();
      seedVendorAttempt(harness, { oauthIssParameterSupported: supported });
      const result = await handleOAuthApi(
        callbackEvent("notion", {
          error: "access_denied",
          error_description: "Mallory says <script>steal()</script>",
          error_uri: "https://attacker.example/explain",
          ...(iss === undefined ? {} : { iss }),
        }),
        harness.dependencies,
      );
      expect(result.statusCode).toBe(303);
      expect(result.body).toBeUndefined();
      const location = new URL(String(result.headers?.location));
      expect(location.origin + location.pathname).toBe(RETURN_TO.split("?")[0]!);
      expect(Object.fromEntries(location.searchParams)).toEqual({
        error: outcome === "accept" ? "access_denied" : "authorization_failed",
        tab: "apps",
      });
      expect(harness.fetches).toEqual([]);
      expect(harness.authorizations).toEqual([]);
    });
  }

  test("reports any other provider error generically", async () => {
    const harness = oauthHarness();
    seedVendorAttempt(harness, {});
    const result = await handleOAuthApi(
      callbackEvent("notion", { error: "server_error", iss: NOTION_ISSUER }),
      harness.dependencies,
    );
    expect(new URL(String(result.headers?.location)).searchParams.get("error")).toBe(
      "authorization_failed",
    );
  });

  test("rejects a mismatched iss without exchanging the code", async () => {
    const harness = oauthHarness();
    seedVendorAttempt(harness, {});
    harness.respond = async () => jsonResponse({ access_token: "token" });
    const result = await handleOAuthApi(
      callbackEvent("notion", { code: "auth-code", iss: "https://attacker.example" }),
      harness.dependencies,
    );
    expect(result.statusCode).toBe(303);
    expect(new URL(String(result.headers?.location)).searchParams.get("error")).toBe(
      "authorization_failed",
    );
    expect(harness.fetches).toEqual([]);
  });

  test("exchanges a CIMD code as a public client with the exact resource and PKCE verifier", async () => {
    const harness = oauthHarness();
    seedVendorAttempt(harness, {});
    harness.respond = async () =>
      jsonResponse({
        access_token: "access-1",
        expires_in: 3600,
        refresh_token: "refresh-1",
        scope: "read write",
        token_type: "Bearer",
      });
    const result = await handleOAuthApi(
      callbackEvent("notion", { code: "auth-code", iss: NOTION_ISSUER }),
      harness.dependencies,
    );
    expect(result.statusCode).toBe(303);
    const location = new URL(String(result.headers?.location));
    expect(Object.fromEntries(location.searchParams)).toEqual({
      connection_id: authorizedConnection(harness).data.id,
      provider: "notion",
      tab: "apps",
    });
    expect(harness.fetches).toHaveLength(1);
    const [request] = harness.fetches;
    expect(request?.url).toBe("https://mcp.notion.example/token");
    expect(request?.init.redirect).toBe("error");
    expect(header(request!.init, "authorization")).toBeNull();
    expect(formBody(request!.init)).toEqual({
      client_id: CIMD_CLIENT_ID,
      code: "auth-code",
      code_verifier: PKCE_VERIFIER,
      grant_type: "authorization_code",
      redirect_uri: `${PUBLIC_ORIGIN}/public/provider-connections/oauth/callback/notion`,
      resource: NOTION_ENDPOINT,
    });

    const connection = authorizedConnection(harness);
    expect(connection.data).toMatchObject({
      authMethod: "oauth",
      authorizationScopes: ["read", "write"],
      externalAccountId: `mcp:${ATTEMPT_ID}`,
      externalAccountName: "Notion",
      oauthClientId: CIMD_CLIENT_ID,
      oauthClientRegistration: "client_id_metadata_document",
      oauthIssuer: NOTION_ISSUER,
      oauthResource: NOTION_ENDPOINT,
      providerKey: "notion",
      scopes: ["tools:read", "tools:write"],
      status: "active",
    });
    expect(connection.data).not.toHaveProperty("providerApplicationId");
    // Token expiry is computed from the wall clock when the token response is parsed.
    const expiresInMs = Date.parse(String(connection.data.refreshAfter)) - Date.now();
    expect(expiresInMs).toBeGreaterThan(3_590_000);
    expect(expiresInMs).toBeLessThanOrEqual(3_600_000);
    const [credential] = harness.vaultWrites;
    expect(credential?.secret.scopes).toEqual(["read", "write"]);
    expect(
      providerOAuthMaterialFromCredentialValues(credential!.secret.values).resource,
    ).toBeUndefined();
    expect(credential?.secret.values.refreshToken).toBe("refresh-1");
  });

  test("uses the pinned PRM resource on the wire, client_secret_basic, and the token subject", async () => {
    const harness = oauthHarness();
    const secretId = ulid(13);
    harness.vaultEntries.set(secretId, {
      document: {
        createdAt: NOW.toISOString(),
        generation: 0,
        schemaVersion: 1,
        updatedAt: NOW.toISOString(),
        values: { clientSecret: "slack-secret" },
      },
      ownerId: SLACK_APPLICATION_ID,
      purpose: "provider-oauth-client-secret",
    });
    putRecord(
      harness,
      Schema.decodeUnknownSync(ProviderApplicationRecord)(
        withCanonicalRecordKeys({
          itemType: "provider-application" as const,
          data: {
            ...SCOPE,
            clientId: "slack-client",
            clientSecretRef: { credentialId: secretId, generation: 0, store: "dynamodb-kms" },
            createdAt: NOW.toISOString(),
            displayName: "Slack MCP",
            id: SLACK_APPLICATION_ID,
            providerKey: "slack_mcp",
            redirectUris: [`${PUBLIC_ORIGIN}/public/provider-connections/oauth/callback/slack-mcp`],
            registration: {
              issuer: "https://slack.example",
              method: "pre_registered",
              tokenEndpointAuthMethod: "client_secret_basic",
            },
            requestedScopes: ["chat:write", "search:read"],
            status: "active",
            updatedAt: NOW.toISOString(),
            version: 0,
          },
        }),
      ),
    );
    seedVendorAttempt(harness, {
      oauthClientId: "slack-client",
      oauthClientRegistration: "pre_registered",
      oauthIssParameterSupported: false,
      oauthIssuer: "https://slack.example",
      providerApplicationId: SLACK_APPLICATION_ID,
      providerKey: "slack_mcp",
      requestedResource: SLACK_ENDPOINT,
      requestedScopes: ["chat:write", "search:read"],
    });
    harness.respond = async () => jsonResponse({ access_token: "access-1", sub: "U123" });
    const result = await handleOAuthApi(
      callbackEvent("slack-mcp", { code: "auth-code" }),
      harness.dependencies,
    );
    expect(result.statusCode).toBe(303);
    expect(new URL(String(result.headers?.location)).searchParams.get("provider")).toBe(
      "slack_mcp",
    );
    const init = harness.fetches[0]!.init;
    expect(header(init, "authorization")).toBe(
      `Basic ${Buffer.from("slack-client:slack-secret").toString("base64")}`,
    );
    const body = formBody(init);
    expect(body.resource).toBe(SLACK_RESOURCE);
    expect(body).not.toHaveProperty("client_secret");
    expect(body.code_verifier).toBe(PKCE_VERIFIER);
    expect(authorizedConnection(harness).data).toMatchObject({
      authorizationScopes: ["chat:write", "search:read"],
      externalAccountId: "U123",
      oauthClientId: "slack-client",
      oauthClientRegistration: "pre_registered",
      oauthResource: SLACK_ENDPOINT,
      providerApplicationId: SLACK_APPLICATION_ID,
    });
    expect(
      providerOAuthMaterialFromCredentialValues(harness.vaultWrites[0]!.secret.values).resource,
    ).toBeUndefined();
  });

  test("names the operator access the attempt was started under on the authorization audit", async () => {
    const grantId = ulid(13);
    const audits = async (data: Readonly<Record<string, unknown>>) => {
      const harness = oauthHarness();
      seedVendorAttempt(harness, data);
      harness.respond = async () =>
        jsonResponse({ access_token: "access-1", refresh_token: "refresh-1" });
      await handleOAuthApi(
        callbackEvent("notion", { code: "auth-code", iss: NOTION_ISSUER }),
        harness.dependencies,
      );
      return (harness.authorizations[0] ?? []).flatMap((operation) =>
        operation.kind === "put" && operation.record.itemType === "audit-event"
          ? [operation.record.data.actor]
          : [],
      );
    };

    expect(await audits({ operatorAccessGrantId: grantId })).toEqual([
      { id: ulid(12), operatorAccessGrantId: grantId, type: "principal" },
    ]);
    expect(await audits({})).toEqual([{ id: ulid(12), type: "principal" }]);
  });

  test("fails closed without a public origin", async () => {
    const harness = oauthHarness([], {});
    seedVendorAttempt(harness, {});
    const result = await handleOAuthApi(
      callbackEvent("notion", { code: "auth-code", iss: NOTION_ISSUER }),
      harness.dependencies,
    );
    expect(result.statusCode).toBe(303);
    expect(new URL(String(result.headers?.location)).searchParams.get("error")).toBe(
      "authorization_failed",
    );
    expect(harness.fetches).toEqual([]);
  });
});
