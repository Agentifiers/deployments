import { tableForItemType, type PlatformRecord } from "../records/index.ts";
import type { UniqueClaimRequirement } from "../unique-claims.ts";

export const CAPACITY_RESOURCES = {
  "app-domain": {
    claimName: "app-domain-slot",
    holder: (record: PlatformRecord) =>
      record.itemType === "app-domain"
        ? {
            holds: record.data.state.kind !== "unverified",
            organizationId: record.data.organizationId,
            ownerId: record.data.id,
            slot: record.data.state.kind === "unverified" ? undefined : record.data.state.slot,
            updatedAt: record.data.updatedAt,
          }
        : undefined,
    itemType: "app-domain",
  },
  "active-sandbox": {
    claimName: "active-sandbox-slot",
    holder: (record: PlatformRecord) =>
      record.itemType === "sandbox-lease"
        ? {
            holds: record.data.computeUsageActive || record.data.status === "resuming",
            organizationId: record.data.organizationId,
            ownerId: record.data.id,
            slot: record.data.capacitySlot,
            updatedAt: record.data.updatedAt,
          }
        : undefined,
    itemType: "sandbox-lease",
  },
  "run-execution": {
    claimName: "run-execution-slot",
    holder: (record: PlatformRecord) =>
      record.itemType === "run"
        ? {
            holds: record.data.status === "running",
            organizationId: record.data.organizationId,
            ownerId: record.data.id,
            slot: record.data.executionSlot,
            updatedAt: record.data.updatedAt,
          }
        : undefined,
    itemType: "run",
  },
} as const satisfies Readonly<
  Record<
    string,
    {
      readonly claimName: string;
      readonly holder: (record: PlatformRecord) =>
        | {
            readonly holds: boolean;
            readonly organizationId: string;
            readonly ownerId: string;
            readonly slot: number | undefined;
            readonly updatedAt: string;
          }
        | undefined;
      readonly itemType: PlatformRecord["itemType"];
    }
  >
>;

export type CapacityResource = keyof typeof CAPACITY_RESOURCES;

export const CAPACITY_RESOURCE_NAMES = Object.keys(
  CAPACITY_RESOURCES,
) as readonly CapacityResource[];

export function capacityClaimNamespace(organizationId: string, resource: CapacityResource) {
  return `organization:${organizationId}:${CAPACITY_RESOURCES[resource].claimName}`;
}

export interface CapacityHolding {
  readonly organizationId: string;
  readonly ownerId: string;
  readonly resource: CapacityResource;
  readonly slot: number | undefined;
  readonly updatedAt: string;
}

export function capacityHolding(record: PlatformRecord): CapacityHolding | undefined {
  for (const resource of CAPACITY_RESOURCE_NAMES) {
    const holder = CAPACITY_RESOURCES[resource].holder(record);
    if (holder?.holds) return { ...holder, resource };
  }
  return undefined;
}

export function isCapacityHolderItemType(itemType: PlatformRecord["itemType"]) {
  return CAPACITY_RESOURCE_NAMES.some(
    (resource) => CAPACITY_RESOURCES[resource].itemType === itemType,
  );
}

export function capacityClaimRequirements(
  record: PlatformRecord,
): readonly UniqueClaimRequirement[] {
  const holding = capacityHolding(record);
  if (!holding || holding.slot === undefined) return [];
  return [
    {
      namespace: capacityClaimNamespace(holding.organizationId, holding.resource),
      ownerId: holding.ownerId,
      ownerItemType: record.itemType,
      ownerPk: record.pk,
      ownerSk: record.sk,
      ownerTable: tableForItemType(record.itemType),
      value: String(holding.slot),
    },
  ];
}
