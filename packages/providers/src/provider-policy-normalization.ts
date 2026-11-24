import type {
  ProviderHostPolicyInput,
  ProviderHostPolicy,
  ProviderVerificationProbeInput,
  ProviderVerificationProbe,
  ProviderRateLimitPolicyInput,
  ProviderRateLimitPolicy,
  ProviderRetryPolicyInput,
  ProviderRetryPolicy,
  ProviderResourceMetadataInput,
  ProviderResourceMetadata,
  ProviderEffectMetadataInput,
  ProviderEffectMetadata,
  ProviderAuditMetadataInput,
  ProviderAuditMetadata,
  ProviderConformanceMetadataInput,
  ProviderConformanceMetadata,
  ProviderAuthDefinition,
  ProviderOriginPolicyInput,
  ProviderOriginPolicy,
  ProviderVerificationDefinitionInput,
  ProviderVerificationDefinition,
} from "./provider-definition-types.ts";
import {
  PROVIDER_VERIFICATION_METHODS,
  PROVIDER_PROBE_HTTP_METHODS,
  PROVIDER_HOST_POLICY_MODES,
  AUTH_FIELD_KEY_PATTERN,
  DEFAULT_RETRY_AFTER_HEADER,
  DEFAULT_RETRYABLE_STATUS_CODES,
} from "./provider-definition-types.ts";
import {
  freezeDeepArray,
  isPlainRecord,
  requireNonEmptyText,
  isProviderVerificationMethod,
  isProviderProbeHttpMethod,
  isProviderHostPolicyMode,
  isProviderToolEffect,
  normalizeMetadataTextList,
  normalizePositiveInteger,
  normalizeProviderApiHost,
  normalizeProviderApiHosts,
  normalizeProviderDefaultScopes,
  normalizeOptionalDescription,
  normalizeHttpsOrigin,
} from "./provider-key-schema-normalization.ts";

export function normalizeProviderOriginPolicy(
  input: ProviderOriginPolicyInput | undefined,
  auth: ProviderAuthDefinition,
): ProviderOriginPolicy | undefined {
  if (!input) return undefined;

  const fieldKey = requireNonEmptyText(input.fieldKey, "Origin policy field key", 64);
  const field = auth.fields.find((entry) => entry.key === fieldKey);
  if (!field) {
    throw new Error(`Origin policy fieldKey ${fieldKey} is not declared in auth fields.`);
  }
  if (field.sensitive) {
    throw new Error(`Origin policy fieldKey ${fieldKey} must reference a non-sensitive field.`);
  }
  if (input.requireHttps === false) {
    throw new Error("Origin policy must require HTTPS.");
  }

  if (field.defaultValue !== undefined) {
    normalizeHttpsOrigin(field.defaultValue, `Auth field ${fieldKey} defaultValue`);
  }

  return Object.freeze({
    fieldKey,
    hostMatch: input.hostMatch ?? "suffix",
    requireHttps: true as const,
    immutableAfterVerification: true as const,
  });
}

export function normalizeProbePath(value: string): string {
  const path = requireNonEmptyText(value, "Verification probe path", 1024);
  if (!path.startsWith("/")) {
    throw new Error("Verification probe path must start with '/'.");
  }
  if (path.includes("://") || path.includes("#") || path.split("/").includes("..")) {
    throw new Error("Verification probe path must not contain a URL, fragment, or dot segment.");
  }
  return path;
}

export function normalizeProbeIdentityIdPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const path = requireNonEmptyText(value, "Verification probe identityIdPath", 256);
  const segments = path.split(".");
  if (
    segments.length > 16 ||
    segments.some(
      (segment) =>
        !/^(?:[a-zA-Z_][a-zA-Z0-9_-]*|0|[1-9]\d*)$/u.test(segment) ||
        ["__proto__", "constructor", "prototype"].includes(segment),
    )
  ) {
    throw new Error("Verification probe identityIdPath is invalid.");
  }
  return path;
}

export function providerHostMatches(candidate: string, allowedHost: string): boolean {
  return candidate === allowedHost || candidate.endsWith(`.${allowedHost}`);
}

export function normalizeProviderVerificationProbe(
  input: ProviderVerificationProbeInput | undefined,
  apiHosts: readonly string[] = [],
): ProviderVerificationProbe | undefined {
  if (input === undefined) return undefined;
  if (!isPlainRecord(input)) throw new Error("Verification probe must be an object.");

  const methodRaw = input.method ?? "GET";
  if (!isProviderProbeHttpMethod(methodRaw)) {
    throw new Error(
      `Unsupported verification probe method: ${methodRaw}. Allowed values are ${PROVIDER_PROBE_HTTP_METHODS.join(", ")}.`,
    );
  }
  const path = normalizeProbePath(input.path);
  const pathFieldKeys = normalizeMetadataTextList(
    input.pathFieldKeys,
    "Verification probe path field key",
  );
  for (const fieldKey of pathFieldKeys) {
    if (!AUTH_FIELD_KEY_PATTERN.test(fieldKey)) {
      throw new Error(`Verification probe path field key ${fieldKey} is invalid.`);
    }
  }
  const pathPlaceholders = [
    ...new Set([...path.matchAll(/\{([a-z][a-zA-Z0-9_]{0,63})\}/gu)].map((match) => match[1]!)),
  ].toSorted();
  if (JSON.stringify(pathPlaceholders) !== JSON.stringify(pathFieldKeys)) {
    throw new Error("Verification probe path placeholders must exactly match pathFieldKeys.");
  }
  const host = input.host === undefined ? undefined : normalizeProviderApiHost(input.host);
  const identityIdPath = normalizeProbeIdentityIdPath(input.identityIdPath);
  if (
    host &&
    apiHosts.length > 0 &&
    !apiHosts.some((allowed) => providerHostMatches(host, allowed))
  ) {
    throw new Error(`Verification probe host ${host} is not covered by apiHosts.`);
  }

  const expectedStatusCodes = input.expectedStatusCodes ?? [200];
  if (expectedStatusCodes.length === 0 || expectedStatusCodes.length > 32) {
    throw new Error("Verification probe expectedStatusCodes must contain 1 to 32 values.");
  }
  const normalizedStatuses = [...new Set(expectedStatusCodes)].map((status) => {
    if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
      throw new Error("Verification probe status codes must be integers from 100 through 599.");
    }
    return status;
  });
  const timeoutMs = input.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new Error("Verification probe timeoutMs must be between 100 and 120000.");
  }
  if (input.body !== undefined && typeof input.body !== "string") {
    throw new Error("Verification probe body must be a string.");
  }
  const body = input.body?.trim() || undefined;
  if (body && !["POST", "PUT", "PATCH"].includes(methodRaw)) {
    throw new Error("Verification probe body requires POST, PUT, or PATCH.");
  }
  if (body && new TextEncoder().encode(body).byteLength > 16_384) {
    throw new Error("Verification probe body must not exceed 16384 bytes.");
  }

  if (input.headers !== undefined && !isPlainRecord(input.headers)) {
    throw new Error("Verification probe headers must be an object.");
  }
  const seenHeaderNames = new Set<string>();
  const headers = Object.fromEntries(
    Object.entries(input.headers ?? {}).map(([rawName, rawValue]) => {
      const name = rawName.toLowerCase();
      if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(name)) {
        throw new Error(`Verification probe header name ${rawName} is invalid.`);
      }
      if (
        [
          "authorization",
          "connection",
          "content-length",
          "cookie",
          "host",
          "proxy-authorization",
          "transfer-encoding",
          "upgrade",
          "user-agent",
        ].includes(name)
      ) {
        throw new Error(`Verification probe header ${name} is reserved.`);
      }
      if (seenHeaderNames.has(name)) {
        throw new Error(`Verification probe header ${name} is duplicated.`);
      }
      seenHeaderNames.add(name);
      if (
        typeof rawValue !== "string" ||
        !rawValue ||
        rawValue.length > 1_024 ||
        /[\r\n]/u.test(rawValue)
      ) {
        throw new Error(`Verification probe header ${name} has an invalid value.`);
      }
      return [name, rawValue] as const;
    }),
  );
  if (Object.keys(headers).length > 16) {
    throw new Error("Verification probe may declare at most 16 headers.");
  }

  return Object.freeze({
    ...(body ? { body } : {}),
    expectedStatusCodes: freezeDeepArray(
      normalizedStatuses.toSorted((left, right) => left - right),
    ),
    headers: Object.freeze(headers),
    ...(host ? { host } : {}),
    ...(identityIdPath ? { identityIdPath } : {}),
    method: methodRaw,
    path,
    pathFieldKeys,
    requiredScopes: normalizeProviderDefaultScopes(input.requiredScopes),
    timeoutMs,
  });
}

export function normalizeProviderHostPolicy(
  input: ProviderHostPolicyInput | undefined,
  apiHosts: readonly string[],
  originPolicy: ProviderOriginPolicy | undefined,
): ProviderHostPolicy {
  const modeRaw =
    input?.mode ?? (originPolicy && apiHosts.length === 0 ? "verified_origin" : "allowlist");
  if (!isProviderHostPolicyMode(modeRaw)) {
    throw new Error(
      `Unsupported host policy mode: ${modeRaw}. Allowed values are ${PROVIDER_HOST_POLICY_MODES.join(", ")}.`,
    );
  }
  if (input?.requireHttps === false) {
    throw new Error("Provider host policy must require HTTPS.");
  }

  const declaredHosts =
    input?.hosts === undefined ? apiHosts : normalizeProviderApiHosts(input.hosts);
  if (modeRaw === "verified_origin") {
    if (!originPolicy) {
      throw new Error("verified_origin host policy requires originPolicy.");
    }
    if (declaredHosts.length > 0) {
      throw new Error("verified_origin host policy cannot declare fixed API hosts.");
    }
  } else if (
    input?.hosts !== undefined &&
    canonicalHostList(declaredHosts) !== canonicalHostList(apiHosts)
  ) {
    throw new Error("Host policy hosts must match apiHosts when both are declared.");
  }

  return Object.freeze({
    hosts: freezeDeepArray(declaredHosts),
    mode: modeRaw,
    requireHttps: true as const,
  });
}

export function canonicalHostList(hosts: readonly string[]): string {
  return JSON.stringify([...hosts].toSorted());
}

export function normalizeProviderRateLimitPolicy(
  input: ProviderRateLimitPolicyInput | undefined,
): ProviderRateLimitPolicy | undefined {
  if (input === undefined) return undefined;
  const maxRequestsPerWindow = normalizePositiveInteger(
    input.maxRequestsPerWindow,
    "maxRequestsPerWindow",
    1_000_000,
  );
  const windowMs = normalizePositiveInteger(input.windowMs, "windowMs", 86_400_000);
  const maxConcurrentRequests =
    input.maxConcurrentRequests === undefined
      ? undefined
      : normalizePositiveInteger(input.maxConcurrentRequests, "maxConcurrentRequests", 100_000);
  const retryAfterHeader = input.retryAfterHeader ?? DEFAULT_RETRY_AFTER_HEADER;
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(retryAfterHeader)) {
    throw new Error("retryAfterHeader must be a lowercase HTTP header name.");
  }
  return Object.freeze({
    maxRequestsPerWindow,
    ...(maxConcurrentRequests !== undefined ? { maxConcurrentRequests } : {}),
    retryAfterHeader,
    windowMs,
  });
}

export function normalizeProviderRetryPolicy(
  input: ProviderRetryPolicyInput | undefined,
): ProviderRetryPolicy | undefined {
  if (input === undefined) return undefined;
  const maxAttempts = input.maxAttempts ?? 3;
  const baseDelayMs = input.baseDelayMs ?? 250;
  const maxDelayMs = input.maxDelayMs ?? 10_000;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error("maxAttempts must be between 1 and 10.");
  }
  if (!Number.isSafeInteger(baseDelayMs) || baseDelayMs < 0 || baseDelayMs > 60_000) {
    throw new Error("baseDelayMs must be between 0 and 60000.");
  }
  if (!Number.isSafeInteger(maxDelayMs) || maxDelayMs < baseDelayMs || maxDelayMs > 300_000) {
    throw new Error("maxDelayMs must be at least baseDelayMs and no greater than 300000.");
  }
  const retryableStatusCodes = input.retryableStatusCodes
    ? [...new Set(input.retryableStatusCodes)].map((status) => {
        if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
          throw new Error("Retryable status codes must be integers from 100 through 599.");
        }
        return status;
      })
    : DEFAULT_RETRYABLE_STATUS_CODES;
  return Object.freeze({
    baseDelayMs,
    maxAttempts,
    maxDelayMs,
    respectRetryAfter: input.respectRetryAfter !== false,
    retryableStatusCodes: freezeDeepArray(
      retryableStatusCodes.toSorted((left, right) => left - right),
    ),
  });
}

export function normalizeProviderResourceMetadata(
  input: ProviderResourceMetadataInput | undefined,
): ProviderResourceMetadata | undefined {
  if (input === undefined) return undefined;
  return Object.freeze({
    authorizationRequired: input.authorizationRequired !== false,
    resourceTypes: normalizeMetadataTextList(input.resourceTypes, "Resource type"),
    selectorKeys: normalizeMetadataTextList(input.selectorKeys, "Resource selector key"),
  });
}

export function normalizeProviderEffectMetadata(
  input: ProviderEffectMetadataInput | undefined,
): ProviderEffectMetadata | undefined {
  if (input === undefined) return undefined;
  const allowedEffects = normalizeMetadataTextList(input.allowedEffects, "Allowed effect").map(
    (effect) => {
      if (!isProviderToolEffect(effect)) throw new Error(`Unsupported provider effect: ${effect}.`);
      return effect;
    },
  );
  const defaultWritePolicy = input.defaultWritePolicy ?? "require_approval";
  if (!("allow,deny,require_approval" as string).split(",").includes(defaultWritePolicy)) {
    throw new Error("defaultWritePolicy must be allow, deny, or require_approval.");
  }
  return Object.freeze({
    allowedEffects: freezeDeepArray(allowedEffects),
    defaultWritePolicy: defaultWritePolicy as ProviderEffectMetadata["defaultWritePolicy"],
    outboundMutation: input.outboundMutation === true,
  });
}

export function normalizeProviderAuditMetadata(
  input: ProviderAuditMetadataInput | undefined,
): ProviderAuditMetadata | undefined {
  if (input === undefined) return undefined;
  const retentionClass = normalizeOptionalDescription(input.retentionClass, "Retention class");
  return Object.freeze({
    dataClasses: normalizeMetadataTextList(input.dataClasses, "Data class"),
    redactedFieldKeys: normalizeMetadataTextList(input.redactedFieldKeys, "Redacted field key"),
    ...(retentionClass ? { retentionClass } : {}),
  });
}

export function normalizeProviderConformanceMetadata(
  input: ProviderConformanceMetadataInput | undefined,
): ProviderConformanceMetadata | undefined {
  if (input === undefined) return undefined;
  const schemaVersion = input.schemaVersion ?? 1;
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    throw new Error("Conformance metadata schemaVersion must be a positive integer.");
  }
  return Object.freeze({
    requiredChecks: normalizeMetadataTextList(input.requiredChecks, "Conformance check"),
    schemaVersion,
    secretRedactionRequired: input.secretRedactionRequired !== false,
  });
}

export function normalizeProviderVerificationDefinition(
  input: ProviderVerificationDefinitionInput,
  apiHosts: readonly string[] = [],
): ProviderVerificationDefinition {
  if (typeof input.required !== "boolean") {
    throw new Error("Verification required flag must be a boolean.");
  }
  const methodRaw = input.method ?? (input.required ? "api_probe" : "none");
  if (!isProviderVerificationMethod(methodRaw)) {
    throw new Error(
      `Unsupported verification method: ${methodRaw}. Allowed values are ${PROVIDER_VERIFICATION_METHODS.join(", ")}.`,
    );
  }
  if (!input.required && methodRaw !== "none" && methodRaw !== "manual") {
    throw new Error("Optional verification may only use method none or manual.");
  }
  if (input.probe !== undefined && methodRaw === "none") {
    throw new Error("Verification probe requires a verification method.");
  }
  const description = normalizeOptionalDescription(input.description, "Verification description");
  const probe = normalizeProviderVerificationProbe(input.probe, apiHosts);

  return Object.freeze({
    required: input.required,
    method: methodRaw,
    ...(probe ? { probe } : {}),
    ...(description ? { description } : {}),
  });
}
