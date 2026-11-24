import {
  MemorySearchEvidenceManifestRecord,
  MemorySearchPlacementRecord,
  MemorySearchProvisioningRecord,
  type PlatformRecord,
  type Ulid,
  memoryPersistence,
} from "@deployments-ai/db";
import { transactWithSemanticEvents } from "@deployments-ai/events";
import { resolveMemorySearchTargetMembership } from "./membership.ts";
import {
  decodeMemorySearchRecord as decode,
  makeMemorySearchControlEvent,
  memorySearchEventPayload,
  memoryTargetCleanupReceiptOperations,
  optionalMemorySearchRecord,
  requiredMemorySearchPlacement,
  targetCleanupComponents,
  withoutMemorySearchOperationLease,
} from "./control-plane-support.ts";
import type { MemorySearchControlPlaneDependencies } from "./control-plane-types.ts";
import { MemorySearchControlPlaneError } from "./control-plane-types.ts";
import {
  MEMORY_SEARCH_COMPACTION_BUDGET_MS,
  memorySearchTargetCompactionOperations,
} from "./control-plane-target-compaction.ts";
import {
  matchesMemorySearchOperationFence,
  type MemorySearchOperationFence,
} from "./control-plane-operation-fence.ts";
import type { MemorySearchTarget } from "./provider.ts";
import { drainMemorySearchTarget } from "./provider-drain.ts";

type Placement = Extract<PlatformRecord, { readonly itemType: "memory-search-placement" }>;
type Provisioning = Extract<PlatformRecord, { readonly itemType: "memory-search-provisioning" }>;

async function purgeProvisioningTarget(args: {
  readonly dependencies: MemorySearchControlPlaneDependencies;
  readonly now: Date;
  readonly operation: Provisioning;
  readonly target: MemorySearchTarget;
}) {
  const provider = await args.dependencies.registry!.resolve(args.target);
  if (!provider.purgeOrganization) {
    throw new MemorySearchControlPlaneError("Provider does not implement organization purge.");
  }
  const purged = await provider.purgeOrganization({
    organizationId: args.operation.data.organizationId,
    ...(args.operation.data.providerPurgeStartedAt
      ? { providerPurgeStartedAt: args.operation.data.providerPurgeStartedAt }
      : {}),
    ...(args.operation.data.providerPurgeState
      ? { providerPurgeState: args.operation.data.providerPurgeState }
      : {}),
  });
  if (purged.receipt.absenceVerified === true) {
    if (
      args.operation.data.backupErasureEligibleAt &&
      (purged.receipt.backupErasureEligibleAt !== args.operation.data.backupErasureEligibleAt ||
        purged.receipt.providerPurgeStartedAt !== args.operation.data.providerPurgeStartedAt ||
        args.now.getTime() < Date.parse(args.operation.data.backupErasureEligibleAt))
    ) {
      throw new Error("Provider completed provisioning abort against an invalid backup boundary.");
    }
    return purged;
  }
  const providerPurgeStartedAt = purged.receipt.providerPurgeStartedAt;
  const backupErasureEligibleAt = purged.receipt.backupErasureEligibleAt;
  if (typeof providerPurgeStartedAt !== "string" || typeof backupErasureEligibleAt !== "string") {
    throw new Error("Provider provisioning abort returned no durable backup boundary.");
  }
  const startedAt = Date.parse(providerPurgeStartedAt);
  const eligibleAt = Date.parse(backupErasureEligibleAt);
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(eligibleAt) ||
    eligibleAt <= startedAt ||
    (args.operation.data.providerPurgeStartedAt &&
      args.operation.data.providerPurgeStartedAt !== providerPurgeStartedAt) ||
    (args.operation.data.backupErasureEligibleAt &&
      eligibleAt < Date.parse(args.operation.data.backupErasureEligibleAt))
  ) {
    throw new Error("Provider provisioning abort changed its durable backup boundary.");
  }
  const timestamp = args.now.toISOString();
  const {
    nextAction: _action,
    nextActionAt: _due,
    ...operationData
  } = withoutMemorySearchOperationLease(args.operation.data);
  const providerTaskPending =
    purged.receipt.providerPurgeState &&
    typeof purged.receipt.providerPurgeState === "object" &&
    (purged.receipt.providerPurgeState as Readonly<Record<string, unknown>>).stage !==
      "backup-wait";
  const waiting = decode(MemorySearchProvisioningRecord, {
    data: {
      ...operationData,
      actionGeneration: args.operation.data.actionGeneration + 1,
      backupErasureEligibleAt,
      nextAction: "abort-provisioning",
      nextActionAt: providerTaskPending ? timestamp : backupErasureEligibleAt,
      providerPurgeStartedAt,
      ...(purged.receipt.providerPurgeState && typeof purged.receipt.providerPurgeState === "object"
        ? { providerPurgeState: purged.receipt.providerPurgeState }
        : {}),
      status: "waiting" as const,
      updatedAt: timestamp,
      version: args.operation.data.version + 1,
    },
    itemType: "memory-search-provisioning" as const,
  }) as Provisioning;
  await memoryPersistence.commit(args.dependencies.database, [
    { kind: "put", previousRecord: args.operation, record: waiting },
  ]);
  throw new MemorySearchControlPlaneError("Provider backup erasure remains pending.");
}

export function makeMemorySearchProvisioningAbort(
  dependencies: MemorySearchControlPlaneDependencies,
  references: {
    readonly live: (
      placement: Placement,
      operationId: Ulid,
      timestamp: string,
    ) => Promise<readonly import("@deployments-ai/db").TransactionOperation[]>;
    readonly remove: (
      target: MemorySearchTarget,
      timestamp: string,
    ) => Promise<readonly import("@deployments-ai/db").TransactionOperation[]>;
  },
) {
  const { database, generateId, membershipDigest } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const event = makeMemorySearchControlEvent(generateId, now);
  return async (organizationId: Ulid, expected?: MemorySearchOperationFence) => {
    if (!dependencies.registry) {
      throw new MemorySearchControlPlaneError("Provider registry is required for abort cleanup.");
    }
    const previous = await requiredMemorySearchPlacement(database, organizationId);
    if (
      !["active", "provisioning"].includes(previous.data.phase) ||
      !previous.data.operationId ||
      !previous.data.candidateTarget ||
      (expected !== undefined && previous.data.operationId !== expected.operationId)
    ) {
      throw new MemorySearchControlPlaneError("Placement has no abortable provisioning target.");
    }
    let operation = await optionalMemorySearchRecord(database, "memory-search-provisioning", {
      id: previous.data.operationId,
      organizationId,
    });
    if (!operation || (expected && !matchesMemorySearchOperationFence(operation, expected))) {
      throw new MemorySearchControlPlaneError("Provisioning operation is missing or stale.");
    }
    const target = previous.data.candidateTarget;
    const migration = previous.data.phase === "active";
    if (operation.data.phase !== "aborting") {
      const timestamp = now().toISOString();
      const {
        nextAction: _action,
        nextActionAt: _due,
        ...operationData
      } = withoutMemorySearchOperationLease(operation.data);
      const aborting = decode(MemorySearchProvisioningRecord, {
        data: {
          ...operationData,
          actionGeneration: operation.data.actionGeneration + 1,
          nextAction: "abort-provisioning",
          nextActionAt: timestamp,
          phase: "aborting",
          status: "pending" as const,
          updatedAt: timestamp,
          version: operation.data.version + 1,
        },
        itemType: "memory-search-provisioning" as const,
      }) as Provisioning;
      await memoryPersistence.commit(database, [
        { kind: "put", previousRecord: operation, record: aborting },
      ]);
      operation = aborting;
    }
    const drained = await drainMemorySearchTarget({
      database,
      now: now(),
      operationId: operation.data.id,
      organizationId,
      targetId: target.targetId,
    });
    if (!drained) {
      throw new MemorySearchControlPlaneError(
        "Memory provider mutations are draining; provisioning abort remains pending.",
      );
    }
    const targetCompaction = await memorySearchTargetCompactionOperations({
      database,
      deadline: now().getTime() + MEMORY_SEARCH_COMPACTION_BUDGET_MS,
      now,
      organizationId,
      targetId: target.targetId,
    });
    if (targetCompaction.status === "pending") {
      throw new Error("Memory search target compaction remains pending.");
    }
    const components = await targetCleanupComponents(database, target);
    const purged = await purgeProvisioningTarget({
      dependencies,
      now: now(),
      operation,
      target,
    });
    const digestCandidates = dependencies.membershipDigests
      ? await dependencies.membershipDigests(target.targetId)
      : [await membershipDigest(target.targetId)];
    const { digest, keyVersion } = await resolveMemorySearchTargetMembership({
      components,
      database,
      digestCandidates,
    });
    const timestamp = now().toISOString();
    const receiptOperations = await memoryTargetCleanupReceiptOperations({
      components,
      generateId,
      keyVersion,
      organizationId,
      providerReceipt: purged.receipt,
      target,
      targetDigest: digest,
      timestamp,
    });
    const liveReferences = await references.remove(target, timestamp);
    const placement = decode(MemorySearchPlacementRecord, {
      data: migration
        ? {
            createdAt: previous.data.createdAt,
            generation: previous.data.generation + 1,
            organizationId,
            phase: "active" as const,
            readTarget: previous.data.readTarget!,
            updatedAt: timestamp,
            version: previous.data.version + 1,
            writeTargets: previous.data.writeTargets,
          }
        : {
            createdAt: previous.data.createdAt,
            generation: previous.data.generation + 1,
            organizationId,
            phase: "unconfigured" as const,
            updatedAt: timestamp,
            version: previous.data.version + 1,
            writeTargets: [],
          },
      itemType: "memory-search-placement" as const,
    }) as Placement;
    const restoredReferences = migration
      ? await references.live(placement, operation.data.id, timestamp)
      : [];
    const {
      nextAction: _action,
      nextActionAt: _due,
      ...operationData
    } = withoutMemorySearchOperationLease(operation.data);
    const aborted = decode(MemorySearchProvisioningRecord, {
      data: {
        ...operationData,
        actionGeneration: operation.data.actionGeneration + 1,
        eventVersion: operation.data.eventVersion + 1,
        phase: "aborted",
        placementGeneration: placement.data.generation,
        status: "aborted" as const,
        updatedAt: timestamp,
        version: operation.data.version + 1,
      },
      itemType: "memory-search-provisioning" as const,
    }) as Provisioning;
    const manifest = operation.data.evidenceManifestId
      ? await optionalMemorySearchRecord(database, "memory-search-evidence-manifest", {
          id: operation.data.evidenceManifestId,
          operationId: operation.data.id,
          organizationId,
        })
      : undefined;
    const cleanedManifest =
      manifest && manifest.data.status !== "clean"
        ? decode(MemorySearchEvidenceManifestRecord, {
            data: {
              ...manifest.data,
              status: "clean" as const,
              updatedAt: timestamp,
              version: manifest.data.version + 1,
            },
            itemType: "memory-search-evidence-manifest" as const,
          })
        : undefined;
    const abortedEvent = await event({
      eventType: migration
        ? "memory.search-placement.migration-aborted"
        : "memory.search-placement.provisioning-aborted",
      operationId: operation.data.id,
      organizationId,
      payload: memorySearchEventPayload(target, placement.data.phase),
      version: aborted.data.eventVersion,
    });
    await transactWithSemanticEvents(
      database,
      [
        ...receiptOperations,
        ...targetCompaction.operations,
        ...liveReferences,
        ...restoredReferences,
        ...(cleanedManifest
          ? [
              {
                kind: "put" as const,
                previousRecord: manifest!,
                record: cleanedManifest,
              },
            ]
          : []),
        { kind: "put", previousRecord: previous, record: placement },
        { kind: "put", previousRecord: operation, record: aborted },
      ],
      [abortedEvent],
    );
    return placement;
  };
}
