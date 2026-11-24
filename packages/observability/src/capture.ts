import { Schema } from "effect";

export const OBSERVABILITY_SCHEMA_VERSION = 1 as const;
export const OBSERVABILITY_REDACTION_POLICY_VERSION = 1 as const;

export const CaptureMode = Schema.Literals(["full-content", "metadata-only", "redacted-content"]);
export type CaptureMode = typeof CaptureMode.Type;

export const DEFAULT_CAPTURE_MODE: CaptureMode = "metadata-only";

export const SENSITIVE_OBSERVABILITY_FIELDS = new Set([
  "authorization",
  "body",
  "content",
  "cookie",
  "credentials",
  "environmentvariables",
  "input",
  "memory",
  "output",
  "prompt",
  "request",
  "response",
  "secret",
  "token",
]);

const SAFE_TOKEN_COUNT_FIELDS = new Set([
  "cachedtokens",
  "inputtokens",
  "outputtokens",
  "totaltokens",
]);

const SAFE_REQUEST_METADATA_FIELDS = new Set([
  "providerrequestid",
  "requestedmodelid",
  "requestedprovider",
]);

function normalizedFieldName(value: string) {
  return value.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

export function metadataOnlyAttributes(
  attributes: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(attributes).flatMap(([name, value]) => {
      const normalized = normalizedFieldName(name);
      const allowed =
        SAFE_TOKEN_COUNT_FIELDS.has(normalized) ||
        SAFE_REQUEST_METADATA_FIELDS.has(normalized) ||
        ![...SENSITIVE_OBSERVABILITY_FIELDS].some((field) => normalized.includes(field));
      if (!allowed) return [];
      if (Array.isArray(value)) {
        return [[name, value.map((entry) => metadataOnlyValue(entry))]];
      }
      return [[name, metadataOnlyValue(value)]];
    }),
  );
}

function metadataOnlyValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => metadataOnlyValue(entry));
  return metadataOnlyAttributes(value as Readonly<Record<string, unknown>>);
}
