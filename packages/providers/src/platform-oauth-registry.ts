import { normalizeProviderApiHosts } from "./provider-definitions.ts";
import type {
  PlatformOAuthTokenUpgradeConfig,
  PlatformOAuthAppProtocolConfig,
  PlatformOAuthAppRegistry,
} from "./platform-oauth-types.ts";
import { PLATFORM_OAUTH_APPS_JSON_ENV } from "./platform-oauth-types.ts";
import {
  isRecord,
  requiredText,
  optionalText,
  optionalPositiveInteger,
  optionalTextArray,
  oauthKey,
  secureUrl,
  stringRecord,
  stringArrayRecord,
  safeIdentityHeaders,
  providerRequestHeaders,
  jsonExpectation,
  secureOrigins,
  clientAuthentication,
  revocationConfig,
} from "./platform-oauth-config.ts";

export function parsePlatformOAuthAppRegistry(value: string): PlatformOAuthAppRegistry {
  let decoded: unknown;
  try {
    decoded = JSON.parse(requiredText(value, PLATFORM_OAUTH_APPS_JSON_ENV, 1_000_000));
  } catch (cause) {
    if (cause instanceof SyntaxError)
      throw new Error(`${PLATFORM_OAUTH_APPS_JSON_ENV} is invalid JSON.`, { cause });
    throw cause;
  }
  if (!isRecord(decoded)) throw new Error(`${PLATFORM_OAUTH_APPS_JSON_ENV} must be an object.`);

  const registry: Record<string, PlatformOAuthAppProtocolConfig> = {};
  for (const [rawKey, rawConfig] of Object.entries(decoded)) {
    const key = oauthKey(rawKey, "OAuth provider key");
    if (!isRecord(rawConfig)) throw new Error(`OAuth app ${key} must be an object.`);
    if ("clientSecret" in rawConfig) {
      throw new Error(
        `OAuth app ${key} must not configure clientSecret; store it on the provider application credential.`,
      );
    }
    const appClientAuthentication = clientAuthentication(
      rawConfig.clientAuthentication,
      `OAuth app ${key} clientAuthentication`,
    );
    const authorizationClientIdParameterName = requiredText(
      rawConfig.authorizationClientIdParameterName ?? "client_id",
      `OAuth app ${key} authorizationClientIdParameterName`,
      128,
    );
    const callbackCodeParameterName = requiredText(
      rawConfig.callbackCodeParameterName ?? "code",
      `OAuth app ${key} callbackCodeParameterName`,
      128,
    );
    const identityEndpoint = optionalText(
      rawConfig.identityEndpoint,
      `OAuth app ${key} identityEndpoint`,
    );
    const identityIdPath = optionalText(
      rawConfig.identityIdPath,
      `OAuth app ${key} identityIdPath`,
      256,
    );
    if (Boolean(identityEndpoint) !== Boolean(identityIdPath)) {
      throw new Error(
        `OAuth app ${key} identityEndpoint and identityIdPath must be configured together.`,
      );
    }
    const identityMethod = rawConfig.identityMethod ?? "GET";
    if (identityMethod !== "GET" && identityMethod !== "POST") {
      throw new Error(`OAuth app ${key} identityMethod is invalid.`);
    }
    const identityCredentialPlacement = rawConfig.identityCredentialPlacement ?? "bearer";
    if (identityCredentialPlacement !== "bearer" && identityCredentialPlacement !== "body") {
      throw new Error(`OAuth app ${key} identityCredentialPlacement is invalid.`);
    }
    if (identityMethod === "GET" && identityCredentialPlacement === "body") {
      throw new Error(`OAuth app ${key} GET identity cannot place credentials in a body.`);
    }
    const identityBodyFormat = rawConfig.identityBodyFormat ?? "form";
    if (identityBodyFormat !== "form" && identityBodyFormat !== "json") {
      throw new Error(`OAuth app ${key} identityBodyFormat is invalid.`);
    }
    const identityParameterName = requiredText(
      rawConfig.identityParameterName ?? "access_token",
      `OAuth app ${key} identityParameterName`,
      128,
    );
    const identityClientAuthentication = clientAuthentication(
      rawConfig.identityClientAuthentication,
      `OAuth app ${key} identityClientAuthentication`,
      "none",
    );
    if (identityCredentialPlacement === "bearer" && identityClientAuthentication !== "none") {
      throw new Error(`OAuth app ${key} bearer identity cannot use client authentication.`);
    }
    const identityScopesPath = optionalText(
      rawConfig.identityScopesPath,
      `OAuth app ${key} identityScopesPath`,
      256,
    );
    const identityScopeItemNamePath = optionalText(
      rawConfig.identityScopeItemNamePath,
      `OAuth app ${key} identityScopeItemNamePath`,
      256,
    );
    const identityScopeItemStatusPath = optionalText(
      rawConfig.identityScopeItemStatusPath,
      `OAuth app ${key} identityScopeItemStatusPath`,
      256,
    );
    const hasIdentityScopeItemStatusValue = Object.hasOwn(
      rawConfig,
      "identityScopeItemStatusValue",
    );
    const identityScopeItemStatusValue = rawConfig.identityScopeItemStatusValue;
    if (identityScopeItemNamePath && !identityScopesPath) {
      throw new Error(`OAuth app ${key} identityScopeItemNamePath requires identityScopesPath.`);
    }
    if (identityScopeItemStatusPath && !identityScopeItemNamePath) {
      throw new Error(
        `OAuth app ${key} identityScopeItemStatusPath requires identityScopeItemNamePath.`,
      );
    }
    if (Boolean(identityScopeItemStatusPath) !== hasIdentityScopeItemStatusValue) {
      throw new Error(
        `OAuth app ${key} identityScopeItemStatusPath and identityScopeItemStatusValue must be configured together.`,
      );
    }
    if (
      hasIdentityScopeItemStatusValue &&
      typeof identityScopeItemStatusValue !== "boolean" &&
      typeof identityScopeItemStatusValue !== "number" &&
      typeof identityScopeItemStatusValue !== "string"
    ) {
      throw new Error(`OAuth app ${key} identityScopeItemStatusValue is invalid.`);
    }
    const identityScopeSeparator = rawConfig.identityScopeSeparator ?? "space";
    if (identityScopeSeparator !== "space" && identityScopeSeparator !== "comma") {
      throw new Error(`OAuth app ${key} identityScopeSeparator is invalid.`);
    }
    const identitySuccess = jsonExpectation(
      rawConfig,
      "identitySuccessJsonPath",
      "identitySuccessJsonValue",
      `OAuth app ${key} identity`,
    );
    const tokenSuccess = jsonExpectation(
      rawConfig,
      "tokenSuccessJsonPath",
      "tokenSuccessJsonValue",
      `OAuth app ${key} token`,
    );
    const tokenIdentityIdPath = optionalText(
      rawConfig.tokenIdentityIdPath,
      `OAuth app ${key} tokenIdentityIdPath`,
      256,
    );
    const tokenIdentityIdPaths = Object.freeze([
      ...new Set([
        ...(tokenIdentityIdPath ? [tokenIdentityIdPath] : []),
        ...optionalTextArray(
          rawConfig.tokenIdentityIdPaths,
          `OAuth app ${key} tokenIdentityIdPaths`,
        ),
      ]),
    ]);
    const tokenIdentityDisplayNamePath = optionalText(
      rawConfig.tokenIdentityDisplayNamePath,
      `OAuth app ${key} tokenIdentityDisplayNamePath`,
      256,
    );
    if (tokenIdentityDisplayNamePath && tokenIdentityIdPaths.length === 0) {
      throw new Error(
        `OAuth app ${key} tokenIdentityDisplayNamePath requires tokenIdentityIdPath.`,
      );
    }
    const tokenResourcePath = optionalText(
      rawConfig.tokenResourcePath,
      `OAuth app ${key} tokenResourcePath`,
      256,
    );
    const tokenAuthorizedAccountIdsPath = optionalText(
      rawConfig.tokenAuthorizedAccountIdsPath,
      `OAuth app ${key} tokenAuthorizedAccountIdsPath`,
      256,
    );
    const tokenResponsePath = optionalText(
      rawConfig.tokenResponsePath,
      `OAuth app ${key} tokenResponsePath`,
      256,
    );
    const tokenBodyFormat = rawConfig.tokenBodyFormat ?? "form";
    if (tokenBodyFormat !== "form" && tokenBodyFormat !== "json") {
      throw new Error(`OAuth app ${key} tokenBodyFormat is invalid.`);
    }
    const tokenAuthorizationCodeParameterName = requiredText(
      rawConfig.tokenAuthorizationCodeParameterName ?? "code",
      `OAuth app ${key} tokenAuthorizationCodeParameterName`,
      128,
    );
    const tokenClientIdParameterName = requiredText(
      rawConfig.tokenClientIdParameterName ?? "client_id",
      `OAuth app ${key} tokenClientIdParameterName`,
      128,
    );
    const tokenClientSecretParameterName = requiredText(
      rawConfig.tokenClientSecretParameterName ?? "client_secret",
      `OAuth app ${key} tokenClientSecretParameterName`,
      128,
    );
    const allowedResources = secureOrigins(
      rawConfig.allowedResources,
      `OAuth app ${key} allowedResources`,
    );
    const allowedResourceHostSuffixes = normalizeProviderApiHosts(
      optionalTextArray(
        rawConfig.allowedResourceHostSuffixes,
        `OAuth app ${key} allowedResourceHostSuffixes`,
      ),
    );
    const resourceMode = rawConfig.resourceMode ?? "parameter";
    if (resourceMode === "canonical_uri") {
      throw new Error(
        `OAuth app ${key} resourceMode canonical_uri is reserved for code-synthesized vendor MCP configs.`,
      );
    }
    if (resourceMode !== "parameter" && resourceMode !== "endpoint_origin") {
      throw new Error(`OAuth app ${key} resourceMode is invalid.`);
    }
    if (
      resourceMode === "endpoint_origin" &&
      allowedResources.length === 0 &&
      allowedResourceHostSuffixes.length === 0
    ) {
      throw new Error(`OAuth app ${key} endpoint-origin resources require an allowlist.`);
    }
    let tokenUpgrade: PlatformOAuthTokenUpgradeConfig | undefined;
    if (rawConfig.tokenUpgrade !== undefined && rawConfig.tokenUpgrade !== null) {
      if (!isRecord(rawConfig.tokenUpgrade)) {
        throw new Error(`OAuth app ${key} tokenUpgrade must be an object.`);
      }
      tokenUpgrade = Object.freeze({
        clientAuthentication: clientAuthentication(
          rawConfig.tokenUpgrade.clientAuthentication,
          `OAuth app ${key} tokenUpgrade clientAuthentication`,
          appClientAuthentication,
        ),
        credentialParameterName: requiredText(
          rawConfig.tokenUpgrade.credentialParameterName,
          `OAuth app ${key} tokenUpgrade credentialParameterName`,
          128,
        ),
        endpoint: secureUrl(
          rawConfig.tokenUpgrade.endpoint,
          `OAuth app ${key} tokenUpgrade endpoint`,
        ),
        params: stringRecord(rawConfig.tokenUpgrade.params, `OAuth app ${key} tokenUpgrade params`),
      });
    }
    const revocation = revocationConfig(rawConfig.revocation, key, appClientAuthentication);
    if (
      revocation?.mode === "request" &&
      revocation.endpointFromResource &&
      resourceMode !== "endpoint_origin"
    ) {
      throw new Error(
        `OAuth app ${key} resource-derived revocation requires endpoint_origin resourceMode.`,
      );
    }
    if (
      revocation?.impact === "shared_grant" &&
      !identityEndpoint &&
      tokenIdentityIdPaths.length === 0
    ) {
      throw new Error(`OAuth app ${key} shared-grant revocation requires provider identity.`);
    }
    const scopeSeparator = rawConfig.scopeSeparator ?? "space";
    if (scopeSeparator !== "space" && scopeSeparator !== "comma") {
      throw new Error(`OAuth app ${key} scopeSeparator is invalid.`);
    }
    const scopeImplications = stringArrayRecord(
      rawConfig.scopeImplications,
      `OAuth app ${key} scopeImplications`,
    );
    registry[key] = Object.freeze({
      allowedResources,
      allowedResourceHostSuffixes,
      authorizationClientIdParameterName,
      authorizationEndpoint: secureUrl(
        rawConfig.authorizationEndpoint,
        `OAuth app ${key} authorizationEndpoint`,
      ),
      authorizationIncludesRedirectUri: rawConfig.authorizationIncludesRedirectUri !== false,
      authorizationIncludesResponseType: rawConfig.authorizationIncludesResponseType !== false,
      authorizationIncludesScope: rawConfig.authorizationIncludesScope !== false,
      authorizationParams: stringRecord(
        rawConfig.authorizationParams,
        `OAuth app ${key} authorizationParams`,
      ),
      callbackCodeParameterName,
      clientAuthentication: appClientAuthentication,
      clientId: requiredText(rawConfig.clientId, `OAuth app ${key} clientId`),
      ...(optionalPositiveInteger(
        rawConfig.defaultAccessTokenTtlSeconds,
        `OAuth app ${key} defaultAccessTokenTtlSeconds`,
      )
        ? {
            defaultAccessTokenTtlSeconds: optionalPositiveInteger(
              rawConfig.defaultAccessTokenTtlSeconds,
              `OAuth app ${key} defaultAccessTokenTtlSeconds`,
            )!,
          }
        : {}),
      identityClientAuthentication,
      identityBodyFormat,
      identityCredentialPlacement,
      identityHeaders: safeIdentityHeaders(
        rawConfig.identityHeaders,
        `OAuth app ${key} identityHeaders`,
      ),
      identityMethod,
      identityParameterName,
      identityParams: stringRecord(rawConfig.identityParams, `OAuth app ${key} identityParams`),
      ...(identityScopeItemNamePath ? { identityScopeItemNamePath } : {}),
      ...(identityScopeItemStatusPath
        ? {
            identityScopeItemStatusPath,
            identityScopeItemStatusValue: identityScopeItemStatusValue as boolean | number | string,
          }
        : {}),
      ...(identityScopesPath ? { identityScopesPath } : {}),
      identityScopesRequired: rawConfig.identityScopesRequired === true,
      identityScopeSeparator,
      ...(identitySuccess.path === undefined
        ? {}
        : {
            identitySuccessJsonPath: identitySuccess.path,
            identitySuccessJsonValue: identitySuccess.value!,
          }),
      ...(optionalText(
        rawConfig.identityDisplayNamePath,
        `OAuth app ${key} identityDisplayNamePath`,
        256,
      )
        ? {
            identityDisplayNamePath: optionalText(
              rawConfig.identityDisplayNamePath,
              `OAuth app ${key} identityDisplayNamePath`,
              256,
            )!,
          }
        : {}),
      ...(identityEndpoint
        ? {
            identityEndpoint: secureUrl(identityEndpoint, `OAuth app ${key} identityEndpoint`),
          }
        : {}),
      ...(identityIdPath ? { identityIdPath } : {}),
      pkce: rawConfig.pkce !== false,
      providerRequestHeaders: providerRequestHeaders(
        rawConfig.providerRequestHeaders,
        `OAuth app ${key} providerRequestHeaders`,
      ),
      redirectUri: secureUrl(rawConfig.redirectUri, `OAuth app ${key} redirectUri`),
      refreshParams: stringRecord(rawConfig.refreshParams, `OAuth app ${key} refreshParams`),
      requestedScopesFallback: rawConfig.requestedScopesFallback === true,
      refreshTokenRequired: rawConfig.refreshTokenRequired === true,
      refreshTokenRotationRequired: rawConfig.refreshTokenRotationRequired === true,
      resourceMode,
      ...(revocation ? { revocation } : {}),
      scopeImplications,
      scopeSeparator,
      tokenAuthorizationCodeParameterName,
      ...(tokenAuthorizedAccountIdsPath ? { tokenAuthorizedAccountIdsPath } : {}),
      tokenBodyFormat,
      tokenClientIdParameterName,
      tokenClientSecretParameterName,
      tokenEndpoint: secureUrl(rawConfig.tokenEndpoint, `OAuth app ${key} tokenEndpoint`),
      tokenHeaders: safeIdentityHeaders(rawConfig.tokenHeaders, `OAuth app ${key} tokenHeaders`),
      tokenIncludesGrantType: rawConfig.tokenIncludesGrantType !== false,
      tokenIncludesRedirectUri: rawConfig.tokenIncludesRedirectUri !== false,
      ...(tokenIdentityDisplayNamePath ? { tokenIdentityDisplayNamePath } : {}),
      ...(tokenIdentityIdPath ? { tokenIdentityIdPath } : {}),
      tokenIdentityIdPaths,
      ...(tokenResourcePath ? { tokenResourcePath } : {}),
      tokenParams: stringRecord(rawConfig.tokenParams, `OAuth app ${key} tokenParams`),
      ...(tokenResponsePath ? { tokenResponsePath } : {}),
      ...(tokenSuccess.path === undefined
        ? {}
        : {
            tokenSuccessJsonPath: tokenSuccess.path,
            tokenSuccessJsonValue: tokenSuccess.value!,
          }),
      ...(tokenUpgrade ? { tokenUpgrade } : {}),
    });
  }
  return Object.freeze(registry);
}
