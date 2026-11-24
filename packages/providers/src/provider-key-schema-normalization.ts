import type {
  ProviderRoute,
  TokenBearingProviderRoute,
  NonTokenProviderRoute,
  ProviderCredentialKind,
  ProviderDefinitionStatus,
  ProviderAuthFieldDisplayFormat,
  ProviderVerificationMethod,
  ProviderProbeHttpMethod,
  ProviderHostPolicyMode,
  ProviderToolEffect,
  ProviderInputSchemaPropertyInput,
  ProviderInputSchemaProperty,
  ProviderInputSchemaInput,
  ProviderInputSchema,
} from "./provider-definition-types.ts";
import {
  PROVIDER_ROUTES,
  TOKEN_BEARING_PROVIDER_ROUTES,
  NON_TOKEN_PROVIDER_ROUTES,
  PROVIDER_CREDENTIAL_KINDS,
  PROVIDER_DEFINITION_STATUSES,
  PROVIDER_AUTH_FIELD_DISPLAY_FORMATS,
  PROVIDER_VERIFICATION_METHODS,
  PROVIDER_PROBE_HTTP_METHODS,
  PROVIDER_HOST_POLICY_MODES,
  PROVIDER_TOOL_EFFECTS,
  PROVIDER_INPUT_SCHEMA_TYPES,
  PROVIDER_KEY_PATTERN,
  OAUTH_PROVIDER_KEY_PATTERN,
  TOOL_NAME_PATTERN,
  API_HOST_PATTERN,
  MAX_PROVIDER_KEY_LENGTH,
  MAX_API_HOST_COUNT,
  MAX_SCOPE_COUNT,
  MAX_TOOL_COUNT,
  MAX_HOST_LENGTH,
  MAX_SCHEMA_DEPTH,
} from "./provider-definition-types.ts";

export function freezeDeepArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function requireNonEmptyText(value: string, label: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${label} is too long.`);
  }
  return trimmed;
}

export function isProviderRoute(value: string): value is ProviderRoute {
  return (PROVIDER_ROUTES as readonly string[]).includes(value);
}

export function isTokenBearingProviderRoute(
  route: ProviderRoute,
): route is TokenBearingProviderRoute {
  return (TOKEN_BEARING_PROVIDER_ROUTES as readonly ProviderRoute[]).includes(route);
}

export function isNonTokenProviderRoute(route: ProviderRoute): route is NonTokenProviderRoute {
  return (NON_TOKEN_PROVIDER_ROUTES as readonly ProviderRoute[]).includes(route);
}

export function isPlatformOAuthProviderRoute(route: ProviderRoute): route is "platform_oauth" {
  return route === "platform_oauth";
}

export function isProviderCredentialKind(value: string): value is ProviderCredentialKind {
  return (PROVIDER_CREDENTIAL_KINDS as readonly string[]).includes(value);
}

export function isProviderDefinitionStatus(value: string): value is ProviderDefinitionStatus {
  return (PROVIDER_DEFINITION_STATUSES as readonly string[]).includes(value);
}

export function isAuthFieldDisplayFormat(value: string): value is ProviderAuthFieldDisplayFormat {
  return (PROVIDER_AUTH_FIELD_DISPLAY_FORMATS as readonly string[]).includes(value);
}

export function isProviderVerificationMethod(value: string): value is ProviderVerificationMethod {
  return (PROVIDER_VERIFICATION_METHODS as readonly string[]).includes(value);
}

export function isProviderProbeHttpMethod(value: string): value is ProviderProbeHttpMethod {
  return (PROVIDER_PROBE_HTTP_METHODS as readonly string[]).includes(value);
}

export function isProviderHostPolicyMode(value: string): value is ProviderHostPolicyMode {
  return (PROVIDER_HOST_POLICY_MODES as readonly string[]).includes(value);
}

export function isProviderToolEffect(value: string): value is ProviderToolEffect {
  return (PROVIDER_TOOL_EFFECTS as readonly string[]).includes(value);
}

export function normalizeMetadataTextList(
  values: readonly string[] | undefined,
  label: string,
): readonly string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const text = requireNonEmptyText(value, label, 128);
    if (seen.has(text)) continue;
    seen.add(text);
    normalized.push(text);
  }
  return freezeDeepArray(normalized.toSorted((left, right) => left.localeCompare(right)));
}

export function normalizePositiveInteger(value: number, label: string, max: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error(`${label} must be a positive integer no greater than ${max}.`);
  }
  return value;
}

/**
 * Canonical provider keys and aliases: lowercase snake_case identifiers only.
 * Rejects empty, mixed-case, punctuation, path/URL-like, and otherwise ambiguous forms.
 */
export function normalizeProviderDefinitionKey(value: string, label = "Provider key"): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  if (value !== value.trim()) {
    throw new Error(`${label} must not contain leading or trailing whitespace.`);
  }
  const trimmed = requireNonEmptyText(value, label, MAX_PROVIDER_KEY_LENGTH);
  if (trimmed !== trimmed.toLowerCase()) {
    throw new Error(`${label} must be lowercase.`);
  }
  if (!PROVIDER_KEY_PATTERN.test(trimmed)) {
    throw new Error(
      `${label} must be a lowercase snake_case identifier (letters, digits, single underscores).`,
    );
  }
  if (trimmed.includes("__")) {
    throw new Error(`${label} must not contain consecutive underscores.`);
  }
  return trimmed;
}

export function normalizeProviderDefinitionAlias(value: string): string {
  return normalizeProviderDefinitionKey(value, "Provider alias");
}

export function normalizeProviderDefinitionOAuthProviderKey(value: string): string {
  const trimmed = requireNonEmptyText(value, "OAuth provider key", MAX_PROVIDER_KEY_LENGTH);
  if (trimmed !== trimmed.toLowerCase()) {
    throw new Error("OAuth provider key must be lowercase.");
  }
  if (!OAUTH_PROVIDER_KEY_PATTERN.test(trimmed)) {
    throw new Error(
      "OAuth provider key must be a lowercase kebab-case identifier (letters, digits, single hyphens).",
    );
  }
  return trimmed;
}

/**
 * API host allowlist entries are hostnames only — no scheme, path, query, fragment, or credentials.
 */
export function normalizeProviderApiHost(value: string): string {
  const trimmed = requireNonEmptyText(value, "API host", MAX_HOST_LENGTH);
  const lowered = trimmed.toLowerCase().replace(/\.$/u, "");

  if (/^[a-z][a-z0-9+.-]*:\/\//u.test(lowered)) {
    throw new Error("API host must not include a URL scheme.");
  }
  if (lowered.includes("/") || lowered.includes("?") || lowered.includes("#")) {
    throw new Error("API host must not include a path, query, or fragment.");
  }
  if (lowered.includes("@") || lowered.includes("\\")) {
    throw new Error("API host must not include credentials or path separators.");
  }
  if (lowered.includes(":")) {
    throw new Error("API host must not include a port.");
  }
  if (lowered.includes("..") || lowered.startsWith(".") || lowered.endsWith(".")) {
    throw new Error("API host is not a valid hostname.");
  }
  if (!API_HOST_PATTERN.test(lowered)) {
    throw new Error("API host is not a valid hostname.");
  }
  return lowered;
}

export function normalizeProviderApiHosts(hosts: readonly string[] | undefined): readonly string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const host of hosts ?? []) {
    const value = normalizeProviderApiHost(host);
    if (seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  if (normalized.length > MAX_API_HOST_COUNT) {
    throw new Error(`Provider may declare at most ${MAX_API_HOST_COUNT} API hosts.`);
  }
  return freezeDeepArray(normalized.toSorted((left, right) => left.localeCompare(right)));
}

export function normalizeProviderDefaultScopes(
  scopes: readonly string[] | undefined,
): readonly string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const scope of scopes ?? []) {
    if (typeof scope !== "string") {
      throw new Error("Default scope must be a string.");
    }
    const value = scope.trim();
    if (!value) continue;
    if (value.length > 256) {
      throw new Error("Default scope is too long.");
    }
    if (seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  if (normalized.length > MAX_SCOPE_COUNT) {
    throw new Error(`Provider may declare at most ${MAX_SCOPE_COUNT} default scopes.`);
  }
  return freezeDeepArray(normalized.toSorted((left, right) => left.localeCompare(right)));
}

export function normalizeProviderToolNames(
  tools: readonly string[] | undefined,
): readonly string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const tool of tools ?? []) {
    const value = requireNonEmptyText(tool, "Tool name", 128);
    if (!TOOL_NAME_PATTERN.test(value)) {
      throw new Error(
        "Tool name must be a lowercase dotted identifier (for example provider.action).",
      );
    }
    if (seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  if (normalized.length > MAX_TOOL_COUNT) {
    throw new Error(`Provider may declare at most ${MAX_TOOL_COUNT} tools.`);
  }
  return freezeDeepArray(normalized.toSorted((left, right) => left.localeCompare(right)));
}

export function normalizeOptionalDescription(
  value: string | undefined,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 500) {
    throw new Error(`${label} is too long.`);
  }
  return trimmed;
}

export function normalizeSchemaTypes(
  value: ProviderInputSchemaPropertyInput["type"],
  label: string,
): ProviderInputSchemaProperty["type"] {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  const normalized = values.map((entry) => {
    if (!(PROVIDER_INPUT_SCHEMA_TYPES as readonly string[]).includes(entry)) {
      throw new Error(`${label} contains unsupported type ${String(entry)}.`);
    }
    return entry;
  });
  const unique = [...new Set(normalized)].toSorted((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return unique.length === 1 ? unique[0] : freezeDeepArray(unique);
}

export function normalizeProviderInputSchemaProperty(
  input: ProviderInputSchemaPropertyInput,
  path: string,
  depth: number,
): ProviderInputSchemaProperty {
  if (!isPlainRecord(input)) {
    throw new Error(`${path} must be an object.`);
  }
  const schema = input as ProviderInputSchemaPropertyInput;
  if (depth > MAX_SCHEMA_DEPTH) {
    throw new Error(`Input schema exceeds maximum depth of ${MAX_SCHEMA_DEPTH}.`);
  }

  const propertiesInput = schema.properties ?? {};
  if (!isPlainRecord(propertiesInput)) {
    throw new Error(`${path}.properties must be an object.`);
  }
  const properties = Object.fromEntries(
    Object.keys(propertiesInput)
      .toSorted()
      .map((key) => [
        key,
        normalizeProviderInputSchemaProperty(
          propertiesInput[key] as ProviderInputSchemaPropertyInput,
          `${path}.properties.${key}`,
          depth + 1,
        ),
      ]),
  ) as Record<string, ProviderInputSchemaProperty>;

  const required = normalizeMetadataTextList(schema.required, `${path}.required entry`);
  for (const key of required) {
    if (!(key in properties)) {
      throw new Error(`${path}.required references unknown property ${key}.`);
    }
  }

  const description = normalizeOptionalDescription(schema.description, `${path}.description`);
  const format = normalizeOptionalDescription(schema.format, `${path}.format`);
  const pattern = normalizeOptionalDescription(schema.pattern, `${path}.pattern`);
  if (pattern !== undefined) {
    try {
      RegExp(pattern, "u");
    } catch {
      throw new Error(`${path}.pattern must be a valid regular expression.`);
    }
  }

  const numericFields = [
    ["minimum", schema.minimum],
    ["maximum", schema.maximum],
    ["minItems", schema.minItems],
    ["minLength", schema.minLength],
  ] as const;
  for (const [field, value] of numericFields) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${path}.${field} must be a non-negative number.`);
    }
  }
  if (
    schema.minimum !== undefined &&
    schema.maximum !== undefined &&
    schema.minimum > schema.maximum
  ) {
    throw new Error(`${path}.minimum must not be greater than maximum.`);
  }

  const type = normalizeSchemaTypes(schema.type, `${path}.type`);
  const items = schema.items
    ? normalizeProviderInputSchemaProperty(schema.items, `${path}.items`, depth + 1)
    : undefined;
  const enumValues = schema.enum ? Object.freeze([...schema.enum]) : undefined;

  return Object.freeze({
    ...(schema.additionalProperties !== undefined
      ? { additionalProperties: schema.additionalProperties === true }
      : {}),
    ...(description ? { description } : {}),
    ...(enumValues ? { enum: enumValues } : {}),
    ...(format ? { format } : {}),
    ...(items ? { items } : {}),
    ...(schema.maximum !== undefined ? { maximum: schema.maximum } : {}),
    ...(schema.minimum !== undefined ? { minimum: schema.minimum } : {}),
    ...(schema.minItems !== undefined ? { minItems: schema.minItems } : {}),
    ...(schema.minLength !== undefined ? { minLength: schema.minLength } : {}),
    ...(pattern ? { pattern } : {}),
    ...(Object.keys(properties).length > 0 ? { properties: Object.freeze(properties) } : {}),
    ...(required.length > 0 ? { required } : {}),
    ...(type ? { type } : {}),
  });
}

export function normalizeProviderInputSchema(
  input: ProviderInputSchemaInput | undefined,
): ProviderInputSchema | undefined {
  if (input === undefined) return undefined;
  if (!isPlainRecord(input)) throw new Error("Input schema must be an object.");
  const schema = input as ProviderInputSchemaInput;
  if (schema.type !== undefined && schema.type !== "object") {
    throw new Error("Input schema root type must be object.");
  }

  const propertiesInput = schema.properties ?? {};
  if (!isPlainRecord(propertiesInput)) {
    throw new Error("Input schema properties must be an object.");
  }
  const properties = Object.fromEntries(
    Object.keys(propertiesInput)
      .toSorted()
      .map((key) => [
        key,
        normalizeProviderInputSchemaProperty(
          propertiesInput[key] as ProviderInputSchemaPropertyInput,
          `Input schema property ${key}`,
          1,
        ),
      ]),
  ) as Record<string, ProviderInputSchemaProperty>;
  const required = normalizeMetadataTextList(schema.required, "Input schema required entry");
  for (const key of required) {
    if (!(key in properties)) {
      throw new Error(`Input schema required references unknown property ${key}.`);
    }
  }
  const description = normalizeOptionalDescription(schema.description, "Input schema description");

  return Object.freeze({
    additionalProperties: schema.additionalProperties === true,
    ...(description ? { description } : {}),
    properties: Object.freeze(properties),
    required,
    type: "object" as const,
  });
}

/**
 * Normalize a customer-configured provider origin to one immutable HTTPS origin
 * (scheme + host + non-default port). Rejects credentials, path, query, fragment,
 * and non-https schemes. Used by originPolicy default validation and connection
 * verification.
 */
export function normalizeImmutableHttpsOrigin(value: string, label = "Origin"): string {
  const trimmed = requireNonEmptyText(value, label, 2048);
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${label} must be a valid absolute HTTPS origin.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${label} must use https.`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not include credentials.`);
  }
  // Accept full URLs that carry a path/query by reducing to origin only when the
  // caller supplies a base URL field (e.g. https://cms.example.com/v1). Path and
  // query are not part of the immutable origin identity.
  if (url.hash) {
    throw new Error(`${label} must not include a fragment.`);
  }
  // Lowercase host, strip default port — URL.origin already does this.
  return url.origin;
}

/** @deprecated Use {@link normalizeImmutableHttpsOrigin}. */
export function normalizeHttpsOrigin(value: string, label: string): string {
  return normalizeImmutableHttpsOrigin(value, label);
}
