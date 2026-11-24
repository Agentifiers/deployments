import { describe, expect, test } from "bun:test";
import type { ExecutePinnedHttpRequestOptions } from "@deployments-ai/net-security";
import {
  discoverMcpAuthorization,
  mcpIssuerIdentifiersEquivalent,
  type DiscoverMcpAuthorizationInput,
  type McpAuthorizationDiscoveryError,
} from "./index.ts";

const PUBLIC_DNS = async () => [{ address: "93.184.216.34", family: 4 as const }];

type Route = (request: ExecutePinnedHttpRequestOptions) => Response;

function json(
  value: unknown,
  init: Omit<ResponseInit, "headers"> & {
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function asMetadata(issuer: string, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    authorization_endpoint: `${issuer}/authorize`,
    code_challenge_methods_supported: ["S256"],
    issuer,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"],
    token_endpoint: `${issuer}/token`,
    ...overrides,
  };
}

/** Fake internet keyed by exact URL; unknown URLs answer 404. */
function fakeWeb(routes: Readonly<Record<string, Route>>) {
  const requests: { readonly method: string; readonly url: string }[] = [];
  const pinnedRequest = async (request: ExecutePinnedHttpRequestOptions) => {
    const url = request.url.toString();
    requests.push({ method: request.method ?? "GET", url });
    return routes[url]?.(request) ?? new Response("not found", { status: 404 });
  };
  const discover = (input: Omit<DiscoverMcpAuthorizationInput, "dnsLookup" | "pinnedRequest">) =>
    discoverMcpAuthorization({ ...input, dnsLookup: PUBLIC_DNS, pinnedRequest });
  return { discover, urls: () => requests.map((request) => `${request.method} ${request.url}`) };
}

const unauthorized =
  (header: string): Route =>
  () =>
    new Response(null, { headers: { "www-authenticate": header }, status: 401 });

describe("discoverMcpAuthorization", () => {
  test("follows the WWW-Authenticate resource_metadata URL (Notion-like)", async () => {
    let probe: ExecutePinnedHttpRequestOptions | undefined;
    const web = fakeWeb({
      "https://mcp.notion.com/mcp": (request) => {
        probe = request;
        return unauthorized(
          'Bearer realm="OAuth", error="invalid_token", resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource/mcp", scope="read write"',
        )(request);
      },
      "https://mcp.notion.com/.well-known/oauth-protected-resource/mcp": () =>
        json({
          authorization_servers: ["https://mcp.notion.com"],
          resource: "https://mcp.notion.com/mcp",
          scopes_supported: ["read", "write"],
        }),
      "https://mcp.notion.com/.well-known/oauth-authorization-server": () =>
        json(
          asMetadata("https://mcp.notion.com", {
            authorization_response_iss_parameter_supported: true,
            client_id_metadata_document_supported: true,
            revocation_endpoint: "https://mcp.notion.com/token/revoke",
            token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
          }),
        ),
    });

    const result = await web.discover({
      mcpUrl: "https://mcp.notion.com/mcp",
      protectedResourceMetadata: "published",
    });

    expect(result).toEqual({
      authorizationServer: {
        authorizationEndpoint: "https://mcp.notion.com/authorize",
        authorizationResponseIssParameterSupported: true,
        clientIdMetadataDocumentSupported: true,
        codeChallengeMethodsSupported: ["S256"],
        issuer: "https://mcp.notion.com",
        metadataUrl: "https://mcp.notion.com/.well-known/oauth-authorization-server",
        registrationEndpoint: "https://mcp.notion.com/register",
        revocationEndpoint: "https://mcp.notion.com/token/revoke",
        tokenEndpoint: "https://mcp.notion.com/token",
        tokenEndpointAuthMethodsSupported: ["none", "client_secret_post"],
      },
      challenge: {
        resourceMetadataUrl: "https://mcp.notion.com/.well-known/oauth-protected-resource/mcp",
        scope: "read write",
      },
      protectedResource: {
        authorizationServers: ["https://mcp.notion.com"],
        metadataUrl: "https://mcp.notion.com/.well-known/oauth-protected-resource/mcp",
        resource: "https://mcp.notion.com/mcp",
        scopesSupported: ["read", "write"],
      },
    });
    expect(probe?.method).toBe("POST");
    expect(probe?.headers).toMatchObject({ accept: "application/json, text/event-stream" });
    expect(probe?.headers?.authorization).toBeUndefined();
    expect(JSON.parse(String(probe?.body))).toMatchObject({ jsonrpc: "2.0", method: "initialize" });
  });

  test("falls back to path-inserted then root well-known PRM and prefers a listed pinned issuer", async () => {
    const web = fakeWeb({
      "https://api.vendor.example/v1/mcp": () => new Response(null, { status: 401 }),
      "https://api.vendor.example/.well-known/oauth-protected-resource": () =>
        json({
          authorization_servers: ["https://other.vendor.example", "https://auth.vendor.example"],
          resource: "https://api.vendor.example/v1/mcp",
        }),
      "https://auth.vendor.example/.well-known/oauth-authorization-server": () =>
        json(asMetadata("https://auth.vendor.example")),
    });

    const result = await web.discover({
      mcpUrl: "https://api.vendor.example/v1/mcp",
      pinnedIssuer: "https://auth.vendor.example",
      protectedResourceMetadata: "published",
    });

    expect(result.challenge).toEqual({});
    expect(result.protectedResource?.metadataUrl).toBe(
      "https://api.vendor.example/.well-known/oauth-protected-resource",
    );
    expect(result.authorizationServer).toMatchObject({
      issuer: "https://auth.vendor.example",
      tokenEndpointAuthMethodsSupported: ["client_secret_basic"],
    });
    expect(web.urls()).toEqual([
      "POST https://api.vendor.example/v1/mcp",
      "GET https://api.vendor.example/.well-known/oauth-protected-resource/v1/mcp",
      "GET https://api.vendor.example/.well-known/oauth-protected-resource",
      "GET https://auth.vendor.example/.well-known/oauth-authorization-server",
    ]);
  });

  test("inserts the issuer path into the RFC 8414 well-known URL (Stripe-like)", async () => {
    const web = fakeWeb({
      "https://mcp.stripe.com/": unauthorized(
        'Bearer resource_metadata="https://mcp.stripe.com/.well-known/oauth-protected-resource"',
      ),
      "https://mcp.stripe.com/.well-known/oauth-protected-resource": () =>
        json({
          authorization_servers: ["https://access.stripe.com/mcp"],
          resource: "https://mcp.stripe.com",
        }),
      "https://access.stripe.com/.well-known/oauth-authorization-server/mcp": () =>
        json(asMetadata("https://access.stripe.com/mcp")),
    });

    const result = await web.discover({
      mcpUrl: "https://mcp.stripe.com",
      protectedResourceMetadata: "published",
    });

    expect(result.authorizationServer.metadataUrl).toBe(
      "https://access.stripe.com/.well-known/oauth-authorization-server/mcp",
    );
    expect(result.authorizationServer.tokenEndpoint).toBe("https://access.stripe.com/mcp/token");
  });

  test("falls back through OIDC path insertion and path append in spec order", async () => {
    const web = fakeWeb({
      "https://mcp.vendor.example/mcp": unauthorized(
        'Bearer resource_metadata="https://mcp.vendor.example/prm"',
      ),
      "https://mcp.vendor.example/prm": () =>
        json({
          authorization_servers: ["https://id.vendor.example/tenant/"],
          resource: "https://mcp.vendor.example/mcp",
        }),
      "https://id.vendor.example/tenant/.well-known/openid-configuration": () =>
        json(asMetadata("https://id.vendor.example/tenant/")),
    });

    const result = await web.discover({
      mcpUrl: "https://mcp.vendor.example/mcp",
      protectedResourceMetadata: "published",
    });

    expect(result.authorizationServer.issuer).toBe("https://id.vendor.example/tenant/");
    expect(web.urls().slice(2)).toEqual([
      "GET https://id.vendor.example/.well-known/oauth-authorization-server/tenant",
      "GET https://id.vendor.example/.well-known/openid-configuration/tenant",
      "GET https://id.vendor.example/tenant/.well-known/openid-configuration",
    ]);
  });

  test("uses the pinned issuer directly when the server publishes no PRM (Atlassian-like)", async () => {
    const web = fakeWeb({
      "https://cf.mcp.atlassian.com/.well-known/oauth-authorization-server": () =>
        json(asMetadata("https://cf.mcp.atlassian.com")),
    });

    const result = await web.discover({
      mcpUrl: "https://mcp.atlassian.com/v1/sse",
      pinnedIssuer: "https://cf.mcp.atlassian.com",
      protectedResourceMetadata: "absent",
    });

    expect(result.challenge).toEqual({});
    expect(result.protectedResource).toBeUndefined();
    expect(result.authorizationServer.registrationEndpoint).toBe(
      "https://cf.mcp.atlassian.com/register",
    );
    expect(web.urls()).toEqual([
      "GET https://cf.mcp.atlassian.com/.well-known/oauth-authorization-server",
    ]);
    expect(
      web.discover({
        mcpUrl: "https://mcp.atlassian.com/v1/sse",
        protectedResourceMetadata: "absent",
      }),
    ).rejects.toMatchObject({
      code: "authorization_server_metadata",
    } satisfies Partial<McpAuthorizationDiscoveryError>);
  });

  test("rejects metadata whose issuer differs from the requested issuer on every candidate", async () => {
    const web = fakeWeb({
      "https://auth.vendor.example/.well-known/oauth-authorization-server": () =>
        json(asMetadata("https://evil.example")),
      "https://auth.vendor.example/.well-known/openid-configuration": () =>
        json(asMetadata("https://auth.vendor.example/tenant")),
    });

    expect(
      web.discover({
        mcpUrl: "https://api.vendor.example/mcp",
        pinnedIssuer: "https://auth.vendor.example",
        protectedResourceMetadata: "absent",
      }),
    ).rejects.toMatchObject({
      code: "issuer_mismatch",
    } satisfies Partial<McpAuthorizationDiscoveryError>);
  });

  test("rejects non-HTTPS MCP URLs, metadata URLs, issuers, and endpoints", async () => {
    const web = fakeWeb({
      "https://mcp.vendor.example/mcp": unauthorized(
        'Bearer resource_metadata="http://mcp.vendor.example/prm"',
      ),
      "https://auth.vendor.example/.well-known/oauth-authorization-server": () =>
        json(
          asMetadata("https://auth.vendor.example", {
            token_endpoint: "http://auth.vendor.example/token",
          }),
        ),
    });

    expect(
      web.discover({
        mcpUrl: "http://mcp.vendor.example/mcp",
        protectedResourceMetadata: "published",
      }),
    ).rejects.toMatchObject({ code: "network" });
    expect(
      web.discover({
        mcpUrl: "https://mcp.vendor.example/mcp",
        protectedResourceMetadata: "published",
      }),
    ).rejects.toMatchObject({ code: "protected_resource_metadata" });
    expect(
      web.discover({
        mcpUrl: "https://mcp.vendor.example/mcp",
        pinnedIssuer: "http://auth.vendor.example",
        protectedResourceMetadata: "absent",
      }),
    ).rejects.toMatchObject({ code: "authorization_server_metadata" });
    expect(
      web.discover({
        mcpUrl: "https://mcp.vendor.example/mcp",
        pinnedIssuer: "https://auth.vendor.example",
        protectedResourceMetadata: "absent",
      }),
    ).rejects.toThrow("token_endpoint must be an absolute HTTPS URL");
  });

  test("rejects oversized metadata, redirects, and malformed PRM", async () => {
    const web = fakeWeb({
      "https://big.vendor.example/mcp": unauthorized(
        'Bearer resource_metadata="https://big.vendor.example/prm"',
      ),
      "https://big.vendor.example/prm": () =>
        json({
          authorization_servers: ["https://a.example"],
          padding: "x".repeat(70_000),
          resource: "r",
        }),
      "https://redirect.vendor.example/mcp": () =>
        new Response(null, {
          headers: { location: "https://redirect.vendor.example/elsewhere" },
          status: 302,
        }),
      "https://redirect.vendor.example/.well-known/oauth-protected-resource/mcp": () =>
        new Response(null, { headers: { location: "/prm" }, status: 307 }),
      "https://redirect.vendor.example/.well-known/oauth-protected-resource": () =>
        new Response(null, { headers: { location: "/prm" }, status: 301 }),
      "https://bad.vendor.example/mcp": unauthorized(
        'Bearer resource_metadata="https://bad.vendor.example/prm"',
      ),
      "https://bad.vendor.example/prm": () =>
        json({ authorization_servers: [], resource: "https://bad.vendor.example/mcp" }),
    });

    expect(
      web.discover({
        mcpUrl: "https://big.vendor.example/mcp",
        protectedResourceMetadata: "published",
      }),
    ).rejects.toThrow("exceeded the 64 KiB metadata limit");
    expect(
      web.discover({
        mcpUrl: "https://redirect.vendor.example/mcp",
        protectedResourceMetadata: "published",
      }),
    ).rejects.toMatchObject({
      code: "protected_resource_metadata",
      message: expect.stringContaining("redirected"),
    });
    expect(web.urls()).not.toContain("GET https://redirect.vendor.example/prm");
    expect(
      web.discover({
        mcpUrl: "https://bad.vendor.example/mcp",
        protectedResourceMetadata: "published",
      }),
    ).rejects.toMatchObject({ code: "protected_resource_metadata" });
  });

  test("maps transport failures and private DNS answers to network errors", async () => {
    expect(
      discoverMcpAuthorization({
        dnsLookup: async () => [{ address: "10.0.0.5", family: 4 }],
        mcpUrl: "https://mcp.vendor.example/mcp",
        pinnedRequest: async () => {
          throw new Error("unreachable");
        },
        protectedResourceMetadata: "published",
      }),
    ).rejects.toMatchObject({ code: "network" });
    expect(
      discoverMcpAuthorization({
        dnsLookup: PUBLIC_DNS,
        mcpUrl: "https://mcp.vendor.example/mcp",
        pinnedRequest: (request) => {
          const { promise, reject } = Promise.withResolvers<Response>();
          request.signal.addEventListener("abort", () => reject(request.signal.reason));
          return promise;
        },
        protectedResourceMetadata: "published",
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ code: "network", message: expect.stringContaining("timed out") });
  });
});

describe("issuer interop", () => {
  test("treats root issuers that differ only by a trailing slash as equivalent", () => {
    const cases: readonly [string, string, boolean][] = [
      ["https://accounts.google.com/", "https://accounts.google.com", true],
      ["https://auth.coupler.io", "https://auth.coupler.io/", true],
      ["https://access.stripe.com/mcp", "https://access.stripe.com/mcp", true],
      ["https://auth.vendor.example/", "https://auth.vendor.example:8443", false],
      ["https://auth.vendor.example/", "https://evil.vendor.example", false],
      ["https://auth.vendor.example/", "http://auth.vendor.example", false],
      ["https://id.vendor.example/tenant/", "https://id.vendor.example/tenant", false],
      ["https://auth.vendor.example/?", "https://auth.vendor.example", false],
      ["https://auth.vendor.example/#", "https://auth.vendor.example", false],
    ];
    for (const [a, b, equivalent] of cases) {
      expect([a, b, mcpIssuerIdentifiersEquivalent(a, b)]).toEqual([a, b, equivalent]);
      expect([b, a, mcpIssuerIdentifiersEquivalent(b, a)]).toEqual([b, a, equivalent]);
    }
  });

  test("accepts Google-like slash differences and returns the metadata issuer verbatim", async () => {
    const web = fakeWeb({
      "https://drive.mcp.example/mcp": unauthorized(
        'Bearer resource_metadata="https://drive.mcp.example/prm"',
      ),
      "https://drive.mcp.example/prm": () =>
        json({
          authorization_servers: ["https://other.example", "https://accounts.google.com/"],
          resource: "https://drive.mcp.example/mcp",
        }),
      "https://accounts.google.com/.well-known/oauth-authorization-server": () =>
        new Response(null, { status: 404 }),
      "https://accounts.google.com/.well-known/openid-configuration": () =>
        json(asMetadata("https://accounts.google.com")),
      "https://auth.coupler.io/.well-known/oauth-authorization-server": () =>
        json(asMetadata("https://auth.coupler.io/")),
    });

    const google = await web.discover({
      mcpUrl: "https://drive.mcp.example/mcp",
      pinnedIssuer: "https://accounts.google.com",
      protectedResourceMetadata: "published",
    });
    expect(google.authorizationServer).toMatchObject({
      issuer: "https://accounts.google.com",
      metadataUrl: "https://accounts.google.com/.well-known/openid-configuration",
    });

    const coupler = await web.discover({
      mcpUrl: "https://drive.mcp.example/mcp",
      pinnedIssuer: "https://auth.coupler.io",
      protectedResourceMetadata: "absent",
    });
    expect(coupler.authorizationServer.issuer).toBe("https://auth.coupler.io/");
  });

  test("still rejects origin and non-root path differences", async () => {
    const web = fakeWeb({
      "https://auth.vendor.example/.well-known/oauth-authorization-server": () =>
        json(asMetadata("https://auth.vendor.example:8443/")),
      "https://auth.vendor.example/.well-known/openid-configuration": () =>
        json(asMetadata("https://login.vendor.example/")),
      "https://id.vendor.example/.well-known/oauth-authorization-server/tenant": () =>
        json(asMetadata("https://id.vendor.example/tenant")),
    });

    expect(
      web.discover({
        mcpUrl: "https://mcp.vendor.example/mcp",
        pinnedIssuer: "https://auth.vendor.example/",
        protectedResourceMetadata: "absent",
      }),
    ).rejects.toMatchObject({ code: "issuer_mismatch" });
    expect(
      web.discover({
        mcpUrl: "https://mcp.vendor.example/mcp",
        pinnedIssuer: "https://id.vendor.example/tenant/",
        protectedResourceMetadata: "absent",
      }),
    ).rejects.toMatchObject({ code: "issuer_mismatch" });
  });

  test("fetches only the reviewed metadata URL and checks the expected issuer verbatim (DocuSign-like)", async () => {
    const metadataUrl = "https://mcp.docusign.com/.well-known/oauth-authorization-server";
    const web = fakeWeb({
      "https://mcp.docusign.com/mcp": unauthorized(
        'Bearer resource_metadata="https://mcp.docusign.com/.well-known/oauth-protected-resource"',
      ),
      "https://mcp.docusign.com/.well-known/oauth-protected-resource": () =>
        json({
          authorization_servers: ["https://mcp.docusign.com"],
          resource: "https://mcp.docusign.com/mcp",
        }),
      [metadataUrl]: () => json(asMetadata("https://account.docusign.com")),
    });

    const result = await web.discover({
      authorizationServerMetadataUrl: metadataUrl,
      expectedIssuer: "https://account.docusign.com",
      mcpUrl: "https://mcp.docusign.com/mcp",
      pinnedIssuer: "https://account.docusign.com",
      protectedResourceMetadata: "published",
    });

    expect(result.protectedResource?.authorizationServers).toEqual(["https://mcp.docusign.com"]);
    expect(result.authorizationServer).toMatchObject({
      issuer: "https://account.docusign.com",
      metadataUrl,
      tokenEndpoint: "https://account.docusign.com/token",
    });
    expect(web.urls()).toEqual([
      "POST https://mcp.docusign.com/mcp",
      "GET https://mcp.docusign.com/.well-known/oauth-protected-resource",
      `GET ${metadataUrl}`,
    ]);

    for (const expectedIssuer of ["https://account.docusign.com/", "https://evil.example"]) {
      expect(
        web.discover({
          authorizationServerMetadataUrl: metadataUrl,
          expectedIssuer,
          mcpUrl: "https://mcp.docusign.com/mcp",
          protectedResourceMetadata: "published",
        }),
      ).rejects.toMatchObject({ code: "issuer_mismatch" });
    }
    expect(
      web.discover({
        authorizationServerMetadataUrl: metadataUrl,
        mcpUrl: "https://mcp.docusign.com/mcp",
        protectedResourceMetadata: "published",
      }),
    ).rejects.toMatchObject({ code: "authorization_server_metadata" });
  });

  test("accepts a reviewed literal templated issuer without a pinned issuer (Microsoft-like)", async () => {
    const metadataUrl =
      "https://login.microsoftonline.com/organizations/v2.0/.well-known/openid-configuration";
    const issuer = "https://login.microsoftonline.com/{tenantid}/v2.0";
    const web = fakeWeb({
      [metadataUrl]: () =>
        json({
          ...asMetadata("https://login.microsoftonline.com/organizations/oauth2/v2.0"),
          issuer,
        }),
    });

    const result = await web.discover({
      authorizationServerMetadataUrl: metadataUrl,
      expectedIssuer: issuer,
      mcpUrl: "https://agent365.svc.cloud.microsoft/mcp",
      protectedResourceMetadata: "absent",
    });

    expect(result.authorizationServer).toMatchObject({ issuer, metadataUrl });
    expect(web.urls()).toEqual([`GET ${metadataUrl}`]);
  });
});
