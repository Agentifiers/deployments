import {
  credentialValuesWithProviderOAuthMaterial,
  CredentialVaultError,
  type CredentialVaultReference,
  type CredentialVaultSecretDocument,
  type CredentialVaultService,
  type CredentialVaultWriteRequest,
} from "@deployments-ai/credential-vault";
import {
  OAuthAuthorizationAttemptRecord,
  ProviderConnectionRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type TransactionOperation,
  type TransactionPut,
  type Ulid,
} from "@deployments-ai/db";
import {
  createProviderDefinitionRegistry,
  platformOAuthStateHash,
  type PlatformOAuthAppRegistry,
  type ProviderDefinitionInput,
} from "@deployments-ai/providers";
import { Schema } from "effect";

import {
  updatedOwner,
  type CredentialOwnershipMutation,
  type ProviderConnectionReauthorizationRequired,
} from "./credential-ownership.ts";
import type { OAuthRefreshDependencies } from "./oauth-refresh.ts";
import type { OAuthScope } from "./oauth-runtime-dependencies.ts";
import { OAuthRecordNotFoundError } from "./oauth-validation.ts";

export const PUBLIC_ORIGIN = "https://channels.example.test";
export const CIMD_CLIENT_ID = `${PUBLIC_ORIGIN}/public/provider-connections/oauth/client-metadata.json`;
export const RETURN_ORIGIN = "https://app.example.test";
export const RETURN_TO = `${RETURN_ORIGIN}/settings/connections?tab=apps`;
export const NOW = new Date("2026-10-01T00:00:00.000Z");

export const ulid = (index: number) =>
  `01ARZ3NDEKTSV4RRFFQ69G5F${String(index).padStart(2, "0")}` as Ulid;

export const SCOPE: OAuthScope = {
  environmentId: ulid(1),
  organizationId: ulid(2),
  projectId: ulid(3),
};

/** CIMD-capable vendor whose PRM resource equals its endpoint; RFC 7009 revocation pinned. */
export const notionInput = {
  key: "notion",
  displayName: "Notion",
  category: "knowledge",
  route: "vendor_mcp",
  status: "configured",
  oauthProviderKey: "notion",
  auth: { kind: "oauth" },
  verification: { method: "mcp_discovery", required: true },
  mcpServer: {
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
    toolEffects: { "notion-search": "read" },
  },
} as const satisfies ProviderDefinitionInput;

/** Pre-registered confidential client; PRM resource is the origin while MCP is served on /mcp. */
const slackInput = {
  key: "slack_mcp",
  displayName: "Slack MCP",
  category: "messaging",
  route: "vendor_mcp",
  status: "configured",
  oauthProviderKey: "slack-mcp",
  auth: { kind: "oauth" },
  verification: { method: "mcp_discovery", required: true },
  mcpServer: {
    url: "https://mcp.slack.example/mcp",
    resource: "https://mcp.slack.example",
    authorization: {
      kind: "oauth",
      issuer: "https://slack.example",
      authorizationEndpoint: "https://slack.example/oauth/authorize",
      tokenEndpoint: "https://slack.example/oauth/token",
      registrationMethods: ["pre_registered"],
      tokenEndpointAuthMethods: ["client_secret_basic"],
      scopes: ["chat:write", "search:read"],
      issParameterSupported: false,
      protectedResourceMetadata: "published",
    },
    documentationUrl: "https://docs.slack.example/mcp",
    reviewedAt: "2026-09-30",
    toolEffects: {},
  },
} as const satisfies ProviderDefinitionInput;

export const NOTION_ENDPOINT = notionInput.mcpServer.url;
export const SLACK_ENDPOINT = slackInput.mcpServer.url;
export const SLACK_RESOURCE = slackInput.mcpServer.resource;
export const SLACK_APPLICATION_ID = ulid(9);

interface FakeVaultEntry {
  readonly document: CredentialVaultSecretDocument;
  readonly ownerId: string;
  readonly purpose: string;
}

export interface OAuthHarness {
  readonly authorizations: (readonly TransactionOperation[])[];
  /** Live refresh claims keyed `<connectionId>#<generation>` -> owner. */
  readonly claims: Map<string, string>;
  readonly dependencies: OAuthRefreshDependencies;
  readonly fetches: { readonly init: RequestInit; readonly url: string }[];
  readonly marks: ProviderConnectionReauthorizationRequired[];
  readonly mutations: CredentialOwnershipMutation[];
  readonly records: Map<string, PlatformRecord>;
  readonly vaultEntries: Map<string, FakeVaultEntry>;
  readonly vaultWrites: CredentialVaultWriteRequest[];
  respond: (url: string, init: RequestInit) => Promise<Response>;
  clock: Date;
}

function recordKey(itemType: string, itemId: string) {
  return `${itemType}:${itemId}`;
}

function fakeVault(harness: Pick<OAuthHarness, "vaultEntries" | "vaultWrites">) {
  const operation = (
    credentialId: string,
    previous: number | undefined,
    next: number,
  ): TransactionPut => {
    const fake: unknown = {
      kind: "put",
      ...(previous === undefined
        ? {}
        : { previousRecord: { data: { generation: previous, id: credentialId } } }),
      record: { data: { generation: next, id: credentialId } },
    };
    return fake as TransactionPut;
  };
  const vault: CredentialVaultService = {
    prepareRevoke: async ({ reference }) => ({
      operation: operation(reference.credentialId, reference.generation, reference.generation),
      reference,
    }),
    prepareWrite: async (request) => {
      harness.vaultWrites.push(request);
      const generation =
        request.expectedGeneration === undefined ? 0 : request.expectedGeneration + 1;
      const existing = harness.vaultEntries.get(request.identity.credentialId);
      if (
        request.expectedGeneration !== undefined &&
        existing?.document.generation !== request.expectedGeneration
      ) {
        throw new CredentialVaultError("conflict", "generation mismatch");
      }
      harness.vaultEntries.set(request.identity.credentialId, {
        document: {
          ...request.secret,
          createdAt: NOW.toISOString(),
          generation,
          schemaVersion: 1,
          updatedAt: NOW.toISOString(),
        },
        ownerId: request.identity.ownerId,
        purpose: request.identity.purpose,
      });
      return {
        operation: operation(request.identity.credentialId, request.expectedGeneration, generation),
        reference: {
          credentialId: request.identity.credentialId,
          generation,
          store: "dynamodb-kms",
        },
      };
    },
    read: async ({ expectedIdentity, reference }) => {
      const entry = harness.vaultEntries.get(reference.credentialId);
      if (!entry) throw new CredentialVaultError("not-found", "missing");
      if (
        entry.document.generation !== reference.generation ||
        entry.ownerId !== expectedIdentity.ownerId ||
        entry.purpose !== expectedIdentity.purpose
      ) {
        throw new CredentialVaultError("conflict", "pinned reference mismatch");
      }
      return entry.document;
    },
    revoke: async () => undefined,
    write: async () => {
      throw new Error("not used");
    },
  };
  return vault;
}

export function oauthHarness(
  extraInputs: readonly ProviderDefinitionInput[] = [],
  options: {
    readonly platformApps?: PlatformOAuthAppRegistry;
    readonly publicOrigin?: string;
  } = { publicOrigin: PUBLIC_ORIGIN },
): OAuthHarness {
  const definitions = createProviderDefinitionRegistry([notionInput, slackInput, ...extraInputs]);
  let nextId = 40;
  const harness: Omit<OAuthHarness, "dependencies"> = {
    authorizations: [],
    claims: new Map(),
    clock: NOW,
    fetches: [],
    marks: [],
    mutations: [],
    records: new Map(),
    respond: async () => new Response("{}", { status: 500 }),
    vaultEntries: new Map(),
    vaultWrites: [],
  };
  const vault = fakeVault(harness);
  const dependencies: OAuthRefreshDependencies = {
    claims: {
      acquire: async (input) => {
        const key = `${input.connectionId}#${input.credentialGeneration}`;
        if (harness.claims.has(key)) return "held" as const;
        harness.claims.set(key, input.owner);
        return "acquired" as const;
      },
      release: async (input) => {
        const key = `${input.connectionId}#${input.credentialGeneration}`;
        if (harness.claims.get(key) === input.owner) harness.claims.delete(key);
      },
    },
    sleep: async (ms) => {
      harness.clock = new Date(harness.clock.getTime() + ms);
    },
    commitAuthorization: async (_scope, operations) => {
      harness.authorizations.push(operations);
    },
    commitOwnership: async (mutation) => {
      harness.mutations.push(mutation);
      const key = recordKey(mutation.ownerType, mutation.ownerId);
      const owner = harness.records.get(key);
      if (!owner) throw new Error("Credential owner was not found.");
      harness.records.set(key, updatedOwner(owner, mutation, harness.clock.toISOString()));
    },
    definitions: () => definitions,
    fetch: async (url, init) => {
      harness.fetches.push({ init, url });
      return harness.respond(url, init);
    },
    loadControlRecord: async (_scope, itemType, itemId) => {
      const record = harness.records.get(recordKey(itemType, itemId));
      if (!record) throw new OAuthRecordNotFoundError(itemType);
      return record;
    },
    id: async () => ulid(nextId++),
    markReauthorizationRequired: async (input) => {
      harness.marks.push(input);
    },
    now: () => harness.clock,
    platformApps: () => options.platformApps ?? {},
    publicOrigin: () => options.publicOrigin,
    returnOrigins: () => [RETURN_ORIGIN],
    standing: { read: async () => ({ state: "active" }) },
    vault: async () => vault,
  };
  return Object.assign(harness, { dependencies });
}

export function putRecord(harness: OAuthHarness, record: PlatformRecord) {
  const id = "id" in record.data ? String(record.data.id) : "";
  harness.records.set(recordKey(record.itemType, id), record);
}

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

export function formBody(init: RequestInit) {
  if (typeof init.body !== "string") throw new TypeError("Expected a string form request body.");
  return Object.fromEntries(new URLSearchParams(init.body));
}

export function header(init: RequestInit, name: string) {
  return new Headers(init.headers).get(name);
}

export const ATTEMPT_ID = ulid(10);
export const STATE = `${SCOPE.organizationId}.${SCOPE.projectId}.${SCOPE.environmentId}.${ATTEMPT_ID}.nonce-value`;
const PKCE_CREDENTIAL_ID = ulid(11);
export const PKCE_VERIFIER = "pkce-verifier-value";

/** Seeds a pending vendor MCP attempt and its vaulted PKCE verifier; `undefined` omits a field. */
export function seedVendorAttempt(harness: OAuthHarness, data: Readonly<Record<string, unknown>>) {
  harness.vaultEntries.set(PKCE_CREDENTIAL_ID, {
    document: {
      createdAt: NOW.toISOString(),
      generation: 0,
      schemaVersion: 1,
      updatedAt: NOW.toISOString(),
      values: { verifier: PKCE_VERIFIER },
    },
    ownerId: ATTEMPT_ID,
    purpose: "oauth-pkce-verifier",
  });
  const expiresAt = new Date(NOW.getTime() + 10 * 60_000).toISOString();
  putRecord(
    harness,
    Schema.decodeUnknownSync(OAuthAuthorizationAttemptRecord)(
      withCanonicalRecordKeys({
        itemType: "oauth-authorization-attempt" as const,
        data: Object.fromEntries(
          Object.entries({
            ...SCOPE,
            createdAt: NOW.toISOString(),
            expiresAt,
            id: ATTEMPT_ID,
            oauthClientId: CIMD_CLIENT_ID,
            oauthClientRegistration: "client_id_metadata_document",
            oauthIssParameterSupported: true,
            oauthIssuer: "https://mcp.notion.example",
            pkceSecretRef: {
              credentialId: PKCE_CREDENTIAL_ID,
              generation: 0,
              store: "dynamodb-kms",
            },
            principalId: ulid(12),
            providerKey: "notion",
            requestedResource: NOTION_ENDPOINT,
            requestedScopes: [],
            returnTo: RETURN_TO,
            stateHash: platformOAuthStateHash(STATE),
            status: "pending",
            version: 0,
            ...data,
          }).filter(([, value]) => value !== undefined),
        ),
        ttl: Math.floor(Date.parse(expiresAt) / 1_000),
      }),
    ),
  );
}

export const CONNECTION_ID = ulid(20);
export const CONNECTION_CREDENTIAL_ID = ulid(21);

const VENDOR_CONNECTION_OAUTH_FIELDS = {
  oauthClientId: CIMD_CLIENT_ID,
  oauthClientRegistration: "client_id_metadata_document",
  oauthIssuer: "https://mcp.notion.example",
  oauthResource: NOTION_ENDPOINT,
} as const;

/** Seeds an active OAuth connection (a CIMD Notion connection by default) at `generation`. */
export function seedVendorConnection(
  harness: OAuthHarness,
  input: {
    readonly data?: Readonly<Record<string, unknown>>;
    readonly generation: number;
    /** Replaces the vendor OAuth client/resource fields (empty for platform_oauth). */
    readonly oauthFields?: Readonly<Record<string, unknown>>;
    readonly refreshToken?: string;
  },
) {
  harness.vaultEntries.set(CONNECTION_CREDENTIAL_ID, {
    document: {
      createdAt: NOW.toISOString(),
      generation: input.generation,
      schemaVersion: 1,
      scopes: [],
      updatedAt: NOW.toISOString(),
      values: credentialValuesWithProviderOAuthMaterial(
        {
          accessToken: "old-access-token",
          ...(input.refreshToken === undefined ? {} : { refreshToken: input.refreshToken }),
        },
        { requestHeaders: {} },
      ),
    },
    ownerId: CONNECTION_ID,
    purpose: "provider-oauth-token",
  });
  const reference: CredentialVaultReference = {
    credentialId: CONNECTION_CREDENTIAL_ID,
    generation: input.generation,
    store: "dynamodb-kms",
  };
  putRecord(
    harness,
    Schema.decodeUnknownSync(ProviderConnectionRecord)(
      withCanonicalRecordKeys({
        itemType: "provider-connection" as const,
        data: {
          ...SCOPE,
          authMethod: "oauth",
          authorizationScopes: [],
          createdAt: NOW.toISOString(),
          credentialRef: reference,
          externalAccountId: `mcp:${ATTEMPT_ID}`,
          externalAccountName: "Notion",
          id: CONNECTION_ID,
          lastVerifiedAt: NOW.toISOString(),
          ...(input.oauthFields ?? VENDOR_CONNECTION_OAUTH_FIELDS),
          providerKey: "notion",
          refreshAfter: NOW.toISOString(),
          scopes: ["tools:read", "tools:write"],
          status: "active",
          updatedAt: NOW.toISOString(),
          version: input.generation,
          ...input.data,
        },
      }),
    ),
  );
  return reference;
}

export function storedConnection(harness: OAuthHarness) {
  return Schema.decodeUnknownSync(ProviderConnectionRecord)(
    harness.records.get(recordKey("provider-connection", CONNECTION_ID)),
  );
}
