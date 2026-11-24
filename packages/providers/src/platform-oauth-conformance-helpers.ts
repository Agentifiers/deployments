import type {
  PlatformOAuthAppProtocolConfig,
  PlatformOAuthRequestRevocationConfig,
} from "./platform-oauth.ts";

export type OAuthAppAssertion = (app: PlatformOAuthAppProtocolConfig) => void;

export function fail(key: string, message: string): never {
  throw new Error(`OAuth app ${key} ${message}`);
}

export function expectEqual(key: string, label: string, actual: unknown, expected: unknown) {
  if (actual !== expected) fail(key, `${label} must be ${JSON.stringify(expected)}.`);
}

function expectUrl(key: string, label: string, actual: string, expected: string) {
  if (new URL(actual).href !== new URL(expected).href) {
    fail(key, `${label} must be ${expected}.`);
  }
}

export function expectParams(
  key: string,
  label: string,
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
) {
  for (const [name, value] of Object.entries(expected)) {
    if (actual[name] !== value) fail(key, `${label}.${name} must be ${JSON.stringify(value)}.`);
  }
}

export function expectIdentity(
  key: string,
  app: PlatformOAuthAppProtocolConfig,
  expected: {
    readonly clientAuthentication?: PlatformOAuthAppProtocolConfig["identityClientAuthentication"];
    readonly credentialPlacement?: PlatformOAuthAppProtocolConfig["identityCredentialPlacement"];
    readonly displayNamePath?: string;
    readonly endpoint: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly idPath: string;
    readonly method?: PlatformOAuthAppProtocolConfig["identityMethod"];
    readonly parameterName?: string;
    readonly params?: Readonly<Record<string, string>>;
    readonly scopesPath?: string;
    readonly scopesRequired?: boolean;
    readonly successJsonPath?: string;
    readonly successJsonValue?: boolean | number | string;
  },
) {
  expectUrl(
    key,
    "identityEndpoint",
    app.identityEndpoint ?? "https://invalid.invalid",
    expected.endpoint,
  );
  expectEqual(key, "identityIdPath", app.identityIdPath, expected.idPath);
  expectParams(key, "identityHeaders", app.identityHeaders, expected.headers ?? {});
  expectEqual(
    key,
    "identityDisplayNamePath",
    app.identityDisplayNamePath,
    expected.displayNamePath,
  );
  expectEqual(key, "identityMethod", app.identityMethod, expected.method ?? "GET");
  expectEqual(
    key,
    "identityCredentialPlacement",
    app.identityCredentialPlacement,
    expected.credentialPlacement ?? "bearer",
  );
  expectEqual(
    key,
    "identityClientAuthentication",
    app.identityClientAuthentication,
    expected.clientAuthentication ?? "none",
  );
  expectEqual(
    key,
    "identityParameterName",
    app.identityParameterName,
    expected.parameterName ?? "access_token",
  );
  expectParams(key, "identityParams", app.identityParams, expected.params ?? {});
  expectEqual(key, "identityScopesPath", app.identityScopesPath, expected.scopesPath);
  expectEqual(
    key,
    "identityScopesRequired",
    app.identityScopesRequired,
    expected.scopesRequired ?? false,
  );
  expectEqual(
    key,
    "identitySuccessJsonPath",
    app.identitySuccessJsonPath,
    expected.successJsonPath,
  );
  expectEqual(
    key,
    "identitySuccessJsonValue",
    app.identitySuccessJsonValue,
    expected.successJsonValue,
  );
}

function requestRevocation(key: string, app: PlatformOAuthAppProtocolConfig) {
  if (!app.revocation || app.revocation.mode !== "request") {
    fail(key, "must configure request-based revocation.");
  }
  return app.revocation as PlatformOAuthRequestRevocationConfig;
}

export function expectRequestRevocation(
  key: string,
  app: PlatformOAuthAppProtocolConfig,
  expected: Partial<PlatformOAuthRequestRevocationConfig> & { readonly endpoint: string },
) {
  const revocation = requestRevocation(key, app);
  expectUrl(key, "revocation.endpoint", revocation.endpoint, expected.endpoint);
  for (const [name, value] of Object.entries(expected)) {
    if (name === "endpoint" || name === "params") continue;
    expectEqual(
      key,
      `revocation.${name}`,
      revocation[name as keyof PlatformOAuthRequestRevocationConfig],
      value,
    );
  }
  expectParams(key, "revocation.params", revocation.params, expected.params ?? {});
}

export function expectBase(
  key: string,
  app: PlatformOAuthAppProtocolConfig,
  expected: {
    readonly authorizationEndpoint: string;
    readonly authorizationIncludesRedirectUri?: boolean;
    readonly authorizationIncludesResponseType?: boolean;
    readonly authorizationIncludesScope?: boolean;
    readonly clientAuthentication: PlatformOAuthAppProtocolConfig["clientAuthentication"];
    readonly pkce: boolean;
    readonly refreshTokenRequired?: boolean;
    readonly refreshTokenRotationRequired?: boolean;
    readonly scopeSeparator?: PlatformOAuthAppProtocolConfig["scopeSeparator"];
    readonly tokenEndpoint: string;
    readonly tokenIncludesGrantType?: boolean;
    readonly tokenIncludesRedirectUri?: boolean;
  },
) {
  expectUrl(
    key,
    "authorizationEndpoint",
    app.authorizationEndpoint,
    expected.authorizationEndpoint,
  );
  expectUrl(key, "tokenEndpoint", app.tokenEndpoint, expected.tokenEndpoint);
  expectEqual(key, "clientAuthentication", app.clientAuthentication, expected.clientAuthentication);
  expectEqual(
    key,
    "authorizationIncludesRedirectUri",
    app.authorizationIncludesRedirectUri,
    expected.authorizationIncludesRedirectUri ?? true,
  );
  expectEqual(
    key,
    "authorizationIncludesResponseType",
    app.authorizationIncludesResponseType,
    expected.authorizationIncludesResponseType ?? true,
  );
  expectEqual(
    key,
    "authorizationIncludesScope",
    app.authorizationIncludesScope,
    expected.authorizationIncludesScope ?? true,
  );
  expectEqual(key, "pkce", app.pkce, expected.pkce);
  expectEqual(
    key,
    "refreshTokenRequired",
    app.refreshTokenRequired,
    expected.refreshTokenRequired ?? false,
  );
  expectEqual(
    key,
    "refreshTokenRotationRequired",
    app.refreshTokenRotationRequired,
    expected.refreshTokenRotationRequired ?? false,
  );
  expectEqual(key, "scopeSeparator", app.scopeSeparator, expected.scopeSeparator ?? "space");
  expectEqual(
    key,
    "tokenIncludesGrantType",
    app.tokenIncludesGrantType,
    expected.tokenIncludesGrantType ?? true,
  );
  expectEqual(
    key,
    "tokenIncludesRedirectUri",
    app.tokenIncludesRedirectUri,
    expected.tokenIncludesRedirectUri ?? true,
  );
  const redirect = new URL(app.redirectUri);
  if (redirect.pathname !== `/public/provider-connections/oauth/callback/${key}`) {
    fail(key, `redirectUri must end at the canonical ${key} callback path.`);
  }
}
