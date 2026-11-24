export const PLATFORM_OAUTH_ROUTE = "platform_oauth" as const;
export const PLATFORM_OAUTH_CONNECTION_SOURCE = "platform_oauth" as const;
export const PLATFORM_OAUTH_APPS_JSON_ENV = "PLATFORM_OAUTH_APPS_JSON" as const;
export const PLATFORM_OAUTH_CONNECTION_SECRET_PREFIX_ENV =
  "PLATFORM_OAUTH_CONNECTION_SECRET_PREFIX" as const;
export const PLATFORM_OAUTH_STATE_SECRET_ENV = "PLATFORM_OAUTH_STATE_SECRET" as const;
/** Exact HTTPS origin of the channel API serving OAuth callbacks and the vendor MCP CIMD. */
export const PLATFORM_OAUTH_PUBLIC_ORIGIN_ENV = "PLATFORM_OAUTH_PUBLIC_ORIGIN" as const;
/**
 * Comma-separated exact HTTPS origins an authorization `returnTo` may target; the OAuth
 * callback redirects the browser there. Empty or unset: no `returnTo` is accepted.
 */
export const PLATFORM_OAUTH_RETURN_ORIGINS_ENV = "PLATFORM_OAUTH_RETURN_ORIGINS" as const;
export const PLATFORM_OAUTH_SECRET_SCHEMA_VERSION = 1 as const;
export const PLATFORM_OAUTH_ATTEMPT_TTL_MS = 10 * 60 * 1_000;
/** Access tokens expiring within this window are refreshed before use. */
export const PLATFORM_OAUTH_REFRESH_SKEW_MS = 120 * 1_000;

export type PlatformOAuthClientAuthentication =
  | "client_secret_basic"
  | "secret_basic"
  | "client_secret_post"
  | "none";

export type PlatformOAuthRevocationCredential =
  | "access_token"
  | "external_account_id"
  | "refresh_token";
export type PlatformOAuthRevocationImpact = "shared_grant" | "token";
export type PlatformOAuthRevocationBodyFormat = "form" | "json";
export type PlatformOAuthRevocationCredentialPlacement = "bearer" | "body";
export type PlatformOAuthRevocationMethod = "DELETE" | "POST";
export type PlatformOAuthBodyFormat = "form" | "json";

export type PlatformOAuthRequestRevocationConfig = {
  readonly mode: "request";
  readonly additionalCredentials: readonly PlatformOAuthRevocationCredential[];
  readonly alreadyRevokedJsonPath?: string;
  readonly alreadyRevokedJsonValues: readonly string[];
  readonly bodyFormat: PlatformOAuthRevocationBodyFormat;
  readonly clientIdParameterName: string;
  readonly clientAuthentication: PlatformOAuthClientAuthentication;
  readonly clientSecretParameterName: string;
  readonly credential: PlatformOAuthRevocationCredential;
  readonly credentialHeaderName?: string;
  readonly credentialPlacement: PlatformOAuthRevocationCredentialPlacement;
  readonly endpoint: string;
  readonly endpointFromResource: boolean;
  readonly impact: PlatformOAuthRevocationImpact;
  readonly includeClientId: boolean;
  readonly method: PlatformOAuthRevocationMethod;
  readonly parameterName: string;
  readonly params: Readonly<Record<string, string>>;
  readonly successJsonPath?: string;
  readonly successJsonValue?: boolean | number | string;
  readonly tokenTypeHintParameterName?: string;
};

export type PlatformOAuthProviderEventRevocationConfig = {
  readonly mode: "provider_event";
  readonly eventType: string;
  readonly impact: PlatformOAuthRevocationImpact;
};

export type PlatformOAuthRevocationConfig =
  | PlatformOAuthProviderEventRevocationConfig
  | PlatformOAuthRequestRevocationConfig;

export type PlatformOAuthTokenUpgradeConfig = {
  readonly clientAuthentication: PlatformOAuthClientAuthentication;
  readonly credentialParameterName: string;
  readonly endpoint: string;
  readonly params: Readonly<Record<string, string>>;
};

export type PlatformOAuthAppConfig = {
  readonly allowedResources: readonly string[];
  readonly allowedResourceHostSuffixes: readonly string[];
  readonly authorizationClientIdParameterName: string;
  readonly authorizationEndpoint: string;
  readonly authorizationIncludesRedirectUri: boolean;
  readonly authorizationIncludesResponseType: boolean;
  readonly authorizationIncludesScope: boolean;
  readonly authorizationParams: Readonly<Record<string, string>>;
  readonly callbackCodeParameterName: string;
  readonly clientAuthentication: PlatformOAuthClientAuthentication;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly defaultAccessTokenTtlSeconds?: number;
  readonly identityClientAuthentication: PlatformOAuthClientAuthentication;
  readonly identityDisplayNamePath?: string;
  readonly identityBodyFormat: "form" | "json";
  readonly identityCredentialPlacement: "bearer" | "body";
  readonly identityEndpoint?: string;
  readonly identityHeaders: Readonly<Record<string, string>>;
  readonly identityIdPath?: string;
  readonly identityMethod: "GET" | "POST";
  readonly identityParameterName: string;
  readonly identityParams: Readonly<Record<string, string>>;
  readonly identityScopeItemNamePath?: string;
  readonly identityScopeItemStatusPath?: string;
  readonly identityScopeItemStatusValue?: boolean | number | string;
  readonly identityScopesPath?: string;
  readonly identityScopesRequired: boolean;
  readonly identityScopeSeparator: "comma" | "space";
  readonly identitySuccessJsonPath?: string;
  readonly identitySuccessJsonValue?: boolean | number | string;
  /** Expected RFC 8414 issuer recorded before redirect (RFC 9207 `iss` validation). */
  readonly issuer?: string;
  /** RFC 9207 `authorization_response_iss_parameter_supported`. */
  readonly issParameterSupported?: boolean;
  readonly pkce: boolean;
  readonly providerRequestHeaders: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly redirectUri: string;
  readonly refreshParams: Readonly<Record<string, string>>;
  readonly requestedScopesFallback: boolean;
  readonly refreshTokenRequired: boolean;
  readonly refreshTokenRotationRequired: boolean;
  /**
   * `parameter`: RFC 8707 `resource=<origin>`; `endpoint_origin`: endpoints rebased onto
   * the resource origin; `canonical_uri`: RFC 8707 `resource=<exact canonical MCP URI>`
   * (path allowed). `canonical_uri` is code-synthesized for vendor MCP only.
   */
  readonly resourceMode: "canonical_uri" | "endpoint_origin" | "parameter";
  readonly revocation?: PlatformOAuthRevocationConfig;
  readonly scopeImplications: Readonly<Record<string, readonly string[]>>;
  readonly scopeSeparator: "comma" | "space";
  readonly tokenAuthorizationCodeParameterName: string;
  readonly tokenAuthorizedAccountIdsPath?: string;
  readonly tokenBodyFormat: PlatformOAuthBodyFormat;
  readonly tokenClientIdParameterName: string;
  readonly tokenClientSecretParameterName: string;
  readonly tokenEndpoint: string;
  readonly tokenHeaders: Readonly<Record<string, string>>;
  readonly tokenIncludesGrantType: boolean;
  readonly tokenIncludesRedirectUri: boolean;
  readonly tokenIdentityDisplayNamePath?: string;
  readonly tokenIdentityIdPath?: string;
  readonly tokenIdentityIdPaths: readonly string[];
  readonly tokenResourcePath?: string;
  readonly tokenParams: Readonly<Record<string, string>>;
  readonly tokenResponsePath?: string;
  readonly tokenSuccessJsonPath?: string;
  readonly tokenSuccessJsonValue?: boolean | number | string;
  readonly tokenUpgrade?: PlatformOAuthTokenUpgradeConfig;
};

/**
 * Secret-free protocol configuration held in `PLATFORM_OAUTH_APPS_JSON`. The client
 * secret is never configured here; it is resolved at runtime from the provider
 * application's vault credential.
 */
export type PlatformOAuthAppProtocolConfig = Omit<PlatformOAuthAppConfig, "clientSecret">;

export type PlatformOAuthAppRegistry = Readonly<Record<string, PlatformOAuthAppProtocolConfig>>;

export type PlatformOAuthTokenBundle = {
  readonly accessToken: string;
  readonly authorizedAccountIds?: readonly string[];
  readonly expiresAt?: number;
  readonly refreshToken?: string;
  readonly providerIdentityDisplayName?: string;
  readonly providerIdentityId?: string;
  readonly resource?: string;
  readonly scopes: readonly string[];
  readonly tokenType?: string;
};

export type PlatformOAuthSecretDocument = PlatformOAuthTokenBundle & {
  readonly connectorAccountId: string;
  readonly createdAt: string;
  readonly oauthProviderKey: string;
  readonly organizationId: string;
  readonly providerKey: string;
  readonly schemaVersion: typeof PLATFORM_OAUTH_SECRET_SCHEMA_VERSION;
  readonly updatedAt: string;
};
