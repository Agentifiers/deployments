import { ProviderApplicationRecord, withCanonicalRecordKeys } from "@deployments-ai/db";
import { McpAuthorizationDiscoveryError } from "@deployments-ai/mcp-client";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import { createAdministrationApi } from "./administration-api.ts";
import {
  CIMD_URL,
  ENVIRONMENT_ID,
  ORGANIZATION_ID,
  PRINCIPAL_ID,
  PROJECT_ID,
  PUBLIC_ORIGIN,
  RETURN_ORIGIN,
  invocation,
  pinnedDiscovery,
  vendorMcpFixture,
  type VendorMcpFixture as Fixture,
} from "./vendor-mcp-authorization.fixture.ts";

const LINEAR_CALLBACK = `${PUBLIC_ORIGIN}/public/provider-connections/oauth/callback/linear`;
const ACME_CALLBACK = `${PUBLIC_ORIGIN}/public/provider-connections/oauth/callback/acme-desk`;

async function begin(fixture: Fixture, body: Readonly<Record<string, unknown>>) {
  const result = (await fixture.service.invoke("beginProviderAuthorization", invocation(body))) as {
    readonly authorizationUrl: string;
  };
  return new URL(result.authorizationUrl);
}

function latestAttempt(fixture: Fixture) {
  return fixture.recordsOf("oauth-authorization-attempt").at(-1)!.data;
}

function latestVerifier(fixture: Fixture) {
  return fixture.credentialWrites
    .filter((write) => write.identity.purpose === "oauth-pkce-verifier")
    .at(-1)!.secret.values.verifier!;
}

async function registerApplication(fixture: Fixture, body: Readonly<Record<string, unknown>>) {
  return (await fixture.service.invoke("createProviderApplication", invocation(body))) as {
    readonly id: string;
  };
}

describe("vendor MCP authorization begin", () => {
  test("uses the client ID metadata document with the pinned resource, PKCE S256, and callback", async () => {
    const fixture = vendorMcpFixture();
    const url = await begin(fixture, {
      providerKey: "notion",
      returnTo: `${RETURN_ORIGIN}/connections?tab=apps`,
    });

    expect(url.origin + url.pathname).toBe("https://mcp.notion.example/authorize");
    expect(url.searchParams.get("client_id")).toBe(CIMD_URL);
    // The wire resource is the PRM resource (origin), not the MCP endpoint path.
    expect(url.searchParams.getAll("resource")).toEqual(["https://mcp.notion.example"]);
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${PUBLIC_ORIGIN}/public/provider-connections/oauth/callback/notion`,
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(latestVerifier(fixture)).digest("base64url"),
    );
    const state = url.searchParams.get("state")!;
    expect(state.split(".").slice(0, 3)).toEqual([ORGANIZATION_ID, PROJECT_ID, ENVIRONMENT_ID]);

    expect(fixture.discoveryInputs).toEqual([
      {
        mcpUrl: "https://mcp.notion.example/mcp",
        pinnedIssuer: "https://mcp.notion.example",
        protectedResourceMetadata: "published",
      },
    ]);
    const attempt = latestAttempt(fixture);
    expect(attempt).toMatchObject({
      oauthClientId: CIMD_URL,
      oauthClientRegistration: "client_id_metadata_document",
      oauthIssParameterSupported: true,
      oauthIssuer: "https://mcp.notion.example",
      principalId: PRINCIPAL_ID,
      providerKey: "notion",
      requestedResource: "https://mcp.notion.example/mcp",
      returnTo: `${RETURN_ORIGIN}/connections?tab=apps`,
      stateHash: createHash("sha256").update(state).digest("hex"),
      status: "pending",
    });
    expect(attempt.providerApplicationId).toBeUndefined();
    expect(fixture.registrations).toHaveLength(0);
    expect(fixture.recordsOf("provider-application")).toHaveLength(0);
  });

  test("stores no returnTo when omitted", async () => {
    const fixture = vendorMcpFixture();
    await begin(fixture, { providerKey: "notion" });
    expect(latestAttempt(fixture)).not.toHaveProperty("returnTo");
  });

  test("rejects a returnTo outside the allowlist with 422 before any discovery or write", async () => {
    for (const returnTo of [
      "/connections",
      `http://app.example.test/connections`,
      `${RETURN_ORIGIN}/connections#fragment`,
      `https://user@app.example.test/connections`,
      "https://evil.example/connections",
      42,
    ]) {
      const fixture = vendorMcpFixture();
      expect(
        fixture.service.invoke(
          "beginProviderAuthorization",
          invocation({ providerKey: "notion", returnTo }),
        ),
      ).rejects.toMatchObject({ code: "invalid_return_to", kind: "unprocessable" });
      expect(fixture.discoveryInputs).toHaveLength(0);
      expect(fixture.recordsOf("oauth-authorization-attempt")).toHaveLength(0);
    }
  });

  test("registers one dynamic client with a vaulted secret and reuses it on the next begin", async () => {
    const fixture = vendorMcpFixture({
      register: async () => ({
        clientId: "dcr-client",
        clientSecret: "dcr-secret",
        tokenEndpointAuthMethod: "client_secret_post",
      }),
    });
    const first = await begin(fixture, { providerKey: "linear" });

    expect(fixture.registrations).toEqual([
      {
        metadata: {
          application_type: "web",
          client_name: "Deployments.ai",
          client_uri: "https://deployments.ai",
          grant_types: ["authorization_code", "refresh_token"],
          redirect_uris: [LINEAR_CALLBACK],
          response_types: ["code"],
          token_endpoint_auth_method: "client_secret_post",
        },
        registrationEndpoint: "https://auth.linear.example/register",
      },
    ]);
    const [application] = fixture.recordsOf("provider-application");
    expect(application?.data).toMatchObject({
      clientId: "dcr-client",
      providerKey: "linear",
      redirectUris: [LINEAR_CALLBACK],
      registration: {
        issuer: "https://auth.linear.example",
        method: "dynamic_client_registration",
        registeredAt: "2026-10-01T12:00:00.000Z",
        tokenEndpointAuthMethod: "client_secret_post",
      },
      requestedScopes: ["read", "write"],
      status: "active",
    });
    const secretRef = application!.data.clientSecretRef as { readonly credentialId: string };
    expect(fixture.secrets.get(secretRef.credentialId)).toEqual({ clientSecret: "dcr-secret" });
    expect(
      fixture.credentialWrites.find((write) => write.identity.ownerId === application!.data.id)
        ?.identity,
    ).toMatchObject({ ownerType: "provider-application", purpose: "provider-oauth-client-secret" });
    const claims = fixture.recordsOf("unique-claim").map((claim) => claim.data);
    expect(claims).toContainEqual(
      expect.objectContaining({
        namespace: `environment:${ENVIRONMENT_ID}:provider-application-registration:linear`,
        value: "https://auth.linear.example",
      }),
    );
    expect(claims).toContainEqual(
      expect.objectContaining({
        namespace: `environment:${ENVIRONMENT_ID}:provider-application:linear`,
        value: "dcr-client",
      }),
    );
    expect(first.searchParams.get("client_id")).toBe("dcr-client");
    expect(first.searchParams.get("scope")).toBe("read write");
    expect(first.searchParams.get("resource")).toBe("https://mcp.linear.example/mcp");
    expect(latestAttempt(fixture)).toMatchObject({
      oauthClientId: "dcr-client",
      oauthClientRegistration: "dynamic_client_registration",
      oauthIssParameterSupported: false,
      providerApplicationId: application!.data.id,
    });

    const second = await begin(fixture, { providerKey: "linear", requestedScopes: ["read"] });
    expect(fixture.registrations).toHaveLength(1);
    expect(fixture.recordsOf("provider-application")).toHaveLength(1);
    expect(second.searchParams.get("client_id")).toBe("dcr-client");
    expect(second.searchParams.get("scope")).toBe("read");
  });

  test("a concurrent registration loser uses the winner's client", async () => {
    let fixture: Fixture | undefined;
    let raced = false;
    let winnerUrl: URL | undefined;
    fixture = vendorMcpFixture({
      register: async () => {
        if (!raced) {
          raced = true;
          // A second begin registers and commits while the first is still registering.
          winnerUrl = await begin(fixture!, { providerKey: "linear" });
          return {
            clientId: "loser-client",
            clientSecret: "loser-secret",
            tokenEndpointAuthMethod: "client_secret_post",
          };
        }
        return {
          clientId: "winner-client",
          clientSecret: "winner-secret",
          tokenEndpointAuthMethod: "client_secret_post",
        };
      },
    });
    const loserUrl = await begin(fixture, { providerKey: "linear" });

    expect(winnerUrl?.searchParams.get("client_id")).toBe("winner-client");
    expect(loserUrl.searchParams.get("client_id")).toBe("winner-client");
    expect(fixture.recordsOf("provider-application").map((record) => record.data.clientId)).toEqual(
      ["winner-client"],
    );
    expect(fixture.recordsOf("oauth-authorization-attempt")).toHaveLength(2);
  });

  test("prefers a pre-registered application over an existing dynamic registration", async () => {
    const fixture = vendorMcpFixture({
      register: async () => ({
        clientId: "dcr-client",
        clientSecret: "dcr-secret",
        tokenEndpointAuthMethod: "client_secret_post",
      }),
    });
    await begin(fixture, { providerKey: "linear" });
    const application = await registerApplication(fixture, {
      clientId: "operator-client",
      clientSecret: "operator-secret",
      displayName: "Linear production",
      providerKey: "linear",
      redirectUris: [LINEAR_CALLBACK],
      requestedScopes: ["read", "write"],
    });

    const url = await begin(fixture, { providerKey: "linear" });
    expect(url.searchParams.get("client_id")).toBe("operator-client");
    expect(latestAttempt(fixture)).toMatchObject({
      oauthClientId: "operator-client",
      oauthClientRegistration: "pre_registered",
      providerApplicationId: application.id,
    });
    expect(fixture.registrations).toHaveLength(1);
  });

  test("fails closed with 409 on pin drift and 502 on discovery failure", async () => {
    const drifted = vendorMcpFixture({
      discover: async (input) => {
        const live = pinnedDiscovery(input.mcpUrl);
        return {
          ...live,
          authorizationServer: {
            ...live.authorizationServer,
            tokenEndpoint: "https://attacker.example/token",
          },
        };
      },
    });
    const mismatch = drifted.service.invoke(
      "beginProviderAuthorization",
      invocation({ providerKey: "notion" }),
    );
    expect(mismatch).rejects.toMatchObject({
      code: "mcp_authorization_server_mismatch",
      status: 409,
    });
    expect(mismatch).rejects.toThrow("https://attacker.example/token");

    for (const failure of [
      new McpAuthorizationDiscoveryError("network", "Protected resource metadata unreachable."),
      new TypeError("fetch failed"),
    ]) {
      const unreachable = vendorMcpFixture({
        discover: async () => {
          throw failure;
        },
      });
      expect(
        unreachable.service.invoke(
          "beginProviderAuthorization",
          invocation({ providerKey: "notion" }),
        ),
      ).rejects.toMatchObject({ code: "mcp_discovery_failed", status: 502 });
      expect(unreachable.recordsOf("oauth-authorization-attempt")).toHaveLength(0);
    }

    const issuerMismatch = vendorMcpFixture({
      discover: async () => {
        throw new McpAuthorizationDiscoveryError("issuer_mismatch", "Metadata issuer differs.");
      },
    });
    expect(
      issuerMismatch.service.invoke(
        "beginProviderAuthorization",
        invocation({ providerKey: "notion" }),
      ),
    ).rejects.toMatchObject({ code: "mcp_authorization_server_mismatch", status: 409 });
    expect(drifted.recordsOf("oauth-authorization-attempt")).toHaveLength(0);
  });

  test("maps vendor MCP failures to HTTP problems at the administration boundary", async () => {
    const fetch = (fixture: Fixture) =>
      createAdministrationApi({
        authenticate: async () => ({
          environmentIds: [ENVIRONMENT_ID],
          organizationIds: [ORGANIZATION_ID],
          principalId: PRINCIPAL_ID,
          projectIds: [PROJECT_ID],
          scopes: ["platform:admin"],
        }),
        authorize: async () => undefined,
        idempotency: { execute: async (input) => input.operation() },
        requestId: () => "vendor_mcp_test",
        service: fixture.service,
      });
    const request = () =>
      new Request("https://api.example/v1/connections", {
        body: JSON.stringify({ providerKey: "notion" }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": `key-${crypto.randomUUID()}`,
          "x-deployments-environment": ENVIRONMENT_ID,
        },
        method: "POST",
      });
    const unconfigured = await fetch(vendorMcpFixture({ vendorMcp: false }))(request());
    expect(unconfigured?.status).toBe(503);
    expect(await unconfigured!.json()).toMatchObject({ code: "vendor_mcp_unconfigured" });

    const failing = vendorMcpFixture({
      discover: async () => {
        throw new McpAuthorizationDiscoveryError("network", "unreachable");
      },
    });
    const failed = await fetch(failing)(request());
    expect(failed?.status).toBe(502);
    expect(await failed!.json()).toMatchObject({ code: "mcp_discovery_failed" });
  });

  test("requires a pre-registered client when no registration method is usable", async () => {
    const fixture = vendorMcpFixture();
    const result = fixture.service.invoke(
      "beginProviderAuthorization",
      invocation({
        providerKey: "acme_desk",
        requestedResource: "https://acme.mcp.tenant.example/mcp",
      }),
    );
    expect(result).rejects.toMatchObject({
      code: "provider_application_required",
      kind: "conflict",
    });
    expect(result).rejects.toThrow("https://docs.tenant.example/mcp");

    const noRegistrationEndpoint = vendorMcpFixture({
      discover: async (input) => {
        const live = pinnedDiscovery(input.mcpUrl);
        const { registrationEndpoint: _, ...server } = live.authorizationServer;
        return { ...live, authorizationServer: server };
      },
    });
    expect(
      noRegistrationEndpoint.service.invoke(
        "beginProviderAuthorization",
        invocation({ providerKey: "linear" }),
      ),
    ).rejects.toMatchObject({ code: "provider_application_required" });
    expect(noRegistrationEndpoint.registrations).toHaveLength(0);
  });

  test("accepts templated tenant resources only on allowed host suffixes", async () => {
    const fixture = vendorMcpFixture();
    await registerApplication(fixture, {
      clientId: "acme-client",
      clientSecret: "acme-secret",
      displayName: "Acme Desk",
      providerKey: "acme_desk",
      redirectUris: [ACME_CALLBACK],
      requestedScopes: ["mcp:read"],
    });
    const url = await begin(fixture, {
      providerKey: "acme_desk",
      requestedResource: "https://acme.mcp.tenant.example/mcp",
    });
    expect(url.origin + url.pathname).toBe("https://acme.mcp.tenant.example/oauth/authorize");
    expect(url.searchParams.get("resource")).toBe("https://acme.mcp.tenant.example/mcp");
    expect(url.searchParams.get("client_id")).toBe("acme-client");
    expect(fixture.discoveryInputs.at(-1)).toMatchObject({
      mcpUrl: "https://acme.mcp.tenant.example/mcp",
      pinnedIssuer: "https://acme.mcp.tenant.example",
    });
    expect(latestAttempt(fixture)).toMatchObject({
      oauthIssuer: "https://acme.mcp.tenant.example",
      requestedResource: "https://acme.mcp.tenant.example/mcp",
    });

    for (const requestedResource of [
      undefined,
      "https://acme.evil.example/mcp",
      "https://a.b.mcp.tenant.example/mcp",
      "https://acme.mcp.tenant.example/other",
    ]) {
      expect(
        fixture.service.invoke(
          "beginProviderAuthorization",
          invocation({
            providerKey: "acme_desk",
            ...(requestedResource ? { requestedResource } : {}),
          }),
        ),
      ).rejects.toMatchObject({ code: "invalid_oauth_resource" });
    }
    expect(
      fixture.service.invoke(
        "beginProviderAuthorization",
        invocation({
          providerKey: "notion",
          requestedResource: "https://mcp.notion.example/other",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_oauth_resource" });
    expect(
      fixture.service.invoke(
        "beginProviderAuthorization",
        invocation({ providerKey: "linear", requestedScopes: ["admin"] }),
      ),
    ).rejects.toMatchObject({ code: "invalid_scope" });
  });

  test("rejects an explicit application bound to a different issuer", async () => {
    const fixture = vendorMcpFixture();
    const application = await registerApplication(fixture, {
      clientId: "linear-client",
      clientSecret: "linear-secret",
      displayName: "Linear",
      providerKey: "linear",
      redirectUris: [LINEAR_CALLBACK],
      requestedScopes: ["read"],
    });
    expect(
      fixture.service.invoke(
        "beginProviderAuthorization",
        invocation({ providerApplicationId: application.id, providerKey: "notion" }),
      ),
    ).rejects.toMatchObject({ code: "provider_application_mismatch" });
  });
});

const NOTION_APPLICATION_ID = "01ARZ3NDEKTSV4RRFFQ69G9AP1";

/** A notion application as persisted directly (bypassing createProviderApplication checks). */
function seedNotionApplication(fixture: Fixture, data: Readonly<Record<string, unknown>> = {}) {
  fixture.put(
    Schema.decodeUnknownSync(ProviderApplicationRecord)(
      withCanonicalRecordKeys({
        itemType: "provider-application",
        data: {
          clientId: "legacy-notion-client",
          createdAt: "2026-09-01T00:00:00.000Z",
          displayName: "Notion",
          environmentId: ENVIRONMENT_ID,
          id: NOTION_APPLICATION_ID,
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          providerKey: "notion",
          redirectUris: [`${PUBLIC_ORIGIN}/public/provider-connections/oauth/callback/notion`],
          requestedScopes: [],
          status: "active",
          updatedAt: "2026-09-01T00:00:00.000Z",
          version: 0,
          ...data,
        },
      }),
    ),
  );
}

describe("vendor MCP application selection", () => {
  test("skips registration-less applications so the metadata document applies", async () => {
    const fixture = vendorMcpFixture();
    seedNotionApplication(fixture);

    const url = await begin(fixture, { providerKey: "notion" });

    expect(url.searchParams.get("client_id")).toBe(CIMD_URL);
    expect(latestAttempt(fixture).providerApplicationId).toBeUndefined();
  });

  test("rejects an explicit registration-less application with 409", async () => {
    const fixture = vendorMcpFixture();
    seedNotionApplication(fixture);

    expect(
      fixture.service.invoke(
        "beginProviderAuthorization",
        invocation({ providerApplicationId: NOTION_APPLICATION_ID, providerKey: "notion" }),
      ),
    ).rejects.toMatchObject({ code: "provider_application_mismatch", kind: "conflict" });
  });

  test("rejects an application whose secret contradicts its pinned authentication with 409", async () => {
    const fixture = vendorMcpFixture();
    seedNotionApplication(fixture, {
      clientSecretRef: {
        credentialId: "01ARZ3NDEKTSV4RRFFQ69G9AP2",
        generation: 0,
        store: "dynamodb-kms",
      },
      registration: {
        issuer: "https://mcp.notion.example",
        method: "pre_registered",
        registeredAt: "2026-09-01T00:00:00.000Z",
        tokenEndpointAuthMethod: "none",
      },
    });

    for (const body of [
      { providerKey: "notion" },
      { providerApplicationId: NOTION_APPLICATION_ID, providerKey: "notion" },
    ]) {
      expect(
        fixture.service.invoke("beginProviderAuthorization", invocation(body)),
      ).rejects.toMatchObject({ code: "provider_application_mismatch", kind: "conflict" });
    }
  });
});

describe("vendor MCP oauth-app registration", () => {
  test("persists a pinned pre-registration bound to the pinned issuer", async () => {
    const fixture = vendorMcpFixture();
    await registerApplication(fixture, {
      clientId: "linear-client",
      clientSecret: "linear-secret",
      displayName: "Linear",
      providerKey: "linear",
      redirectUris: [LINEAR_CALLBACK],
      requestedScopes: ["read"],
    });
    await registerApplication(fixture, {
      clientId: "acme-client",
      clientSecret: "acme-secret",
      displayName: "Acme",
      providerKey: "acme_desk",
      redirectUris: [ACME_CALLBACK],
      requestedScopes: [],
    });
    await registerApplication(fixture, {
      clientId: "linear-post",
      clientSecret: "linear-secret",
      displayName: "Linear post",
      providerKey: "linear",
      redirectUris: [LINEAR_CALLBACK],
      registration: { method: "pre_registered", tokenEndpointAuthMethod: "client_secret_post" },
      requestedScopes: ["read"],
    });

    const registrations = Object.fromEntries(
      fixture
        .recordsOf("provider-application")
        .map((record) => [record.data.clientId, record.data.registration]),
    );
    expect(registrations).toEqual({
      "acme-client": {
        method: "pre_registered",
        registeredAt: "2026-10-01T12:00:00.000Z",
        tokenEndpointAuthMethod: "client_secret_basic",
      },
      // Default: the first pinned secret-bearing method in canonical pin order.
      "linear-client": {
        issuer: "https://auth.linear.example",
        method: "pre_registered",
        registeredAt: "2026-10-01T12:00:00.000Z",
        tokenEndpointAuthMethod: "client_secret_basic",
      },
      "linear-post": {
        issuer: "https://auth.linear.example",
        method: "pre_registered",
        registeredAt: "2026-10-01T12:00:00.000Z",
        tokenEndpointAuthMethod: "client_secret_post",
      },
    });
  });

  test("rejects registrations the pins or callback do not allow", async () => {
    const fixture = vendorMcpFixture();
    const base = {
      clientId: "client",
      clientSecret: "secret",
      displayName: "App",
      providerKey: "linear",
      redirectUris: [LINEAR_CALLBACK],
      requestedScopes: ["read"],
    };
    const cases: readonly [Readonly<Record<string, unknown>>, string][] = [
      [{ ...base, providerKey: "notion", requestedScopes: [] }, "registration_method_unsupported"],
      [
        { ...base, redirectUris: ["https://elsewhere.example/callback"] },
        "oauth_redirect_uri_mismatch",
      ],
      [{ ...base, requestedScopes: ["admin"] }, "invalid_scope"],
      [
        { ...base, registration: { method: "dynamic_client_registration" } },
        "invalid_registration",
      ],
      [
        { ...base, registration: { method: "pre_registered", tokenEndpointAuthMethod: "none" } },
        "invalid_registration",
      ],
      [
        {
          ...base,
          providerKey: "github",
          redirectUris: ["https://app.example/oauth/callback"],
          registration: { method: "pre_registered", tokenEndpointAuthMethod: "client_secret_post" },
          requestedScopes: ["repo"],
        },
        "registration_unsupported",
      ],
    ];
    for (const [body, code] of cases) {
      expect(
        fixture.service.invoke("createProviderApplication", invocation(body)),
      ).rejects.toMatchObject({ code });
    }
    expect(fixture.recordsOf("provider-application")).toHaveLength(0);
  });
});
