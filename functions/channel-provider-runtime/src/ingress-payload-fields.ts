import { Ulid } from "@deployments-ai/db";
import { Schema } from "effect";

export function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

export function text(value: Readonly<Record<string, unknown>>, field: string, label: string) {
  const candidate = value[field];
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new Error(`${label}.${field} is required.`);
  }
  return candidate.trim();
}

export function ulid(value: unknown, label: string): Ulid {
  try {
    return Schema.decodeUnknownSync(Ulid)(value);
  } catch {
    throw new Error(`${label} must be a canonical ULID.`);
  }
}
