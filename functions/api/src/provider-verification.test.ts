import { describe, expect, test } from "bun:test";
import type { ExecutePinnedHttpRequestOptions } from "@deployments-ai/net-security";
import type { ProviderDefinition } from "@deployments-ai/providers";
import { codeProviderDefinitionRegistry } from "@deployments-ai/providers";
import {
  AdministrationProviderVerificationError,
  makeAdministrationProviderVerifier,
} from "./provider-verification.ts";

function providerDefinition(key: string): ProviderDefinition {
  const definition = codeProviderDefinitionRegistry().resolve(key);
  if (!definition) throw new Error(`${key} provider definition is missing.`);
  return definition;
}

/** SavvyCal's `/v1/me` probe with an identity path, as a provider may declare one. */
function savvycalWithProbeIdentity(identityIdPath: string): ProviderDefinition {
  const definition = providerDefinition("savvycal");
  const probe = definition.verification.probe;
  if (!probe) throw new Error("SavvyCal verification probe is missing.");
  return {
    ...definition,
    verification: { ...definition.verification, probe: { ...probe, identityIdPath } },
  };
}

describe("administration provider verification", () => {
  test("only classifies durable credential rejections as definitive", () => {
    for (const status of [408, 409, 425, 429]) {
      expect(new AdministrationProviderVerificationError("transient", status).definitive).toBe(
        false,
      );
    }
    for (const status of [400, 401, 403, 404]) {
      expect(new AdministrationProviderVerificationError("rejected", status).definitive).toBe(true);
    }
  });

  test("maps granted OAuth scopes to platform capability scopes", async () => {
    const definition: ProviderDefinition = {
      ...providerDefinition("shopify"),
      authorizationScopeCapabilities: {
        read_products: ["products:read"],
        write_fulfillments: ["fulfillments:write", "orders:read"],
      },
    };
    const verifier = makeAdministrationProviderVerifier();
    expect(
      verifier.verify({
        connection: {
          externalAccountId: "shop-account",
          id: "connection-1",
          scopes: ["read_products"],
        },
        credential: {
          scopes: ["write_fulfillments", "read_products", "unmapped_scope"],
          values: { accessToken: "oauth-token" },
        },
        definition,
      }),
    ).resolves.toMatchObject({
      externalAccountId: "shop-account",
      scopes: ["fulfillments:write", "orders:read", "products:read"],
    });
  });

  test("executes the code-owned API probe with the vault credential", async () => {
    const definition = providerDefinition("savvycal");
    const requests: ExecutePinnedHttpRequestOptions[] = [];
    const verifier = makeAdministrationProviderVerifier({
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
      pinnedRequest: async (request) => {
        requests.push(request);
        return new Response(JSON.stringify({ id: "savvycal-user" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      },
    });
    const result = await verifier.verify({
      connection: {
        externalAccountId: "savvycal-account",
        id: "connection-1",
        scopes: ["events:read", "links:read"],
      },
      credential: {
        scopes: ["links:read", "events:read"],
        values: { personalAccessToken: "vault-secret" },
      },
      definition,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      headers: {
        accept: "application/json",
        authorization: "Bearer vault-secret",
      },
      method: "GET",
    });
    expect(String(requests[0]?.url)).toBe("https://api.savvycal.com/v1/me");
    expect(result).toMatchObject({
      externalAccountId: "savvycal-account",
      metadata: { method: "api_probe", responseStatus: 200 },
      scopes: ["events:read", "links:read"],
    });
  });

  test("classifies rejected probes before reading oversized response bodies", async () => {
    const definition = providerDefinition("savvycal");
    const verifier = makeAdministrationProviderVerifier({
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
      pinnedRequest: async () =>
        new Response("x".repeat(1_024 * 1_024 + 1), {
          status: 401,
        }),
    });

    expect(
      verifier.verify({
        connection: {
          id: "connection-1",
          scopes: ["events:read", "links:read"],
        },
        credential: {
          scopes: ["events:read", "links:read"],
          values: { personalAccessToken: "vault-secret" },
        },
        definition,
      }),
    ).rejects.toMatchObject({ definitive: true });
  });

  test("preserves token-exchange rejection classification when body cancellation fails", async () => {
    const definition = codeProviderDefinitionRegistry().resolve("hotjar");
    if (!definition) throw new Error("Hotjar provider definition is missing.");
    const verifier = makeAdministrationProviderVerifier({
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
      pinnedRequest: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              return Promise.reject(new Error("simulated cancellation failure"));
            },
          }),
          { status: 401 },
        ),
    });

    expect(
      verifier.verify({
        connection: { id: "connection-1", scopes: ["surveys:read"] },
        credential: {
          scopes: ["surveys:read"],
          values: {
            clientId: "client-id",
            clientSecret: "client-secret",
            siteId: "site-id",
          },
        },
        definition,
      }),
    ).rejects.toMatchObject({
      definitive: true,
      message: "Provider token exchange returned HTTP 401.",
    });
  });

  test("projects manifest OAuth permissions into platform capabilities", async () => {
    const definition: ProviderDefinition = {
      ...providerDefinition("shopify"),
      authorizationScopeMode: "manifest",
    };
    const verifier = makeAdministrationProviderVerifier();

    expect(
      verifier.verify({
        connection: { id: "connection-1", scopes: [] },
        credential: { scopes: [], values: { accessToken: "oauth-token" } },
        definition,
      }),
    ).resolves.toMatchObject({ scopes: definition.defaultScopes.toSorted() });
  });

  test("pins dynamic provider probes to the credential origin", async () => {
    const definition = codeProviderDefinitionRegistry().resolve("strapi");
    if (!definition) throw new Error("Strapi provider definition is missing.");
    const requests: ExecutePinnedHttpRequestOptions[] = [];
    const verifier = makeAdministrationProviderVerifier({
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
      pinnedRequest: async (request) => {
        requests.push(request);
        return new Response('{"data":[]}', {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      },
    });
    await verifier.verify({
      connection: {
        id: "connection-1",
        scopes: ["documents:read", "documents:write"],
      },
      credential: {
        scopes: ["documents:read", "documents:write"],
        values: {
          apiToken: "vault-secret",
          baseUrl: "https://cms.example.com",
          verificationContentType: "articles",
        },
      },
      definition,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://cms.example.com/api/articles?pagination%5BpageSize%5D=1",
    );
  });

  test("verifies Snowflake against the credential account URL with a read-only query", async () => {
    const definition = codeProviderDefinitionRegistry().resolve("snowflake");
    if (!definition) throw new Error("Snowflake provider definition is missing.");
    const requests: ExecutePinnedHttpRequestOptions[] = [];
    const verifier = makeAdministrationProviderVerifier({
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
      pinnedRequest: async (request) => {
        requests.push(request);
        return new Response('{"statementHandle":"handle"}', { status: 200 });
      },
    });

    await verifier.verify({
      connection: { id: "connection-1", scopes: [] },
      credential: {
        scopes: [],
        values: {
          accountUrl: "https://example-org-example-account.snowflakecomputing.com",
          password: "vault-password",
          username: "snowflake-user",
        },
      },
      definition,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      body: JSON.stringify({
        statement: "SELECT CURRENT_ACCOUNT() AS account_name",
        timeout: 20,
      }),
      headers: {
        authorization: `Basic ${Buffer.from("snowflake-user:vault-password").toString("base64")}`,
        "content-type": "application/json",
      },
      method: "POST",
      url: "https://example-org-example-account.snowflakecomputing.com/api/v2/statements",
    });
  });

  test("rejects a successful probe that omits its required account identity", async () => {
    const definition = savvycalWithProbeIdentity("user.id");
    const verifier = makeAdministrationProviderVerifier({
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
      pinnedRequest: async () =>
        new Response("{}", {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    });

    expect(
      verifier.verify({
        connection: {
          id: "connection-1",
          scopes: ["events:read", "links:read"],
        },
        credential: {
          scopes: ["events:read", "links:read"],
          values: { personalAccessToken: "vault-secret" },
        },
        definition,
      }),
    ).rejects.toThrow("omitted identity path user.id");
  });

  test("rejects provider identity responses that echo credential material", async () => {
    const definition = savvycalWithProbeIdentity("id");
    const verifier = makeAdministrationProviderVerifier({
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
      pinnedRequest: async () =>
        new Response('{"id":"vault-secret"}', {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    });

    expect(
      verifier.verify({
        connection: { id: "connection-1", scopes: [] },
        credential: { scopes: [], values: { personalAccessToken: "vault-secret" } },
        definition,
      }),
    ).rejects.toThrow("echoed credential material");
  });

  test("preserves code-owned static capabilities after an API probe", async () => {
    const definition = savvycalWithProbeIdentity("id");
    const verifier = makeAdministrationProviderVerifier({
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
      pinnedRequest: async () =>
        new Response('{"id":"savvycal-user"}', {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    });

    expect(
      verifier.verify({
        connection: {
          id: "connection-1",
          scopes: ["events:read", "links:read"],
        },
        credential: {
          scopes: ["events:read", "links:read"],
          values: { personalAccessToken: "vault-secret" },
        },
        definition,
      }),
    ).resolves.toMatchObject({
      externalAccountId: "savvycal-user",
      scopes: ["events:read", "links:read"],
    });
  });
});
