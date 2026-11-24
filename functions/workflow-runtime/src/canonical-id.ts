import { Ulid } from "@deployments-ai/db";
import { Schema } from "effect";

export function id(value: unknown, label: string) {
  try {
    return Schema.decodeUnknownSync(Ulid)(value);
  } catch (cause) {
    throw new Error(`${label} must be a canonical ULID.`, { cause });
  }
}
