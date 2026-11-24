import { credentialValuesWithProviderOAuthMaterial } from "@deployments-ai/credential-vault";
import type { Ulid } from "@deployments-ai/db";
import {
  platformOAuthIssValidation,
  VENDOR_MCP_CAPABILITY_SCOPES,
  type ProviderDefinition,
} from "@deployments-ai/providers";

import {
  attemptPkceVerifier,
  persistAuthorizedConnection,
  type OAuthAuthorizationAttempt,
} from "./oauth-authorization-commit.ts";
import type { OAuthCallbackOutcome } from "./oauth-callback-response.ts";
import { resolveOAuthAppConfig } from "./oauth-config.ts";
import { VENDOR_MCP_SYNTHETIC_ACCOUNT_PREFIX } from "./oauth-connection-lifecycle.ts";
import type { OAuthRuntimeDependencies, OAuthScope } from "./oauth-runtime-dependencies.ts";
import { oauthRefreshResource } from "./oauth-token-response.ts";
import { exchange, type OAuthEvent } from "./oauth-validation.ts";
import { required } from "./required-value.ts";

function normalizedScopes(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].toSorted();
}

/**
 * Completes a vendor MCP authorization. RFC 9207 `iss` validation runs before the code or
 * any provider error is read; only an `iss`-validated `access_denied` is reported as such.
 */
export async function vendorMcpCallback(
  dependencies: OAuthRuntimeDependencies,
  input: {
    readonly attempt: OAuthAuthorizationAttempt;
    readonly definition: ProviderDefinition;
    readonly event: OAuthEvent;
    readonly scope: OAuthScope;
    readonly state: string;
  },
): Promise<OAuthCallbackOutcome> {
  const { attempt, definition, scope } = input;
  const query = input.event.queryStringParameters ?? {};
  const expectedIssuer = attempt.data.oauthIssuer;
  const issParameterSupported = attempt.data.oauthIssParameterSupported;
  if (
    !expectedIssuer ||
    issParameterSupported === undefined ||
    platformOAuthIssValidation({
      expectedIssuer,
      issParameterSupported,
      receivedIss: query.iss,
    }) === "reject"
  ) {
    console.warn("Vendor MCP authorization response issuer was rejected.", {
      providerKey: definition.key,
    });
    return { error: "authorization_failed", kind: "failed" };
  }
  if (query.error !== undefined) {
    return {
      error: query.error === "access_denied" ? "access_denied" : "authorization_failed",
      kind: "failed",
    };
  }
  const resolved = await resolveOAuthAppConfig(dependencies, scope, {
    providerKey: attempt.data.providerKey,
    ...(attempt.data.oauthClientId ? { oauthClientId: attempt.data.oauthClientId } : {}),
    ...(attempt.data.oauthClientRegistration
      ? { oauthClientRegistration: attempt.data.oauthClientRegistration }
      : {}),
    ...(attempt.data.requestedResource ? { oauthResource: attempt.data.requestedResource } : {}),
    ...(attempt.data.providerApplicationId
      ? { providerApplicationId: attempt.data.providerApplicationId }
      : {}),
  });
  if (resolved.route !== "vendor_mcp") {
    throw new Error("OAuth provider does not use a vendor MCP server.");
  }
  const code = required(query[resolved.config.callbackCodeParameterName], "OAuth code");
  const vault = await dependencies.vault(scope);
  const codeVerifier = await attemptPkceVerifier(vault, scope, attempt, input.state, false);
  const token = await exchange(
    resolved.config,
    { [resolved.config.tokenAuthorizationCodeParameterName]: code, code_verifier: codeVerifier },
    resolved.resource,
    false,
    dependencies.fetch,
  );
  oauthRefreshResource(resolved.resource, token.resource);
  const connectionId = await dependencies.id();
  const authorizationScopes = normalizedScopes(
    token.scopes.length > 0 ? token.scopes : attempt.data.requestedScopes,
  );
  const credential = await vault.prepareWrite({
    identity: {
      credentialId: await dependencies.id(),
      environmentId: scope.environmentId as Ulid,
      organizationId: scope.organizationId as Ulid,
      ownerId: connectionId,
      ownerType: "provider-connection",
      projectId: scope.projectId as Ulid,
      purpose: "provider-oauth-token",
    },
    secret: {
      ...(token.expiresAt ? { expiresAt: new Date(token.expiresAt).toISOString() } : {}),
      scopes: authorizationScopes,
      values: credentialValuesWithProviderOAuthMaterial(
        {
          accessToken: token.accessToken,
          ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
          ...(token.tokenType ? { tokenType: token.tokenType } : {}),
        },
        // Provider OAuth material only carries origins; the canonical endpoint binding lives
        // on `connection.oauthResource`.
        { requestHeaders: {} },
      ),
    },
  });
  const now = dependencies.now().toISOString();
  await persistAuthorizedConnection(dependencies, {
    attempt,
    connection: {
      authMethod: "oauth",
      authorizationScopes,
      externalAccountId:
        token.providerIdentityId ?? `${VENDOR_MCP_SYNTHETIC_ACCOUNT_PREFIX}${attempt.data.id}`,
      externalAccountName: token.providerIdentityDisplayName ?? definition.displayName,
      id: connectionId,
      lastVerifiedAt: now,
      oauthClientId: resolved.config.clientId,
      ...(attempt.data.oauthClientRegistration
        ? { oauthClientRegistration: attempt.data.oauthClientRegistration }
        : {}),
      oauthIssuer: expectedIssuer,
      oauthResource: resolved.canonicalUrl,
      ...(resolved.application ? { providerApplicationId: resolved.application.data.id } : {}),
      providerKey: definition.key,
      ...(token.expiresAt ? { refreshAfter: new Date(token.expiresAt).toISOString() } : {}),
      scopes: [...VENDOR_MCP_CAPABILITY_SCOPES],
      status: "active",
    },
    credential,
    now,
    scope,
    vault,
  });
  return { connectionId, kind: "connected" };
}
