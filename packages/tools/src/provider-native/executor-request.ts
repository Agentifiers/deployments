/* eslint-disable no-await-in-loop -- Provider retries and redirect-safe requests are ordered. */

import {
  applyProviderAuthTransport,
  codeProviderDefinitionRegistry,
  type ProviderDefinition,
} from "@deployments-ai/providers";
import {
  normalizeHttpsOriginForComparison,
  readBoundedRawBody,
  type DnsLookup,
  type ExecutePinnedHttpRequestOptions,
} from "@deployments-ai/net-security";
import { providerApiHostAllowed, readToolInputObject } from "./core-input.ts";
import { providerNativeAcceptedProviders } from "./core-adapter.ts";
import type {
  ProviderAccessToken,
  ProviderNativeBody,
  ProviderNativeHostPolicy,
  ProviderNativeHttpToolDefinition,
  ProviderNativeToolRequestContext,
} from "./core-types.ts";

export const DEFAULT_PROVIDER_NATIVE_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_PROVIDER_NATIVE_REQUEST_MAX_BYTES = 1024 * 1024;
export const DEFAULT_PROVIDER_NATIVE_RESPONSE_MAX_BYTES = 5_000_000;
export const DEFAULT_PROVIDER_NATIVE_TOKEN_RESPONSE_MAX_BYTES = 64_000;
export const DEFAULT_PROVIDER_NATIVE_USER_AGENT = "deployments-ai-agent-worker/1";

export class ProviderNativeExecutionKnownFailureError extends Error {
  constructor(
    readonly toolName: string,
    readonly executionCause: unknown,
  ) {
    const detail =
      executionCause instanceof Error && executionCause.message.trim()
        ? `: ${executionCause.message.trim()}`
        : "";
    super(`Provider-native tool ${toolName} failed without an ambiguous side effect${detail}`, {
      cause: executionCause,
    });
    this.name = "ProviderNativeExecutionKnownFailureError";
  }
}

export class ProviderNativeExecutionOutcomeUnknownError extends Error {
  constructor(
    readonly toolName: string,
    readonly executionCause: unknown,
  ) {
    const detail =
      executionCause instanceof Error && executionCause.message.trim()
        ? `: ${executionCause.message.trim()}`
        : "";
    super(`Provider-native tool ${toolName} may have completed after request dispatch${detail}`, {
      cause: executionCause,
    });
    this.name = "ProviderNativeExecutionOutcomeUnknownError";
  }
}

export class ProviderNativeExecutionRetryableError extends Error {
  constructor(
    readonly toolName: string,
    readonly executionCause: unknown,
  ) {
    super(`Provider-native tool ${toolName} was rejected with a retryable response.`, {
      cause: executionCause,
    });
    this.name = "ProviderNativeExecutionRetryableError";
  }
}

export class ProviderNativeHttpResponseError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
  ) {
    super(`${provider} provider API request returned HTTP ${status}.`);
    this.name = "ProviderNativeHttpResponseError";
  }
}

export function definitiveProviderRejection(cause: unknown): boolean {
  return (
    cause instanceof ProviderNativeHttpResponseError &&
    cause.status >= 400 &&
    cause.status < 500 &&
    ![408, 409, 425, 429].includes(cause.status)
  );
}

export function retryableProviderRejection(
  cause: unknown,
  retryableStatusCodes: readonly number[] = [425, 429],
): boolean {
  return (
    cause instanceof ProviderNativeHttpResponseError && retryableStatusCodes.includes(cause.status)
  );
}

export interface ProviderNativeCredential {
  readonly authorizationFingerprint?: string;
  readonly connectionId?: string;
  readonly externalAccountId: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly grantedScopes?: readonly string[];
  readonly provider: string;
  readonly requestHeaders?: Readonly<Record<string, string>>;
  readonly resourceBindings?: Readonly<Record<string, unknown>>;
  readonly resourceDefaults?: Readonly<Record<string, unknown>>;
}

export interface ProviderNativeHttpExecutorOptions {
  readonly dnsLookup?: DnsLookup;
  readonly maxRedirects?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxTokenResponseBytes?: number;
  readonly now?: () => number;
  readonly pinnedRequest?: (args: ExecutePinnedHttpRequestOptions) => Promise<Response>;
  readonly requestTimeoutMs?: number;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly userAgent?: string;
}

export interface ExecuteProviderNativeHttpToolInput {
  readonly credential: ProviderNativeCredential;
  readonly definition: ProviderNativeHttpToolDefinition;
  readonly input: Readonly<Record<string, unknown>>;
  readonly request: ProviderNativeToolRequestContext;
  readonly signal?: AbortSignal;
}

export interface ProviderNativeHttpExecutionResult {
  readonly artifactBody: string;
  readonly contentType: string;
  readonly externalOperationId?: string;
  readonly itemCount?: number;
  readonly outputSummary: string;
  readonly parsedBody: unknown;
  readonly provider: string;
  readonly requestHost: string;
  readonly responseStatus: number;
  readonly sourceCharacterCount: number;
}

export function positiveInteger(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${field} must be a positive safe integer.`);
  }
  return resolved;
}

function canonicalProvider(value: string): string {
  return codeProviderDefinitionRegistry().resolve(value)?.key ?? value.trim();
}

function acceptedProviderKeys(definition: ProviderNativeHttpToolDefinition): readonly string[] {
  return providerNativeAcceptedProviders(definition).map(canonicalProvider);
}

export function providerDefinitionForExecution(
  definition: ProviderNativeHttpToolDefinition,
  credential: ProviderNativeCredential,
): ProviderDefinition {
  const registry = codeProviderDefinitionRegistry();
  if (!acceptedProviderKeys(definition).includes(canonicalProvider(credential.provider))) {
    throw new Error(
      `${definition.toolName} does not accept credentials for provider ${credential.provider}.`,
    );
  }
  const credentialProvider = registry.resolve(credential.provider);
  const provider = credentialProvider ?? registry.resolve(definition.provider);
  if (!provider) throw new Error("Provider definition is not registered.");
  if (!acceptedProviderKeys(definition).includes(provider.key)) {
    throw new Error(`${definition.toolName} canonical provider is not accepted for execution.`);
  }
  if (provider.status !== "configured" && provider.status !== "verified") {
    throw new Error(`Provider ${provider.key} is not available for execution.`);
  }
  if (!provider.tools.includes(definition.toolName)) {
    throw new Error(`Provider ${provider.key} does not register tool ${definition.toolName}.`);
  }
  return provider;
}

export function mergedCredentialFields(
  provider: ProviderDefinition,
  credential: ProviderNativeCredential,
): Readonly<Record<string, unknown>> {
  const oauthResource = credential.resourceDefaults?.oauthResource;
  return Object.freeze({
    ...Object.fromEntries(
      provider.auth.fields.flatMap((field) =>
        field.defaultValue === undefined ? [] : [[field.key, field.defaultValue] as const],
      ),
    ),
    ...credential.fields,
    ...(provider.originPolicy && typeof oauthResource === "string" && oauthResource.trim()
      ? { [provider.originPolicy.fieldKey]: oauthResource.trim() }
      : {}),
  });
}

function requiredCredentialField(
  fields: Readonly<Record<string, unknown>>,
  fieldKey: string,
): string {
  const value = fields[fieldKey];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Provider credential is missing required field ${fieldKey}.`);
  }
  return value.trim();
}

export function firstCredentialField(
  fields: Readonly<Record<string, unknown>>,
  fieldKeys: readonly string[],
): string | undefined {
  for (const fieldKey of fieldKeys) {
    const value = fields[fieldKey];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function staticCredentialToken(
  provider: ProviderDefinition,
  fields: Readonly<Record<string, unknown>>,
): string {
  const sensitiveFields = provider.auth.fields.filter((field) => field.sensitive);
  if (sensitiveFields.length === 1) {
    return requiredCredentialField(fields, sensitiveFields[0]!.key);
  }
  const transport = provider.auth.transport;
  if (!transport) {
    throw new Error(`${provider.key} has no unambiguous credential token field.`);
  }
  if (transport.type === "basic") {
    const username = transport.usernameFieldKey
      ? requiredCredentialField(fields, transport.usernameFieldKey)
      : "";
    const password = transport.passwordFieldKey
      ? requiredCredentialField(fields, transport.passwordFieldKey)
      : "";
    return `${username}:${password}`;
  }
  if (transport.type === "headers") {
    return transport
      .headerFields!.map((entry) => requiredCredentialField(fields, entry.fieldKey))
      .join(":");
  }
  return requiredCredentialField(fields, transport.fieldKey!);
}

function nonSecretResourceHints(
  provider: ProviderDefinition,
  fields: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const requestFieldKeys = new Set(provider.auth.requestFieldKeys);
  if (provider.originPolicy) requestFieldKeys.add(provider.originPolicy.fieldKey);
  return Object.freeze(
    Object.fromEntries(
      provider.auth.fields.flatMap((field) => {
        if (field.sensitive || !requestFieldKeys.has(field.key)) return [];
        const value = fields[field.key];
        return value === undefined ? [] : [[field.key, value] as const];
      }),
    ),
  );
}

export function effectiveToolInput(
  input: Readonly<Record<string, unknown>>,
  credential: ProviderNativeCredential,
  provider: ProviderDefinition,
  fields: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return readToolInputObject({
    ...input,
    ...credential.resourceDefaults,
    ...nonSecretResourceHints(provider, fields),
    ...credential.resourceBindings,
  });
}

export function normalizedHeaders(
  values: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(values)) {
    const name = rawName.trim().toLowerCase();
    if (!name || !/^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(name)) {
      throw new Error("Provider request contains an invalid header name.");
    }
    if (["connection", "content-length", "host", "transfer-encoding"].includes(name)) {
      throw new Error(`Provider request must not set ${name}.`);
    }
    if (rawValue === undefined) {
      delete headers[name];
      continue;
    }
    const value = rawValue.trim();
    if (!value || /[\r\n]/u.test(value)) {
      throw new Error(`Provider request header ${name} is empty or malformed.`);
    }
    headers[name] = value;
  }
  return headers;
}

export function validatedCredentialRequestHeaders(
  values: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  if (!values) return {};
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
  const normalized = normalizedHeaders(values);
  for (const name of Object.keys(normalized)) {
    if (forbidden.has(name)) {
      throw new Error(`Provider credential returned unsafe request header ${name}.`);
    }
  }
  return normalized;
}

export function requestBody(
  body: ProviderNativeBody,
  maximumBytes: number,
  toolName: string,
): string | Uint8Array | undefined {
  if (body?.body === undefined) return undefined;
  const value =
    typeof body.body === "string" || body.body instanceof Uint8Array
      ? body.body
      : body.body instanceof ArrayBuffer
        ? new Uint8Array(body.body)
        : body.body instanceof URLSearchParams
          ? body.body.toString()
          : undefined;
  if (value === undefined) {
    throw new Error(`${toolName} uses an unsupported pinned request body type.`);
  }
  const byteLength =
    typeof value === "string" ? new TextEncoder().encode(value).byteLength : value.byteLength;
  if (byteLength > maximumBytes) {
    throw new Error(`${toolName} provider request exceeds ${maximumBytes} bytes.`);
  }
  return value;
}

function contentTypeCharset(contentType: string): string | undefined {
  for (const parameter of contentType.split(";").slice(1)) {
    const separator = parameter.indexOf("=");
    if (separator < 0 || parameter.slice(0, separator).trim().toLowerCase() !== "charset") continue;
    return parameter
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/gu, "")
      .toLowerCase();
  }
  return undefined;
}

export async function readUtf8Response(
  response: Response,
  maximumBytes: number,
  label: string,
): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  const charset = contentTypeCharset(contentType);
  if (charset && charset !== "utf-8" && charset !== "utf8") {
    await response.body?.cancel();
    throw new Error(`${label} declared unsupported charset ${charset}.`);
  }
  const bytes = await readBoundedRawBody(response.body, {
    contentLengthHeader: response.headers.get("content-length"),
    maxBytes: maximumBytes,
  });
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new Error(`${label} was not valid UTF-8.`, { cause });
  }
}

export function jsonContentType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

export function parseResponseBody(rawBody: string, contentType: string, label: string): unknown {
  if (!rawBody.trim()) return undefined;
  if (!jsonContentType(contentType)) return rawBody;
  try {
    return JSON.parse(rawBody) as unknown;
  } catch (cause) {
    throw new Error(`${label} declared JSON but returned invalid JSON.`, { cause });
  }
}

export function addCredentialMaterial(materials: Set<string>, value: string): void {
  const normalized = value.trim();
  if (!normalized) return;
  materials.add(normalized);
  const encoded = encodeURIComponent(normalized);
  if (encoded !== normalized) materials.add(encoded);
  const formEncoded = new URLSearchParams({ value: normalized }).toString().slice("value=".length);
  if (formEncoded !== normalized) materials.add(formEncoded);
  for (const serialized of [encoded, formEncoded]) {
    const lowercaseEscapes = serialized.replaceAll(/%[0-9A-F]{2}/gu, (escape) =>
      escape.toLowerCase(),
    );
    if (lowercaseEscapes !== normalized) materials.add(lowercaseEscapes);
  }
  const jsonEscaped = JSON.stringify(normalized).slice(1, -1);
  if (jsonEscaped !== normalized) materials.add(jsonEscaped);
}

function addSensitiveMaterial(materials: Set<string>, value: unknown): void {
  if (typeof value === "string") {
    addCredentialMaterial(materials, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) addSensitiveMaterial(materials, entry);
    return;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      addSensitiveMaterial(materials, child);
    }
    try {
      addCredentialMaterial(materials, JSON.stringify(value));
    } catch {
      // Credential vault values are JSON-compatible; rejectable values are covered individually.
    }
  }
}

export function credentialLeakMaterials(args: {
  readonly authHeaders: Readonly<Record<string, string>>;
  readonly credential: ProviderNativeCredential;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly provider: ProviderDefinition;
  readonly token: ProviderAccessToken;
}): ReadonlySet<string> {
  const materials = new Set<string>();
  for (const field of args.provider.auth.fields) {
    if (field.sensitive) addSensitiveMaterial(materials, args.fields[field.key]);
  }
  addCredentialMaterial(materials, args.token.token);
  for (const value of Object.values(args.authHeaders)) {
    addCredentialMaterial(materials, value);
    const separator = value.indexOf(" ");
    if (separator > 0) addCredentialMaterial(materials, value.slice(separator + 1));
  }
  if (args.provider.auth.transport) {
    const applied = applyProviderAuthTransport({
      fields: args.fields,
      transport: args.provider.auth.transport,
      url: "https://credential.invalid/",
    });
    for (const value of Object.values(applied.headers)) addCredentialMaterial(materials, value);
    for (const value of new URL(applied.url).searchParams.values()) {
      addCredentialMaterial(materials, value);
    }
  }
  for (const value of Object.values(args.credential.requestHeaders ?? {})) {
    addCredentialMaterial(materials, value);
  }
  return materials;
}

function credentialComparisonVariants(value: string): readonly string[] {
  const variants = new Set<string>();
  let frontier = [value];
  for (let depth = 0; depth < 3 && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const candidate of frontier) {
      variants.add(candidate.replaceAll(/%[0-9a-f]{2}/giu, (escape) => escape.toUpperCase()));
      for (const encoded of [candidate.replaceAll("+", "%2B"), candidate]) {
        const escapedSeparators = encoded.replaceAll("&", "%26").replaceAll("=", "%3D");
        const decoded = new URLSearchParams(`value=${escapedSeparators}`).get("value") ?? "";
        if (decoded !== candidate && !variants.has(decoded)) next.push(decoded);
      }
    }
    frontier = next;
  }
  return [...variants];
}

function containsCredentialMaterial(value: string, material: string): boolean {
  for (const comparableValue of credentialComparisonVariants(value)) {
    for (const comparableMaterial of credentialComparisonVariants(material)) {
      if (comparableValue.trim() === comparableMaterial) return true;
      let offset = comparableValue.indexOf(comparableMaterial);
      while (offset >= 0) {
        const before = offset === 0 ? undefined : comparableValue[offset - 1];
        const after = comparableValue[offset + comparableMaterial.length];
        if (
          (!before || /[^\p{L}\p{N}]/u.test(before)) &&
          (!after || /[^\p{L}\p{N}]/u.test(after))
        ) {
          return true;
        }
        offset = comparableValue.indexOf(comparableMaterial, offset + 1);
      }
    }
  }
  return false;
}

function structuredCredentialLeak(value: unknown, materials: ReadonlySet<string>): boolean {
  if (typeof value === "string") {
    return [...materials].some((material) => containsCredentialMaterial(value, material));
  }
  if (Array.isArray(value))
    return value.some((entry) => structuredCredentialLeak(entry, materials));
  if (value && typeof value === "object") {
    return Object.entries(value as Readonly<Record<string, unknown>>).some(
      ([name, entry]) =>
        [...materials].some(
          (material) => material.length >= 8 && containsCredentialMaterial(name, material),
        ) || structuredCredentialLeak(entry, materials),
    );
  }
  return false;
}

export function assertNoCredentialLeak(
  body: string,
  materials: ReadonlySet<string>,
  structuredBody?: unknown,
): void {
  if (structuredBody !== undefined && structuredCredentialLeak(structuredBody, materials)) {
    throw new Error("Provider response contained credential material and cannot be persisted.");
  }
  const comparableBodies = credentialComparisonVariants(body);
  for (const material of materials) {
    const directEcho = structuredBody === undefined && body.trim() === JSON.stringify(material);
    const embeddedEcho =
      material.length >= 8
        ? comparableBodies.some((candidate) =>
            credentialComparisonVariants(material).some((variant) => candidate.includes(variant)),
          )
        : structuredBody === undefined && containsCredentialMaterial(body, material);
    if (directEcho || embeddedEcho) {
      throw new Error("Provider response contained credential material and cannot be persisted.");
    }
  }
}

function providerHostPolicy(
  definition: ProviderNativeHttpToolDefinition,
  provider: ProviderDefinition,
): ProviderNativeHostPolicy {
  return definition.hostPolicy ?? provider.hostPolicy;
}

export function verifiedOrigin(
  definition: ProviderNativeHttpToolDefinition,
  provider: ProviderDefinition,
  fields: Readonly<Record<string, unknown>>,
): string | undefined {
  if (providerHostPolicy(definition, provider).mode !== "verified_origin") return undefined;
  if (!provider.originPolicy) {
    throw new Error(`${definition.toolName} requires a provider origin policy.`);
  }
  return normalizeHttpsOriginForComparison(
    requiredCredentialField(fields, provider.originPolicy.fieldKey),
  );
}

export function validateRequestUrl(args: {
  readonly definition: ProviderNativeHttpToolDefinition;
  readonly provider: ProviderDefinition;
  readonly requestUrl: string;
  readonly verifiedOrigin?: string;
}): { readonly origin: string; readonly url: string } {
  let parsed: URL;
  try {
    parsed = new URL(args.requestUrl);
  } catch (cause) {
    throw new Error(`${args.definition.toolName} produced an invalid provider request URL.`, {
      cause,
    });
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${args.definition.toolName} produced a non-HTTPS or credentialed URL.`);
  }
  const policy = providerHostPolicy(args.definition, args.provider);
  if (
    policy.mode === "allowlist" &&
    !providerApiHostAllowed(args.provider.key, parsed.hostname, policy)
  ) {
    throw new Error(`${args.definition.toolName} request host is not allowlisted.`);
  }
  const origin = normalizeHttpsOriginForComparison(parsed.origin);
  if (args.verifiedOrigin && origin !== args.verifiedOrigin) {
    throw new Error(`${args.definition.toolName} request escaped its verified origin.`);
  }
  return { origin, url: parsed.toString() };
}

export function timeoutSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { readonly cleanup: () => void; readonly signal: AbortSignal } {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error("Provider request timed out.")),
    timeoutMs,
  );
  return {
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abortFromParent);
    },
    signal: controller.signal,
  };
}
