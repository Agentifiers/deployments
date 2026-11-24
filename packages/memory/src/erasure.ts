import {
  MemoryErasureTargetReceiptRecord,
  MemoryProviderPurgeCheckpointRecord,
  canonicalRecordKeys,
  key,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  Ulid,
  memoryPersistence,
} from "@deployments-ai/db";
import type {
  MemorySearchErasureReceipt,
  MemorySearchErasureResult,
} from "@deployments-ai/governance";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import { memorySearchPlacementKey } from "./placement.ts";
import { makeMemorySearchRegistration } from "./control-plane-registration.ts";
import { memorySearchMembershipShard, resolveMemorySearchTargetMembership } from "./membership.ts";
import type { MemorySearchProviderRegistry, MemorySearchTarget } from "./provider.ts";
import { drainMemorySearchTarget } from "./provider-drain.ts";
import { parseTenantPurgeOutcome, requireBoundaryContinuity } from "./erasure-provider-outcome.ts";
import {
  MEMORY_SEARCH_COMPACTION_BUDGET_MS,
  memorySearchTargetCompactionOperations,
} from "./control-plane-target-compaction.ts";
import { awsNativeTargetLocation } from "./aws-native-contracts.ts";
import { memorySearchIndexOwnership } from "./search-index-ownership.ts";
import {
  MEMORY_SEARCH_RETIREMENT_BATCH,
  memorySearchIndexRetirement,
} from "./search-index-retirement.ts";

type Component = Extract<PlatformRecord, { readonly itemType: "memory-search-component" }>;
type ErasureReceipt = Extract<
  PlatformRecord,
  { readonly itemType: "memory-erasure-target-receipt" }
>;
type PurgeCheckpoint = Extract<
  PlatformRecord,
  { readonly itemType: "memory-provider-purge-checkpoint" }
>;
type CleanupReceipt = Extract<
  PlatformRecord,
  { readonly itemType: "memory-target-cleanup-receipt" }
>;
type TargetComponent = {
  readonly component: Component;
  readonly componentId: Ulid;
  readonly existing?: ErasureReceipt;
  readonly receiptId: Ulid;
};

export interface PseudonymousProviderProof {
  readonly absenceVerified: true;
  readonly receiptDigest: string;
}

type TargetErasure = MemorySearchErasureReceipt["targets"][number];

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function deterministicReceiptId(operationId: Ulid, targetId: Ulid, componentId: Ulid): Ulid {
  const bytes = createHash("sha256")
    .update(operationId)
    .update("\0")
    .update(targetId)
    .update("\0")
    .update(componentId)
    .digest()
    .subarray(0, 16);
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD_BASE32[Number(value & 31n)]! + encoded;
    value >>= 5n;
  }
  return encoded as Ulid;
}

async function strongRecord(
  database: DynamoDatabaseService,
  itemType: PlatformRecord["itemType"],
  data: Readonly<Record<string, unknown>>,
) {
  const keys = canonicalRecordKeys({ data, itemType }, "control");
  return await memoryPersistence.read(database, "control", { pk: keys.pk, sk: keys.sk }, true);
}

function persistedProviderProof(
  receipt: ErasureReceipt,
  componentId: Ulid,
): PseudonymousProviderProof {
  const componentReceipt = receipt.data.componentReceipts[0];
  if (
    receipt.data.componentReceipts.length !== 1 ||
    !componentReceipt ||
    componentReceipt.componentId !== componentId ||
    typeof componentReceipt.providerReceipt !== "object" ||
    componentReceipt.providerReceipt === null ||
    !("receiptDigest" in componentReceipt.providerReceipt) ||
    typeof componentReceipt.providerReceipt.receiptDigest !== "string" ||
    componentReceipt.providerReceipt.absenceVerified !== true
  ) {
    throw new Error("Persisted memory erasure receipt does not match its target component.");
  }
  return { absenceVerified: true, receiptDigest: componentReceipt.providerReceipt.receiptDigest };
}

function latestBoundary(boundaries: readonly (string | undefined)[]) {
  return boundaries.reduce<string | undefined>(
    (latest, boundary) =>
      boundary !== undefined && (latest === undefined || Date.parse(boundary) > Date.parse(latest))
        ? boundary
        : latest,
    undefined,
  );
}

function settledTargetErasure(
  target: MemorySearchTarget,
  settled: readonly { readonly componentId: Ulid; readonly existing: ErasureReceipt }[],
): TargetErasure {
  const backupErasureEligibleAt = latestBoundary(
    settled.map(({ existing }) => existing.data.backupErasureEligibleAt),
  );
  return {
    ...(backupErasureEligibleAt ? { backupErasureEligibleAt } : {}),
    componentReceipts: settled.map(({ componentId, existing }) => ({
      componentId,
      generationId: existing.data.generationId,
      providerReceipt: persistedProviderProof(existing, componentId),
    })),
    providerId: target.providerId,
    targetDigest: settled[0]!.existing.data.targetDigest,
  };
}

/**
 * The catalog records to retire with the target's index, when the organization alone owns the
 * index and nothing outside the target still uses its catalog. Otherwise the index stays.
 */
async function exclusiveIndexCatalog(args: {
  readonly approvedOpenSearchEndpoint: string;
  readonly database: DynamoDatabaseService;
  readonly organizationId: Ulid;
  readonly target: MemorySearchTarget;
}) {
  const { database, organizationId, target } = args;
  const ownership = await memorySearchIndexOwnership({
    approvedOrigin: new URL(args.approvedOpenSearchEndpoint).origin,
    database,
    organizationId,
    targets: [target],
  });
  if (ownership.kind !== "owned") return undefined;
  const retirement = await memorySearchIndexRetirement({
    database,
    index: awsNativeTargetLocation(target),
    organizationId,
    releaseTargets: true,
    targets: async () => [target],
  });
  return retirement.kind === "retire" ? retirement.records : undefined;
}

/**
 * Splits a retirement into the anchors that a retried erasure still reads, which the receipt
 * commit deletes, and the rest, which erasure deletes first in batches. The anchors are the
 * target's own component, generation, membership, live reference, their shard heads, owner,
 * identity, and profile, so the receipt commit stays bounded however many stale generations share
 * the location.
 */
function splitRetirement(
  records: readonly PlatformRecord[],
  target: MemorySearchTarget,
  digest: string,
) {
  const generationIds = new Set(
    records.flatMap((record) =>
      record.itemType === "memory-search-component" && target.componentIds.includes(record.data.id)
        ? [record.data.generationId]
        : [],
    ),
  );
  const ownEntry = (record: PlatformRecord) =>
    (record.itemType === "memory-search-generation-target" &&
      record.data.targetDigest === digest &&
      generationIds.has(record.data.generationId)) ||
    (record.itemType === "memory-search-generation-live-target" &&
      record.data.targetId === target.targetId);
  const anchorPartitions = new Set(records.filter(ownEntry).map((record) => record.pk));
  const isAnchor = (record: PlatformRecord) => {
    switch (record.itemType) {
      case "memory-search-component":
        return target.componentIds.includes(record.data.id);
      case "memory-search-generation":
        return generationIds.has(record.data.id);
      case "memory-search-generation-target":
      case "memory-search-generation-live-target":
        return ownEntry(record);
      case "memory-search-generation-target-shard":
      case "memory-search-generation-live-shard":
        return anchorPartitions.has(record.pk);
      case "memory-embedding-profile":
        return record.data.id === target.embeddingProfileId;
      default:
        return true;
    }
  };
  return {
    anchors: records.filter(isAnchor),
    rest: records.filter((record) => !isAnchor(record)),
  };
}

async function loadErasureTargetState(args: {
  readonly database: DynamoDatabaseService;
  readonly membershipDigest: (targetId: Ulid) => Promise<{
    readonly digest: string;
    readonly keyVersion: number;
  }>;
  readonly membershipDigests?: (targetId: Ulid) => Promise<
    readonly {
      readonly digest: string;
      readonly keyVersion: number;
    }[]
  >;
  readonly operationId: Ulid;
  readonly target: MemorySearchTarget;
}) {
  const components: TargetComponent[] = [];
  const retired: { readonly componentId: Ulid; readonly existing?: ErasureReceipt }[] = [];
  for (const componentId of args.target.componentIds) {
    const component = await strongRecord(args.database, "memory-search-component", {
      id: componentId,
    });
    const receiptId = deterministicReceiptId(args.operationId, args.target.targetId, componentId);
    const existing = await strongRecord(args.database, "memory-erasure-target-receipt", {
      id: receiptId,
    });
    if (existing && existing.itemType !== "memory-erasure-target-receipt") {
      throw new Error("Deterministic erasure receipt identity is occupied.");
    }
    if (!component || component.itemType !== "memory-search-component") {
      retired.push({ componentId, ...(existing ? { existing } : {}) });
      continue;
    }
    components.push({
      component: component as Component,
      componentId,
      ...(existing ? { existing } : {}),
      receiptId,
    });
  }
  if (retired.length > 0) {
    // Erasure retires a dropped index's catalog in the transaction that writes every receipt.
    const settled = [...components, ...retired].map(({ componentId, existing }) => {
      if (!existing) throw new Error("Memory search component disappeared during erasure.");
      return { componentId, existing };
    });
    return { erasure: settledTargetErasure(args.target, settled), kind: "settled" } as const;
  }
  const digestCandidates = args.membershipDigests
    ? await args.membershipDigests(args.target.targetId)
    : [await args.membershipDigest(args.target.targetId)];
  const { digest, keyVersion } = await resolveMemorySearchTargetMembership({
    components: components.map(({ component }) => component),
    database: args.database,
    digestCandidates,
  });
  for (const { component, existing } of components) {
    if (
      existing &&
      (existing.data.generationId !== component.data.generationId ||
        existing.data.targetDigest !== digest ||
        existing.data.keyVersion !== keyVersion)
    ) {
      throw new Error("Persisted memory erasure receipt does not match the target catalog.");
    }
  }
  return { components, digest, keyVersion, kind: "purge", target: args.target } as const;
}

export function pseudonymousMemoryProviderReceipt(
  targetDigest: string,
  providerReceipt: Readonly<Record<string, unknown>>,
): PseudonymousProviderProof {
  return {
    absenceVerified: true,
    receiptDigest: createHash("sha256")
      .update(targetDigest)
      .update(JSON.stringify(providerReceipt))
      .digest("hex"),
  };
}

async function compactHistoricalCleanupReceipts(args: {
  readonly database: DynamoDatabaseService;
  readonly now: Date;
  readonly operationId: Ulid;
  readonly organizationId: Ulid;
}): Promise<"complete" | "pending"> {
  const page = await memoryPersistence.find(args.database, "control", {
    ConsistentRead: true,
    ExpressionAttributeValues: {
      ":pk": key("ORG", args.organizationId),
      ":prefix": `${key("MEMORY-TARGET-CLEANUP-RECEIPT")}#`,
    },
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    Limit: 40,
  });
  const receipts = page.items.filter(
    (record): record is CleanupReceipt => record.itemType === "memory-target-cleanup-receipt",
  );
  if (receipts.length === 0) return "complete";
  const operations: TransactionOperation[] = [];
  for (const receipt of receipts) {
    const componentReceipt = receipt.data.componentReceipts[0] as
      | Readonly<Record<string, unknown>>
      | undefined;
    const componentId = Schema.decodeUnknownSync(Ulid)(componentReceipt?.componentId);
    const providerReceipt = componentReceipt?.providerReceipt;
    if (
      receipt.data.componentReceipts.length !== 1 ||
      !providerReceipt ||
      typeof providerReceipt !== "object" ||
      Array.isArray(providerReceipt) ||
      (providerReceipt as Readonly<Record<string, unknown>>).absenceVerified !== true
    ) {
      throw new Error("Historical memory cleanup receipt has no provider absence proof.");
    }
    const membership = await strongRecord(args.database, "memory-search-generation-target", {
      generationId: receipt.data.generationId,
      membershipShard: memorySearchMembershipShard(receipt.data.targetDigest),
      targetDigest: receipt.data.targetDigest,
    });
    if (
      !membership ||
      membership.itemType !== "memory-search-generation-target" ||
      membership.data.keyVersion !== receipt.data.keyVersion ||
      membership.data.targetDigest !== receipt.data.targetDigest
    ) {
      throw new Error("Historical memory cleanup receipt does not match target membership.");
    }
    const proof = pseudonymousMemoryProviderReceipt(
      receipt.data.targetDigest,
      providerReceipt as Readonly<Record<string, unknown>>,
    );
    const replacementId = deterministicReceiptId(
      args.operationId,
      receipt.data.targetId,
      componentId,
    );
    const existing = await strongRecord(args.database, "memory-erasure-target-receipt", {
      id: replacementId,
    });
    if (existing && existing.itemType !== "memory-erasure-target-receipt") {
      throw new Error("Historical erasure receipt identity is occupied.");
    }
    if (existing) {
      const existingProof = persistedProviderProof(existing, componentId);
      if (
        existing.data.generationId !== receipt.data.generationId ||
        existing.data.keyVersion !== receipt.data.keyVersion ||
        existing.data.targetDigest !== receipt.data.targetDigest ||
        existingProof.receiptDigest !== proof.receiptDigest
      ) {
        throw new Error("Historical erasure receipt does not match cleanup evidence.");
      }
    } else {
      operations.push({
        conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        kind: "put",
        record: Schema.decodeUnknownSync(MemoryErasureTargetReceiptRecord)(
          withCanonicalRecordKeys({
            data: {
              acceptedAt: args.now.toISOString(),
              componentReceipts: [{ componentId, providerReceipt: proof }],
              createdAt: args.now.toISOString(),
              generationId: receipt.data.generationId,
              id: replacementId,
              keyVersion: receipt.data.keyVersion,
              targetDigest: receipt.data.targetDigest,
              updatedAt: args.now.toISOString(),
              version: 0,
            },
            itemType: "memory-erasure-target-receipt" as const,
          }),
        ),
      });
    }
    operations.push({ kind: "delete", record: receipt });
  }
  if (!memoryPersistence.supportsErasure(args.database)) {
    throw new Error("Erasure-owner-aware memory persistence is unavailable.");
  }
  await memoryPersistence.commitErasure(args.database, operations, {
    operationId: args.operationId,
    organizationId: args.organizationId,
  });
  return page.lastEvaluatedKey ? "pending" : "complete";
}

export function makeMemorySearchErasurePurger(args: {
  /** Erasure drops only an index on this domain that the organization alone owns. */
  readonly approvedOpenSearchEndpoint?: string;
  readonly database: DynamoDatabaseService;
  readonly membershipDigest: (targetId: Ulid) => Promise<{
    readonly digest: string;
    readonly keyVersion: number;
  }>;
  readonly membershipDigests?: (targetId: Ulid) => Promise<
    readonly {
      readonly digest: string;
      readonly keyVersion: number;
    }[]
  >;
  readonly now?: () => Date;
  readonly registry: MemorySearchProviderRegistry;
}) {
  const now = args.now ?? (() => new Date());
  const registration = makeMemorySearchRegistration({
    database: args.database,
    membershipDigest: args.membershipDigest,
    ...(args.membershipDigests ? { membershipDigests: args.membershipDigests } : {}),
    now,
  });
  return async (organizationId: Ulid, operationId: Ulid): Promise<MemorySearchErasureResult> => {
    const compactionDeadline = now().getTime() + MEMORY_SEARCH_COMPACTION_BUDGET_MS;
    const historicalCompaction = await compactHistoricalCleanupReceipts({
      database: args.database,
      now: now(),
      operationId,
      organizationId,
    });
    if (historicalCompaction === "pending") {
      return { reason: "cleanup_receipts_compacting", status: "pending" };
    }
    const placementRecord = await memoryPersistence.read(
      args.database,
      "control",
      memorySearchPlacementKey(organizationId),
      true,
    );
    if (!placementRecord || placementRecord.itemType !== "memory-search-placement") {
      throw new Error("Memory search placement is unavailable; erasure remains pending.");
    }
    const data = placementRecord.data;
    const targets = [data.readTarget, ...data.writeTargets, data.candidateTarget].filter(
      (target): target is MemorySearchTarget => target !== undefined,
    );
    const uniqueTargets = [...new Map(targets.map((target) => [target.targetId, target])).values()];
    const receipts: TargetErasure[] = [];
    const targetStates = await Promise.all(
      uniqueTargets.map((target) =>
        loadErasureTargetState({
          database: args.database,
          membershipDigest: args.membershipDigest,
          ...(args.membershipDigests ? { membershipDigests: args.membershipDigests } : {}),
          operationId,
          target,
        }),
      ),
    );
    const drainStates = await Promise.all(
      targetStates
        .flatMap((state) =>
          state.kind === "purge" && state.components.some(({ existing }) => !existing)
            ? [state.target]
            : [],
        )
        .map((target) =>
          drainMemorySearchTarget({
            database: args.database,
            erasureOwned: true,
            now: now(),
            operationId,
            organizationId,
            targetId: target.targetId,
          }),
        ),
    );
    if (drainStates.some((drained) => !drained)) {
      return { reason: "provider_mutations_draining", status: "pending" };
    }
    let livePurgePending = false;
    for (const state of targetStates) {
      if (state.kind === "settled") {
        receipts.push(state.erasure);
        continue;
      }
      const { components, digest, keyVersion, target } = state;
      if (components.every(({ existing }) => existing !== undefined)) {
        receipts.push(
          settledTargetErasure(
            target,
            components.map(({ componentId, existing }) => ({ componentId, existing: existing! })),
          ),
        );
        continue;
      }
      const compaction = await memorySearchTargetCompactionOperations({
        database: args.database,
        deadline: compactionDeadline,
        erasureOwner: { operationId, organizationId },
        now,
        organizationId,
        targetId: target.targetId,
      });
      if (compaction.status === "pending") {
        return { reason: "target_records_compacting", status: "pending" };
      }
      const timestamp = now().toISOString();
      const checkpointValue = await strongRecord(
        args.database,
        "memory-provider-purge-checkpoint",
        {
          operationId,
          organizationId,
          targetId: target.targetId,
        },
      );
      if (checkpointValue && checkpointValue.itemType !== "memory-provider-purge-checkpoint") {
        throw new Error("Provider purge checkpoint identity is occupied.");
      }
      const purgeCheckpoint = checkpointValue as PurgeCheckpoint | undefined;
      const provider = await args.registry.resolve(target);
      if (!provider.purgeOrganization) {
        throw new Error(`${target.providerId} does not implement organization purge.`);
      }
      // The drop precedes the purge, which then finds the index absent and anchors the backup
      // boundary after the deletion. An index that is shared, or whose catalog something else
      // still uses, keeps the delete-by-query purge.
      const retiredCatalog =
        provider.dropOrganizationIndex && args.approvedOpenSearchEndpoint
          ? await exclusiveIndexCatalog({
              approvedOpenSearchEndpoint: args.approvedOpenSearchEndpoint,
              database: args.database,
              organizationId,
              target,
            })
          : undefined;
      const indexDrop =
        retiredCatalog && provider.dropOrganizationIndex
          ? await provider.dropOrganizationIndex({ organizationId })
          : undefined;
      const providerReceipt = await provider.purgeOrganization({
        organizationId,
        ...(purgeCheckpoint
          ? {
              providerPurgeStartedAt: purgeCheckpoint.data.providerPurgeStartedAt,
              ...(purgeCheckpoint.data.providerReceipt.providerPurgeState &&
              typeof purgeCheckpoint.data.providerReceipt.providerPurgeState === "object"
                ? {
                    providerPurgeState: purgeCheckpoint.data.providerReceipt
                      .providerPurgeState as Readonly<Record<string, unknown>>,
                  }
                : {}),
            }
          : {}),
      });
      const outcome = parseTenantPurgeOutcome(target.providerId, providerReceipt.receipt);
      requireBoundaryContinuity(purgeCheckpoint?.data, outcome);
      if (!memoryPersistence.supportsErasure(args.database)) {
        throw new Error("Erasure-owner-aware memory persistence is unavailable.");
      }
      switch (outcome.kind) {
        case "live-purge-running": {
          const checkpoint = Schema.decodeUnknownSync(MemoryProviderPurgeCheckpointRecord)(
            withCanonicalRecordKeys({
              data: {
                backupErasureEligibleAt: outcome.boundary.backupErasureEligibleAt,
                createdAt: purgeCheckpoint?.data.createdAt ?? timestamp,
                operationId,
                organizationId,
                providerId: target.providerId,
                providerPurgeStartedAt: outcome.boundary.providerPurgeStartedAt,
                providerReceipt: outcome.receipt,
                targetId: target.targetId,
                updatedAt: timestamp,
                version: (purgeCheckpoint?.data.version ?? -1) + 1,
              },
              itemType: "memory-provider-purge-checkpoint" as const,
            }),
          );
          await memoryPersistence.commitErasure(
            args.database,
            [
              {
                ...(!purgeCheckpoint
                  ? {
                      conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                    }
                  : { previousRecord: purgeCheckpoint }),
                kind: "put",
                record: checkpoint,
              },
            ],
            { operationId, organizationId },
          );
          livePurgePending = true;
          continue;
        }
        case "live-purge-verified":
          break;
        default: {
          const _exhaustive: never = outcome;
          throw _exhaustive;
        }
      }
      const providerProof = pseudonymousMemoryProviderReceipt(
        digest,
        indexDrop ? { ...outcome.receipt, indexDrop } : outcome.receipt,
      );
      const verifiedBoundary = outcome.boundary?.backupErasureEligibleAt;
      const componentReceipts: TargetErasure["componentReceipts"][number][] = [];
      const operations: TransactionOperation[] = [];
      if (purgeCheckpoint) operations.push({ kind: "delete", record: purgeCheckpoint });
      for (const { component, componentId, existing, receiptId } of components) {
        const proof = existing ? persistedProviderProof(existing, componentId) : providerProof;
        componentReceipts.push({
          componentId,
          generationId: component.data.generationId,
          providerReceipt: proof,
        });
        if (existing) continue;
        const receipt = Schema.decodeUnknownSync(MemoryErasureTargetReceiptRecord)(
          withCanonicalRecordKeys({
            data: {
              acceptedAt: timestamp,
              ...(verifiedBoundary ? { backupErasureEligibleAt: verifiedBoundary } : {}),
              componentReceipts: [
                {
                  componentId,
                  providerReceipt: proof,
                },
              ],
              createdAt: timestamp,
              generationId: component.data.generationId,
              id: receiptId,
              keyVersion,
              targetDigest: digest,
              updatedAt: timestamp,
              version: 0,
            },
            itemType: "memory-erasure-target-receipt" as const,
          }),
        );
        operations.push({
          conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          kind: "put",
          record: receipt,
        });
      }
      if (retiredCatalog) {
        const { anchors, rest } = splitRetirement(retiredCatalog, target, digest);
        for (let start = 0; start < rest.length; start += MEMORY_SEARCH_RETIREMENT_BATCH) {
          await memoryPersistence.commitErasure(
            args.database,
            rest
              .slice(start, start + MEMORY_SEARCH_RETIREMENT_BATCH)
              .map((record) => ({ kind: "delete" as const, record })),
            { operationId, organizationId },
          );
        }
        operations.push(...anchors.map((record) => ({ kind: "delete" as const, record })));
      } else {
        operations.push(...(await registration.removeLiveReferenceOperations(target, timestamp)));
      }
      operations.push(...compaction.operations);
      await memoryPersistence.commitErasure(args.database, operations, {
        operationId,
        organizationId,
      });
      const backupErasureEligibleAt = latestBoundary([
        verifiedBoundary,
        ...components.map(({ existing }) => existing?.data.backupErasureEligibleAt),
      ]);
      receipts.push({
        ...(backupErasureEligibleAt ? { backupErasureEligibleAt } : {}),
        componentReceipts,
        providerId: target.providerId,
        targetDigest: digest,
      });
    }
    if (livePurgePending) {
      return { reason: "live_purge_running", status: "pending" };
    }
    return { receipt: { operationId, targets: receipts }, status: "complete" };
  };
}
