import { describe, expect, test } from "bun:test";
import { normalizeProviderDefinition } from "./provider-definition-normalization.ts";
import type { VendorMcpDiscoveredAuthorization } from "./vendor-mcp-types.ts";
import {
  atlassianLegacyDiscovery,
  docusignLikeDiscovery,
  docusignLikeInput,
  googleLikeDiscovery,
  googleLikeInput,
  microsoftLikeDiscovery,
  microsoftLikeInput,
  atlassianLegacyInput,
  notionLikeDiscovery,
  notionLikeInput,
  tenantTemplatedInput,
} from "./vendor-mcp.fixture.ts";
import {
  vendorMcpAuthorizationDrift as drift,
  vendorMcpCanonicalUrl,
  vendorMcpDiscoveryInput,
  vendorMcpIssuerEquivalent,
  vendorMcpTenant,
} from "./vendor-mcp-authorization.ts";
import { VendorMcpConfigurationError, vendorMcpSubstitute } from "./vendor-mcp-template.ts";

const notion = normalizeProviderDefinition(notionLikeInput);
const atlassian = normalizeProviderDefinition(atlassianLegacyInput);
const templated = normalizeProviderDefinition(tenantTemplatedInput);

function expectInvalidResource(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(VendorMcpConfigurationError);
    expect((error as VendorMcpConfigurationError).code).toBe("invalid_mcp_resource");
    return;
  }
  throw new Error("Expected invalid_mcp_resource.");
}

describe("vendorMcpCanonicalUrl", () => {
  test("static servers resolve to the pinned url only", () => {
    expect(vendorMcpCanonicalUrl(notion)).toBe("https://mcp.notion.example/mcp");
    expect(vendorMcpCanonicalUrl(notion, "https://mcp.notion.example/mcp")).toBe(
      "https://mcp.notion.example/mcp",
    );
    expectInvalidResource(() => vendorMcpCanonicalUrl(notion, "https://mcp.notion.example/mcp/"));
    expectInvalidResource(() => vendorMcpCanonicalUrl(notion, "https://mcp.notion.example"));
    expect(vendorMcpTenant(notion, "https://mcp.notion.example/mcp")).toBeUndefined();
  });

  test("templated servers accept one valid tenant label", () => {
    const url = "https://acme-1.mcp.tenant.example/mcp";
    expect(vendorMcpCanonicalUrl(templated, url)).toBe(url);
    expect(vendorMcpTenant(templated, url)).toBe("acme-1");
    expect(vendorMcpSubstitute("https://{tenant}.mcp.tenant.example", "acme-1")).toBe(
      "https://acme-1.mcp.tenant.example",
    );
  });

  test("templated servers reject missing, malformed, or foreign resources", () => {
    for (const resource of [
      undefined,
      "https://acme.evil.example/mcp",
      "https://acme.mcp.tenant.example.evil.example/mcp",
      "https://a.b.mcp.tenant.example/mcp",
      "https://-acme.mcp.tenant.example/mcp",
      "https://acme-.mcp.tenant.example/mcp",
      "https://ACME.mcp.tenant.example/mcp",
      `https://${"a".repeat(64)}.mcp.tenant.example/mcp`,
      "https://acme.mcp.tenant.example/other",
      "https://acme.mcp.tenant.example/mcp/",
      "https://acme.mcp.tenant.example/mcp#x",
      "http://acme.mcp.tenant.example/mcp",
    ]) {
      expectInvalidResource(() => vendorMcpCanonicalUrl(templated, resource));
    }
    expectInvalidResource(() => vendorMcpSubstitute("https://{tenant}.mcp.tenant.example", "a.b"));
  });
});

type DiscoveredServer = VendorMcpDiscoveredAuthorization["authorizationServer"];

/** Overrides; an `undefined` value removes the field from discovery. */
function withServer(
  base: VendorMcpDiscoveredAuthorization,
  overrides: { readonly [K in keyof DiscoveredServer]?: DiscoveredServer[K] | undefined },
): VendorMcpDiscoveredAuthorization {
  const merged = { ...base.authorizationServer, ...overrides };
  return {
    ...base,
    authorizationServer: Object.fromEntries(
      Object.entries(merged).filter(([, value]) => value !== undefined),
    ) as unknown as DiscoveredServer,
  };
}

describe("vendorMcpAuthorizationDrift", () => {
  const notionUrl = "https://mcp.notion.example/mcp";
  const atlassianUrl = "https://mcp.atlassian.example/v1/mcp";

  test("clean discovery has no drift", () => {
    expect(drift(notion, notionUrl, notionLikeDiscovery)).toEqual([]);
    expect(drift(atlassian, atlassianUrl, atlassianLegacyDiscovery)).toEqual([]);
  });

  test("templated pins are substituted before comparison", () => {
    const url = "https://acme.mcp.tenant.example/mcp";
    const discovered: VendorMcpDiscoveredAuthorization = {
      protectedResource: {
        resource: url,
        authorizationServers: ["https://acme.mcp.tenant.example"],
      },
      authorizationServer: {
        issuer: "https://acme.mcp.tenant.example",
        authorizationEndpoint: "https://acme.mcp.tenant.example/oauth/authorize",
        tokenEndpoint: "https://acme.mcp.tenant.example/oauth/token",
        clientIdMetadataDocumentSupported: false,
        codeChallengeMethodsSupported: ["S256"],
        tokenEndpointAuthMethodsSupported: ["client_secret_basic"],
        authorizationResponseIssParameterSupported: false,
      },
    };
    expect(drift(templated, url, discovered)).toEqual([]);
    expect(
      drift(templated, url, withServer(discovered, { issuer: "https://other.mcp.tenant.example" })),
    ).toHaveLength(1);
  });

  test("published protected resource metadata must be present", () => {
    const { protectedResource: _omitted, ...withoutPrm } = notionLikeDiscovery;
    expect(drift(notion, notionUrl, withoutPrm)).toEqual([
      "Protected resource metadata is pinned as published but was not found.",
    ]);
  });

  test("protected resource and authorization server list must match pins", () => {
    const result = drift(notion, notionUrl, {
      ...notionLikeDiscovery,
      protectedResource: {
        resource: "https://mcp.notion.example/mcp/",
        authorizationServers: ["https://evil.example"],
      },
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("Protected resource is https://mcp.notion.example/mcp/");
    expect(result[1]).toContain(
      "do not include pinned authorization server https://mcp.notion.example",
    );
  });

  const endpointCases: readonly (readonly [
    string,
    { readonly [K in keyof DiscoveredServer]?: DiscoveredServer[K] | undefined },
  ])[] = [
    ["issuer", { issuer: "https://mcp.notion.example/other" }],
    ["authorization_endpoint", { authorizationEndpoint: "https://evil.example/authorize" }],
    ["token_endpoint", { tokenEndpoint: "https://evil.example/token" }],
    ["revocation_endpoint", { revocationEndpoint: undefined }],
  ];
  for (const [name, overrides] of endpointCases) {
    test(`reports ${name} drift`, () => {
      const result = drift(notion, notionUrl, withServer(notionLikeDiscovery, overrides));
      expect(result).toHaveLength(1);
      expect(result[0]).toContain(`Authorization server ${name}`);
    });
  }

  test("reports missing PKCE S256", () => {
    expect(
      drift(
        notion,
        notionUrl,
        withServer(notionLikeDiscovery, { codeChallengeMethodsSupported: ["plain"] }),
      ),
    ).toEqual(["Authorization server does not advertise PKCE S256."]);
  });

  test("reports registration drift only when no pinned method remains usable", () => {
    expect(
      drift(
        notion,
        notionUrl,
        withServer(notionLikeDiscovery, { clientIdMetadataDocumentSupported: false }),
      ),
    ).toEqual([]);
    const result = drift(
      notion,
      notionUrl,
      withServer(notionLikeDiscovery, {
        clientIdMetadataDocumentSupported: false,
        registrationEndpoint: undefined,
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("none of the pinned registration methods");
    expect(
      drift(
        atlassian,
        atlassianUrl,
        withServer(atlassianLegacyDiscovery, { registrationEndpoint: undefined }),
      ),
    ).toHaveLength(1);
  });

  test("pre-registration stays usable without CIMD or DCR", () => {
    const url = "https://acme.mcp.tenant.example/mcp";
    expect(
      drift(templated, url, {
        protectedResource: {
          resource: url,
          authorizationServers: ["https://acme.mcp.tenant.example"],
        },
        authorizationServer: {
          issuer: "https://acme.mcp.tenant.example",
          authorizationEndpoint: "https://acme.mcp.tenant.example/oauth/authorize",
          tokenEndpoint: "https://acme.mcp.tenant.example/oauth/token",
          clientIdMetadataDocumentSupported: false,
          codeChallengeMethodsSupported: ["S256"],
          tokenEndpointAuthMethodsSupported: ["client_secret_basic"],
          authorizationResponseIssParameterSupported: false,
        },
      }),
    ).toEqual([]);
  });

  test("reports iss parameter support pin mismatch in both directions", () => {
    expect(
      drift(
        notion,
        notionUrl,
        withServer(notionLikeDiscovery, { authorizationResponseIssParameterSupported: false }),
      ),
    ).toHaveLength(1);
    expect(
      drift(
        atlassian,
        atlassianUrl,
        withServer(atlassianLegacyDiscovery, { authorizationResponseIssParameterSupported: true }),
      ),
    ).toHaveLength(1);
  });

  test("rejects a canonical url that is not the pinned server", () => {
    expectInvalidResource(() => drift(notion, "https://evil.example/mcp", notionLikeDiscovery));
  });

  test("tenant pins are substituted into the discovery input", () => {
    expect(vendorMcpDiscoveryInput(templated, "https://acme.mcp.tenant.example/mcp")).toEqual({
      mcpUrl: "https://acme.mcp.tenant.example/mcp",
      protectedResourceMetadata: "published",
      pinnedIssuer: "https://acme.mcp.tenant.example",
    });
    expect(vendorMcpDiscoveryInput(atlassian, atlassianUrl)).toEqual({
      mcpUrl: atlassianUrl,
      protectedResourceMetadata: "absent",
      pinnedIssuer: "https://cf.mcp.atlassian.example",
    });
  });
});

describe("vendorMcpIssuerEquivalent", () => {
  const cases = [
    ["https://accounts.google.com/", "https://accounts.google.com", true],
    ["https://accounts.google.com", "https://accounts.google.com", true],
    ["https://auth.example.com/tenant/", "https://auth.example.com/tenant", false],
    ["https://Accounts.google.com/", "https://accounts.google.com", false],
    ["https://accounts.google.com:443/", "https://accounts.google.com", false],
    ["http://accounts.google.com/", "http://accounts.google.com", false],
    ["https://accounts.google.com/?", "https://accounts.google.com", false],
  ] as const;
  for (const [left, right, equivalent] of cases) {
    test(`${left} vs ${right} -> ${String(equivalent)}`, () => {
      expect(vendorMcpIssuerEquivalent(left, right)).toBe(equivalent);
      expect(vendorMcpIssuerEquivalent(right, left)).toBe(equivalent);
    });
  }
});

describe("reviewed interop pins", () => {
  const google = normalizeProviderDefinition(googleLikeInput);
  const docusign = normalizeProviderDefinition(docusignLikeInput);
  const microsoft = normalizeProviderDefinition(microsoftLikeInput);
  const googleUrl = "https://drivemcp.googleapis.com/mcp/v1";
  const docusignUrl = "https://mcp.docusign.com/mcp";
  const microsoftUrl = "https://mcp.microsoft.example/mcp";

  test("root trailing-slash authorization server identifiers pass (Google-like)", () => {
    expect(drift(google, googleUrl, googleLikeDiscovery)).toEqual([]);
    expect(
      drift(
        google,
        googleUrl,
        withServer(googleLikeDiscovery, { issuer: "https://accounts.google.com/" }),
      ),
    ).toEqual([]);
    expect(vendorMcpDiscoveryInput(google, googleUrl)).toEqual({
      mcpUrl: googleUrl,
      protectedResourceMetadata: "published",
      pinnedIssuer: "https://accounts.google.com",
    });
  });

  test("pinned metadata URL and PRM authorization server pass (Docusign-like, Microsoft-like)", () => {
    expect(drift(docusign, docusignUrl, docusignLikeDiscovery)).toEqual([]);
    expect(drift(microsoft, microsoftUrl, microsoftLikeDiscovery)).toEqual([]);
    expect(vendorMcpDiscoveryInput(microsoft, microsoftUrl)).toEqual({
      mcpUrl: microsoftUrl,
      protectedResourceMetadata: "published",
      pinnedIssuer: "https://login.microsoftonline.com/organizations/v2.0",
      authorizationServerMetadataUrl:
        "https://login.microsoftonline.com/organizations/v2.0/.well-known/openid-configuration",
      expectedIssuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
    });
  });

  test("mismatches are still reported", () => {
    expect(
      drift(docusign, docusignUrl, {
        ...docusignLikeDiscovery,
        protectedResource: {
          resource: docusignUrl,
          authorizationServers: ["https://account.docusign.com"],
        },
      }),
    ).toEqual([
      "Protected resource authorization_servers do not include pinned authorization server https://mcp.docusign.com.",
    ]);
    expect(
      drift(
        microsoft,
        microsoftUrl,
        withServer(microsoftLikeDiscovery, {
          issuer: "https://login.microsoftonline.com/organizations/v2.0",
        }),
      ),
    ).toHaveLength(1);
    expect(
      drift(
        docusign,
        docusignUrl,
        withServer(docusignLikeDiscovery, { issuer: "https://account.docusign.com/" }),
      ),
    ).toEqual([
      "Authorization server issuer is https://account.docusign.com/; pinned https://account.docusign.com.",
    ]);
    expect(
      drift(
        google,
        googleUrl,
        withServer(googleLikeDiscovery, { issuer: "https://accounts.google.com/o" }),
      ),
    ).toHaveLength(1);
    expect(
      drift(google, googleUrl, {
        ...googleLikeDiscovery,
        protectedResource: {
          resource: googleUrl,
          authorizationServers: ["https://accounts.google.com/tenant"],
        },
      }),
    ).toHaveLength(1);
  });
});
