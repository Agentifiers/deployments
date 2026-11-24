import type { BrainResourceListOptions } from "@deployments-ai/brains";

export function brainAggregateCursor(cursor: string | undefined, expectedPartition: string) {
  if (!cursor) return undefined;
  const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid Brain cursor.");
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (
    Object.keys(record).length !== 2 ||
    typeof record.pk !== "string" ||
    typeof record.sk !== "string" ||
    record.pk !== expectedPartition
  ) {
    throw new TypeError("Invalid or cross-tenant Brain cursor.");
  }
  return record as Record<string, string>;
}

export function encodeBrainAggregateCursor(value: Readonly<Record<string, unknown>> | undefined) {
  return value
    ? Buffer.from(JSON.stringify({ pk: value.pk, sk: value.sk })).toString("base64url")
    : undefined;
}

export function encodeBrainIndexCursor(value: Readonly<Record<string, unknown>> | undefined) {
  if (!value) return undefined;
  return Buffer.from(
    JSON.stringify(
      Object.fromEntries(["gsi1pk", "gsi1sk", "pk", "sk"].map((name) => [name, value[name]])),
    ),
  ).toString("base64url");
}

export function validateBrainResourceListOptions(
  options: BrainResourceListOptions,
  maxPageSize = 100,
) {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > maxPageSize) {
    throw new TypeError(`Brain resource list limit must be between 1 and ${maxPageSize}.`);
  }
}
