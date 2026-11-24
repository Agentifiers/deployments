import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { makePublicOpenApiSpec } from "./openapi.ts";
import {
  BeginProviderAuthorizationRequest,
  CreateConnectionGrantRequest,
  CreateProviderApplicationRequest,
  CreateProviderCredentialRequest,
  PROVIDER_API_ROUTES,
  PROVIDER_API_SCHEMAS,
  ProviderApplicationResponse,
  ProviderConnectionResponse,
  SyncConnectionToolsResponse,
} from "./providers.ts";
import { PUBLIC_API_SCHEMAS } from "./schema-registry.ts";

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NOW = "2026-07-25T00:00:00.000Z";

const publicOpenApiSpec = makePublicOpenApiSpec();

function operation(method: string, path: string) {
  const openApiPath = path.replaceAll(/:([A-Za-z0-9_]+)/gu, "{$1}");
  return publicOpenApiSpec.paths[openApiPath]?.[method.toLowerCase()];
}

describe("provider administration API contract", () => {
  test("publishes unique, registered routes with consistent authorization and idempotency", () => {
    const names = PROVIDER_API_ROUTES.map((route) => route.name);
    const methodPaths = PROVIDER_API_ROUTES.map(
      (route) => `${route.method} ${route.path.replaceAll(/:[^/]+/gu, "{}")}`,
    );

    expect(new Set(names).size).toBe(names.length);
    expect(new Set(methodPaths).size).toBe(methodPaths.length);

    for (const route of PROVIDER_API_ROUTES) {
      expect(PUBLIC_API_SCHEMAS).toHaveProperty(route.responseBody);
      expect(PROVIDER_API_SCHEMAS).toHaveProperty(route.responseBody);
      if ("requestBody" in route && route.requestBody) {
        expect(PUBLIC_API_SCHEMAS).toHaveProperty(route.requestBody);
        expect(PROVIDER_API_SCHEMAS).toHaveProperty(route.requestBody);
      }
      expect(route.idempotency).toBe(route.method === "GET" ? "none" : "required");
      expect(operation(route.method, route.path)?.operationId).toBe(route.name);
    }

    expect(PROVIDER_API_ROUTES.filter((route) => route.path.startsWith("/v1/providers"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ authentication: "none", scopeHeaders: "none" }),
      ]),
    );
    expect(
      PROVIDER_API_ROUTES.filter((route) => !route.path.startsWith("/v1/providers")).every(
        (route) =>
          route.authentication === "platform-bearer" && route.scopeHeaders === "environment",
      ),
    ).toBe(true);
  });

  test("uses provider-key path validation instead of the public ULID pattern", () => {
    const parameters = operation("GET", "/v1/providers/:providerKey")?.parameters as
      | readonly {
          readonly name?: string;
          readonly schema?: Readonly<Record<string, unknown>>;
        }[]
      | undefined;
    const providerKey = parameters?.find((parameter) => parameter.name === "providerKey");

    expect(providerKey?.schema).toMatchObject({
      pattern: "^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$",
      type: "string",
    });
    expect(providerKey?.schema?.pattern).not.toBe("^[0-7][0-9A-HJKMNP-TV-Z]{25}$");
  });

  test("keeps OAuth and provider credentials out of response projections", () => {
    const application = Schema.decodeUnknownSync(ProviderApplicationResponse)({
      clientId: "public-client-id",
      clientSecret: "must-not-leak",
      clientSecretRef: { arn: "must-not-leak" },
      createdAt: NOW,
      displayName: "Customer OAuth",
      hasClientSecret: true,
      id: ID,
      providerKey: "github",
      redirectUris: ["https://app.example.test/oauth/callback"],
      requestedScopes: ["repo:read"],
      status: "active",
      updatedAt: NOW,
      version: 1,
    });
    const connection = Schema.decodeUnknownSync(ProviderConnectionResponse)({
      authMethod: "oauth",
      createdAt: NOW,
      credential: { accessToken: "must-not-leak" },
      credentialRef: { credentialId: ID, generation: 1, store: "dynamodb-kms" },
      displayName: "Customer GitHub",
      hasCredential: true,
      id: ID,
      providerKey: "github",
      scopes: ["repo:read"],
      status: "active",
      updatedAt: NOW,
      version: 1,
    });

    expect(application).not.toHaveProperty("clientSecret");
    expect(application).not.toHaveProperty("clientSecretRef");
    expect(connection).not.toHaveProperty("credential");
    expect(connection).not.toHaveProperty("credentialRef");
  });

  test("accepts provider-native OAuth scope formats", () => {
    const requestedScopes = ["https://www.googleapis.com/auth/adwords", "100", "201"];
    expect(
      Schema.decodeUnknownSync(CreateProviderApplicationRequest)({
        clientId: "public-client-id",
        clientSecret: "client-secret",
        displayName: "OAuth application",
        providerKey: "google_ads",
        redirectUris: ["https://app.example.test/oauth/callback"],
        requestedScopes,
      }).requestedScopes,
    ).toEqual(requestedScopes);
    expect(
      Schema.decodeUnknownSync(BeginProviderAuthorizationRequest)({
        providerKey: "google_ads",
        requestedScopes,
      }).requestedScopes,
    ).toEqual(requestedScopes);
    expect(
      Schema.decodeUnknownSync(CreateConnectionGrantRequest)({
        connectionId: ID,
        purpose: "agent-runtime",
        scopes: requestedScopes,
        workspaceId: ID,
      }).scopes,
    ).toEqual(requestedScopes);
  });

  test("models connection grants as durable workspace authorization", () => {
    const grant = Schema.decodeUnknownSync(CreateConnectionGrantRequest)({
      connectionId: ID,
      externalResourceConstraints: { repository: "Agentifiers/deployments" },
      purpose: "agent-runtime",
      scopes: ["repo:read"],
      workspaceId: ID,
    });

    expect(String(grant.connectionId)).toBe(ID);
    expect(String(grant.workspaceId)).toBe(ID);
    expect(grant).toMatchObject({
      externalResourceConstraints: { repository: "Agentifiers/deployments" },
      purpose: "agent-runtime",
      scopes: ["repo:read"],
    });

    expect(
      PROVIDER_API_ROUTES.find((route) => route.name === "requestConnectionVerification"),
    ).toMatchObject({
      idempotency: "required",
      path: "/v1/connections/:id/verify",
      successStatus: 202,
    });
  });

  test("publishes vendor MCP tool sync as an idempotent connection operation", () => {
    expect(PROVIDER_API_ROUTES.find((route) => route.name === "syncConnectionTools")).toMatchObject(
      {
        authentication: "platform-bearer",
        idempotency: "required",
        method: "POST",
        path: "/v1/connections/:connectionId/tools/sync",
        scopeHeaders: "environment",
        successStatus: 200,
      },
    );
    const tool = {
      change: "created",
      classified: true,
      destructive: false,
      effect: "read",
      remoteName: "notion-search",
      toolName: "notion.notion_search",
    };
    const decode = Schema.decodeUnknownSync(SyncConnectionToolsResponse);
    expect(
      decode({
        connectionId: ID,
        providerKey: "notion",
        syncedAt: NOW,
        tools: [
          tool,
          {
            change: "rejected",
            classified: false,
            destructive: false,
            effect: "write",
            reason: "invalid_name",
            remoteName: "%%%",
          },
        ],
      }).tools,
    ).toHaveLength(2);
    expect(() =>
      decode({
        connectionId: ID,
        providerKey: "notion",
        syncedAt: NOW,
        tools: [{ ...tool, change: "deleted" }],
      }),
    ).toThrow();
    expect(() =>
      decode({
        connectionId: ID,
        providerKey: "notion",
        syncedAt: NOW,
        tools: [{ ...tool, effect: "destructive" }],
      }),
    ).toThrow();
  });

  test("accepts secretless pre-registered vendor MCP applications", () => {
    const base = {
      clientId: "client",
      displayName: "Notion",
      providerKey: "notion",
      redirectUris: ["https://channels.example/public/provider-connections/oauth/callback/notion"],
      requestedScopes: [],
    };
    expect(
      Schema.decodeUnknownSync(CreateProviderApplicationRequest)({
        ...base,
        registration: { method: "pre_registered", tokenEndpointAuthMethod: "none" },
      }).registration,
    ).toEqual({ method: "pre_registered", tokenEndpointAuthMethod: "none" });
    expect(() =>
      Schema.decodeUnknownSync(CreateProviderApplicationRequest)({
        ...base,
        registration: { method: "dynamic_client_registration" },
      }),
    ).toThrow();
  });

  test("accepts a vendor MCP tenant resource on credential create and publishes it", () => {
    const body = { displayName: "Freshdesk", providerKey: "freshdesk" };
    expect(
      Schema.decodeUnknownSync(CreateProviderCredentialRequest)({
        ...body,
        requestedResource: "https://acme.freshdesk.com/mcp",
      }).requestedResource,
    ).toBe("https://acme.freshdesk.com/mcp");
    expect(() =>
      Schema.decodeUnknownSync(CreateProviderCredentialRequest)({ ...body, requestedResource: "" }),
    ).toThrow();
    const schemas = publicOpenApiSpec.components.schemas as Readonly<
      Record<string, { readonly properties?: Readonly<Record<string, unknown>> }>
    >;
    expect(schemas.CreateProviderCredentialRequest?.properties).toHaveProperty("requestedResource");
  });
});
