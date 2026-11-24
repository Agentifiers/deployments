import {
  platformOAuthCanonicalResource,
  platformOAuthResponseTextAtPath,
  platformOAuthResponseValueAtPath,
  platformOAuthResourceAllowed,
  type PlatformOAuthAppConfig,
  type PlatformOAuthTokenBundle,
} from "@deployments-ai/providers";
import { readBoundedRawBody } from "@deployments-ai/net-security";

const MAX_OAUTH_IDENTITY_RESPONSE_BYTES = 256 * 1024;

async function boundedIdentityJson(response: Response): Promise<unknown> {
  const bytes = await readBoundedRawBody(response.body, {
    contentLengthHeader: response.headers.get("content-length"),
    maxBytes: MAX_OAUTH_IDENTITY_RESPONSE_BYTES,
  });
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new Error("OAuth identity response was not valid UTF-8.", { cause });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error("OAuth identity response was not valid JSON.", { cause });
  }
}

function formEncoded(value: string) {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}

function basicAuthorization(
  config: PlatformOAuthAppConfig,
  authentication: "client_secret_basic" | "secret_basic",
) {
  const username = authentication === "secret_basic" ? config.clientSecret! : config.clientId;
  const password = authentication === "secret_basic" ? "" : config.clientSecret!;
  return `Basic ${Buffer.from(`${formEncoded(username)}:${formEncoded(password)}`).toString("base64")}`;
}

function normalizedScopes(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].toSorted();
}

function authorizedAccountIds(value: unknown, config: PlatformOAuthAppConfig) {
  const resolved = config.tokenAuthorizedAccountIdsPath
    ? platformOAuthResponseValueAtPath(value, config.tokenAuthorizedAccountIdsPath)
    : undefined;
  return {
    ids: Array.isArray(resolved)
      ? normalizedScopes(
          resolved.flatMap((accountId) =>
            typeof accountId === "string"
              ? [accountId]
              : typeof accountId === "number" && Number.isFinite(accountId)
                ? [String(accountId)]
                : [],
          ),
        )
      : [],
    present: resolved !== undefined,
  };
}

export function validatedOAuthResource(value: string, config: PlatformOAuthAppConfig) {
  if (config.resourceMode === "canonical_uri") {
    try {
      return platformOAuthCanonicalResource(config, value);
    } catch (cause) {
      throw new Error("OAuth token resource is invalid or not allowed.", { cause });
    }
  }
  const resource = new URL(value);
  if (
    resource.protocol !== "https:" ||
    resource.username ||
    resource.password ||
    resource.search ||
    resource.hash ||
    (resource.pathname !== "/" && resource.pathname !== "") ||
    !platformOAuthResourceAllowed(config, resource.origin)
  ) {
    throw new Error("OAuth token resource is invalid or not allowed.");
  }
  return resource.origin;
}

export function resolveProviderRequestHeaderReferences(
  configured: Readonly<Record<string, Readonly<Record<string, string>>>>,
  credentialValues: Readonly<Record<string, string>>,
  clientIds?: { readonly configured: string; readonly persisted: string },
) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(configured).map(([provider, headers]) => [
        provider,
        Object.freeze(
          Object.fromEntries(
            Object.entries(headers).map(([header, reference]) => {
              const match = /^credential:([a-zA-Z][a-zA-Z0-9_.:-]{0,79})$/u.exec(reference);
              const value = match
                ? credentialValues[match[1]!]?.trim()
                : clientIds &&
                    (reference === "client-id" || reference.trim() === clientIds.configured)
                  ? clientIds.persisted.trim()
                  : undefined;
              if (!value) {
                throw new Error(
                  `OAuth provider request header ${provider}.${header} must reference an encrypted credential or the OAuth client ID.`,
                );
              }
              return [header, value] as const;
            }),
          ),
        ),
      ]),
    ),
  );
}

function identityScopes(value: unknown, config: PlatformOAuthAppConfig) {
  const resolved = platformOAuthResponseValueAtPath(value, config.identityScopesPath);
  if (typeof resolved === "string") {
    return normalizedScopes(
      resolved.split(config.identityScopeSeparator === "comma" ? "," : /\s+/u),
    );
  }
  if (!Array.isArray(resolved)) return [];
  if (!config.identityScopeItemNamePath) {
    return normalizedScopes(resolved.filter((scope): scope is string => typeof scope === "string"));
  }
  return normalizedScopes(
    resolved.flatMap((item) => {
      if (
        config.identityScopeItemStatusPath &&
        platformOAuthResponseValueAtPath(item, config.identityScopeItemStatusPath) !==
          config.identityScopeItemStatusValue
      ) {
        return [];
      }
      const scope = platformOAuthResponseTextAtPath(item, config.identityScopeItemNamePath);
      return scope ? [scope] : [];
    }),
  );
}

export function tokenWithConfiguredIdentity(
  config: PlatformOAuthAppConfig,
  response: unknown,
  token: PlatformOAuthTokenBundle,
  fallbackResource?: string,
  requireConfiguredIdentity = true,
): PlatformOAuthTokenBundle {
  const configuredAuthorizedAccounts = authorizedAccountIds(response, config);
  const providerIdentityId = config.tokenIdentityIdPaths
    .map((path) => platformOAuthResponseTextAtPath(response, path))
    .find(Boolean);
  if (requireConfiguredIdentity && config.tokenIdentityIdPaths.length > 0 && !providerIdentityId) {
    throw new Error("OAuth token response is missing the configured provider identity.");
  }
  if (
    requireConfiguredIdentity &&
    config.tokenAuthorizedAccountIdsPath &&
    configuredAuthorizedAccounts.ids.length === 0
  ) {
    throw new Error("OAuth token response is missing configured authorized accounts.");
  }
  const providerIdentityDisplayName = platformOAuthResponseTextAtPath(
    response,
    config.tokenIdentityDisplayNamePath,
  );
  const rawResource = platformOAuthResponseTextAtPath(response, config.tokenResourcePath);
  const resource = rawResource
    ? validatedOAuthResource(rawResource, config)
    : fallbackResource
      ? validatedOAuthResource(fallbackResource, config)
      : undefined;
  if (config.tokenResourcePath && !resource) {
    throw new Error("OAuth token response is missing the configured resource.");
  }
  return {
    ...token,
    ...(configuredAuthorizedAccounts.present
      ? { authorizedAccountIds: configuredAuthorizedAccounts.ids }
      : {}),
    ...(providerIdentityDisplayName ? { providerIdentityDisplayName } : {}),
    ...(providerIdentityId ? { providerIdentityId } : {}),
    ...(resource ? { resource } : {}),
  };
}

export async function resolveOAuthExternalIdentity(input: {
  readonly config: PlatformOAuthAppConfig;
  readonly fallbackId: string;
  readonly fallbackName: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly preferIdentityEndpoint?: boolean;
  readonly requestedExternalAccountId?: string;
  readonly token: PlatformOAuthTokenBundle;
}) {
  const useIdentityEndpoint =
    input.preferIdentityEndpoint === true &&
    input.config.identityEndpoint !== undefined &&
    input.config.identityIdPath !== undefined;
  if (!useIdentityEndpoint && input.token.providerIdentityId) {
    return {
      displayName: input.token.providerIdentityDisplayName ?? input.fallbackName,
      externalAccountId: input.token.providerIdentityId,
      scopes: input.token.scopes,
    };
  }
  if (!useIdentityEndpoint && input.token.authorizedAccountIds !== undefined) {
    if (input.token.authorizedAccountIds.length === 0) {
      throw new Error("OAuth provider did not authorize any external accounts.");
    }
    const requested = input.requestedExternalAccountId?.trim();
    if (requested && !input.token.authorizedAccountIds.includes(requested)) {
      throw new Error("OAuth provider did not authorize the requested external account.");
    }
    const externalAccountId = requested ?? input.token.authorizedAccountIds[0];
    if (!externalAccountId || (!requested && input.token.authorizedAccountIds.length !== 1)) {
      throw new Error("OAuth provider returned multiple accounts; requestedResource is required.");
    }
    return {
      displayName: `${input.fallbackName} ${externalAccountId}`,
      externalAccountId,
      scopes: input.token.scopes,
    };
  }
  if (!input.config.identityEndpoint || !input.config.identityIdPath) {
    return {
      displayName: input.fallbackName,
      externalAccountId: input.token.resource ?? input.fallbackId,
      scopes: input.token.scopes,
    };
  }

  const headers: Record<string, string> = {
    accept: "application/json",
    ...input.config.identityHeaders,
  };
  let body: string | undefined;
  if (input.config.identityCredentialPlacement === "bearer") {
    headers.authorization = `Bearer ${input.token.accessToken}`;
  } else {
    const values: Record<string, string> = {
      ...input.config.identityParams,
      [input.config.identityParameterName]: input.token.accessToken,
    };
    if (input.config.identityClientAuthentication === "client_secret_post") {
      values.client_id = input.config.clientId;
      values.client_secret = input.config.clientSecret!;
    } else if (
      input.config.identityClientAuthentication === "client_secret_basic" ||
      input.config.identityClientAuthentication === "secret_basic"
    ) {
      headers.authorization = basicAuthorization(
        input.config,
        input.config.identityClientAuthentication,
      );
    }
    headers["content-type"] =
      input.config.identityBodyFormat === "json"
        ? "application/json"
        : "application/x-www-form-urlencoded";
    body =
      input.config.identityBodyFormat === "json"
        ? JSON.stringify(values)
        : new URLSearchParams(values).toString();
  }

  const response = await (input.fetch ?? globalThis.fetch)(input.config.identityEndpoint, {
    ...(body === undefined ? {} : { body }),
    headers,
    method: input.config.identityMethod,
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`OAuth identity endpoint returned HTTP ${response.status}.`);
  }
  const decoded = await boundedIdentityJson(response);
  if (
    input.config.identitySuccessJsonPath &&
    platformOAuthResponseValueAtPath(decoded, input.config.identitySuccessJsonPath) !==
      input.config.identitySuccessJsonValue
  ) {
    throw new Error("OAuth identity endpoint did not acknowledge the request.");
  }
  const externalAccountId = platformOAuthResponseTextAtPath(decoded, input.config.identityIdPath);
  if (!externalAccountId) throw new Error("OAuth provider identity is missing an account id.");
  const scopes = identityScopes(decoded, input.config);
  if (input.config.identityScopesRequired && scopes.length === 0) {
    throw new Error("OAuth provider identity is missing granted scopes.");
  }
  return {
    displayName:
      platformOAuthResponseTextAtPath(decoded, input.config.identityDisplayNamePath) ??
      input.fallbackName,
    externalAccountId,
    scopes: scopes.length > 0 ? scopes : input.token.scopes,
  };
}

export async function resolveOAuthRefreshIdentity(input: {
  readonly config: PlatformOAuthAppConfig;
  readonly externalAccountId?: string;
  readonly fallbackId: string;
  readonly fallbackName: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly token: PlatformOAuthTokenBundle;
}) {
  const expectedExternalAccountId = input.externalAccountId?.trim();
  if (expectedExternalAccountId) {
    assertOAuthRefreshIdentity(input.token, expectedExternalAccountId);
  }
  const identity = await resolveOAuthExternalIdentity({
    config: input.config,
    fallbackId: expectedExternalAccountId ?? input.fallbackId,
    fallbackName: input.fallbackName,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(expectedExternalAccountId ? { requestedExternalAccountId: expectedExternalAccountId } : {}),
    preferIdentityEndpoint: true,
    token: input.token,
  });
  if (
    expectedExternalAccountId &&
    identity.externalAccountId.trim() !== expectedExternalAccountId
  ) {
    throw new Error("OAuth refresh returned a different provider account identity.");
  }
  return identity;
}

export function oauthRefreshScopes(
  refreshedScopes: readonly string[],
  currentScopes: readonly string[] | undefined,
  connectionScopes: readonly string[],
) {
  return refreshedScopes.length > 0
    ? normalizedScopes(refreshedScopes)
    : normalizedScopes(currentScopes ?? connectionScopes);
}

export function assertOAuthRefreshIdentity(
  token: PlatformOAuthTokenBundle,
  externalAccountId: string,
): void {
  const expected = externalAccountId.trim();
  if (!expected) throw new Error("OAuth connection is missing its external account identity.");
  if (token.providerIdentityId && token.providerIdentityId.trim() !== expected) {
    throw new Error("OAuth refresh returned a different provider account identity.");
  }
  if (
    token.authorizedAccountIds !== undefined &&
    !token.authorizedAccountIds.some((accountId) => accountId.trim() === expected)
  ) {
    throw new Error("OAuth refresh no longer authorizes the connected provider account.");
  }
}
