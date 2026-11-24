import type { DynamoDatabaseService } from "../client-types.ts";
import { Keys, key } from "../keys.ts";
import { capacityClaimNamespace, type CapacityResource } from "./requirements.ts";

const MAX_SLOT_RACES = 3;

export type CapacityAcquisition<T> =
  | { readonly kind: "acquired"; readonly slot: number; readonly value: T }
  | { readonly kind: "at-capacity"; readonly inUse: number; readonly limit: number };

export interface SlotAcquireInput<T> {
  readonly limit: number;
  readonly holderId: string;
  readonly commit: (slot: number) => Promise<T>;
}

export interface CapacityAcquireInput<T> extends SlotAcquireInput<T> {
  readonly organizationId: string;
  readonly resource: CapacityResource;
}

export interface CapacityClaim {
  readonly ownerId: string;
  readonly ownerKey: { readonly pk: string; readonly sk: string };
  readonly slot: string;
}

export interface OrganizationCapacity {
  readonly acquire: <T>(input: CapacityAcquireInput<T>) => Promise<CapacityAcquisition<T>>;
  readonly claims: (
    organizationId: string,
    resource: CapacityResource,
  ) => Promise<readonly CapacityClaim[]>;
  readonly inUse: (organizationId: string, resource: CapacityResource) => Promise<number>;
}

export interface SlotClaims {
  readonly acquire: <T>(
    namespace: string,
    input: SlotAcquireInput<T>,
  ) => Promise<CapacityAcquisition<T>>;
  readonly claims: (namespace: string) => Promise<readonly CapacityClaim[]>;
}

export function makeSlotClaims(
  database: DynamoDatabaseService,
  random: () => number = Math.random,
): SlotClaims {
  const claims = async (namespace: string) => {
    const held: CapacityClaim[] = [];
    let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
    do {
      const page = await database.queryRecords("control", {
        ConsistentRead: true,
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: { ":pk": key("UNIQUE", namespace), ":sk": "VALUE#" },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
      });
      for (const record of page.items) {
        if (record.itemType !== "unique-claim") continue;
        held.push({
          ownerId: record.data.ownerId,
          ownerKey: { pk: record.data.ownerPk, sk: record.data.ownerSk },
          slot: record.data.value,
        });
      }
      exclusiveStartKey = page.lastEvaluatedKey;
    } while (exclusiveStartKey);
    return held;
  };

  const lostSlotRace = async (namespace: string, holderId: string, slot: number) => {
    const claim = await database.getRecord(
      "control",
      Keys.control.uniqueClaim(namespace, String(slot)),
      true,
    );
    return claim?.itemType === "unique-claim" && claim.data.ownerId !== holderId;
  };

  return {
    acquire: async (namespace, input) => {
      for (let attempt = 0; ; attempt += 1) {
        const held = new Set((await claims(namespace)).map((claim) => claim.slot));
        const free = Array.from({ length: input.limit }, (_, slot) => slot).filter(
          (slot) => !held.has(String(slot)),
        );
        if (held.size >= input.limit || free.length === 0 || attempt > MAX_SLOT_RACES) {
          return { inUse: held.size, kind: "at-capacity", limit: input.limit };
        }
        const slot = free[Math.floor(random() * free.length)] as number;
        try {
          return { kind: "acquired", slot, value: await input.commit(slot) };
        } catch (cause) {
          if (!(await lostSlotRace(namespace, input.holderId, slot))) throw cause;
        }
      }
    },
    claims,
  };
}

export function makeOrganizationCapacity(
  database: DynamoDatabaseService,
  random: () => number = Math.random,
): OrganizationCapacity {
  const slots = makeSlotClaims(database, random);
  const claims = (organizationId: string, resource: CapacityResource) =>
    slots.claims(capacityClaimNamespace(organizationId, resource));
  return {
    acquire: (input) =>
      slots.acquire(capacityClaimNamespace(input.organizationId, input.resource), input),
    claims,
    inUse: async (organizationId, resource) => (await claims(organizationId, resource)).length,
  };
}
