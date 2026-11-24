import { Ulid, type Ulid as UlidValue } from "@deployments-ai/db";
import { Schema } from "effect";

export function required(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export function ulid(value: unknown, label: string): UlidValue {
  try {
    return Schema.decodeUnknownSync(Ulid)(value);
  } catch {
    throw new Error(`${label} must be a ULID.`);
  }
}
