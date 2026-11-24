import {
  MemoryIndexJobRecord,
  MemoryProviderMutationGateRecord,
  key,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
  memoryPersistence,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { memoryProviderMutationClaimPrefix, memoryProviderMutationGateKey } from "./placement.ts";
import {
  resolveMemoryProviderMutationClaim,
  type MemoryProviderMutationClaim,
} from "./provider-mutation-claim.ts";

type Gate = Extract<PlatformRecord, { readonly itemType: "memory-provider-mutation-gate" }>;
type IndexJob = Extract<PlatformRecord, { readonly itemType: "memory-index-job" }>;

// Covers the 15-minute control-plane Lambda ceiling plus a one-minute safety margin.
export const PROVIDER_MUTATION_DRAIN_MS = 16 * 60_000;

function admissionJobKey(claim: MemoryProviderMutationClaim) {
  if (!claim.data.messageGroup.startsWith("index-job:")) return undefined;
  try {
    const tuple: unknown = JSON.parse(claim.data.mutationTuple);
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 3 ||
      tuple.some((value) => typeof value !== "string" || !value)
    ) {
      return undefined;
    }
    return { pk: tuple[0] as string, sk: tuple[1] as string };
  } catch {
    return undefined;
  }
}

async function writeDrainReconciliation(
  database: DynamoDatabaseService,
  operations: readonly TransactionOperation[],
  erasureOwner?: { readonly operationId: Ulid; readonly organizationId: Ulid },
) {
  if (erasureOwner) {
    if (!memoryPersistence.supportsErasure(database)) {
      throw new Error("Erasure-owner-aware memory persistence is unavailable.");
    }
    await memoryPersistence.commitErasure(database, operations, erasureOwner);
    return;
  }
  await memoryPersistence.commit(database, operations);
}

async function reconcileIndexAdmission(args: {
  readonly claim: MemoryProviderMutationClaim;
  readonly database: DynamoDatabaseService;
  readonly erasureOwner?: {
    readonly operationId: Ulid;
    readonly organizationId: Ulid;
  };
  readonly now: Date;
  readonly organizationId: Ulid;
  readonly targetId: Ulid;
}) {
  const jobKey = admissionJobKey(args.claim);
  if (!jobKey) {
    throw new Error("Memory index admission claim has invalid durable job coordinates.");
  }
  const value = await memoryPersistence.read(args.database, "execution", jobKey, true);
  const job = value?.itemType === "memory-index-job" ? (value as IndexJob) : undefined;
  const expectedId = args.claim.data.messageGroup.slice("index-job:".length);
  if (
    job &&
    (job.data.id !== expectedId ||
      job.data.organizationId !== args.organizationId ||
      job.data.targetId !== args.targetId)
  ) {
    throw new Error("Memory index admission claim resolved a mismatched durable job.");
  }
  const leaseExpiresAt = job?.data.leaseExpiresAt
    ? Date.parse(job.data.leaseExpiresAt)
    : Number.NaN;
  if (job?.data.status === "running" && leaseExpiresAt > args.now.getTime()) return true;
  const operations: TransactionOperation[] = [{ kind: "delete", record: args.claim }];
  if (job?.data.status === "queued" || job?.data.status === "running") {
    const {
      completedAt: _completed,
      leaseExpiresAt: _lease,
      leaseOwner: _owner,
      nextDueAt: _nextDueAt,
      ...jobData
    } = job.data;
    const terminal = Schema.decodeUnknownSync(MemoryIndexJobRecord)(
      withCanonicalRecordKeys({
        data: {
          ...jobData,
          error: "Memory index job was cancelled while its target drained.",
          skipReason: "target-draining",
          status: "failed" as const,
          updatedAt: args.now.toISOString(),
          version: job.data.version + 1,
        },
        itemType: "memory-index-job" as const,
      }),
    );
    operations.push({ kind: "put", previousRecord: job, record: terminal });
  }
  await writeDrainReconciliation(args.database, operations, args.erasureOwner);
  return false;
}

async function hasActiveMutationClaims(args: {
  readonly database: DynamoDatabaseService;
  readonly erasureOwner?: {
    readonly operationId: Ulid;
    readonly organizationId: Ulid;
  };
  readonly now: Date;
  readonly organizationId: Ulid;
  readonly targetId: Ulid;
}) {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await memoryPersistence.find(args.database, "control", {
      ConsistentRead: true,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      ExpressionAttributeValues: {
        ":pk": key("ORG", args.organizationId),
        ":prefix": memoryProviderMutationClaimPrefix(args.targetId),
      },
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    });
    for (const record of page.items) {
      if (record.itemType !== "memory-provider-mutation-claim") {
        throw new Error("Memory provider mutation claim query returned an invalid record.");
      }
      if (record.data.status === "claimed" || record.data.status === "ambiguous") {
        if (record.data.messageGroup.startsWith("index-job:")) {
          if (
            await reconcileIndexAdmission({
              claim: record,
              database: args.database,
              ...(args.erasureOwner ? { erasureOwner: args.erasureOwner } : {}),
              now: args.now,
              organizationId: args.organizationId,
              targetId: args.targetId,
            })
          ) {
            return true;
          }
          continue;
        }
        const ambiguityUntil = record.data.ambiguityUntil
          ? Date.parse(record.data.ambiguityUntil)
          : Number.NaN;
        if (!Number.isFinite(ambiguityUntil) || ambiguityUntil > args.now.getTime()) return true;
        const terminal = resolveMemoryProviderMutationClaim(record, "failed", args.now);
        await writeDrainReconciliation(
          args.database,
          [{ kind: "put", previousRecord: record, record: terminal }],
          args.erasureOwner,
        );
      }
    }
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey);
  return false;
}

export async function drainMemorySearchTarget(args: {
  readonly database: DynamoDatabaseService;
  readonly erasureOwned?: boolean;
  readonly now: Date;
  readonly operationId: Ulid;
  readonly organizationId: Ulid;
  readonly targetId: Ulid;
}) {
  const value = await memoryPersistence.read(
    args.database,
    "control",
    memoryProviderMutationGateKey(args.organizationId, args.targetId),
    true,
  );
  if (!value || value.itemType !== "memory-provider-mutation-gate") {
    throw new Error("Memory provider mutation gate is unavailable; purge is blocked.");
  }
  const previous = value as Gate;
  const takingErasureOwnership =
    args.erasureOwned === true &&
    previous.data.operationId !== undefined &&
    previous.data.operationId !== args.operationId;
  if (
    previous.data.operationId &&
    previous.data.operationId !== args.operationId &&
    !takingErasureOwnership
  ) {
    throw new Error("Memory provider mutation gate is owned by another operation.");
  }
  if (previous.data.status === "closed" && !takingErasureOwnership) return true;
  const timestamp = args.now.toISOString();
  const drainElapsed =
    previous.data.status === "draining" &&
    !takingErasureOwnership &&
    args.now.getTime() - Date.parse(previous.data.updatedAt) >= PROVIDER_MUTATION_DRAIN_MS;
  if (previous.data.status === "draining" && !drainElapsed && !takingErasureOwnership) return false;
  if (
    drainElapsed &&
    (await hasActiveMutationClaims({
      database: args.database,
      ...(args.erasureOwned
        ? {
            erasureOwner: {
              operationId: args.operationId,
              organizationId: args.organizationId,
            },
          }
        : {}),
      now: args.now,
      organizationId: args.organizationId,
      targetId: args.targetId,
    }))
  ) {
    return false;
  }
  const next = Schema.decodeUnknownSync(MemoryProviderMutationGateRecord)(
    withCanonicalRecordKeys({
      data: {
        ...previous.data,
        drainEpoch:
          previous.data.status === "open" || takingErasureOwnership
            ? previous.data.drainEpoch + 1
            : previous.data.drainEpoch,
        operationId: args.operationId,
        status:
          drainElapsed && !takingErasureOwnership ? ("closed" as const) : ("draining" as const),
        updatedAt: timestamp,
        version: previous.data.version + 1,
      },
      itemType: "memory-provider-mutation-gate" as const,
    }),
  );
  const operations = [{ kind: "put" as const, previousRecord: previous, record: next }];
  if (args.erasureOwned) {
    if (!memoryPersistence.supportsErasure(args.database)) {
      throw new Error("Erasure-owner-aware memory persistence is unavailable.");
    }
    await memoryPersistence.commitErasure(args.database, operations, {
      operationId: args.operationId,
      organizationId: args.organizationId,
    });
  } else {
    await memoryPersistence.commit(args.database, operations);
  }
  return next.data.status === "closed";
}
