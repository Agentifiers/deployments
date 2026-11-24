import type { ProviderDefinitionInput } from "./provider-definition-types.ts";
import type {
  VendorMcpDiscoveredAuthorization,
  VendorMcpOAuthAuthorization,
  VendorMcpServerDefinitionInput,
} from "./vendor-mcp-types.ts";

const verification = { method: "mcp_discovery", required: true } as const;

export const notionLikeServer = {
  url: "https://mcp.notion.example/mcp",
  resource: "https://mcp.notion.example/mcp",
  authorization: {
    kind: "oauth",
    issuer: "https://mcp.notion.example",
    authorizationEndpoint: "https://mcp.notion.example/authorize",
    tokenEndpoint: "https://mcp.notion.example/token",
    revocationEndpoint: "https://mcp.notion.example/token/revoke",
    registrationMethods: ["client_id_metadata_document", "dynamic_client_registration"],
    tokenEndpointAuthMethods: ["none"],
    scopes: [],
    issParameterSupported: true,
    protectedResourceMetadata: "published",
  },
  documentationUrl: "https://developers.notion.example/docs/mcp",
  reviewedAt: "2026-09-30",
  toolEffects: {
    "notion-search": "read",
    "notion-update-page": "write",
    "notion-delete": "destructive",
  },
} as const satisfies VendorMcpServerDefinitionInput;

export const notionLikeInput = {
  key: "notion",
  displayName: "Notion",
  category: "knowledge",
  route: "vendor_mcp",
  status: "configured",
  oauthProviderKey: "notion",
  auth: { kind: "oauth" },
  verification,
  mcpServer: notionLikeServer,
} as const satisfies ProviderDefinitionInput;

export const notionLikeDiscovery: VendorMcpDiscoveredAuthorization = {
  protectedResource: {
    resource: "https://mcp.notion.example/mcp",
    authorizationServers: ["https://mcp.notion.example"],
  },
  authorizationServer: {
    issuer: "https://mcp.notion.example",
    authorizationEndpoint: "https://mcp.notion.example/authorize",
    tokenEndpoint: "https://mcp.notion.example/token",
    registrationEndpoint: "https://mcp.notion.example/register",
    revocationEndpoint: "https://mcp.notion.example/token/revoke",
    clientIdMetadataDocumentSupported: true,
    codeChallengeMethodsSupported: ["plain", "S256"],
    tokenEndpointAuthMethodsSupported: ["none", "client_secret_basic"],
    authorizationResponseIssParameterSupported: true,
  },
};

/** Legacy server: no protected resource metadata; AS metadata at the pinned issuer. */
export const atlassianLegacyInput = {
  key: "atlassian",
  displayName: "Atlassian",
  category: "engineering",
  route: "vendor_mcp",
  status: "configured",
  oauthProviderKey: "atlassian",
  auth: { kind: "oauth" },
  verification,
  mcpServer: {
    url: "https://mcp.atlassian.example/v1/mcp",
    resource: "https://mcp.atlassian.example/v1/mcp",
    authorization: {
      kind: "oauth",
      issuer: "https://cf.mcp.atlassian.example",
      authorizationEndpoint: "https://mcp.atlassian.example/v1/authorize",
      tokenEndpoint: "https://cf.mcp.atlassian.example/v1/token",
      registrationMethods: ["dynamic_client_registration"],
      tokenEndpointAuthMethods: ["client_secret_basic", "client_secret_post", "none"],
      scopes: [],
      issParameterSupported: false,
      protectedResourceMetadata: "absent",
    },
    documentationUrl: "https://support.atlassian.example/rovo-mcp",
    reviewedAt: "2026-09-30",
    toolEffects: { getJiraIssue: "read", createJiraIssue: "write" },
  },
} as const satisfies ProviderDefinitionInput;

export const atlassianLegacyDiscovery: VendorMcpDiscoveredAuthorization = {
  authorizationServer: {
    issuer: "https://cf.mcp.atlassian.example",
    authorizationEndpoint: "https://mcp.atlassian.example/v1/authorize",
    tokenEndpoint: "https://cf.mcp.atlassian.example/v1/token",
    registrationEndpoint: "https://cf.mcp.atlassian.example/v1/register",
    clientIdMetadataDocumentSupported: false,
    codeChallengeMethodsSupported: ["S256"],
    tokenEndpointAuthMethodsSupported: ["client_secret_basic", "client_secret_post", "none"],
    authorizationResponseIssParameterSupported: false,
  },
};

function preRegisteredOAuthInput(
  key: string,
  url: string,
  authorization: Pick<
    VendorMcpOAuthAuthorization,
    | "issuer"
    | "authorizationEndpoint"
    | "tokenEndpoint"
    | "authorizationServerMetadataUrl"
    | "protectedResourceAuthorizationServer"
  >,
): ProviderDefinitionInput {
  return {
    key,
    displayName: key,
    category: "productivity",
    route: "vendor_mcp",
    status: "configured",
    oauthProviderKey: key.replaceAll("_", "-"),
    auth: { kind: "oauth" },
    verification,
    mcpServer: {
      url,
      resource: url,
      authorization: {
        kind: "oauth",
        registrationMethods: ["pre_registered"],
        tokenEndpointAuthMethods: ["client_secret_post"],
        scopes: [],
        issParameterSupported: false,
        protectedResourceMetadata: "published",
        ...authorization,
      },
      documentationUrl: "https://docs.vendor.example/mcp",
      reviewedAt: "2026-09-30",
      toolEffects: {},
    },
  };
}

function preRegisteredDiscovery(
  resource: string,
  authorizationServers: readonly string[],
  server: Pick<
    VendorMcpDiscoveredAuthorization["authorizationServer"],
    "issuer" | "authorizationEndpoint" | "tokenEndpoint"
  >,
): VendorMcpDiscoveredAuthorization {
  return {
    protectedResource: { resource, authorizationServers },
    authorizationServer: {
      ...server,
      clientIdMetadataDocumentSupported: false,
      codeChallengeMethodsSupported: ["S256"],
      tokenEndpointAuthMethodsSupported: ["client_secret_post"],
      authorizationResponseIssParameterSupported: false,
    },
  };
}

/** PRM lists the issuer with a root trailing slash; metadata issuer has none. */
export const googleLikeInput = preRegisteredOAuthInput(
  "google_drive",
  "https://drivemcp.googleapis.com/mcp/v1",
  {
    issuer: "https://accounts.google.com",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
  },
);

export const googleLikeDiscovery = preRegisteredDiscovery(
  "https://drivemcp.googleapis.com/mcp/v1",
  ["https://accounts.google.com/"],
  {
    issuer: "https://accounts.google.com",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
  },
);

/** PRM names the MCP host as authorization server; metadata issuer is the account host. */
export const docusignLikeInput = preRegisteredOAuthInput(
  "docusign",
  "https://mcp.docusign.com/mcp",
  {
    issuer: "https://account.docusign.com",
    authorizationServerMetadataUrl: "https://account.docusign.com/.well-known/openid-configuration",
    protectedResourceAuthorizationServer: "https://mcp.docusign.com",
    authorizationEndpoint: "https://account.docusign.com/oauth/auth",
    tokenEndpoint: "https://account.docusign.com/oauth/token",
  },
);

export const docusignLikeDiscovery = preRegisteredDiscovery(
  "https://mcp.docusign.com/mcp",
  ["https://mcp.docusign.com"],
  {
    issuer: "https://account.docusign.com",
    authorizationEndpoint: "https://account.docusign.com/oauth/auth",
    tokenEndpoint: "https://account.docusign.com/oauth/token",
  },
);

/** Multi-tenant Entra: metadata publishes the literal `{tenantid}` issuer. */
export const microsoftLikeInput = preRegisteredOAuthInput(
  "microsoft_365",
  "https://mcp.microsoft.example/mcp",
  {
    issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
    authorizationServerMetadataUrl:
      "https://login.microsoftonline.com/organizations/v2.0/.well-known/openid-configuration",
    protectedResourceAuthorizationServer: "https://login.microsoftonline.com/organizations/v2.0",
    authorizationEndpoint: "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
    tokenEndpoint: "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
  },
);

export const microsoftLikeDiscovery = preRegisteredDiscovery(
  "https://mcp.microsoft.example/mcp",
  ["https://login.microsoftonline.com/organizations/v2.0"],
  {
    issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
    authorizationEndpoint: "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
    tokenEndpoint: "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
  },
);

/** Tenant-templated server (`https://{tenant}.mcp.tenant.example/mcp`). */
export const tenantTemplatedInput = {
  key: "acme_desk",
  displayName: "Acme Desk",
  category: "support",
  route: "vendor_mcp",
  status: "configured",
  oauthProviderKey: "acme-desk",
  auth: { kind: "oauth" },
  verification,
  mcpServer: {
    url: "https://{tenant}.mcp.tenant.example/mcp",
    tenant: { label: "Acme Desk subdomain", hostSuffixes: ["mcp.tenant.example"] },
    resource: "https://{tenant}.mcp.tenant.example/mcp",
    authorization: {
      kind: "oauth",
      issuer: "https://{tenant}.mcp.tenant.example",
      authorizationEndpoint: "https://{tenant}.mcp.tenant.example/oauth/authorize",
      tokenEndpoint: "https://{tenant}.mcp.tenant.example/oauth/token",
      registrationMethods: ["pre_registered"],
      tokenEndpointAuthMethods: ["client_secret_basic"],
      scopes: ["mcp:read", "mcp:write"],
      issParameterSupported: false,
      protectedResourceMetadata: "published",
    },
    documentationUrl: "https://docs.tenant.example/mcp",
    reviewedAt: "2026-09-30",
    toolEffects: {},
  },
} as const satisfies ProviderDefinitionInput;

export const apiKeyInput = {
  key: "keyed_vendor",
  displayName: "Keyed Vendor",
  category: "data",
  route: "vendor_mcp",
  status: "configured",
  auth: {
    kind: "api_key",
    fields: [{ key: "apiKey", displayName: "API key", sensitive: true }],
  },
  verification,
  mcpServer: {
    url: "https://mcp.keyed.example/mcp",
    resource: "https://mcp.keyed.example/mcp",
    authorization: {
      kind: "api_key",
      field: "apiKey",
      headerName: "authorization",
      scheme: "Bearer",
    },
    documentationUrl: "https://docs.keyed.example/mcp",
    reviewedAt: "2026-09-30",
    toolEffects: {},
  },
} as const satisfies ProviderDefinitionInput;
