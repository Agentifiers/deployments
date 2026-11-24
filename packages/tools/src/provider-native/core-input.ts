import type { ProviderNativeHostPolicy, ProviderNativeBody } from "./core-types.ts";
import { providerNativeHostPolicy } from "./core-types.ts";

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readToolInputObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Tool input must be an object");
  }
  return input as Record<string, unknown>;
}

export function requireToolString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Tool input ${key} is required`);
  }
  return value.trim();
}

export function optionalToolString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function optionalToolPositiveInteger(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Tool input ${key} must be a positive number`);
  }
  return Math.trunc(value);
}

export function optionalToolNumber(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Tool input ${key} must be a number`);
  }
  return value;
}

export function optionalToolBoolean(
  input: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Tool input ${key} must be a boolean`);
  return value;
}

export function readToolRecord(
  input: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = input[key];
  if (value === undefined) return {};
  if (!isPlainRecord(value)) throw new Error(`Tool input ${key} must be an object`);
  return value;
}

export function optionalToolObject(
  input: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  if (!(key in input)) return undefined;
  return readToolRecord(input, key);
}

export function optionalToolStringArray(
  input: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`Tool input ${key} must be an array of strings`);
  return value.flatMap((entry) =>
    typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
  );
}

export function providerApiHostAllowed(
  provider: string,
  hostname: string,
  policy: ProviderNativeHostPolicy = providerNativeHostPolicy(provider),
): boolean {
  if (policy.mode !== "allowlist") return false;
  const normalizedHostname = hostname.trim().toLowerCase().replace(/\.$/u, "");
  return policy.hosts.some((suffix) => {
    const normalizedSuffix = suffix.trim().toLowerCase().replace(/\.$/u, "");
    return (
      normalizedHostname === normalizedSuffix || normalizedHostname.endsWith(`.${normalizedSuffix}`)
    );
  });
}

export function quickbooksRequestId(idempotencyKey: string): string {
  const normalized = idempotencyKey
    .replace(/[^a-zA-Z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 50);
  return normalized || "deployments-ai-request";
}

export function jsonProviderNativeBody(value: unknown): ProviderNativeBody {
  return { body: JSON.stringify(value), contentType: "application/json" };
}

export function boundedJsonProviderNativeBody(
  value: unknown,
  fieldName: string,
  maxBytes = 100_000,
): ProviderNativeBody {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw new Error(`Tool input ${fieldName} must be JSON serializable`);
  }
  if (body === undefined) {
    throw new Error(`Tool input ${fieldName} must be JSON serializable`);
  }
  const byteLength = new TextEncoder().encode(body).byteLength;
  if (byteLength > maxBytes) {
    throw new Error(`Tool input ${fieldName} exceeds ${maxBytes} JSON bytes`);
  }
  return { body, contentType: "application/json" };
}

export function appendNativeQueryValue(url: URL, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item === undefined || item === null) continue;
      const text =
        typeof item === "boolean"
          ? item
            ? "true"
            : "false"
          : typeof item === "object"
            ? JSON.stringify(item)
            : String(item).trim();
      if (text) url.searchParams.append(key, text);
    }
    return;
  }
  if (typeof value === "boolean") {
    url.searchParams.set(key, value ? "true" : "false");
    return;
  }
  if (typeof value === "object") {
    url.searchParams.set(key, JSON.stringify(value));
    return;
  }
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return;
  const text = String(value).trim();
  if (text) url.searchParams.set(key, text);
}

export function appendNativeQueryFields(
  url: URL,
  input: Record<string, unknown>,
  fields: readonly string[],
): void {
  for (const field of fields) appendNativeQueryValue(url, field, input[field]);
}

export function encodedPath(value: string): string {
  return value
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      if (segment === "." || segment === "..") {
        throw new Error("Provider API path cannot contain dot segments");
      }
      return encodeURIComponent(segment);
    })
    .join("/");
}

export function requirePositiveLimit(
  input: Record<string, unknown>,
  key: string,
  defaultValue: number,
  maxValue: number,
): number {
  return Math.min(optionalToolPositiveInteger(input, key) ?? defaultValue, maxValue);
}

export function requireProviderBaseUrl(
  input: Record<string, unknown>,
  key: string,
  provider: string,
): URL {
  const rawUrl = requireToolString(input, key);
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Tool input ${key} must be a valid URL`);
  }
  if (parsed.protocol !== "https:") throw new Error(`Tool input ${key} must use https`);
  if (parsed.username || parsed.password) {
    throw new Error(`Tool input ${key} must not contain URL credentials`);
  }
  if (!providerApiHostAllowed(provider, parsed.hostname)) {
    throw new Error(`Tool input ${key} host is not allowed for ${provider}`);
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed;
}

export function optionalProviderBaseUrl(
  input: Record<string, unknown>,
  key: string,
  provider: string,
  fallback: string,
): URL {
  if (!optionalToolString(input, key)) return new URL(fallback);
  return requireProviderBaseUrl(input, key, provider);
}
