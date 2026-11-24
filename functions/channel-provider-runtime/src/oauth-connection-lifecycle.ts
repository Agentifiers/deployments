import {
  CredentialVaultError,
  credentialValuesWithProviderOAuthMaterial,
  providerOAuthMaterialFromCredentialValues,
  type CredentialVaultReference,
  type CredentialVaultSecretDocument,
  type CredentialVaultService,
} from "@deployments-ai/credential-vault";
import type { OrganizationAuditActor, Ulid } from "@deployments-ai/db";
import {
  VENDOR_MCP_CAPABILITY_SCOPES,
  type PlatformOAuthAppConfig,
  type PlatformOAuthTokenBundle,
} from "@deployments-ai/providers";

import type { ProviderConnection } from "./oauth-authorization-commit.ts";
import {
  resolveOAuthAppConfig,
  type OAuthConfigSubject,
  type ResolvedOAuthAppConfig,
} from "./oauth-config.ts";
import {
  assertOAuthRefreshIdentity,
  oauthRefreshScopes,
  resolveOAuthRefreshIdentity,
  validatedOAuthResource,
} from "./oauth-identity.ts";
import { revokeOAuthToken } from "./oauth-revocation.ts";
import type { OAuthRuntimeDependencies, OAuthScope } from "./oauth-runtime-dependencies.ts";
import {
  assertRotatedRefreshToken,
  OAuthTokenEndpointError,
  oauthRefreshResource,
} from "./oauth-token-response.ts";
import { exchange, platformCapabilityScopes } from "./oauth-validation.ts";
import { vaultReference } from "./runtime.ts";

/** Synthetic external account for vendor MCP connections whose token carries no `sub`. */
export const VENDOR_MCP_SYNTHETIC_ACCOUNT_PREFIX = "mcp:";

export type OAuthRefreshFailureStatus =
  | "not_refreshable"
  | "reauthorization_required"
  | "retryable";

/** Classified refresh failure surfaced by the internal `oauth-refresh` Lambda. */
export class OAuthRefreshFailure extends Error {
  constructor(
    readonly status: OAuthRefreshFailureStatus,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OAuthRefreshFailure";
  }
}

export interface OAuthConnectionRefreshResult {
  readonly reference: CredentialVaultReference;
  readonly refreshAfter?: string;
}

function oauthConnectionSubject(connection: ProviderConnection): OAuthConfigSubject {
  const data = connection.data;
  return {
    providerKey: data.providerKey,
    ...(data.oauthClientId ? { oauthClientId: data.oauthClientId } : {}),
    ...(data.oauthClientRegistration
      ? { oauthClientRegistration: data.oauthClientRegistration }
      : {}),
    ...(data.oauthResource ? { oauthResource: data.oauthResource } : {}),
    ...(data.providerApplicationId ? { providerApplicationId: data.providerApplicationId } : {}),
  };
}

interface RefreshContext {
  readonly connection: ProviderConnection;
  readonly current: CredentialVaultSecretDocument;
  readonly dependencies: OAuthRuntimeDependencies;
  readonly reference: CredentialVaultReference;
  readonly refreshToken: string;
  readonly scope: OAuthScope;
  readonly vault: CredentialVaultService;
}

function prepareRotation(
  context: RefreshContext,
  input: {
    readonly expectedGeneration: number;
    readonly providerRequestHeaders: Readonly<Record<string, string>>;
    readonly resource: string | undefined;
    readonly scopes: readonly string[];
    readonly token: PlatformOAuthTokenBundle;
  },
) {
  const { token } = input;
  return context.vault.prepareWrite({
    expectedGeneration: input.expectedGeneration,
    identity: {
      credentialId: context.reference.credentialId,
      environmentId: context.scope.environmentId as Ulid,
      organizationId: context.scope.organizationId as Ulid,
      ownerId: context.connection.data.id,
      ownerType: "provider-connection",
      projectId: context.scope.projectId as Ulid,
      purpose: "provider-oauth-token",
    },
    secret: {
      ...(token.expiresAt ? { expiresAt: new Date(token.expiresAt).toISOString() } : {}),
      scopes: [...input.scopes],
      values: credentialValuesWithProviderOAuthMaterial(
        {
          accessToken: token.accessToken,
          refreshToken: token.refreshToken ?? context.refreshToken,
          ...(token.tokenType ? { tokenType: token.tokenType } : {}),
        },
        {
          requestHeaders: input.providerRequestHeaders,
          ...(input.resource ? { resource: input.resource } : {}),
        },
      ),
    },
  });
}

/** Existing two-phase platform_oauth rotation with identity re-resolution. */
async function refreshPlatformConnection(
  context: RefreshContext,
  config: PlatformOAuthAppConfig,
): Promise<OAuthConnectionRefreshResult> {
  const { connection, current, dependencies, reference, refreshToken, scope } = context;
  const currentMaterial = providerOAuthMaterialFromCredentialValues(current.values);
  if (connection.data.oauthResource && currentMaterial.resource !== connection.data.oauthResource) {
    throw new Error("OAuth credential resource does not match the connection projection.");
  }
  const currentResource = connection.data.oauthResource ?? currentMaterial.resource;
  const refreshResource = currentResource
    ? validatedOAuthResource(currentResource, config)
    : undefined;
  const token = await exchange(
    config,
    { grant_type: "refresh_token", refresh_token: refreshToken, ...config.refreshParams },
    refreshResource,
    false,
    dependencies.fetch,
  );
  const resource = oauthRefreshResource(refreshResource, token.resource);
  const providerRequestHeaders = config.providerRequestHeaders[connection.data.providerKey] ?? {};
  const provisionalAuthorizationScopes = oauthRefreshScopes(
    token.scopes,
    current.scopes,
    connection.data.authorizationScopes ?? connection.data.scopes,
  );
  const staged = await prepareRotation(context, {
    expectedGeneration: reference.generation,
    providerRequestHeaders,
    resource,
    scopes: provisionalAuthorizationScopes,
    token,
  });
  await dependencies.commitOwnership({
    action: "rotated",
    ownerId: connection.data.id,
    ownerType: "provider-connection",
    prepared: staged,
    providerConnectionUpdate: {
      ...(connection.data.externalAccountId
        ? { externalAccountId: connection.data.externalAccountId }
        : {}),
      ...(connection.data.externalAccountName
        ? { externalAccountName: connection.data.externalAccountName }
        : {}),
      ...(connection.data.lastVerifiedAt ? { lastVerifiedAt: connection.data.lastVerifiedAt } : {}),
      ...(resource ? { oauthResource: resource } : {}),
      ...(token.expiresAt ? { refreshAfter: new Date(token.expiresAt).toISOString() } : {}),
      authorizationScopes: provisionalAuthorizationScopes,
      scopes: connection.data.scopes,
      status: "reauthorization-required",
    },
    scope,
  });
  assertRotatedRefreshToken(config, refreshToken, token.refreshToken);
  const refreshedIdentity = await resolveOAuthRefreshIdentity({
    config,
    ...(connection.data.externalAccountId
      ? { externalAccountId: connection.data.externalAccountId }
      : {}),
    fallbackId: connection.data.id,
    fallbackName: connection.data.externalAccountName ?? connection.data.providerKey,
    token,
  });
  const authorizationScopes = oauthRefreshScopes(
    refreshedIdentity?.scopes ?? token.scopes,
    current.scopes,
    connection.data.authorizationScopes ?? connection.data.scopes,
  );
  const prepared = await prepareRotation(context, {
    expectedGeneration: staged.reference.generation,
    providerRequestHeaders,
    resource,
    scopes: authorizationScopes,
    token,
  });
  const refreshAfter = token.expiresAt
    ? new Date(token.expiresAt).toISOString()
    : connection.data.refreshAfter;
  await dependencies.commitOwnership({
    action: "rotated",
    ownerId: connection.data.id,
    ownerType: "provider-connection",
    prepared,
    providerConnectionUpdate: {
      ...(refreshedIdentity
        ? {
            externalAccountId: refreshedIdentity.externalAccountId,
            externalAccountName: refreshedIdentity.displayName,
          }
        : {}),
      lastVerifiedAt: dependencies.now().toISOString(),
      ...(resource ? { oauthResource: resource } : {}),
      ...(refreshAfter ? { refreshAfter } : {}),
      authorizationScopes,
      scopes: platformCapabilityScopes(
        connection.data.providerKey,
        authorizationScopes,
        dependencies.definitions(),
      ),
      status: "active",
    },
    scope,
  });
  return {
    reference: prepared.reference,
    ...(refreshAfter ? { refreshAfter } : {}),
  };
}

/**
 * Vendor MCP rotation: one vault rotation straight to `active` (no identity phase). The
 * connection's `oauthResource` holds the canonical endpoint (the credential material holds no
 * resource: provider OAuth material only carries origins) and the pinned RFC 8707 resource is
 * sent on the wire.
 */
async function refreshVendorMcpConnection(
  context: RefreshContext,
  resolved: Extract<ResolvedOAuthAppConfig, { readonly route: "vendor_mcp" }>,
): Promise<OAuthConnectionRefreshResult> {
  const { connection, current, dependencies, reference, refreshToken, scope } = context;
  const token = await exchange(
    resolved.config,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    resolved.resource,
    false,
    dependencies.fetch,
  );
  oauthRefreshResource(resolved.resource, token.resource);
  const externalAccountId = connection.data.externalAccountId;
  if (externalAccountId && !externalAccountId.startsWith(VENDOR_MCP_SYNTHETIC_ACCOUNT_PREFIX)) {
    assertOAuthRefreshIdentity(token, externalAccountId);
  }
  const authorizationScopes = oauthRefreshScopes(
    token.scopes,
    current.scopes,
    connection.data.authorizationScopes ?? connection.data.scopes,
  );
  const prepared = await prepareRotation(context, {
    expectedGeneration: reference.generation,
    providerRequestHeaders: {},
    resource: undefined,
    scopes: authorizationScopes,
    token,
  });
  const refreshAfter = token.expiresAt
    ? new Date(token.expiresAt).toISOString()
    : connection.data.refreshAfter;
  await dependencies.commitOwnership({
    action: "rotated",
    ownerId: connection.data.id,
    ownerType: "provider-connection",
    prepared,
    providerConnectionUpdate: {
      authorizationScopes,
      oauthResource: resolved.canonicalUrl,
      ...(refreshAfter ? { refreshAfter } : {}),
      scopes: [...VENDOR_MCP_CAPABILITY_SCOPES],
      status: "active",
    },
    scope,
  });
  return {
    reference: prepared.reference,
    ...(refreshAfter ? { refreshAfter } : {}),
  };
}

async function readConnectionCredential(
  dependencies: OAuthRuntimeDependencies,
  scope: OAuthScope,
  connection: ProviderConnection,
) {
  if (!connection.data.credentialRef) {
    throw new OAuthRefreshFailure(
      "not_refreshable",
      "oauth_connection_incomplete",
      "OAuth connection has no credential.",
    );
  }
  const reference = vaultReference(connection.data.credentialRef);
  const vault = await dependencies.vault(scope);
  const current = await vault.read({
    environmentId: scope.environmentId as Ulid,
    expectedIdentity: {
      ownerId: connection.data.id,
      ownerType: "provider-connection",
      projectId: scope.projectId as Ulid,
      purpose: "provider-oauth-token",
    },
    organizationId: scope.organizationId as Ulid,
    reference,
  });
  return { current, reference, vault };
}

/**
 * Refreshes one OAuth provider connection (platform_oauth or vendor_mcp) from its pinned
 * credential generation. Shared by the JWT refresh route and the internal refresh Lambda.
 */
export async function refreshProviderConnection(
  dependencies: OAuthRuntimeDependencies,
  scope: OAuthScope,
  connection: ProviderConnection,
): Promise<OAuthConnectionRefreshResult> {
  const { current, reference, vault } = await readConnectionCredential(
    dependencies,
    scope,
    connection,
  );
  const refreshToken = current.values.refreshToken?.trim();
  if (!refreshToken) {
    throw new OAuthRefreshFailure(
      "not_refreshable",
      "oauth_refresh_token_missing",
      "OAuth connection has no refresh token.",
    );
  }
  const resolved = await resolveOAuthAppConfig(
    dependencies,
    scope,
    oauthConnectionSubject(connection),
  );
  const context = { connection, current, dependencies, reference, refreshToken, scope, vault };
  return resolved.route === "vendor_mcp"
    ? refreshVendorMcpConnection(context, resolved)
    : refreshPlatformConnection(context, resolved.config);
}

/**
 * Maps a refresh failure to the internal refresh contract: a token endpoint rejection
 * (`invalid_grant`, HTTP 400/401) requires reauthorization; network, 5xx, vault conflicts,
 * and anything unexpected are retryable.
 */
export function classifyOAuthRefreshFailure(cause: unknown): OAuthRefreshFailure {
  if (cause instanceof OAuthRefreshFailure) return cause;
  if (cause instanceof OAuthTokenEndpointError) {
    return cause.status === 400 || cause.status === 401
      ? new OAuthRefreshFailure(
          "reauthorization_required",
          "oauth_refresh_rejected",
          "The provider rejected the refresh grant; the connection must be re-authorized.",
          { cause },
        )
      : new OAuthRefreshFailure(
          "retryable",
          "oauth_token_endpoint_unavailable",
          `The provider token endpoint returned HTTP ${cause.status}.`,
          { cause },
        );
  }
  if (cause instanceof CredentialVaultError && cause.code === "conflict") {
    return new OAuthRefreshFailure(
      "retryable",
      "oauth_credential_conflict",
      "The OAuth credential changed during refresh.",
      { cause },
    );
  }
  return new OAuthRefreshFailure(
    "retryable",
    "oauth_refresh_failed",
    "OAuth refresh failed before completing.",
    { cause },
  );
}

/**
 * Disconnects an OAuth connection. Vendor MCP connections first revoke their token at the
 * pinned RFC 7009 endpoint (best-effort: failures are logged and the local disconnect
 * still happens); platform_oauth connections only disconnect locally.
 */
export async function revokeProviderConnection(
  dependencies: OAuthRuntimeDependencies,
  scope: OAuthScope,
  connection: ProviderConnection,
  actor?: OrganizationAuditActor,
) {
  if (!connection.data.credentialRef) throw new Error("OAuth connection is incomplete.");
  const definition = dependencies.definitions().resolve(connection.data.providerKey);
  if (definition?.route === "vendor_mcp") {
    try {
      const resolved = await resolveOAuthAppConfig(
        dependencies,
        scope,
        oauthConnectionSubject(connection),
      );
      const revocation = resolved.config.revocation;
      if (revocation?.mode === "request") {
        const { current } = await readConnectionCredential(dependencies, scope, connection);
        const refreshToken = current.values.refreshToken?.trim();
        const token = refreshToken || current.values.accessToken?.trim();
        if (token) {
          await revokeOAuthToken({
            config: resolved.config,
            endpoint: revocation.endpoint,
            fetch: dependencies.fetch,
            token,
            tokenTypeHint: refreshToken ? "refresh_token" : "access_token",
          });
        }
      }
    } catch (cause) {
      console.warn("Vendor MCP token revocation failed; disconnecting locally.", {
        errorType: cause instanceof Error ? cause.name : "UnknownError",
        providerKey: connection.data.providerKey,
      });
    }
  }
  const vault = await dependencies.vault(scope);
  await dependencies.commitOwnership({
    action: "revoked",
    ...(actor ? { actor } : {}),
    ownerId: connection.data.id,
    ownerType: "provider-connection",
    prepared: await vault.prepareRevoke({
      environmentId: scope.environmentId as Ulid,
      organizationId: scope.organizationId as Ulid,
      reference: vaultReference(connection.data.credentialRef),
    }),
    scope,
  });
}
