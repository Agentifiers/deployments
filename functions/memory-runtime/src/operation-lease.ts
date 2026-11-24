import {
  canonicalRecordKeys,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
  memoryRuntimePersistence,
} from "@deployments-ai/db";

type Operation = Extract<PlatformRecord, { readonly itemType: "memory-search-provisioning" }>;

const DEFAULT_LEASE_MS = 16 * 60_000;

function operationLeaseMs() {
  const value = Number(process.env.DEPLOYMENTS_AI_MEMORY_OPERATION_LEASE_MS ?? DEFAULT_LEASE_MS);
  if (!Number.isSafeInteger(value) || value < 60_000 || value > 60 * 60_000) {
    throw new Error("DEPLOYMENTS_AI_MEMORY_OPERATION_LEASE_MS must be 60000 through 3600000.");
  }
  return value;
}

export async function claimMemorySearchOperation(args: {
  readonly actionGeneration: number;
  readonly database: DynamoDatabaseService;
  readonly leaseOwner: string;
  readonly nextAction: string;
  readonly now: Date;
  readonly operationId: Ulid;
  readonly organizationId: Ulid;
}) {
  const itemType = "memory-search-provisioning" as const;
  const value = await memoryRuntimePersistence.read(
    args.database,
    "control",
    canonicalRecordKeys(
      {
        data: { id: args.operationId, organizationId: args.organizationId },
        itemType,
      },
      "control",
    ),
    true,
  );
  if (
    !value ||
    value.itemType !== itemType ||
    value.data.actionGeneration !== args.actionGeneration ||
    value.data.nextAction !== args.nextAction ||
    value.data.status === "completed" ||
    value.data.status === "aborted"
  ) {
    return undefined;
  }
  const nextActionAt = value.data.nextActionAt ? Date.parse(value.data.nextActionAt) : Number.NaN;
  const leaseExpiresAt = value.data.leaseExpiresAt
    ? Date.parse(value.data.leaseExpiresAt)
    : Number.NaN;
  if (
    (Number.isFinite(nextActionAt) && nextActionAt > args.now.getTime()) ||
    (Number.isFinite(leaseExpiresAt) && leaseExpiresAt > args.now.getTime())
  ) {
    return undefined;
  }
  const timestamp = args.now.toISOString();
  const leaseRecoveryAt = new Date(args.now.getTime() + operationLeaseMs()).toISOString();
  const claimed = withCanonicalRecordKeys({
    data: {
      ...value.data,
      dispatchCheckpoint: `${args.actionGeneration}:${args.nextAction}`,
      leaseExpiresAt: leaseRecoveryAt,
      leaseOwner: args.leaseOwner,
      nextActionAt: leaseRecoveryAt,
      status: "running" as const,
      updatedAt: timestamp,
      version: value.data.version + 1,
    },
    itemType: value.itemType,
  }) as Operation;
  await memoryRuntimePersistence.commit(args.database, [
    { kind: "put", previousRecord: value, record: claimed },
  ]);
  return claimed;
}
