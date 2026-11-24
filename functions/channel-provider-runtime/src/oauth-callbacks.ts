import { credentialValuesWithProviderOAuthMaterial } from "@deployments-ai/credential-vault";
import {
  OAuthAuthorizationAttemptRecord,
  ProviderConnectionRecord,
  type Ulid,
} from "@deployments-ai/db";
import type { ApiActivity } from "@deployments-ai/organization-admission";
import {
  platformOAuthStateHash,
  PlatformOAuthReturnToError,
  VENDOR_MCP_CLIENT_METADATA_PATH,
  vendorMcpClientMetadataDocument,
} from "@deployments-ai/providers";
import { Schema } from "effect";
import { randomUUID } from "node:crypto";

import {
  attemptPkceVerifier,
  persistAuthorizedConnection,
  type OAuthAuthorizationAttempt,
} from "./oauth-authorization-commit.ts";
import {
  oauthCallbackConnected,
  oauthCallbackFailed,
  oauthCallbackRejected,
  type OAuthCallbackOutcome,
} from "./oauth-callback-response.ts";
import { resolveOAuthAppConfig } from "./oauth-config.ts";
import { revokeProviderConnection } from "./oauth-connection-lifecycle.ts";
import { resolveOAuthExternalIdentity } from "./oauth-identity.ts";
import {
  defaultRefreshDependencies,
  refreshOAuthConnectionRoute,
  type OAuthRefreshDependencies,
} from "./oauth-refresh.ts";
import {
  defaultOAuthRuntimeDependencies,
  type OAuthRuntimeDependencies,
  type OAuthScope,
} from "./oauth-runtime-dependencies.ts";
import {
  authorize,
  exchange,
  platformCapabilityScopes,
  response,
  scopeFromClaims,
  stateParts,
  type OAuthEvent,
  type OAuthHttpResponse,
} from "./oauth-validation.ts";
import { vendorMcpCallback } from "./oauth-vendor-callback.ts";
import { standingRefusal } from "./organization-standing.ts";
import {
  ChannelProviderIdentityError,
  operatorAccessAuditActor,
  type ChannelProviderScope,
} from "./platform-identity.ts";
import { required } from "./required-value.ts";

/** A pending, unexpired attempt whose state hash matched the callback `state`. */
interface TrustedOAuthAttempt {
  readonly attempt: OAuthAuthorizationAttempt;
  readonly scope: OAuthScope;
  readonly state: string;
}

/** Loads the attempt named by `state`; any failure means the callback is untrusted. */
async function trustedAttempt(
  event: OAuthEvent,
  dependencies: OAuthRuntimeDependencies,
): Promise<TrustedOAuthAttempt> {
  const state = required(event.queryStringParameters?.state, "state");
  const parsed = stateParts(state);
  const scope = {
    organizationId: parsed.organizationId,
    projectId: parsed.projectId,
    environmentId: parsed.environmentId,
  };
  const attempt = Schema.decodeUnknownSync(OAuthAuthorizationAttemptRecord)(
    await dependencies.loadControlRecord(scope, "oauth-authorization-attempt", parsed.attemptId),
  );
  if (
    attempt.data.status !== "pending" ||
    attempt.data.stateHash !== platformOAuthStateHash(state) ||
    Date.parse(attempt.data.expiresAt) <= dependencies.now().getTime()
  )
    throw new Error("OAuth state is invalid or expired.");
  return { attempt, scope, state };
}

function errorType(cause: unknown) {
  return cause instanceof Error ? cause.name : "UnknownError";
}

/**
 * Public browser endpoint. An untrusted state gets a static error page; a state-verified
 * attempt redirects to its allowlisted `returnTo` (or renders a page) with only
 * platform-chosen query parameters.
 */
async function callback(
  event: OAuthEvent,
  dependencies: OAuthRuntimeDependencies = defaultOAuthRuntimeDependencies(),
): Promise<OAuthHttpResponse> {
  let trusted: TrustedOAuthAttempt;
  try {
    trusted = await trustedAttempt(event, dependencies);
  } catch (cause) {
    console.warn("OAuth callback state was rejected.", { errorType: errorType(cause) });
    return oauthCallbackRejected();
  }
  const { attempt } = trusted;
  const definitions = dependencies.definitions();
  let outcome: OAuthCallbackOutcome;
  try {
    outcome = await completeAuthorization(event, dependencies, trusted);
  } catch (cause) {
    console.error("OAuth callback failed.", { errorType: errorType(cause) });
    outcome = { error: "authorization_failed", kind: "failed" };
  }
  return outcome.kind === "failed"
    ? oauthCallbackFailed(attempt.data.returnTo, outcome.error)
    : oauthCallbackConnected({
        connectionId: outcome.connectionId,
        providerDisplayName:
          definitions.resolve(attempt.data.providerKey)?.displayName ?? attempt.data.providerKey,
        providerKey: attempt.data.providerKey,
        returnTo: attempt.data.returnTo,
      });
}

async function completeAuthorization(
  event: OAuthEvent,
  dependencies: OAuthRuntimeDependencies,
  { attempt, scope, state }: TrustedOAuthAttempt,
): Promise<OAuthCallbackOutcome> {
  const provider = required(event.pathParameters?.provider, "provider");
  const definitions = dependencies.definitions();
  const vendorDefinition = definitions.resolve(attempt.data.providerKey);
  if (vendorDefinition?.route === "vendor_mcp") {
    if ((vendorDefinition.oauthProviderKey ?? vendorDefinition.key) !== provider)
      throw new Error("OAuth provider does not match the authorization attempt.");
    return vendorMcpCallback(dependencies, {
      attempt,
      definition: vendorDefinition,
      event,
      scope,
      state,
    });
  }
  const resolved = await resolveOAuthAppConfig(dependencies, scope, {
    providerKey: attempt.data.providerKey,
    ...(attempt.data.providerApplicationId
      ? { providerApplicationId: attempt.data.providerApplicationId }
      : {}),
  });
  if (resolved.route !== "platform_oauth") throw new Error("OAuth provider route changed.");
  const { application, config } = resolved;
  const definition = definitions.resolve(application.data.providerKey);
  if ((definition?.oauthProviderKey ?? application.data.providerKey) !== provider)
    throw new Error("OAuth provider does not match the authorization attempt.");
  const providerError = event.queryStringParameters?.error;
  if (providerError !== undefined) {
    // platform_oauth providers carry no RFC 9207 issuer pin, so there is no `iss` to check.
    return {
      error: providerError === "access_denied" ? "access_denied" : "authorization_failed",
      kind: "failed",
    };
  }
  const code = required(
    event.queryStringParameters?.[config.callbackCodeParameterName] ??
      event.queryStringParameters?.code,
    "OAuth code",
  );
  const resource =
    attempt.data.requestedResource && !config.tokenAuthorizedAccountIdsPath
      ? attempt.data.requestedResource
      : undefined;
  const vault = await dependencies.vault(scope);
  const codeVerifier = config.pkce
    ? await attemptPkceVerifier(vault, scope, attempt, state, true)
    : undefined;
  const token = await exchange(
    config,
    {
      [config.tokenAuthorizationCodeParameterName]: code,
      ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
    },
    resource,
    true,
    dependencies.fetch,
  );
  if (config.refreshTokenRequired && !token.refreshToken)
    throw new Error("OAuth provider omitted the required refresh token.");
  const connectionId = await dependencies.id();
  const identity = await resolveOAuthExternalIdentity({
    config,
    fallbackId: connectionId,
    fallbackName: application.data.providerKey,
    ...(attempt.data.requestedResource && config.tokenAuthorizedAccountIdsPath
      ? { requestedExternalAccountId: attempt.data.requestedResource }
      : {}),
    token,
  });
  const providerRequestHeaders = config.providerRequestHeaders[application.data.providerKey] ?? {};
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
      scopes: identity.scopes,
      values: credentialValuesWithProviderOAuthMaterial(
        {
          accessToken: token.accessToken,
          ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
          ...(token.tokenType ? { tokenType: token.tokenType } : {}),
        },
        {
          requestHeaders: providerRequestHeaders,
          ...(token.resource ? { resource: token.resource } : {}),
        },
      ),
    },
  });
  const now = dependencies.now().toISOString();
  await persistAuthorizedConnection(dependencies, {
    attempt,
    connection: {
      authMethod: "oauth",
      authorizationScopes: identity.scopes,
      externalAccountId: identity.externalAccountId,
      externalAccountName: identity.displayName,
      id: connectionId,
      lastVerifiedAt: now,
      ...(token.resource ? { oauthResource: token.resource } : {}),
      providerApplicationId: application.data.id,
      providerKey: application.data.providerKey,
      ...(token.expiresAt ? { refreshAfter: new Date(token.expiresAt).toISOString() } : {}),
      scopes: platformCapabilityScopes(application.data.providerKey, identity.scopes, definitions),
      status: "active",
    },
    credential,
    now,
    scope,
    vault,
  });
  return { connectionId, kind: "connected" };
}

async function refreshOrRevoke(
  event: OAuthEvent,
  scope: ChannelProviderScope,
  revoke: boolean,
  dependencies: OAuthRefreshDependencies,
): Promise<OAuthHttpResponse> {
  const connectionId = required(event.pathParameters?.connectionId, "connectionId");
  const connection = Schema.decodeUnknownSync(ProviderConnectionRecord)(
    await dependencies.loadControlRecord(scope, "provider-connection", connectionId),
  );
  if (!connection.data.credentialRef) throw new Error("OAuth connection is incomplete.");
  if (revoke) {
    await revokeProviderConnection(
      dependencies,
      scope,
      connection,
      operatorAccessAuditActor(scope),
    );
    return response(204);
  }
  return refreshOAuthConnectionRoute(dependencies, scope, connection, randomUUID());
}

/** The JWT routes a member calls, each with the activity organization standing decides. */
const OAUTH_API_ROUTES: readonly {
  readonly activity: ApiActivity;
  readonly method: string;
  readonly segment: string;
  readonly handle: (
    event: OAuthEvent,
    scope: ChannelProviderScope,
    dependencies: OAuthRefreshDependencies,
  ) => Promise<OAuthHttpResponse>;
}[] = [
  {
    activity: "api.write",
    method: "POST",
    segment: "/provider-applications/",
    handle: (event, scope, dependencies) => authorize(event, scope, dependencies.returnOrigins()),
  },
  {
    activity: "api.write",
    method: "POST",
    segment: "/provider-connections/",
    handle: (event, scope, dependencies) => refreshOrRevoke(event, scope, false, dependencies),
  },
  {
    activity: "api.remediate",
    method: "DELETE",
    segment: "/provider-connections/",
    handle: (event, scope, dependencies) => refreshOrRevoke(event, scope, true, dependencies),
  },
];

/** Public OAuth Client ID Metadata Document listing every vendor MCP callback. */
function clientMetadata(dependencies: OAuthRuntimeDependencies): OAuthHttpResponse {
  const publicOrigin = dependencies.publicOrigin();
  if (!publicOrigin) return response(404, { error: "not_found" });
  return {
    body: JSON.stringify(
      vendorMcpClientMetadataDocument({
        definitions: dependencies.definitions().list(),
        publicOrigin,
      }),
    ),
    headers: { "cache-control": "public, max-age=300", "content-type": "application/json" },
    statusCode: 200,
  };
}

export async function handleOAuthApi(
  event: OAuthEvent,
  dependencies: OAuthRefreshDependencies = defaultRefreshDependencies(),
): Promise<OAuthHttpResponse> {
  try {
    const path = event.requestContext?.http?.path ?? "";
    const method = event.requestContext?.http?.method?.toUpperCase();
    if (path.endsWith(VENDOR_MCP_CLIENT_METADATA_PATH) && method === "GET")
      return clientMetadata(dependencies);
    if (path.includes("/oauth/callback/")) return await callback(event, dependencies);
    const route = OAUTH_API_ROUTES.find(
      (candidate) => candidate.method === method && path.includes(candidate.segment),
    );
    if (!route) return response(405, { error: "method_not_allowed" });
    const scope = await scopeFromClaims(event);
    const refusal = await standingRefusal({
      activity: route.activity,
      organizationId: scope.organizationId,
      requestId: event.requestContext?.requestId,
      standing: dependencies.standing,
    });
    return refusal ?? (await route.handle(event, scope, dependencies));
  } catch (cause) {
    console.error("OAuth request failed.", { errorType: errorType(cause) });
    if (cause instanceof ChannelProviderIdentityError)
      return response(cause.statusCode, { error: cause.code });
    return cause instanceof PlatformOAuthReturnToError
      ? response(422, { error: "invalid_return_to" })
      : response(400, { error: "invalid_oauth_request" });
  }
}

export const handler = (event: OAuthEvent) => handleOAuthApi(event);
