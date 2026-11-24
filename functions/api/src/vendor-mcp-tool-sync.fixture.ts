import {
  ConnectionCapabilityRecord,
  ProviderConnectionRecord,
  ToolAdapterRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import type {
  RemoteMcpAllToolsDiscovery,
  RemoteMcpAllToolsDiscoveryResult,
} from "@deployments-ai/mcp-client";
import {
  CODE_PROVIDER_DEFINITION_INPUTS,
  createProviderDefinitionRegistry,
  type OAuthRefreshRequest,
  type OAuthRefreshResponse,
  type ProviderDefinitionInput,
} from "@deployments-ai/providers";
import { Schema } from "effect";
import type { AdministrationApiService } from "./administration-api.ts";
import type {
  AdministrationCredentialPort,
  AdministrationInvocation,
} from "./administration-persistence.ts";
import { makeAdministrationPersistence } from "./administration-persistence.ts";
import {
  ENVIRONMENT_ID,
  ORGANIZATION_ID,
  PROJECT_ID,
  PUBLIC_ORIGIN,
  invocation,
  memoryDatabase,
} from "./vendor-mcp-authorization.fixture.ts";

export const NOW = new Date("2026-10-01T12:00:00.000Z");
export const CONNECTION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FC0" as Ulid;
export const CREDENTIAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FC1" as Ulid;
export const ACCESS_TOKEN = "access-token-0123456789";
export const REFRESHED_ACCESS_TOKEN = "access-token-refreshed-9876543210";

const verification = { method: "mcp_discovery", required: true } as const;

/** OAuth vendor server serving MCP on a path, with code-owned tool classification. */
const docsInput = {
  key: "docs",
  displayName: "Docs",
  category: "knowledge",
  route: "vendor_mcp",
  status: "configured",
  oauthProviderKey: "docs",
  auth: { kind: "oauth" },
  verification,
  mcpServer: {
    url: "https://mcp.docs.example/mcp",
    resource: "https://mcp.docs.example",
    authorization: {
      kind: "oauth",
      issuer: "https://mcp.docs.example",
      authorizationEndpoint: "https://mcp.docs.example/authorize",
      tokenEndpoint: "https://mcp.docs.example/token",
      registrationMethods: ["client_id_metadata_document"],
      tokenEndpointAuthMethods: ["none"],
      scopes: [],
      issParameterSupported: true,
      protectedResourceMetadata: "published",
    },
    documentationUrl: "https://docs.example/mcp",
    reviewedAt: "2026-09-30",
    toolEffects: {
      "docs-search": "read",
      "docs-update": "write",
      "docs-delete": "destructive",
    },
  },
} as const satisfies ProviderDefinitionInput;

const keyedInput = {
  key: "keyed",
  displayName: "Keyed",
  category: "data",
  route: "vendor_mcp",
  status: "configured",
  auth: {
    kind: "api_key",
    fields: [{ key: "apiKey", displayName: "API key", sensitive: true }],
  },
  verification,
  mcpServer: {
    url: "https://mcp.keyed.example/v1/mcp",
    resource: "https://mcp.keyed.example/v1/mcp",
    authorization: { kind: "api_key", field: "apiKey", headerName: "x-api-key" },
    documentationUrl: "https://docs.keyed.example/mcp",
    reviewedAt: "2026-09-30",
    toolEffects: {},
  },
} as const satisfies ProviderDefinitionInput;

/** Freshdesk-shaped api_key server whose endpoint is templated per tenant subdomain. */
const tenantKeyedInput = {
  key: "tenant_keyed",
  displayName: "Tenant keyed",
  category: "support",
  route: "vendor_mcp",
  status: "configured",
  auth: {
    kind: "api_key",
    fields: [{ key: "apiKey", displayName: "API key", sensitive: true }],
  },
  verification,
  mcpServer: {
    url: "https://{tenant}.tenant-keyed.example/mcp",
    tenant: { label: "Tenant subdomain", hostSuffixes: ["tenant-keyed.example"] },
    resource: "https://{tenant}.tenant-keyed.example/mcp",
    authorization: { kind: "api_key", field: "apiKey", headerName: "authorization" },
    documentationUrl: "https://docs.tenant-keyed.example/mcp",
    reviewedAt: "2026-09-30",
    toolEffects: {},
  },
} as const satisfies ProviderDefinitionInput;

const githubInput = {
  key: "github",
  displayName: "GitHub",
  category: "engineering",
  route: "platform_oauth",
  status: "configured",
  oauthProviderKey: "github",
  auth: { kind: "oauth" },
  authorizationScopes: ["repo"],
  verification: { method: "oauth_scopes", required: true },
  tools: [],
} as const satisfies ProviderDefinitionInput;

export interface ToolSyncFixtureOptions {
  readonly discover?: (
    input: RemoteMcpAllToolsDiscovery,
  ) => Promise<RemoteMcpAllToolsDiscoveryResult>;
  readonly refresh?: (request: OAuthRefreshRequest) => Promise<OAuthRefreshResponse>;
  readonly vendorMcp?: boolean;
}

export interface SeedConnectionOptions {
  readonly authMethod?: string;
  readonly capability?: boolean;
  readonly generation?: number;
  /** Overrides the provider default; `null` omits it. */
  readonly oauthResource?: string | null;
  readonly providerKey?: string;
  readonly refreshAfter?: string;
  readonly status?: "active" | "reauthorization-required";
  readonly values?: Readonly<Record<string, string>>;
}

export interface ToolSyncFixture {
  readonly discoveries: readonly RemoteMcpAllToolsDiscovery[];
  readonly invoke: (routeName: string, body?: unknown, key?: string) => Promise<unknown>;
  readonly put: (record: PlatformRecord) => void;
  readonly recordsOf: <T extends PlatformRecord["itemType"]>(
    itemType: T,
  ) => Extract<PlatformRecord, { readonly itemType: T }>[];
  readonly refreshes: readonly OAuthRefreshRequest[];
  readonly secrets: Map<string, Readonly<Record<string, string>>>;
  readonly seedConnection: (options?: SeedConnectionOptions) => void;
  readonly service: AdministrationApiService;
}

const API_KEY_PROVIDERS: ReadonlySet<string> = new Set(["keyed", "tenant_keyed"]);
const timestamps = { createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
const tenant = {
  environmentId: ENVIRONMENT_ID,
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
};

export function connectionRecord(options: SeedConnectionOptions = {}) {
  const providerKey = options.providerKey ?? "docs";
  const oauthResource =
    options.oauthResource === undefined
      ? providerKey === "docs"
        ? "https://mcp.docs.example/mcp"
        : undefined
      : (options.oauthResource ?? undefined);
  return Schema.decodeUnknownSync(ProviderConnectionRecord)(
    withCanonicalRecordKeys({
      itemType: "provider-connection",
      data: {
        ...timestamps,
        ...tenant,
        authMethod:
          options.authMethod ?? (API_KEY_PROVIDERS.has(providerKey) ? "api_key" : "oauth"),
        credentialRef: {
          credentialId: CREDENTIAL_ID,
          generation: options.generation ?? 0,
          store: "dynamodb-kms",
        },
        externalAccountId: "mcp:account",
        id: CONNECTION_ID,
        ...(oauthResource ? { oauthResource } : {}),
        providerKey,
        ...(options.refreshAfter ? { refreshAfter: options.refreshAfter } : {}),
        scopes: ["tools:read", "tools:write"],
        status: options.status ?? "active",
        version: 0,
      },
    }),
  );
}

/** Active synced adapter as a previous sync would have written it. */
export function vendorAdapterRecord(input: {
  readonly id: string;
  readonly name: string;
  readonly providerKey?: string;
  readonly remoteToolName: string;
  readonly toolHash: string;
  readonly effect?: "read" | "write";
  readonly description?: string;
  readonly defaultPolicyAction?: "allow" | "require_approval";
  readonly execution?: Readonly<Record<string, unknown>>;
}) {
  const providerKey = input.providerKey ?? "docs";
  const effect = input.effect ?? "read";
  return Schema.decodeUnknownSync(ToolAdapterRecord)(
    withCanonicalRecordKeys({
      itemType: "tool-adapter",
      data: {
        ...timestamps,
        ...tenant,
        defaultPolicyAction:
          input.defaultPolicyAction ?? (effect === "read" ? "allow" : "require_approval"),
        description: input.description ?? "Search docs",
        effect,
        execution: input.execution ?? {
          providerKey,
          remoteToolName: input.remoteToolName,
          toolHash: input.toolHash,
          type: "vendor_mcp",
        },
        id: input.id,
        inputSchema: { type: "object" },
        name: input.name,
        providerKey,
        requiredScopes: [effect === "read" ? "tools:read" : "tools:write"],
        status: "active",
        version: 0,
      },
    }),
  );
}

export function toolSyncFixture(options: ToolSyncFixtureOptions = {}): ToolSyncFixture {
  const store = memoryDatabase();
  let sequence = 0;
  const secrets = new Map<string, Readonly<Record<string, string>>>();
  const discoveries: RemoteMcpAllToolsDiscovery[] = [];
  const refreshes: OAuthRefreshRequest[] = [];
  const unused = async (): Promise<never> => {
    throw new Error("unexpected port call");
  };
  const credentials: AdministrationCredentialPort = {
    prepareRevoke: unused,
    prepareWrite: async (input) => {
      secrets.set(`${input.identity.credentialId}#0`, input.secret.values);
      const record = {
        data: { id: input.identity.credentialId },
        itemType: "credential-vault-entry",
        pk: `vault#${input.identity.credentialId}`,
        sk: `vault#${input.identity.credentialId}`,
      };
      return {
        // Stand-in vault row; the memory database stores it opaquely.
        operation: { kind: "put", record: record as unknown as PlatformRecord },
        reference: {
          credentialId: input.identity.credentialId,
          generation: 0,
          store: "dynamodb-kms" as const,
        },
      };
    },
    read: async (input) => {
      const { reference } = input;
      if (!("credentialId" in reference)) throw new Error("unexpected secret reference");
      const values = secrets.get(`${reference.credentialId}#${reference.generation}`);
      if (!values) throw new Error(`missing credential generation ${reference.generation}`);
      return { values };
    },
  };
  const put = store.seed;
  const service = makeAdministrationPersistence({
    credentials,
    database: store.database,
    generateId: async () => {
      sequence += 1;
      return `01ARZ3NDEKTSV4RRFFQ69H${String(sequence).padStart(4, "0")}`;
    },
    mcpDiscovery: { discover: unused },
    now: () => NOW,
    providerVerification: { verify: unused },
    providers: createProviderDefinitionRegistry([
      docsInput,
      keyedInput,
      tenantKeyedInput,
      githubInput,
      ...CODE_PROVIDER_DEFINITION_INPUTS.filter((input) => input.key === "wordpress"),
    ]),
    resolveEnvironment: async () => ({ ...tenant, id: ENVIRONMENT_ID, status: "active" }),
    resolveWorkspace: async () => false,
    ...(options.vendorMcp === false
      ? {}
      : {
          vendorMcp: {
            discoverAuthorization: unused,
            mcpClient: {
              callTool: unused,
              discoverAllTools: async (input) => {
                discoveries.push(input);
                return (options.discover ?? unused)(input);
              },
              discoverTools: unused,
            },
            publicOrigin: PUBLIC_ORIGIN,
            refreshConnection: async (request) => {
              refreshes.push(request);
              return (options.refresh ?? unused)(request);
            },
            registerClient: unused,
          },
        }),
  });
  return {
    discoveries,
    invoke: (routeName, body, key) => {
      const base: AdministrationInvocation = invocation(body, key);
      return service.invoke(routeName as never, {
        ...base,
        id: CONNECTION_ID,
        params: { connectionId: CONNECTION_ID, id: CONNECTION_ID },
      });
    },
    put,
    recordsOf: <T extends PlatformRecord["itemType"]>(itemType: T) =>
      [...store.records.values()].filter(
        (record): record is Extract<PlatformRecord, { readonly itemType: T }> =>
          record.itemType === itemType,
      ),
    refreshes,
    secrets,
    seedConnection: (seed = {}) => {
      put(connectionRecord(seed));
      secrets.set(
        `${CREDENTIAL_ID}#${seed.generation ?? 0}`,
        seed.values ??
          (API_KEY_PROVIDERS.has(seed.providerKey ?? "docs")
            ? { apiKey: "keyed-secret-0123456789" }
            : { accessToken: ACCESS_TOKEN, refreshToken: "refresh-token-0123456789" }),
      );
      if (seed.capability === false) return;
      put(
        Schema.decodeUnknownSync(ConnectionCapabilityRecord)(
          withCanonicalRecordKeys({
            itemType: "connection-capability",
            data: {
              ...timestamps,
              ...tenant,
              connectionId: CONNECTION_ID,
              id: "01ARZ3NDEKTSV4RRFFQ69G5FC2",
              providerKey: seed.providerKey ?? "docs",
              scopes: ["tools:read", "tools:write"],
              status: "active",
              verificationVersion: 1,
              version: 0,
            },
          }),
        ),
      );
    },
    service,
  };
}
