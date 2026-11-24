import {
  DatabaseError,
  tableForItemType,
  type DynamoDatabaseService,
  type PlatformRecord,
  type QueryRecordsResult,
  type TableName,
  type Ulid,
} from "@deployments-ai/db";
import type {
  DiscoverMcpAuthorizationInput,
  DynamicOAuthClientRegistration,
  McpDiscoveredAuthorization,
  RegisterDynamicOAuthClientInput,
} from "@deployments-ai/mcp-client";
import {
  createProviderDefinitionRegistry,
  type ProviderDefinitionInput,
} from "@deployments-ai/providers";
import type { AdministrationApiService } from "./administration-api.ts";
import type {
  AdministrationCredentialPort,
  AdministrationInvocation,
} from "./administration-persistence.ts";
import { makeAdministrationPersistence } from "./administration-persistence.ts";

export const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
export const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
export const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;
export const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
export const PUBLIC_ORIGIN = "https://channels.example.test";
export const CIMD_URL = `${PUBLIC_ORIGIN}/public/provider-connections/oauth/client-metadata.json`;
export const RETURN_ORIGIN = "https://app.example.test";

const verification = { method: "mcp_discovery", required: true } as const;

/** CIMD + DCR public client; PRM `resource` is the origin while MCP is served on `/mcp`. */
const notionInput = {
  key: "notion",
  displayName: "Notion",
  category: "knowledge",
  route: "vendor_mcp",
  status: "configured",
  oauthProviderKey: "notion",
  auth: { kind: "oauth" },
  verification,
  mcpServer: {
    url: "https://mcp.notion.example/mcp",
    resource: "https://mcp.notion.example",
    authorization: {
      kind: "oauth",
      issuer: "https://mcp.notion.example",
      authorizationEndpoint: "https://mcp.notion.example/authorize",
      tokenEndpoint: "https://mcp.notion.example/token",
      registrationMethods: ["client_id_metadata_document", "dynamic_client_registration"],
      tokenEndpointAuthMethods: ["none"],
      scopes: [],
      issParameterSupported: true,
      protectedResourceMetadata: "published",
    },
    documentationUrl: "https://developers.notion.example/docs/mcp",
    reviewedAt: "2026-09-30",
    toolEffects: {},
  },
} as const satisfies ProviderDefinitionInput;

/** Confidential client: pre-registration or DCR, no CIMD. */
const linearInput = {
  key: "linear",
  displayName: "Linear",
  category: "engineering",
  route: "vendor_mcp",
  status: "configured",
  oauthProviderKey: "linear",
  auth: { kind: "oauth" },
  verification,
  mcpServer: {
    url: "https://mcp.linear.example/mcp",
    resource: "https://mcp.linear.example/mcp",
    authorization: {
      kind: "oauth",
      issuer: "https://auth.linear.example",
      authorizationEndpoint: "https://auth.linear.example/authorize",
      tokenEndpoint: "https://auth.linear.example/token",
      registrationMethods: ["pre_registered", "dynamic_client_registration"],
      tokenEndpointAuthMethods: ["client_secret_post", "client_secret_basic"],
      scopes: ["read", "write"],
      issParameterSupported: false,
      protectedResourceMetadata: "published",
    },
    documentationUrl: "https://linear.example/docs/mcp",
    reviewedAt: "2026-09-30",
    toolEffects: {},
  },
} as const satisfies ProviderDefinitionInput;

/** Tenant-templated, pre-registration only. */
const acmeInput = {
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
      scopes: ["mcp:read"],
      issParameterSupported: false,
      protectedResourceMetadata: "published",
    },
    documentationUrl: "https://docs.tenant.example/mcp",
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

/** Live discovery result matching the pins of `input` for `mcpUrl`. */
export function pinnedDiscovery(mcpUrl: string): McpDiscoveredAuthorization {
  const url = new URL(mcpUrl);
  if (url.hostname === "mcp.notion.example") {
    return {
      challenge: {},
      protectedResource: {
        authorizationServers: ["https://mcp.notion.example"],
        metadataUrl: "https://mcp.notion.example/.well-known/oauth-protected-resource/mcp",
        resource: "https://mcp.notion.example",
      },
      authorizationServer: {
        authorizationEndpoint: "https://mcp.notion.example/authorize",
        authorizationResponseIssParameterSupported: true,
        clientIdMetadataDocumentSupported: true,
        codeChallengeMethodsSupported: ["S256"],
        issuer: "https://mcp.notion.example",
        metadataUrl: "https://mcp.notion.example/.well-known/oauth-authorization-server",
        registrationEndpoint: "https://mcp.notion.example/register",
        tokenEndpoint: "https://mcp.notion.example/token",
        tokenEndpointAuthMethodsSupported: ["none"],
      },
    };
  }
  if (url.hostname === "mcp.linear.example") {
    return {
      challenge: {},
      protectedResource: {
        authorizationServers: ["https://auth.linear.example"],
        metadataUrl: "https://mcp.linear.example/.well-known/oauth-protected-resource/mcp",
        resource: "https://mcp.linear.example/mcp",
      },
      authorizationServer: {
        authorizationEndpoint: "https://auth.linear.example/authorize",
        authorizationResponseIssParameterSupported: false,
        clientIdMetadataDocumentSupported: false,
        codeChallengeMethodsSupported: ["S256"],
        issuer: "https://auth.linear.example",
        metadataUrl: "https://auth.linear.example/.well-known/oauth-authorization-server",
        registrationEndpoint: "https://auth.linear.example/register",
        tokenEndpoint: "https://auth.linear.example/token",
        tokenEndpointAuthMethodsSupported: ["client_secret_post", "client_secret_basic"],
      },
    };
  }
  const origin = url.origin;
  return {
    challenge: {},
    protectedResource: {
      authorizationServers: [origin],
      metadataUrl: `${origin}/.well-known/oauth-protected-resource/mcp`,
      resource: mcpUrl,
    },
    authorizationServer: {
      authorizationEndpoint: `${origin}/oauth/authorize`,
      authorizationResponseIssParameterSupported: false,
      clientIdMetadataDocumentSupported: false,
      codeChallengeMethodsSupported: ["S256"],
      issuer: origin,
      metadataUrl: `${origin}/.well-known/oauth-authorization-server`,
      tokenEndpoint: `${origin}/oauth/token`,
      tokenEndpointAuthMethodsSupported: ["client_secret_basic"],
    },
  };
}

function conflict(operation: string) {
  return new DatabaseError({
    cause: new Error("simulated conditional failure"),
    message: "Conditional write failed.",
    operation,
    reason: "conflict",
    table: "control",
  });
}

function field(record: PlatformRecord, name: string) {
  return (record as unknown as Readonly<Record<string, unknown>>)[name];
}

/** In-memory control table with create-only and optimistic-version transaction semantics. */
export function memoryDatabase() {
  const records = new Map<string, PlatformRecord>();
  const storageKey = (table: TableName, key: { readonly pk: string; readonly sk: string }) =>
    `${table}\u0000${key.pk}\u0000${key.sk}`;
  const keyOf = (record: PlatformRecord) => storageKey(tableForItemType(record.itemType), record);
  const database: DynamoDatabaseService = {
    deleteRecord: async (record) => {
      records.delete(keyOf(record));
    },
    getRecord: async (table, key) => structuredClone(records.get(storageKey(table, key))),
    putRecord: async (record) => {
      records.set(keyOf(record), structuredClone(record));
    },
    queryRecords: async (table, input) => {
      const values = input.ExpressionAttributeValues ?? {};
      const index = input.IndexName ?? "";
      const prefix = String(values[":prefix"] ?? "");
      const items = [...records.values()].filter((record) => {
        const sortKey = field(record, `${index}sk`);
        return (
          tableForItemType(record.itemType) === table &&
          field(record, `${index}pk`) === values[":partition"] &&
          (typeof sortKey === "string" ? sortKey : "").startsWith(prefix)
        );
      });
      return { items: structuredClone(items) } satisfies QueryRecordsResult;
    },
    transactWrite: async (operations) => {
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        const existing = records.get(keyOf(operation.record));
        if (operation.kind === "delete") continue;
        if (operation.previousRecord) {
          const previous = operation.previousRecord.data as Readonly<Record<string, unknown>>;
          const current = existing?.data as Readonly<Record<string, unknown>> | undefined;
          if (current?.version !== previous.version) throw conflict("put");
        } else if (existing && !operation.allowExisting) {
          throw conflict("create");
        }
      }
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        if (operation.kind === "delete") records.delete(keyOf(operation.record));
        else records.set(keyOf(operation.record), structuredClone(operation.record));
      }
    },
  };
  const seed = (record: PlatformRecord) => {
    records.set(keyOf(record), structuredClone(record));
  };
  return { database, records, seed };
}

export function invocation(
  body: unknown,
  idempotencyKey = `key-${crypto.randomUUID()}`,
): AdministrationInvocation {
  return {
    body,
    identity: {
      environmentIds: [ENVIRONMENT_ID],
      organizationIds: [ORGANIZATION_ID],
      principalId: PRINCIPAL_ID,
      projectIds: [PROJECT_ID],
      scopes: ["administration:write"],
    },
    idempotencyKey,
    params: {},
    query: {},
    scope: { environmentId: ENVIRONMENT_ID },
  };
}

export interface VendorMcpFixtureOptions {
  readonly vendorMcp?: boolean;
  readonly discover?: (input: DiscoverMcpAuthorizationInput) => Promise<McpDiscoveredAuthorization>;
  readonly register?: (
    input: RegisterDynamicOAuthClientInput,
  ) => Promise<DynamicOAuthClientRegistration>;
}

export interface VendorMcpFixture {
  readonly credentialWrites: readonly Parameters<AdministrationCredentialPort["prepareWrite"]>[0][];
  readonly discoveryInputs: readonly DiscoverMcpAuthorizationInput[];
  readonly put: (record: PlatformRecord) => void;
  readonly recordsOf: <T extends PlatformRecord["itemType"]>(
    itemType: T,
  ) => Extract<PlatformRecord, { readonly itemType: T }>[];
  readonly registrations: readonly RegisterDynamicOAuthClientInput[];
  readonly secrets: ReadonlyMap<string, Readonly<Record<string, string>>>;
  readonly service: AdministrationApiService;
}

export function vendorMcpFixture(options: VendorMcpFixtureOptions = {}): VendorMcpFixture {
  const store = memoryDatabase();
  let sequence = 0;
  const secrets = new Map<string, Readonly<Record<string, string>>>();
  const credentialWrites: Parameters<AdministrationCredentialPort["prepareWrite"]>[0][] = [];
  const discoveryInputs: DiscoverMcpAuthorizationInput[] = [];
  const registrations: RegisterDynamicOAuthClientInput[] = [];
  const credentials: AdministrationCredentialPort = {
    prepareRevoke: async () => {
      throw new Error("unexpected revoke");
    },
    prepareWrite: async (input) => {
      credentialWrites.push(input);
      secrets.set(input.identity.credentialId, input.secret.values);
      const reference = {
        credentialId: input.identity.credentialId,
        generation: 0,
        store: "dynamodb-kms" as const,
      };
      return {
        operation: {
          kind: "put",
          record: {
            data: { id: input.identity.credentialId },
            itemType: "credential-vault-entry",
            pk: `vault#${input.identity.credentialId}`,
            sk: `vault#${input.identity.credentialId}`,
          } as unknown as PlatformRecord,
        },
        reference,
      };
    },
    read: async (input) => ({ values: secrets.get(input.reference.credentialId) ?? {} }),
  };
  const unused = async (): Promise<never> => {
    throw new Error("unexpected vendor MCP port call");
  };
  const service = makeAdministrationPersistence({
    credentials,
    database: store.database,
    generateId: async () => {
      sequence += 1;
      return `01ARZ3NDEKTSV4RRFFQ69G${String(sequence).padStart(4, "0")}`;
    },
    mcpDiscovery: { discover: unused },
    now: () => new Date("2026-10-01T12:00:00.000Z"),
    oauthReturnOrigins: [RETURN_ORIGIN],
    providerVerification: { verify: unused },
    providers: createProviderDefinitionRegistry([notionInput, linearInput, acmeInput, githubInput]),
    resolveEnvironment: async () => ({
      id: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      status: "active",
    }),
    resolveWorkspace: async () => false,
    ...(options.vendorMcp === false
      ? {}
      : {
          vendorMcp: {
            discoverAuthorization: async (input) => {
              discoveryInputs.push(input);
              return (options.discover ?? (async () => pinnedDiscovery(input.mcpUrl)))(input);
            },
            mcpClient: { callTool: unused, discoverAllTools: unused, discoverTools: unused },
            publicOrigin: PUBLIC_ORIGIN,
            refreshConnection: unused,
            registerClient: async (input) => {
              registrations.push(input);
              if (!options.register) throw new Error("unexpected registration");
              return options.register(input);
            },
          },
        }),
  });
  const recordsOf = <T extends PlatformRecord["itemType"]>(itemType: T) =>
    [...store.records.values()].filter(
      (record): record is Extract<PlatformRecord, { readonly itemType: T }> =>
        record.itemType === itemType,
    );
  return {
    credentialWrites,
    discoveryInputs,
    put: store.seed,
    recordsOf,
    registrations,
    secrets,
    service,
  };
}
