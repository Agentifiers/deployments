import { normalizeProviderDefinitionKey } from "./provider-definitions.ts";
import type {
  PlatformOAuthClientAuthentication,
  PlatformOAuthRevocationCredential,
  PlatformOAuthRevocationConfig,
} from "./platform-oauth-types.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function platformOAuthResponseValueAtPath(
  value: unknown,
  path: string | undefined,
): unknown {
  if (!path?.trim()) return undefined;
  let current = value;
  for (const segment of path.split(".")) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) return undefined;
      current = current[Number(segment)];
      continue;
    }
    if (!current || typeof current !== "object" || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function platformOAuthResponseTextAtPath(
  value: unknown,
  path: string | undefined,
): string | undefined {
  const resolved = platformOAuthResponseValueAtPath(value, path);
  if (typeof resolved === "string" && resolved.trim()) return resolved.trim();
  if (typeof resolved === "number" && Number.isFinite(resolved)) return String(resolved);
  return undefined;
}

export function requiredText(value: unknown, label: string, maxLength = 8_192): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${label} is too long.`);
  return normalized;
}

export function optionalText(value: unknown, label: string, maxLength = 8_192): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredText(value, label, maxLength);
}

export function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

export function optionalTextArray(value: unknown, label: string): readonly string[] {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return Object.freeze(value.map((entry, index) => requiredText(entry, `${label}[${index}]`, 256)));
}

export function oauthKey(value: unknown, label: string): string {
  const normalized = requiredText(value, label, 64).toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(normalized)) {
    throw new Error(`${label} must be lowercase kebab-case.`);
  }
  return normalized;
}

export function secureUrl(value: unknown, label: string): string {
  const normalized = requiredText(value, label);
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`${label} must be an absolute URL.`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error(`${label} must use HTTPS.`);
  }
  if (url.username || url.password || url.hash) throw new Error(`${label} is invalid.`);
  return url.toString();
}

export function stringRecord(value: unknown, label: string): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  const entries = Object.entries(value).map(
    ([key, entry]) =>
      [
        requiredText(key, `${label} key`, 128),
        requiredText(entry, `${label}.${key}`, 2_048),
      ] as const,
  );
  return Object.freeze(Object.fromEntries(entries));
}

export function stringArrayRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, readonly string[]>> {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, entries]) => [
        requiredText(key, `${label} key`, 256),
        optionalTextArray(entries, `${label}.${key}`),
      ]),
    ),
  );
}

export function safeHeaderName(value: unknown, label: string): string | undefined {
  const name = optionalText(value, label, 128)?.toLowerCase();
  if (!name) return undefined;
  const forbidden = new Set([
    "authorization",
    "content-length",
    "content-type",
    "cookie",
    "host",
    "proxy-authorization",
  ]);
  if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(name) || forbidden.has(name)) {
    throw new Error(`${label} is not an allowed credential header.`);
  }
  return name;
}

export function safeIdentityHeaders(
  value: unknown,
  label: string,
): Readonly<Record<string, string>> {
  const headers = stringRecord(value, label);
  const forbidden = new Set([
    "authorization",
    "content-length",
    "cookie",
    "host",
    "proxy-authorization",
  ]);
  const entries = Object.entries(headers).map(([name, headerValue]) => {
    const normalizedName = name.trim().toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(normalizedName) || forbidden.has(normalizedName)) {
      throw new Error(`${label}.${name} is not an allowed identity header.`);
    }
    return [normalizedName, headerValue] as const;
  });
  return Object.freeze(Object.fromEntries(entries));
}

export function safeProviderRequestHeaderValues(
  value: unknown,
  label: string,
): Readonly<Record<string, string>> {
  const headers = stringRecord(value, label);
  const forbidden = new Set([
    "authorization",
    "content-length",
    "content-type",
    "cookie",
    "host",
    "idempotency-key",
    "proxy-authorization",
    "user-agent",
    "x-http-method",
    "x-http-method-override",
    "x-method-override",
  ]);
  const entries = Object.entries(headers).map(([name, headerValue]) => {
    const normalizedName = name.trim().toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(normalizedName) || forbidden.has(normalizedName)) {
      throw new Error(`${label}.${name} is not an allowed provider request header.`);
    }
    return [normalizedName, headerValue] as const;
  });
  return Object.freeze(Object.fromEntries(entries));
}

export function providerRequestHeaders(
  value: unknown,
  label: string,
): Readonly<Record<string, Readonly<Record<string, string>>>> {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([provider, headers]) => {
        const providerKey = normalizeProviderDefinitionKey(provider);
        return [
          providerKey,
          safeProviderRequestHeaderValues(headers, `${label}.${providerKey}`),
        ] as const;
      }),
    ),
  );
}

export function jsonExpectation(
  input: Record<string, unknown>,
  pathKey: string,
  valueKey: string,
  label: string,
): {
  readonly path?: string;
  readonly value?: boolean | number | string;
} {
  const path = optionalText(input[pathKey], `${label} ${pathKey}`, 256);
  const hasValue = Object.hasOwn(input, valueKey);
  const value = input[valueKey];
  if (
    hasValue &&
    typeof value !== "boolean" &&
    typeof value !== "number" &&
    typeof value !== "string"
  ) {
    throw new Error(`${label} ${valueKey} is invalid.`);
  }
  if (Boolean(path) !== hasValue) {
    throw new Error(`${label} ${pathKey} and ${valueKey} must be configured together.`);
  }
  return path && hasValue ? { path, value: value as boolean | number | string } : {};
}

export function secureOrigins(value: unknown, label: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const origins = value.map((entry, index) => {
    const url = new URL(secureUrl(entry, `${label}[${index}]`));
    if (url.search || (url.pathname !== "/" && url.pathname !== "")) {
      throw new Error(`${label}[${index}] must be an HTTPS origin.`);
    }
    return url.origin;
  });
  return Object.freeze([...new Set(origins)].toSorted());
}

export function clientAuthentication(
  value: unknown,
  label: string,
  fallback?: PlatformOAuthClientAuthentication,
): PlatformOAuthClientAuthentication {
  const resolved = value ?? fallback ?? "client_secret_basic";
  if (
    resolved !== "client_secret_basic" &&
    resolved !== "secret_basic" &&
    resolved !== "client_secret_post" &&
    resolved !== "none"
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return resolved;
}

export function revocationConfig(
  value: unknown,
  key: string,
  defaultClientAuthentication: PlatformOAuthClientAuthentication,
): PlatformOAuthRevocationConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`OAuth app ${key} revocation must be an object.`);
  const mode = value.mode ?? "request";
  if (mode === "provider_event") {
    const impact = value.impact;
    if (impact !== "token" && impact !== "shared_grant") {
      throw new Error(`OAuth app ${key} revocation impact is invalid.`);
    }
    if ("eventSecret" in value) {
      throw new Error(
        `OAuth app ${key} revocation must not configure eventSecret; secrets belong on the provider application credential.`,
      );
    }
    return Object.freeze({
      eventType: requiredText(value.eventType, `OAuth app ${key} revocation eventType`, 256),
      impact,
      mode,
    });
  }
  if (mode !== "request") throw new Error(`OAuth app ${key} revocation mode is invalid.`);
  const method = value.method ?? "POST";
  if (method !== "POST" && method !== "DELETE") {
    throw new Error(`OAuth app ${key} revocation method is invalid.`);
  }
  const bodyFormat = value.bodyFormat ?? "form";
  if (bodyFormat !== "form" && bodyFormat !== "json") {
    throw new Error(`OAuth app ${key} revocation bodyFormat is invalid.`);
  }
  const credential = value.credential;
  if (
    credential !== "access_token" &&
    credential !== "refresh_token" &&
    credential !== "external_account_id"
  ) {
    throw new Error(`OAuth app ${key} revocation credential is invalid.`);
  }
  const additionalCredentials = optionalTextArray(
    value.additionalCredentials,
    `OAuth app ${key} revocation additionalCredentials`,
  );
  for (const additionalCredential of additionalCredentials) {
    if (
      additionalCredential !== "access_token" &&
      additionalCredential !== "refresh_token" &&
      additionalCredential !== "external_account_id"
    ) {
      throw new Error(`OAuth app ${key} revocation additional credential is invalid.`);
    }
  }
  if (new Set([credential, ...additionalCredentials]).size !== additionalCredentials.length + 1) {
    throw new Error(`OAuth app ${key} revocation credentials must be unique.`);
  }
  const impact = value.impact;
  if (impact !== "token" && impact !== "shared_grant") {
    throw new Error(`OAuth app ${key} revocation impact is invalid.`);
  }
  const credentialPlacement = value.credentialPlacement ?? "body";
  if (credentialPlacement !== "body" && credentialPlacement !== "bearer") {
    throw new Error(`OAuth app ${key} revocation credentialPlacement is invalid.`);
  }
  if (
    credentialPlacement === "bearer" &&
    value.clientAuthentication !== undefined &&
    value.clientAuthentication !== "none"
  ) {
    throw new Error(`OAuth app ${key} bearer revocation cannot use client authentication.`);
  }
  const success = jsonExpectation(
    value,
    "successJsonPath",
    "successJsonValue",
    `OAuth app ${key} revocation`,
  );
  const alreadyRevokedJsonPath = optionalText(
    value.alreadyRevokedJsonPath,
    `OAuth app ${key} revocation alreadyRevokedJsonPath`,
    256,
  );
  const alreadyRevokedJsonValues = optionalTextArray(
    value.alreadyRevokedJsonValues,
    `OAuth app ${key} revocation alreadyRevokedJsonValues`,
  );
  if (Boolean(alreadyRevokedJsonPath) !== alreadyRevokedJsonValues.length > 0) {
    throw new Error(
      `OAuth app ${key} revocation alreadyRevokedJsonPath and alreadyRevokedJsonValues must be configured together.`,
    );
  }
  const credentialHeaderName = safeHeaderName(
    value.credentialHeaderName,
    `OAuth app ${key} revocation credentialHeaderName`,
  );
  return Object.freeze({
    additionalCredentials: Object.freeze(
      additionalCredentials as PlatformOAuthRevocationCredential[],
    ),
    alreadyRevokedJsonValues,
    ...(alreadyRevokedJsonPath ? { alreadyRevokedJsonPath } : {}),
    bodyFormat,
    clientIdParameterName: requiredText(
      value.clientIdParameterName ?? "client_id",
      `OAuth app ${key} revocation clientIdParameterName`,
      128,
    ),
    clientAuthentication: clientAuthentication(
      value.clientAuthentication,
      `OAuth app ${key} revocation clientAuthentication`,
      defaultClientAuthentication,
    ),
    clientSecretParameterName: requiredText(
      value.clientSecretParameterName ?? "client_secret",
      `OAuth app ${key} revocation clientSecretParameterName`,
      128,
    ),
    credential,
    ...(credentialHeaderName ? { credentialHeaderName } : {}),
    credentialPlacement,
    endpoint: secureUrl(value.endpoint, `OAuth app ${key} revocation endpoint`),
    endpointFromResource: value.endpointFromResource === true,
    impact,
    includeClientId: value.includeClientId === true,
    method,
    mode,
    parameterName: requiredText(
      value.parameterName ?? "token",
      `OAuth app ${key} revocation parameterName`,
      128,
    ),
    params: stringRecord(value.params, `OAuth app ${key} revocation params`),
    ...(optionalText(
      value.tokenTypeHintParameterName,
      `OAuth app ${key} revocation tokenTypeHintParameterName`,
      128,
    )
      ? {
          tokenTypeHintParameterName: optionalText(
            value.tokenTypeHintParameterName,
            `OAuth app ${key} revocation tokenTypeHintParameterName`,
            128,
          )!,
        }
      : {}),
    ...(success.path === undefined
      ? {}
      : { successJsonPath: success.path, successJsonValue: success.value! }),
  });
}
