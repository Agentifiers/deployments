import { describe, expect, test } from "bun:test";
import {
  platformOAuthAuthorizationUrl,
  platformOAuthIssValidation,
  platformOAuthPkceChallenge,
  platformOAuthResourceAllowed,
} from "./platform-oauth-flow.ts";
import { parsePlatformOAuthAppRegistry } from "./platform-oauth-registry.ts";
import { normalizeProviderDefinition } from "./provider-definition-normalization.ts";
import {
  apiKeyInput,
  atlassianLegacyInput,
  notionLikeDiscovery,
  notionLikeInput,
  notionLikeServer,
  tenantTemplatedInput,
} from "./vendor-mcp.fixture.ts";
import { vendorMcpClientMetadataDocument, vendorMcpOAuthAppConfig } from "./vendor-mcp-oauth.ts";
import {
  vendorMcpAuthorizationDrift,
  vendorMcpDiscoveryInput,
  vendorMcpResource,
} from "./vendor-mcp-authorization.ts";

const exampleDefinition = normalizeProviderDefinition({
  ...notionLikeInput,
  key: "example",
  oauthProviderKey: "example-mcp",
  mcpServer: {
    ...notionLikeServer,
    url: "https://mcp.example.com/mcp",
    resource: "https://mcp.example.com/mcp",
  },
});
const publicOrigin = "https://channels.example.test";

describe("vendorMcpOAuthAppConfig", () => {
  const app = vendorMcpOAuthAppConfig({
    definition: exampleDefinition,
    canonicalUrl: "https://mcp.example.com/mcp",
    clientId: `${publicOrigin}/public/provider-connections/oauth/client-metadata.json`,
    clientAuthentication: "none",
    publicOrigin,
  });

  test("synthesizes a canonical-resource PKCE app bound to the callback path", () => {
    expect(app).toMatchObject({
      allowedResources: ["https://mcp.example.com/mcp"],
      authorizationEndpoint: "https://mcp.notion.example/authorize",
      clientAuthentication: "none",
      issuer: "https://mcp.notion.example",
      issParameterSupported: true,
      pkce: true,
      redirectUri:
        "https://channels.example.test/public/provider-connections/oauth/callback/example-mcp",
      refreshTokenRequired: false,
      resourceMode: "canonical_uri",
      tokenEndpoint: "https://mcp.notion.example/token",
      tokenIdentityIdPaths: ["sub"],
    });
    expect(app.identityEndpoint).toBeUndefined();
    expect(app.revocation).toMatchObject({
      mode: "request",
      endpoint: "https://mcp.notion.example/token/revoke",
      method: "POST",
      bodyFormat: "form",
      credential: "refresh_token",
      parameterName: "token",
      params: { token_type_hint: "refresh_token" },
      clientAuthentication: "none",
      includeClientId: true,
    });
  });

  test("authorization URL sends the exact canonical resource and PKCE S256", () => {
    const verifier = "v".repeat(43);
    const authorizationUrl = platformOAuthAuthorizationUrl({
      app,
      resource: "https://mcp.example.com/mcp",
      scopes: [],
      state: "state-value",
      verifier,
    });
    expect(authorizationUrl).toContain("resource=https%3A%2F%2Fmcp.example.com%2Fmcp&");
    const params = new URL(authorizationUrl).searchParams;
    expect(params.get("resource")).toBe("https://mcp.example.com/mcp");
    expect(params.get("code_challenge")).toBe(platformOAuthPkceChallenge(verifier));
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("client_id")).toBe(app.clientId);
    expect(params.get("redirect_uri")).toBe(app.redirectUri);
    expect(params.has("scope")).toBe(false);
  });

  test("canonical resources must match exactly and are required", () => {
    for (const resource of [
      undefined,
      "https://mcp.example.com/mcp/",
      "https://mcp.example.com",
      "https://MCP.example.com/mcp",
      "https://mcp.example.com/mcp#x",
    ]) {
      expect(() =>
        platformOAuthAuthorizationUrl({
          app,
          ...(resource === undefined ? {} : { resource }),
          scopes: [],
          state: "s",
          verifier: "v",
        }),
      ).toThrow("OAuth resource is not allowed");
    }
    expect(platformOAuthResourceAllowed(app, "https://mcp.example.com/mcp")).toBe(true);
    expect(platformOAuthResourceAllowed(app, "https://mcp.example.com/mcp/")).toBe(false);
  });

  test("substitutes templated endpoints and requests pinned scopes", () => {
    const templated = vendorMcpOAuthAppConfig({
      definition: normalizeProviderDefinition(tenantTemplatedInput),
      canonicalUrl: "https://acme.mcp.tenant.example/mcp",
      clientId: "registered-client",
      clientAuthentication: "client_secret_basic",
      publicOrigin,
    });
    expect(templated).toMatchObject({
      allowedResources: ["https://acme.mcp.tenant.example/mcp"],
      authorizationEndpoint: "https://acme.mcp.tenant.example/oauth/authorize",
      issuer: "https://acme.mcp.tenant.example",
      tokenEndpoint: "https://acme.mcp.tenant.example/oauth/token",
    });
    expect(templated.revocation).toBeUndefined();
    const url = new URL(
      platformOAuthAuthorizationUrl({
        app: templated,
        resource: "https://acme.mcp.tenant.example/mcp",
        scopes: tenantTemplatedInput.mcpServer.authorization.scopes,
        state: "s",
        verifier: "v",
      }),
    );
    expect(url.searchParams.get("scope")).toBe("mcp:read mcp:write");
  });

  test("rejects unpinned client auth, non-oauth definitions, and bad origins", () => {
    const base = {
      definition: exampleDefinition,
      canonicalUrl: "https://mcp.example.com/mcp",
      clientId: "client",
      clientAuthentication: "none",
      publicOrigin,
    } as const;
    expect(() =>
      vendorMcpOAuthAppConfig({ ...base, clientAuthentication: "client_secret_post" }),
    ).toThrow("not pinned");
    expect(() =>
      vendorMcpOAuthAppConfig({ ...base, definition: normalizeProviderDefinition(apiKeyInput) }),
    ).toThrow("does not use OAuth");
    expect(() =>
      vendorMcpOAuthAppConfig({ ...base, canonicalUrl: "https://mcp.example.com/other" }),
    ).toThrow("MCP resource must be");
    for (const origin of ["http://channels.example.test", "https://channels.example.test/base"]) {
      expect(() => vendorMcpOAuthAppConfig({ ...base, publicOrigin: origin })).toThrow(
        "absolute HTTPS origin",
      );
    }
  });
});

describe("origin resource with a path endpoint (Slack-like)", () => {
  const endpoint = "https://mcp.notion.example/mcp";
  const slackLike = normalizeProviderDefinition({
    ...notionLikeInput,
    mcpServer: { ...notionLikeServer, resource: "https://mcp.notion.example" },
  });
  const app = vendorMcpOAuthAppConfig({
    definition: slackLike,
    canonicalUrl: endpoint,
    clientId: "client",
    clientAuthentication: "none",
    publicOrigin,
  });

  test("sends the pinned resource, not the endpoint, as the RFC 8707 resource", () => {
    expect(vendorMcpResource(slackLike, endpoint)).toBe("https://mcp.notion.example");
    expect(app.allowedResources).toEqual(["https://mcp.notion.example"]);
    const url = new URL(
      platformOAuthAuthorizationUrl({
        app,
        resource: vendorMcpResource(slackLike, endpoint),
        scopes: [],
        state: "s",
        verifier: "v",
      }),
    );
    expect(url.searchParams.get("resource")).toBe("https://mcp.notion.example");
    expect(() =>
      platformOAuthAuthorizationUrl({
        app,
        resource: endpoint,
        scopes: [],
        state: "s",
        verifier: "v",
      }),
    ).toThrow("OAuth resource is not allowed");
  });

  test("discovery probes the endpoint and drift compares PRM resource to the pin", () => {
    expect(vendorMcpDiscoveryInput(slackLike, endpoint).mcpUrl).toBe(endpoint);
    const discovered = {
      ...notionLikeDiscovery,
      protectedResource: {
        resource: "https://mcp.notion.example",
        authorizationServers: ["https://mcp.notion.example"],
      },
    };
    expect(vendorMcpAuthorizationDrift(slackLike, endpoint, discovered)).toEqual([]);
    expect(vendorMcpAuthorizationDrift(slackLike, endpoint, notionLikeDiscovery)).toEqual([
      "Protected resource is https://mcp.notion.example/mcp; pinned https://mcp.notion.example.",
    ]);
  });

  test("resource helpers reject an endpoint that is not the pinned server", () => {
    expect(() => vendorMcpResource(slackLike, "https://mcp.notion.example")).toThrow(
      "MCP resource must be",
    );
  });

  test("templated resources are tenant-substituted", () => {
    const templated = normalizeProviderDefinition({
      ...tenantTemplatedInput,
      mcpServer: {
        ...tenantTemplatedInput.mcpServer,
        resource: "https://{tenant}.mcp.tenant.example",
      },
    });
    expect(vendorMcpResource(templated, "https://acme.mcp.tenant.example/mcp")).toBe(
      "https://acme.mcp.tenant.example",
    );
  });
});

describe("platformOAuthIssValidation", () => {
  const expectedIssuer = "https://auth.example.com";
  const cases = [
    [true, "https://auth.example.com", "accept"],
    [true, "https://auth.example.com/", "reject"],
    [true, "https://AUTH.example.com", "reject"],
    [true, undefined, "reject"],
    [false, "https://auth.example.com", "accept"],
    [false, "https://evil.example.com", "reject"],
    [false, "", "reject"],
    [false, undefined, "accept"],
  ] as const;
  for (const [issParameterSupported, receivedIss, outcome] of cases) {
    test(`supported=${issParameterSupported} iss=${String(receivedIss)} -> ${outcome}`, () => {
      expect(
        platformOAuthIssValidation({ expectedIssuer, issParameterSupported, receivedIss }),
      ).toBe(outcome);
    });
  }
});

describe("vendorMcpClientMetadataDocument", () => {
  test("lists sorted unique callbacks for vendor MCP OAuth providers only", () => {
    const definitions = [
      normalizeProviderDefinition(notionLikeInput),
      normalizeProviderDefinition(atlassianLegacyInput),
      normalizeProviderDefinition({ ...atlassianLegacyInput, key: "jira" }),
      normalizeProviderDefinition(apiKeyInput),
      normalizeProviderDefinition({
        key: "github",
        displayName: "GitHub",
        category: "engineering",
        route: "platform_oauth",
        status: "planned",
        oauthProviderKey: "github",
        auth: { kind: "oauth" },
        verification: { method: "oauth_scopes", required: true },
      }),
    ];
    expect(
      vendorMcpClientMetadataDocument({ publicOrigin: `${publicOrigin}/`, definitions }),
    ).toEqual({
      client_id:
        "https://channels.example.test/public/provider-connections/oauth/client-metadata.json",
      client_name: "Deployments.ai",
      client_uri: "https://deployments.ai",
      redirect_uris: [
        "https://channels.example.test/public/provider-connections/oauth/callback/atlassian",
        "https://channels.example.test/public/provider-connections/oauth/callback/notion",
      ],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "web",
    });
  });
});

describe("OpenTofu OAuth registry", () => {
  test("rejects code-only canonical_uri resource mode", () => {
    expect(() =>
      parsePlatformOAuthAppRegistry(
        JSON.stringify({
          example: {
            authorizationEndpoint: "https://auth.example.com/authorize",
            clientId: "client",
            redirectUri:
              "https://channels.example.test/public/provider-connections/oauth/callback/example",
            resourceMode: "canonical_uri",
            allowedResources: ["https://mcp.example.com"],
            tokenEndpoint: "https://auth.example.com/token",
          },
        }),
      ),
    ).toThrow("resourceMode canonical_uri is reserved for code-synthesized vendor MCP configs");
  });
});
