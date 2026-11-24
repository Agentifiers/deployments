import { Schema } from "effect";

export interface KeyableRecord {
  readonly data: Readonly<Record<string, unknown>>;
  readonly itemType: string;
}

export class CanonicalKeyError extends Schema.TaggedErrorClass<CanonicalKeyError>()(
  "CanonicalKeyError",
  {
    field: Schema.String,
    itemType: Schema.String,
    message: Schema.String,
  },
) {}

export function field(data: Readonly<Record<string, unknown>>, name: string) {
  const value = data[name];
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function requiredField(record: KeyableRecord, name: string) {
  const value = field(record.data, name);
  if (value) return value;
  throw new CanonicalKeyError({
    field: name,
    itemType: record.itemType,
    message: `Record ${record.itemType} requires ${name} to derive its DynamoDB key.`,
  });
}

export function stableShard(identity: readonly string[], shardCount: number) {
  let hash = 2_166_136_261;
  for (const byte of new TextEncoder().encode(identity.join("\u0000"))) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619);
  }
  return String((hash >>> 0) % shardCount).padStart(2, "0");
}
