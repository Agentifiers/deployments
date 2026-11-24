import { tableForItemType, type PlatformRecord } from "./records/index.ts";
import type { UniqueClaimRequirement } from "./unique-claims.ts";

export function claimValue(data: Readonly<Record<string, unknown>>, field: string) {
  const candidate = data[field];
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : undefined;
}

export function claimRequirement(
  record: PlatformRecord,
  namespace: string,
  uniqueValue: string | undefined,
): UniqueClaimRequirement[] {
  const data = record.data as Readonly<Record<string, unknown>>;
  const ownerId = claimValue(data, "id");
  if (!ownerId || !uniqueValue) return [];
  const expiresAt = record.ttl === undefined ? undefined : claimValue(data, "expiresAt");
  return [
    {
      ...(expiresAt && record.ttl !== undefined ? { expiresAt, ttl: record.ttl } : {}),
      namespace,
      ownerId,
      ownerItemType: record.itemType,
      ownerPk: record.pk,
      ownerSk: record.sk,
      ownerTable: tableForItemType(record.itemType),
      value: uniqueValue,
    },
  ];
}

export function claimOwnerAttributes(
  data: Readonly<Record<string, unknown>>,
  names: readonly string[],
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    names.map((name) => [name, typeof data[name] === "string" ? data[name] : undefined]),
  );
}
