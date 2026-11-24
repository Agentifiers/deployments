import {
  OAuthAuthorizationAttemptRecord,
  ProviderApplicationRecord,
  UNIQUE_CLAIM_CONDITION,
  UniqueClaimRecord,
  decodePlatformRecord,
  key,
  makeDynamoDatabase,
  makeIdGenerator,
  makeUniqueClaimRecord,
  uniqueClaimRequirements,
  withCanonicalRecordKeys,
  type Ulid,
  channelProviderDocumentPersistence,
  channelProviderPersistence,
} from "@deployments-ai/db";
import {
  codeProviderDefinitionRegistry,
  parsePlatformOAuthAppRegistry,
  parsePlatformOAuthTokenResponse,
  platformOAuthAuthorizationUrl,
  platformOAuthCanonicalResource,
  platformOAuthEndpointAtResource,
  platformOAuthResponseValueAtPath,
  platformOAuthReturnTo,
  platformOAuthStateHash,
  type PlatformOAuthAppConfig,
  type PlatformOAuthAppRegistry,
  type ProviderDefinitionRegistry,
} from "@deployments-ai/providers";
import { Effect, Schema } from "effect";
import { randomBytes } from "node:crypto";

import {
  resolveProviderRequestHeaderReferences,
  tokenWithConfiguredIdentity,
} from "./oauth-identity.ts";
import { channelProviderScope, type ChannelProviderScope } from "./platform-identity.ts";
import { oauthTokenFetchInit, parseOAuthTokenEndpointResponse } from "./oauth-token-response.ts";
import { required } from "./required-value.ts";
import { runtimeCredentialVault, runtimeScopedDocumentClient } from "./runtime.ts";

export interface OAuthEvent {
  readonly body?: string | null;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly pathParameters?: Readonly<Record<string, string | undefined>>;
  readonly queryStringParameters?: Readonly<Record<string, string | undefined>>;
  readonly requestContext?: {
    readonly authorizer?: { readonly jwt?: { readonly claims?: Readonly<Record<string, string>> } };
    readonly http?: { readonly method?: string; readonly path?: string };
    readonly requestId?: string;
  };
}

const ids = makeIdGenerator();
const ATTEMPT_TTL_MS = 10 * 60 * 1_000;

export async function id() {
  return ids.generate();
}
function optionalText(value: unknown, label: string, maximum = 2_048) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maximum ||
    Array.from(normalized).some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}
function jsonBody(event: OAuthEvent) {
  const value = JSON.parse(event.body ?? "{}");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Body must be an object.");
  return value as Record<string, unknown>;
}
export interface OAuthHttpResponse {
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly statusCode: number;
}

export function response(statusCode: number, body?: unknown): OAuthHttpResponse {
  return {
    statusCode,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  };
}
export function requiredUniqueClaim(
  record: Parameters<typeof uniqueClaimRequirements>[0],
  createdAt: string,
) {
  const [requirement] = uniqueClaimRequirements(record);
  if (!requirement) throw new Error(`${record.itemType} uniqueness is not registered.`);
  return Schema.decodeUnknownSync(UniqueClaimRecord)(makeUniqueClaimRecord(requirement, createdAt));
}
export function scopeFromClaims(event: OAuthEvent) {
  return channelProviderScope(event);
}
export function stateParts(state: string) {
  const parts = state.split(".");
  if (parts.length !== 5) throw new Error("OAuth state is invalid.");
  return {
    organizationId: parts[0]!,
    projectId: parts[1]!,
    environmentId: parts[2]!,
    attemptId: parts[3]!,
    nonce: parts[4]!,
  };
}
export function registry() {
  return parsePlatformOAuthAppRegistry(
    required(process.env.PLATFORM_OAUTH_APPS_JSON, "PLATFORM_OAUTH_APPS_JSON"),
  );
}

export function platformCapabilityScopes(
  providerKey: string,
  authorizationScopes: readonly string[],
  definitions: ProviderDefinitionRegistry = codeProviderDefinitionRegistry(),
) {
  const definition = definitions.resolve(providerKey);
  if (!definition) return [];
  if (definition.authorizationScopeMode === "manifest") {
    return [...new Set(definition.defaultScopes)].toSorted();
  }
  if (Object.keys(definition.authorizationScopeCapabilities).length > 0) {
    return [
      ...new Set(
        authorizationScopes.flatMap(
          (scope) => definition.authorizationScopeCapabilities[scope] ?? [],
        ),
      ),
    ].toSorted();
  }
  return [
    ...new Set(authorizationScopes.filter((scope) => definition.defaultScopes.includes(scope))),
  ].toSorted();
}

export async function getRecord(
  scope: { organizationId: string; environmentId: string; projectId: string },
  itemType: string,
  itemId: string,
) {
  const client = await runtimeScopedDocumentClient(scope, "writer");
  const result = await channelProviderDocumentPersistence.read(client, {
    ConsistentRead: true,
    Key: {
      pk: key("ORG", scope.organizationId, "ENV", scope.environmentId),
      sk: key(itemType.toUpperCase(), itemId),
    },
    TableName: process.env.DEPLOYMENTS_AI_CONTROL_TABLE,
  });
  if (!result.Item) throw new OAuthRecordNotFoundError(itemType);
  return Effect.runPromise(decodePlatformRecord(result.Item));
}
export class OAuthRecordNotFoundError extends Error {
  constructor(readonly itemType: string) {
    super(`${itemType} was not found.`);
    this.name = "OAuthRecordNotFoundError";
  }
}

export function appConfig(
  application: typeof ProviderApplicationRecord.Type,
  credentials?: Readonly<Record<string, string>>,
  definitions: ProviderDefinitionRegistry = codeProviderDefinitionRegistry(),
  apps: PlatformOAuthAppRegistry = registry(),
) {
  const definition = definitions.resolve(application.data.providerKey);
  const oauthKey = definition?.oauthProviderKey ?? application.data.providerKey;
  const base = apps[oauthKey];
  if (!base) throw new Error("OAuth provider configuration is not registered.");
  const configuredProviderHeaders = base.providerRequestHeaders[application.data.providerKey];
  return {
    ...base,
    clientId: application.data.clientId,
    ...(credentials
      ? {
          clientSecret: required(credentials.clientSecret, "clientSecret"),
          providerRequestHeaders: resolveProviderRequestHeaderReferences(
            configuredProviderHeaders
              ? { [application.data.providerKey]: configuredProviderHeaders }
              : {},
            credentials,
            { configured: base.clientId, persisted: application.data.clientId },
          ),
        }
      : {}),
  } satisfies PlatformOAuthAppConfig;
}

/** RFC 8707 `resource` body field for token and refresh requests. */
function tokenResourceFields(
  config: PlatformOAuthAppConfig,
  resource: string | undefined,
): Record<string, string> {
  if (!resource) return {};
  if (config.resourceMode === "canonical_uri") {
    return { resource: platformOAuthCanonicalResource(config, resource) };
  }
  return config.resourceMode === "parameter" ? { resource } : {};
}

function tokenRequest(
  config: PlatformOAuthAppConfig,
  fields: Record<string, string>,
  resource?: string,
) {
  const values: Record<string, string> = {
    ...config.tokenParams,
    ...fields,
    ...tokenResourceFields(config, resource),
  };
  if (config.tokenIncludesGrantType && !values.grant_type) values.grant_type = "authorization_code";
  if (config.tokenIncludesRedirectUri) values.redirect_uri = config.redirectUri;
  if (
    config.clientAuthentication === "client_secret_post" ||
    config.clientAuthentication === "secret_basic"
  ) {
    values[config.tokenClientIdParameterName] = config.clientId;
    values[config.tokenClientSecretParameterName] = required(
      config.clientSecret,
      "OAuth client secret",
    );
  }
  if (config.clientAuthentication === "none") {
    values[config.tokenClientIdParameterName] = config.clientId;
  }
  const headers: Record<string, string> = { accept: "application/json", ...config.tokenHeaders };
  if (config.clientAuthentication === "client_secret_basic")
    headers.authorization = `Basic ${Buffer.from(`${config.clientId}:${required(config.clientSecret, "OAuth client secret")}`).toString("base64")}`;
  if (config.tokenBodyFormat === "json") {
    headers["content-type"] = "application/json";
    return { body: JSON.stringify(values), headers };
  }
  headers["content-type"] = "application/x-www-form-urlencoded";
  return { body: new URLSearchParams(values).toString(), headers };
}

export async function exchange(
  config: PlatformOAuthAppConfig,
  fields: Record<string, string>,
  resource?: string,
  requireConfiguredIdentity = true,
  fetchImpl: (input: string, init: RequestInit) => Promise<Response> = fetch,
) {
  const request = tokenRequest(config, fields, resource);
  const endpoint =
    resource && config.resourceMode === "endpoint_origin"
      ? platformOAuthEndpointAtResource(config.tokenEndpoint, resource).toString()
      : config.tokenEndpoint;
  const result = await fetchImpl(endpoint, oauthTokenFetchInit(request));
  const raw = await parseOAuthTokenEndpointResponse(result);
  return tokenWithConfiguredIdentity(
    config,
    raw,
    parsePlatformOAuthTokenResponse(
      config.tokenResponsePath
        ? platformOAuthResponseValueAtPath(raw, config.tokenResponsePath)
        : raw,
    ),
    resource,
    requireConfiguredIdentity,
  );
}

export async function authorize(
  event: OAuthEvent,
  scope: ChannelProviderScope,
  returnOrigins: readonly string[],
) {
  const applicationId = required(event.pathParameters?.applicationId, "applicationId");
  const body = jsonBody(event);
  // A non-string `returnTo` fails validation like any other disallowed value.
  const returnTo =
    body.returnTo === undefined
      ? undefined
      : platformOAuthReturnTo(
          typeof body.returnTo === "string" ? body.returnTo : "",
          returnOrigins,
        );
  const application = Schema.decodeUnknownSync(ProviderApplicationRecord)(
    await getRecord(scope, "provider-application", applicationId),
  );
  const requestedScopes = Array.isArray(body.scopes)
    ? body.scopes.filter((value): value is string => typeof value === "string")
    : application.data.requestedScopes;
  const requestedResource = optionalText(body.requestedResource, "requestedResource");
  const authorizationConfig = appConfig(application);
  const attemptId = await id();
  const state = [
    scope.organizationId,
    scope.projectId,
    scope.environmentId,
    attemptId,
    randomBytes(32).toString("base64url"),
  ].join(".");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ATTEMPT_TTL_MS).toISOString();
  const verifier = randomBytes(32).toString("base64url");
  const vault = await runtimeCredentialVault(scope, "writer");
  const preparedPkce = await vault.prepareWrite({
    identity: {
      credentialId: await id(),
      environmentId: scope.environmentId as Ulid,
      organizationId: scope.organizationId as Ulid,
      ownerId: attemptId as Ulid,
      ownerType: "oauth-authorization-attempt",
      projectId: scope.projectId as Ulid,
      purpose: "oauth-pkce-verifier",
    },
    secret: { expiresAt, values: { verifier } },
  });
  const attempt = Schema.decodeUnknownSync(OAuthAuthorizationAttemptRecord)(
    withCanonicalRecordKeys({
      itemType: "oauth-authorization-attempt" as const,
      data: {
        createdAt: now.toISOString(),
        environmentId: scope.environmentId,
        expiresAt,
        id: attemptId,
        ...(scope.operatorAccessGrantId
          ? { operatorAccessGrantId: scope.operatorAccessGrantId }
          : {}),
        organizationId: scope.organizationId,
        principalId: scope.principalId,
        pkceSecretRef: preparedPkce.reference,
        projectId: scope.projectId,
        providerApplicationId: applicationId,
        providerKey: application.data.providerKey,
        ...(requestedResource ? { requestedResource } : {}),
        requestedScopes,
        ...(returnTo ? { returnTo } : {}),
        stateHash: platformOAuthStateHash(state),
        status: "pending" as const,
        version: 0,
      },
      ttl: Math.floor(Date.parse(expiresAt) / 1000),
    }),
  );
  const client = await runtimeScopedDocumentClient(scope, "writer");
  const database = makeDynamoDatabase(client);
  const attemptClaim = requiredUniqueClaim(attempt, attempt.data.createdAt);
  await channelProviderPersistence.commit(database, [
    { conditionExpression: UNIQUE_CLAIM_CONDITION, kind: "put", record: attempt },
    { conditionExpression: UNIQUE_CLAIM_CONDITION, kind: "put", record: attemptClaim },
    preparedPkce.operation,
  ]);
  return response(201, {
    authorizationUrl: platformOAuthAuthorizationUrl({
      app: authorizationConfig,
      ...(requestedResource && !authorizationConfig.tokenAuthorizedAccountIdsPath
        ? { resource: requestedResource }
        : {}),
      scopes: requestedScopes,
      state,
      verifier,
    }),
    expiresAt,
  });
}
