import {
  canonicalRecordKeys,
  key,
  MemoryTargetCleanupReceiptRecord,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
  memoryPersistence,
} from "@deployments-ai/db";
import { makeSemanticEventRecord } from "@deployments-ai/events";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import type { MemorySearchTarget } from "./provider.ts";

type Component = Extract<PlatformRecord, { readonly itemType: "memory-search-component" }>;

export function decodeMemorySearchRecord<RecordType>(
  schema: Schema.Codec<RecordType, unknown>,
  value: unknown,
) {
  return Schema.decodeUnknownSync(schema)(withCanonicalRecordKeys(value as never));
}

export function memorySearchOperationShard(value: string) {
  return createHash("sha256").update(value).digest().readUInt32BE(0) % 16;
}

export function validMemorySearchEvidenceKeys(keys: readonly string[]) {
  return keys.length > 0 && keys.length <= 100;
}

export function makeMemorySearchControlEvent(generateId: () => Promise<Ulid>, now: () => Date) {
  return async (args: {
    readonly eventType: string;
    readonly operationId: Ulid;
    readonly organizationId: Ulid;
    readonly payload: Readonly<Record<string, boolean | number | string>>;
    readonly version: number;
  }) =>
    makeSemanticEventRecord({
      aggregateId: args.operationId,
      aggregateType: "memory-search-operation",
      aggregateVersion: args.version,
      eventId: await generateId(),
      eventType: args.eventType,
      occurredAt: now(),
      organizationId: args.organizationId,
      payload: args.payload,
    });
}

export async function optionalMemorySearchRecord<ItemType extends PlatformRecord["itemType"]>(
  database: DynamoDatabaseService,
  itemType: ItemType,
  data: Readonly<Record<string, unknown>>,
): Promise<Extract<PlatformRecord, { readonly itemType: ItemType }> | undefined> {
  const keys = canonicalRecordKeys({ data, itemType }, "control");
  const value = await memoryPersistence.read(database, "control", keys, true);
  return value?.itemType === itemType
    ? (value as Extract<PlatformRecord, { readonly itemType: ItemType }>)
    : undefined;
}

export async function requiredMemorySearchPlacement(
  database: DynamoDatabaseService,
  organizationId: string,
) {
  const value = await memoryPersistence.read(
    database,
    "control",
    {
      pk: key("ORG", organizationId),
      sk: key("MEMORY-SEARCH-PLACEMENT", organizationId),
    },
    true,
  );
  if (!value || value.itemType !== "memory-search-placement") {
    throw new Error("Memory search placement is not configured.");
  }
  return value;
}

export function memorySearchEventPayload(target: MemorySearchTarget, phase: string) {
  return { phase, provider: target.providerId, targetId: target.targetId };
}

export function validateMemorySearchTarget(target: MemorySearchTarget) {
  if (
    target.componentIds.length === 0 ||
    new Set(target.componentIds).size !== target.componentIds.length
  ) {
    throw new Error("A memory search target requires unique components.");
  }
}

export function withoutMemorySearchOperationLease<
  Data extends {
    readonly dispatchCheckpoint?: string | undefined;
    readonly leaseExpiresAt?: string | undefined;
    readonly leaseOwner?: string | undefined;
  },
>(data: Data): Omit<Data, "dispatchCheckpoint" | "leaseExpiresAt" | "leaseOwner"> {
  const {
    dispatchCheckpoint: _dispatchCheckpoint,
    leaseExpiresAt: _leaseExpiresAt,
    leaseOwner: _leaseOwner,
    ...remaining
  } = data;
  return remaining;
}

export async function targetCleanupComponents(
  database: DynamoDatabaseService,
  target: MemorySearchTarget,
) {
  const components: Component[] = [];
  for (const componentId of target.componentIds) {
    const keys = canonicalRecordKeys(
      { data: { id: componentId }, itemType: "memory-search-component" },
      "control",
    );
    const value = await memoryPersistence.read(database, "control", keys, true);
    if (!value || value.itemType !== "memory-search-component") {
      throw new Error("Cleanup component is unavailable.");
    }
    components.push(value);
  }
  return components;
}

export async function memoryTargetCleanupReceiptOperations(args: {
  readonly components: readonly Component[];
  readonly generateId: () => Promise<Ulid>;
  readonly keyVersion: number;
  readonly organizationId: Ulid;
  readonly providerReceipt: Readonly<Record<string, unknown>>;
  readonly target: MemorySearchTarget;
  readonly targetDigest: string;
  readonly timestamp: string;
}): Promise<TransactionOperation[]> {
  return Promise.all(
    args.components.map(async (component) => {
      const componentId = component.data.id;
      const backupErasureEligibleAt = args.providerReceipt.backupErasureEligibleAt;
      const receipt = decodeMemorySearchRecord(MemoryTargetCleanupReceiptRecord, {
        data: {
          acceptedAt: args.timestamp,
          ...(typeof backupErasureEligibleAt === "string" ? { backupErasureEligibleAt } : {}),
          componentReceipts: [{ componentId, providerReceipt: args.providerReceipt }],
          createdAt: args.timestamp,
          generationId: component.data.generationId,
          id: await args.generateId(),
          keyVersion: args.keyVersion,
          organizationId: args.organizationId,
          targetDigest: args.targetDigest,
          targetId: args.target.targetId,
          updatedAt: args.timestamp,
          version: 0,
        },
        itemType: "memory-target-cleanup-receipt" as const,
      });
      return {
        conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        kind: "put" as const,
        record: receipt,
      };
    }),
  );
}
