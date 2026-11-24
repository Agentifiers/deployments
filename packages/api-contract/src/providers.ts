import { Schema } from "effect";
import { Cursor, Metadata, PageLimit, PublicId, ResourceName, Timestamp } from "./primitives.ts";
import type { PublicApiRouteContract } from "./route-contract.ts";

const NonEmptyText = Schema.String.pipe(
  Schema.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(2_048)),
);
const OAuthScope = Schema.String.pipe(
  Schema.check(
    Schema.isTrimmed(),
    Schema.isMinLength(1),
    Schema.isMaxLength(2_048),
    Schema.isPattern(/^\S+$/u),
  ),
);
const OAuthScopeList = Schema.Array(OAuthScope).pipe(Schema.check(Schema.isUnique()));
export const ProviderKey = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u)),
);
const SecretDocument = Schema.Union([NonEmptyText, Schema.Record(Schema.String, Schema.String)]);
const Status = Schema.Literals(["active", "archived", "disabled", "error", "revoked"]);
const Version = Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)));
const ListQuery = Schema.Struct({
  cursor: Schema.optional(Cursor),
  limit: Schema.optional(PageLimit),
});

export const ProviderResponse = Schema.Struct({
  authMethods: Schema.Array(Schema.String),
  category: Schema.optional(Schema.String),
  displayName: ResourceName,
  key: ProviderKey,
  metadata: Schema.optional(Metadata),
  route: Schema.String,
  status: Schema.String,
  supportedScopes: Schema.Array(Schema.String),
  supportedTools: Schema.Array(Schema.String),
  verification: Schema.optional(Metadata),
});
export const ListProvidersResponse = Schema.Struct({
  items: Schema.Array(ProviderResponse),
  nextCursor: Schema.NullOr(Schema.String),
});

/** Pre-registered client for a vendor MCP provider; only valid for route `vendor_mcp`. */
export const ProviderApplicationRegistrationRequest = Schema.Struct({
  method: Schema.Literal("pre_registered"),
  tokenEndpointAuthMethod: Schema.optional(
    Schema.Literals(["none", "client_secret_basic", "client_secret_post"]),
  ),
});
export const CreateProviderApplicationRequest = Schema.Struct({
  clientId: NonEmptyText,
  /** Required unless the vendor MCP registration uses token endpoint auth `none`. */
  clientSecret: Schema.optional(NonEmptyText),
  credential: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  displayName: ResourceName,
  metadata: Schema.optional(Metadata),
  providerKey: ProviderKey,
  redirectUris: Schema.Array(Schema.String),
  registration: Schema.optional(ProviderApplicationRegistrationRequest),
  requestedScopes: OAuthScopeList,
});
export const RotateProviderApplicationSecretRequest = Schema.Struct({
  clientSecret: NonEmptyText,
  credential: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  expectedVersion: Version,
});
export const ProviderApplicationResponse = Schema.Struct({
  clientId: NonEmptyText,
  createdAt: Timestamp,
  displayName: ResourceName,
  hasClientSecret: Schema.Boolean,
  id: PublicId,
  metadata: Schema.optional(Metadata),
  providerKey: ProviderKey,
  redirectUris: Schema.Array(Schema.String),
  requestedScopes: Schema.Array(Schema.String),
  status: Status,
  updatedAt: Timestamp,
  version: Version,
});
export const ListProviderApplicationsResponse = Schema.Struct({
  items: Schema.Array(ProviderApplicationResponse),
  nextCursor: Schema.NullOr(Schema.String),
});

export const CreateProviderCredentialRequest = Schema.Struct({
  credential: Schema.optional(SecretDocument),
  displayName: ResourceName,
  metadata: Schema.optional(Metadata),
  providerKey: ProviderKey,
  /** Vendor MCP only: tenant endpoint matching the definition's templated server URL. */
  requestedResource: Schema.optional(NonEmptyText),
});
export const RotateProviderCredentialRequest = Schema.Struct({
  credential: SecretDocument,
  expectedVersion: Version,
});
export const ProviderConnectionResponse = Schema.Struct({
  authMethod: Schema.String,
  createdAt: Timestamp,
  displayName: ResourceName,
  externalAccountId: Schema.optional(Schema.String),
  externalAccountName: Schema.optional(Schema.String),
  hasCredential: Schema.Boolean,
  id: PublicId,
  lastVerifiedAt: Schema.optional(Timestamp),
  providerApplicationId: Schema.optional(PublicId),
  providerKey: ProviderKey,
  refreshAfter: Schema.optional(Timestamp),
  scopes: Schema.Array(Schema.String),
  status: Schema.String,
  updatedAt: Timestamp,
  version: Version,
});
export const ListProviderConnectionsResponse = Schema.Struct({
  items: Schema.Array(ProviderConnectionResponse),
  nextCursor: Schema.NullOr(Schema.String),
});
export const BeginProviderAuthorizationRequest = Schema.Struct({
  providerApplicationId: Schema.optional(PublicId),
  providerKey: ProviderKey,
  requestedResource: Schema.optional(NonEmptyText),
  requestedScopes: Schema.optional(OAuthScopeList),
  returnTo: Schema.optional(
    Schema.String.annotate({
      description:
        "Absolute https URL the OAuth callback sends the browser to. Its origin must exactly match an entry of the deployment's PLATFORM_OAUTH_RETURN_ORIGINS allowlist, without userinfo or a fragment; otherwise the request fails with 422 invalid_return_to. The callback answers 303 to this URL with connection_id and provider query parameters on success, or error=access_denied (the user declined) or error=authorization_failed on failure; existing query parameters are kept. Omit it to have the callback render a static result page instead.",
    }),
  ),
});
export const BeginProviderAuthorizationResponse = Schema.Struct({
  authorizationUrl: Schema.String,
  expiresAt: Timestamp,
});
export const RequestConnectionVerificationRequest = Schema.Struct({
  idempotencyKey: Schema.optional(Schema.String),
});
export const ConnectionVerificationResponse = Schema.Struct({
  completedAt: Schema.optional(Timestamp),
  connectionId: PublicId,
  createdAt: Timestamp,
  error: Schema.optional(Metadata),
  id: PublicId,
  providerKey: ProviderKey,
  result: Schema.optional(Metadata),
  status: Schema.String,
  updatedAt: Timestamp,
  version: Version,
});
export const ConnectionCapabilityResponse = Schema.Struct({
  connectionId: PublicId,
  id: PublicId,
  metadata: Schema.optional(Metadata),
  providerKey: ProviderKey,
  scopes: Schema.Array(Schema.String),
  status: Schema.String,
  verificationVersion: Version,
});
export const ListConnectionCapabilitiesResponse = Schema.Struct({
  items: Schema.Array(ConnectionCapabilityResponse),
  nextCursor: Schema.NullOr(Schema.String),
});

export const CreateConnectionGrantRequest = Schema.Struct({
  connectionId: PublicId,
  externalResourceConstraints: Schema.optional(Metadata),
  purpose: NonEmptyText,
  scopes: OAuthScopeList,
  workspaceId: Schema.NullOr(PublicId).annotate({
    description:
      "Workspace whose runs may use the connection. null grants every workspace in the environment and is accepted only for a connection that uses no credential; any other connection fails with 422 environment_grant_requires_credentialless_connection.",
  }),
});
export const ConnectionGrantResponse = Schema.Struct({
  authorizationVersion: Version,
  connectionId: PublicId,
  createdAt: Timestamp,
  externalAccountId: Schema.String,
  externalResourceConstraints: Metadata,
  id: PublicId,
  providerKey: ProviderKey,
  purpose: Schema.String,
  scopes: Schema.Array(Schema.String),
  status: Schema.Literals(["active", "revoked"]),
  updatedAt: Timestamp,
  version: Version,
  workspaceId: Schema.NullOr(PublicId).annotate({
    description:
      "Granted workspace, or null when the grant covers every workspace in the environment.",
  }),
});
export const ListConnectionGrantsResponse = Schema.Struct({
  items: Schema.Array(ConnectionGrantResponse),
  nextCursor: Schema.NullOr(Schema.String),
});
export const RevokeAdministrationResourceRequest = Schema.Struct({
  expectedVersion: Schema.optional(Version),
  reason: Schema.optional(Schema.String),
});
export const VendorMcpToolSyncChange = Schema.Struct({
  change: Schema.Literals(["archived", "created", "rejected", "unchanged", "updated"]),
  classified: Schema.Boolean,
  destructive: Schema.Boolean,
  effect: Schema.Literals(["read", "write"]),
  reason: Schema.optional(Schema.String),
  remoteName: Schema.String,
  /** Absent only for tools rejected because their name cannot be normalized. */
  toolName: Schema.optional(Schema.String),
});
export const SyncConnectionToolsResponse = Schema.Struct({
  connectionId: PublicId,
  providerKey: ProviderKey,
  syncedAt: Timestamp,
  tools: Schema.Array(VendorMcpToolSyncChange),
});

export const PROVIDER_API_SCHEMAS = {
  BeginProviderAuthorizationRequest,
  BeginProviderAuthorizationResponse,
  ConnectionCapabilityResponse,
  ConnectionGrantResponse,
  ConnectionVerificationResponse,
  CreateConnectionGrantRequest,
  CreateProviderApplicationRequest,
  CreateProviderCredentialRequest,
  ListConnectionCapabilitiesResponse,
  ListConnectionGrantsResponse,
  ListProviderApplicationsResponse,
  ListProviderConnectionsResponse,
  ListProvidersResponse,
  ListQuery,
  ProviderApplicationRegistrationRequest,
  ProviderApplicationResponse,
  ProviderConnectionResponse,
  ProviderResponse,
  RequestConnectionVerificationRequest,
  RevokeAdministrationResourceRequest,
  RotateProviderApplicationSecretRequest,
  RotateProviderCredentialRequest,
  SyncConnectionToolsResponse,
  VendorMcpToolSyncChange,
} as const;

type Input = Omit<
  PublicApiRouteContract,
  "authentication" | "errors" | "idempotency" | "scopeHeaders" | "tag"
> & { readonly public?: boolean };
const readErrors = [400, 401, 403, 404, 422] as const;
const mutationErrors = [400, 401, 403, 404, 409, 422, 429] as const;
const listQueryParameters = [
  { name: "cursor", schema: { maxLength: 4_096, minLength: 1, type: "string" } },
  { name: "limit", schema: { maximum: 100, minimum: 1, type: "integer" } },
] as const;
function providerRoute<const Route extends Input>(route: Route) {
  const mutation = route.method !== "GET";
  return {
    authentication: route.public ? ("none" as const) : ("platform-bearer" as const),
    errors: mutation ? mutationErrors : readErrors,
    idempotency: mutation ? ("required" as const) : ("none" as const),
    scopeHeaders: route.public ? ("none" as const) : ("environment" as const),
    tag: "Providers" as const,
    ...route,
    ...(route.name.startsWith("list") ? { queryParameters: listQueryParameters } : {}),
  };
}

export const PROVIDER_API_ROUTES = [
  providerRoute({
    method: "GET",
    name: "listProviders",
    path: "/v1/providers",
    public: true,
    responseBody: "ListProvidersResponse",
    successStatus: 200,
  }),
  providerRoute({
    method: "GET",
    name: "getProvider",
    path: "/v1/providers/:providerKey",
    pathParameters: [
      {
        name: "providerKey",
        schema: {
          pattern: "^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$",
          type: "string",
        },
      },
    ],
    public: true,
    responseBody: "ProviderResponse",
    successStatus: 200,
  }),
  providerRoute({
    method: "GET",
    name: "listProviderApplications",
    path: "/v1/oauth-apps",
    responseBody: "ListProviderApplicationsResponse",
    successStatus: 200,
  }),
  providerRoute({
    method: "POST",
    name: "createProviderApplication",
    path: "/v1/oauth-apps",
    requestBody: "CreateProviderApplicationRequest",
    responseBody: "ProviderApplicationResponse",
    successStatus: 201,
  }),
  providerRoute({
    method: "GET",
    name: "getProviderApplication",
    path: "/v1/oauth-apps/:id",
    responseBody: "ProviderApplicationResponse",
    successStatus: 200,
  }),
  providerRoute({
    method: "POST",
    name: "rotateProviderApplicationSecret",
    path: "/v1/oauth-apps/:id/rotate",
    requestBody: "RotateProviderApplicationSecretRequest",
    responseBody: "ProviderApplicationResponse",
    successStatus: 200,
  }),
  providerRoute({
    method: "DELETE",
    name: "archiveProviderApplication",
    path: "/v1/oauth-apps/:id",
    requestBody: "RevokeAdministrationResourceRequest",
    requestBodyRequired: false,
    responseBody: "ProviderApplicationResponse",
    successStatus: 200,
  }),
  providerRoute({
    method: "GET",
    name: "listProviderCredentials",
    path: "/v1/credentials",
    responseBody: "ListProviderConnectionsResponse",
    successStatus: 200,
  }),
  providerRoute({
    method: "POST",
    name: "createProviderCredential",
    path: "/v1/credentials",
    requestBody: "CreateProviderCredentialRequest",
    responseBody: "ProviderConnectionResponse",
    successStatus: 201,
  }),
  providerRoute({
    method: "POST",
    name: "rotateProviderCredential",
    path: "/v1/credentials/:id/rotate",
    requestBody: "RotateProviderCredentialRequest",
    responseBody: "ProviderConnectionResponse",
    successStatus: 200,
  }),
  providerRoute({
    method: "DELETE",
    name: "revokeProviderCredential",
    path: "/v1/credentials/:id",
    requestBody: "RevokeAdministrationResourceRequest",
    requestBodyRequired: false,
    responseBody: "ProviderConnectionResponse",
    standing: "remediation",
    successStatus: 200,
  }),
  providerRoute({
    method: "GET",
    name: "listProviderConnections",
    path: "/v1/connections",
    responseBody: "ListProviderConnectionsResponse",
    successStatus: 200,
  }),
  providerRoute({
    method: "POST",
    name: "beginProviderAuthorization",
    path: "/v1/connections",
    requestBody: "BeginProviderAuthorizationRequest",
    responseBody: "BeginProviderAuthorizationResponse",
    successStatus: 201,
  }),
  providerRoute({
    method: "GET",
    name: "getProviderConnection",
    path: "/v1/connections/:id",
    responseBody: "ProviderConnectionResponse",
    successStatus: 200,
  }),
  providerRoute({
    method: "POST",
    name: "requestConnectionVerification",
    path: "/v1/connections/:id/verify",
    requestBody: "RequestConnectionVerificationRequest",
    requestBodyRequired: false,
    responseBody: "ConnectionVerificationResponse",
    successStatus: 202,
  }),
  providerRoute({
    method: "DELETE",
    name: "revokeProviderConnection",
    path: "/v1/connections/:id",
    requestBody: "RevokeAdministrationResourceRequest",
    requestBodyRequired: false,
    responseBody: "ProviderConnectionResponse",
    standing: "remediation",
    successStatus: 200,
  }),
  providerRoute({
    method: "GET",
    name: "listConnectionCapabilities",
    path: "/v1/connections/:id/capabilities",
    responseBody: "ListConnectionCapabilitiesResponse",
    successStatus: 200,
  }),
  providerRoute({
    method: "GET",
    name: "getConnectionVerification",
    path: "/v1/connection-verifications/:id",
    responseBody: "ConnectionVerificationResponse",
    successStatus: 200,
  }),
  providerRoute({
    method: "POST",
    name: "syncConnectionTools",
    path: "/v1/connections/:connectionId/tools/sync",
    responseBody: "SyncConnectionToolsResponse",
    successStatus: 200,
  }),
  providerRoute({
    method: "GET",
    name: "listConnectionGrants",
    path: "/v1/connection-grants",
    responseBody: "ListConnectionGrantsResponse",
    successStatus: 200,
  }),
  providerRoute({
    method: "POST",
    name: "createConnectionGrant",
    path: "/v1/connection-grants",
    requestBody: "CreateConnectionGrantRequest",
    responseBody: "ConnectionGrantResponse",
    successStatus: 201,
  }),
  providerRoute({
    method: "GET",
    name: "getConnectionGrant",
    path: "/v1/connection-grants/:id",
    responseBody: "ConnectionGrantResponse",
    successStatus: 200,
  }),
  providerRoute({
    method: "DELETE",
    name: "revokeConnectionGrant",
    path: "/v1/connection-grants/:id",
    requestBody: "RevokeAdministrationResourceRequest",
    requestBodyRequired: false,
    responseBody: "ConnectionGrantResponse",
    standing: "remediation",
    successStatus: 200,
  }),
] as const satisfies readonly PublicApiRouteContract[];

export type ProviderApiRouteName = (typeof PROVIDER_API_ROUTES)[number]["name"];
