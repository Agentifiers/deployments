import { describe, expect, test } from "bun:test";
import { createProviderDefinitionRegistry } from "./provider-definition-registry.ts";
import { normalizeProviderDefinition } from "./provider-definition-normalization.ts";
import type { ProviderDefinitionInput } from "./provider-definition-types.ts";
import { makeProviderDefinitionRecord } from "./provider-records.ts";
import {
  apiKeyInput,
  atlassianLegacyInput,
  notionLikeInput,
  notionLikeServer,
  tenantTemplatedInput,
  microsoftLikeInput,
} from "./vendor-mcp.fixture.ts";

function withServer(overrides: Record<string, unknown>): ProviderDefinitionInput {
  return {
    ...notionLikeInput,
    mcpServer: { ...notionLikeServer, ...overrides },
  } as ProviderDefinitionInput;
}

function withAuthorization(overrides: Record<string, unknown>): ProviderDefinitionInput {
  return withServer({ authorization: { ...notionLikeServer.authorization, ...overrides } });
}

function withoutKey(
  input: ProviderDefinitionInput,
  key: keyof ProviderDefinitionInput,
): ProviderDefinitionInput {
  const copy: Record<string, unknown> = { ...input };
  delete copy[key];
  return copy as unknown as ProviderDefinitionInput;
}

describe("vendor_mcp provider normalization", () => {
  test("derives capability scopes, hosts, manifest mode, and freezes pins", () => {
    const definition = normalizeProviderDefinition(notionLikeInput);
    expect(definition.route).toBe("vendor_mcp");
    expect(definition.defaultScopes).toEqual(["tools:read", "tools:write"]);
    expect(definition.authorizationScopeMode).toBe("manifest");
    expect(definition.apiHosts).toEqual(["mcp.notion.example"]);
    expect(definition.tools).toEqual([]);
    expect(definition.verification.method).toBe("mcp_discovery");
    expect(definition.mcpServer?.authorization).toMatchObject({
      kind: "oauth",
      registrationMethods: ["client_id_metadata_document", "dynamic_client_registration"],
    });
    expect(Object.isFrozen(definition.mcpServer)).toBe(true);
    expect(Object.isFrozen(definition.mcpServer?.toolEffects)).toBe(true);
  });

  test("templated servers use tenant host suffixes as api hosts", () => {
    const definition = normalizeProviderDefinition(tenantTemplatedInput);
    expect(definition.apiHosts).toEqual(["mcp.tenant.example"]);
    expect(definition.mcpServer?.url).toBe("https://{tenant}.mcp.tenant.example/mcp");
  });

  test("keeps verbatim literal issuer braces when a metadata URL is pinned", () => {
    expect(normalizeProviderDefinition(microsoftLikeInput).mcpServer?.authorization).toMatchObject({
      issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
      authorizationServerMetadataUrl:
        "https://login.microsoftonline.com/organizations/v2.0/.well-known/openid-configuration",
      protectedResourceAuthorizationServer: "https://login.microsoftonline.com/organizations/v2.0",
    });
  });

  test("accepts legacy servers and api_key servers with a sensitive key field", () => {
    expect(
      normalizeProviderDefinition(atlassianLegacyInput).mcpServer?.authorization,
    ).toMatchObject({
      protectedResourceMetadata: "absent",
    });
    const keyed = normalizeProviderDefinition(apiKeyInput);
    expect(keyed.auth.kind).toBe("api_key");
    expect(keyed.oauthProviderKey).toBeUndefined();
  });

  test("projects vendor_mcp to the mcp record route with server metadata", () => {
    const record = makeProviderDefinitionRecord({
      definition: normalizeProviderDefinition(notionLikeInput),
      occurredAt: "2026-09-30T00:00:00.000Z",
    });
    expect(record.data.route).toBe("mcp");
    expect(record.data.supportedTools).toEqual([]);
    expect(record.data.metadata).toMatchObject({
      mcpRegistrationMethods: ["client_id_metadata_document", "dynamic_client_registration"],
      mcpServerUrl: "https://mcp.notion.example/mcp",
      providerRoute: "vendor_mcp",
    });
  });

  const rejected: readonly (readonly [string, ProviderDefinitionInput, string])[] = [
    ["missing mcpServer", withoutKey(notionLikeInput, "mcpServer"), "require mcpServer"],
    [
      "mcpServer on another route",
      {
        ...notionLikeInput,
        route: "platform_oauth",
        authorizationScopes: ["read"],
        verification: { method: "oauth_scopes", required: true },
      },
      "only valid for vendor_mcp",
    ],
    ["declared tools", { ...notionLikeInput, tools: ["notion.search"] }, "tools are discovered"],
    [
      "missing oauthProviderKey",
      withoutKey(notionLikeInput, "oauthProviderKey"),
      "require oauthProviderKey",
    ],
    [
      "authorizationScopes",
      { ...notionLikeInput, authorizationScopes: ["read"] },
      "authorizationScopes is only valid",
    ],
    [
      "authorizationScopeCapabilities",
      { ...notionLikeInput, authorizationScopeCapabilities: {} },
      "authorizationScopeCapabilities is only valid",
    ],
    [
      "oauthResources",
      { ...notionLikeInput, oauthResources: ["https://mcp.notion.example"] },
      "oauthResources is only valid",
    ],
    [
      "oauth_request scope mode",
      { ...notionLikeInput, authorizationScopeMode: "oauth_request" },
      "manifest",
    ],
    [
      "other defaultScopes",
      { ...notionLikeInput, defaultScopes: ["tools:read"] },
      "defaultScopes must be",
    ],
    [
      "other apiHosts",
      { ...notionLikeInput, apiHosts: ["api.notion.example"] },
      "apiHosts must be",
    ],
    [
      "non-discovery verification",
      { ...notionLikeInput, verification: { method: "manual", required: true } },
      "require mcp_discovery",
    ],
    [
      "auth kind mismatch",
      { ...notionLikeInput, auth: { kind: "api_key", fields: [] } },
      "must match",
    ],
    [
      "none auth kind",
      { ...notionLikeInput, auth: { kind: "none" } },
      "does not allow credential kind none",
    ],
    [
      "api_key oauthProviderKey",
      { ...apiKeyInput, oauthProviderKey: "keyed-vendor" },
      "only valid for platform_oauth and vendor_mcp oauth",
    ],
    [
      "api_key field not sensitive",
      {
        ...apiKeyInput,
        auth: {
          kind: "api_key",
          fields: [{ key: "apiKey", displayName: "API key", sensitive: false }],
        },
      },
      "must be a sensitive auth field",
    ],
    [
      "api_key field missing",
      {
        ...apiKeyInput,
        auth: {
          kind: "api_key",
          fields: [{ key: "token", displayName: "Token", sensitive: true }],
        },
      },
      "must be a sensitive auth field",
    ],
    ["http url", withServer({ url: "http://mcp.notion.example/mcp" }), "absolute https URL"],
    ["url fragment", withServer({ url: "https://mcp.notion.example/mcp#x" }), "without a fragment"],
    [
      "url query",
      withServer({ url: "https://mcp.notion.example/mcp?x=1" }),
      "must not include a query",
    ],
    [
      "url credentials",
      withServer({ url: "https://user@mcp.notion.example/mcp" }),
      "without credentials",
    ],
    [
      "template without tenant",
      withServer({ url: "https://{tenant}.mcp.notion.example/mcp" }),
      "requires tenant",
    ],
    [
      "template with empty suffixes",
      withServer({
        url: "https://{tenant}.mcp.notion.example/mcp",
        tenant: { label: "Workspace", hostSuffixes: [] },
      }),
      "non-empty tenant hostSuffixes",
    ],
    [
      "template inside a host label",
      withServer({
        url: "https://x{tenant}.mcp.notion.example/mcp",
        tenant: { label: "Workspace", hostSuffixes: ["mcp.notion.example"] },
      }),
      "whole host label",
    ],
    [
      "template in path",
      withServer({
        url: "https://mcp.notion.example/{tenant}/mcp",
        tenant: { label: "Workspace", hostSuffixes: ["mcp.notion.example"] },
      }),
      "whole host label",
    ],
    [
      "template host outside suffixes",
      withServer({
        url: "https://{tenant}.mcp.notion.example/mcp",
        resource: "https://{tenant}.mcp.notion.example/mcp",
        tenant: { label: "Workspace", hostSuffixes: ["other.example"] },
      }),
      "declared tenant host suffix",
    ],
    [
      "other placeholder",
      withServer({ url: "https://{workspace}.mcp.notion.example/mcp" }),
      "only use the {tenant}",
    ],
    [
      "tenant on static url",
      withServer({ tenant: { label: "Workspace", hostSuffixes: ["mcp.notion.example"] } }),
      "only valid when the url contains {tenant}",
    ],
    [
      "templated issuer on static url",
      withAuthorization({ issuer: "https://{tenant}.mcp.notion.example" }),
      "when the MCP server url is templated",
    ],
    [
      "empty registration methods",
      withAuthorization({ registrationMethods: [] }),
      "non-empty array",
    ],
    [
      "duplicate registration method",
      withAuthorization({ registrationMethods: ["pre_registered", "pre_registered"] }),
      "duplicate value",
    ],
    [
      "unknown registration method",
      withAuthorization({ registrationMethods: ["magic"] }),
      "unsupported value",
    ],
    [
      "empty token auth methods",
      withAuthorization({ tokenEndpointAuthMethods: [] }),
      "non-empty array",
    ],
    [
      "CIMD without public client auth",
      withAuthorization({ tokenEndpointAuthMethods: ["client_secret_basic"] }),
      "requires token auth method none",
    ],
    [
      "non-boolean iss pin",
      withAuthorization({ issParameterSupported: "yes" }),
      "issParameterSupported",
    ],
    ["empty toolEffects key", withServer({ toolEffects: { "": "read" } }), "toolEffects key"],
    [
      "long toolEffects key",
      withServer({ toolEffects: { ["a".repeat(257)]: "read" } }),
      "toolEffects key",
    ],
    [
      "unknown tool effect",
      withServer({ toolEffects: { search: "execute" } }),
      "unsupported effect",
    ],
    ["invalid reviewedAt", withServer({ reviewedAt: "2026-02-30" }), "YYYY-MM-DD"],
    ["reviewedAt timestamp", withServer({ reviewedAt: "2026-09-30T00:00:00Z" }), "YYYY-MM-DD"],
    [
      "literal issuer braces without metadata URL",
      withAuthorization({ issuer: "https://login.example.com/{tenantid}/v2.0" }),
      "only use the {tenant} placeholder",
    ],
    [
      "literal braces in issuer host",
      withAuthorization({
        issuer: "https://{tenantid}.login.example.com/v2.0",
        authorizationServerMetadataUrl:
          "https://login.example.com/.well-known/openid-configuration",
      }),
      "only use the {tenant} placeholder",
    ],
    [
      "http metadata URL",
      withAuthorization({
        authorizationServerMetadataUrl: "http://login.example.com/.well-known/openid-configuration",
      }),
      "absolute https URL",
    ],
    [
      "metadata URL braces",
      withAuthorization({
        authorizationServerMetadataUrl: "https://login.example.com/{tenantid}/.well-known/x",
      }),
      "only use the {tenant} placeholder",
    ],
    [
      "PRM authorization server without published PRM",
      withAuthorization({
        protectedResourceMetadata: "absent",
        authorizationServerMetadataUrl:
          "https://login.example.com/.well-known/openid-configuration",
        protectedResourceAuthorizationServer: "https://mcp.notion.example",
      }),
      "requires published protected resource metadata",
    ],
    [
      "PRM authorization server without metadata URL",
      withAuthorization({ protectedResourceAuthorizationServer: "https://mcp.notion.example" }),
      "requires authorizationServerMetadataUrl",
    ],
    [
      "http PRM authorization server",
      withAuthorization({
        authorizationServerMetadataUrl:
          "https://login.example.com/.well-known/openid-configuration",
        protectedResourceAuthorizationServer: "http://mcp.notion.example",
      }),
      "absolute https URL",
    ],
  ];

  for (const [name, input, message] of rejected) {
    test(`rejects ${name}`, () => {
      expect(() => normalizeProviderDefinition(input)).toThrow(message);
    });
  }

  test("mcp_discovery verification is reserved for vendor_mcp", () => {
    expect(() =>
      normalizeProviderDefinition({
        key: "plain",
        displayName: "Plain",
        category: "data",
        route: "platform_webhook",
        status: "planned",
        auth: { kind: "none" },
        verification: { method: "mcp_discovery", required: true },
      }),
    ).toThrow("require mcp_discovery");
  });

  test("an OAuth provider key cannot be shared with another route", () => {
    expect(() =>
      createProviderDefinitionRegistry([
        notionLikeInput,
        {
          key: "notion_native",
          displayName: "Notion native",
          category: "knowledge",
          route: "platform_oauth",
          status: "planned",
          oauthProviderKey: "notion",
          auth: { kind: "oauth" },
          verification: { method: "oauth_scopes", required: true },
        },
      ]),
    ).toThrow("cannot be shared between vendor_mcp and other provider routes");
  });
});
