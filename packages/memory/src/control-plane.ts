import {
  MemorySearchEvidenceManifestRecord,
  MemorySearchPlacementRecord,
  MemorySearchProvisioningRecord,
  memoryPersistence,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { transactWithSemanticEvents } from "@deployments-ai/events";
import {
  requireCleanProvisioningEvidence,
  verifyProvisioningEvidence,
} from "./control-plane-evidence.ts";
import { openMemoryProviderMutationGateCondition } from "./control-plane-operation-fence.ts";
import { makeMemorySearchProvisioningAbort } from "./control-plane-provisioning-abort.ts";
import {
  makeMemorySearchRegistration,
  type MemorySearchCatalogRegistration,
} from "./control-plane-registration.ts";
import {
  decodeMemorySearchRecord as decode,
  makeMemorySearchControlEvent,
  memorySearchEventPayload as eventPayload,
  memorySearchOperationShard as shard,
  optionalMemorySearchRecord as optionalRecord,
  requiredMemorySearchPlacement as requiredPlacement,
  validMemorySearchEvidenceKeys,
  validateMemorySearchTarget as validateTarget,
} from "./control-plane-support.ts";
import {
  MemorySearchControlPlaneError,
  MemorySearchProvisioningStageError,
  type MemorySearchProvisioningStage,
  type MemorySearchControlPlaneDependencies,
} from "./control-plane-types.ts";
import type { MemorySearchTarget } from "./provider.ts";

export {
  MemorySearchControlPlaneError,
  MemorySearchProvisioningStageError,
  type MemorySearchCatalogRegistration,
  type MemorySearchControlPlaneDependencies,
  type MemorySearchProvisioningStage,
};

type Placement = Extract<PlatformRecord, { readonly itemType: "memory-search-placement" }>;
type Provisioning = Extract<PlatformRecord, { readonly itemType: "memory-search-provisioning" }>;

export function makeMemorySearchControlPlane(dependencies: MemorySearchControlPlaneDependencies) {
  const { database, generateId, membershipDigest } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const embedProvisioningEvidence =
    dependencies.embedProvisioningEvidence ??
    (async () => {
      throw new Error("Profile-pinned provisioning evidence embedding is unavailable.");
    });
  const {
    liveReferenceOperations,
    registerCatalog,
    registrationOperations,
    removeLiveReferenceOperations,
  } = makeMemorySearchRegistration({
    database,
    membershipDigest,
    ...(dependencies.membershipDigests
      ? { membershipDigests: dependencies.membershipDigests }
      : {}),
    now,
  });
  const event = makeMemorySearchControlEvent(generateId, now);
  const abortProvisioning = makeMemorySearchProvisioningAbort(dependencies, {
    live: liveReferenceOperations,
    remove: removeLiveReferenceOperations,
  });

  async function provisioningStage<Result>(
    stage: MemorySearchProvisioningStage,
    operation: () => Promise<Result>,
  ) {
    try {
      return await operation();
    } catch (cause) {
      throw new MemorySearchProvisioningStageError(stage, cause);
    }
  }

  async function requestProvisioning(args: {
    readonly evidenceKeys: readonly string[];
    readonly organizationId: Ulid;
    readonly target: MemorySearchTarget;
  }) {
    validateTarget(args.target);
    if (!validMemorySearchEvidenceKeys(args.evidenceKeys)) {
      throw new MemorySearchControlPlaneError("Provisioning requires a bounded evidence manifest.");
    }
    const previous = await requiredPlacement(database, args.organizationId);
    const migration = previous.data.phase === "active";
    if (
      previous.data.phase !== "unconfigured" &&
      (!migration || previous.data.candidateTarget || previous.data.operationId)
    ) {
      throw new MemorySearchControlPlaneError(
        "Only an unconfigured or stable active organization can be provisioned.",
      );
    }
    if (
      migration &&
      (!previous.data.readTarget ||
        previous.data.writeTargets.length !== 1 ||
        previous.data.writeTargets[0]?.targetId !== previous.data.readTarget.targetId)
    ) {
      throw new MemorySearchControlPlaneError("Active placement routing is invalid for migration.");
    }
    if (migration && previous.data.readTarget!.targetId === args.target.targetId) {
      throw new MemorySearchControlPlaneError("A migration candidate requires a new target ID.");
    }
    const timestamp = now().toISOString();
    const operationId = await generateId();
    const manifestId = await generateId();
    const placement = decode(MemorySearchPlacementRecord, {
      data: {
        ...previous.data,
        candidateTarget: args.target,
        generation: previous.data.generation + 1,
        operationId,
        phase: migration ? ("active" as const) : ("provisioning" as const),
        updatedAt: timestamp,
        version: previous.data.version + 1,
      },
      itemType: "memory-search-placement" as const,
    }) as Placement;
    const operation = decode(MemorySearchProvisioningRecord, {
      data: {
        actionGeneration: 0,
        createdAt: timestamp,
        evidenceManifestId: manifestId,
        eventVersion: 1,
        id: operationId,
        nextAction: "provision-components",
        nextActionAt: timestamp,
        operationShard: shard(operationId),
        organizationId: args.organizationId,
        phase: "requested",
        placementGeneration: placement.data.generation,
        status: "pending" as const,
        target: args.target,
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "memory-search-provisioning" as const,
    }) as Provisioning;
    const manifest = decode(MemorySearchEvidenceManifestRecord, {
      data: {
        componentLocations: args.target.componentIds.map((componentId) => ({ componentId })),
        createdAt: timestamp,
        evidenceKeys: [...args.evidenceKeys],
        id: manifestId,
        operationId,
        organizationId: args.organizationId,
        status: "manifested" as const,
        targetId: args.target.targetId,
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "memory-search-evidence-manifest" as const,
    });
    const registrations = await registrationOperations({
      operationId,
      organizationId: args.organizationId,
      placementGeneration: placement.data.generation,
      target: args.target,
      timestamp,
    });
    const requested = await event({
      eventType: migration
        ? "memory.search-placement.migration-requested"
        : "memory.search-placement.provisioning-requested",
      operationId,
      organizationId: args.organizationId,
      payload: eventPayload(args.target, placement.data.phase),
      version: operation.data.eventVersion,
    });
    await transactWithSemanticEvents(
      database,
      [
        { kind: "put", previousRecord: previous, record: placement },
        { kind: "put", record: operation },
        { kind: "put", record: manifest },
        ...registrations,
      ],
      [requested],
    );
    return { operation, placement };
  }

  async function activateProvisioning(
    organizationId: Ulid,
    operationId: Ulid,
    expectedActionGeneration: number,
  ) {
    const previous = await requiredPlacement(database, organizationId);
    const operation = await optionalRecord(database, "memory-search-provisioning", {
      id: operationId,
      organizationId,
    });
    if (
      !["active", "provisioning"].includes(previous.data.phase) ||
      previous.data.operationId !== operationId ||
      !previous.data.candidateTarget ||
      !operation ||
      operation.data.actionGeneration !== expectedActionGeneration ||
      !(
        (operation.data.phase === "requested" &&
          operation.data.nextAction === "provision-components" &&
          ["pending", "running"].includes(operation.data.status)) ||
        (operation.data.phase === "ready" && operation.data.status === "waiting")
      )
    ) {
      throw new MemorySearchControlPlaneError("Provisioning operation no longer owns placement.");
    }
    await requireCleanProvisioningEvidence(database, operation);
    const timestamp = now().toISOString();
    const target = previous.data.candidateTarget;
    const replacedTarget = previous.data.phase === "active" ? previous.data.readTarget : undefined;
    const placement = decode(MemorySearchPlacementRecord, {
      data: {
        createdAt: previous.data.createdAt,
        generation: previous.data.generation + 1,
        organizationId,
        phase: "active" as const,
        readTarget: target,
        updatedAt: timestamp,
        version: previous.data.version + 1,
        writeTargets: [target],
      },
      itemType: "memory-search-placement" as const,
    }) as Placement;
    const {
      dispatchCheckpoint: _dispatch,
      leaseExpiresAt: _lease,
      leaseOwner: _owner,
      nextAction: _action,
      nextActionAt: _due,
      ...operationData
    } = operation.data;
    const completed = decode(MemorySearchProvisioningRecord, {
      data: {
        ...operationData,
        actionGeneration: operation.data.actionGeneration + 1,
        eventVersion: operation.data.eventVersion + 1,
        phase: "completed",
        status: "completed" as const,
        updatedAt: timestamp,
        version: operation.data.version + 1,
      },
      itemType: "memory-search-provisioning" as const,
    }) as Provisioning;
    const activated = await event({
      eventType: replacedTarget
        ? "memory.search-placement.migrated"
        : "memory.search-placement.activated",
      operationId,
      organizationId,
      payload: eventPayload(target, placement.data.phase),
      version: completed.data.eventVersion,
    });
    const liveReferences = await liveReferenceOperations(placement, operationId, timestamp);
    const retiredReferences = replacedTarget
      ? await removeLiveReferenceOperations(replacedTarget, timestamp)
      : [];
    await transactWithSemanticEvents(
      database,
      [
        openMemoryProviderMutationGateCondition(organizationId, target.targetId),
        { kind: "put", previousRecord: previous, record: placement },
        { kind: "put", previousRecord: operation, record: completed },
        ...liveReferences,
        ...retiredReferences,
      ],
      [activated],
    );
    return placement;
  }

  async function prepareProvisioning(
    organizationId: Ulid,
    operationId: Ulid,
    expectedActionGeneration: number,
  ) {
    if (!dependencies.registry) {
      throw new MemorySearchControlPlaneError("Provider registry is required for provisioning.");
    }
    const placement = await requiredPlacement(database, organizationId);
    if (
      !["active", "provisioning"].includes(placement.data.phase) ||
      placement.data.operationId !== operationId ||
      !placement.data.candidateTarget
    ) {
      throw new MemorySearchControlPlaneError("Provisioning operation no longer owns placement.");
    }
    const operation = await optionalRecord(database, "memory-search-provisioning", {
      id: operationId,
      organizationId,
    });
    if (
      !operation ||
      operation.data.phase !== "requested" ||
      operation.data.actionGeneration !== expectedActionGeneration ||
      operation.data.nextAction !== "provision-components"
    ) {
      throw new MemorySearchControlPlaneError("Provisioning action is stale or no longer active.");
    }
    const provider = await provisioningStage("resolve-provider", () =>
      dependencies.registry!.resolve(placement.data.candidateTarget!),
    );
    if (!provider.prepare || !provider.readiness) {
      throw new MemorySearchControlPlaneError(
        "Provider does not implement provisioning readiness.",
      );
    }
    await provisioningStage("prepare-provider", () => provider.prepare!({ organizationId }));
    const readiness = await provisioningStage("read-provider-readiness", () =>
      provider.readiness!({ organizationId }),
    );
    if (!readiness.ready) {
      throw new MemorySearchControlPlaneError("Provider target is not ready.");
    }
    await provisioningStage("verify-evidence", () =>
      verifyProvisioningEvidence({
        database,
        embed: embedProvisioningEvidence,
        generateId,
        now,
        operation,
        provider,
        target: placement.data.candidateTarget!,
      }),
    );
    if (placement.data.phase === "active") {
      const timestamp = now().toISOString();
      const {
        dispatchCheckpoint: _dispatch,
        leaseExpiresAt: _lease,
        leaseOwner: _owner,
        nextAction: _action,
        nextActionAt: _due,
        ...operationData
      } = operation.data;
      const ready = decode(MemorySearchProvisioningRecord, {
        data: {
          ...operationData,
          actionGeneration: operation.data.actionGeneration + 1,
          phase: "ready",
          status: "waiting" as const,
          updatedAt: timestamp,
          version: operation.data.version + 1,
        },
        itemType: "memory-search-provisioning" as const,
      }) as Provisioning;
      await memoryPersistence.commit(database, [
        { kind: "put", previousRecord: operation, record: ready },
      ]);
      return placement;
    }
    return activateProvisioning(organizationId, operationId, expectedActionGeneration);
  }

  async function completeMigration(organizationId: Ulid, operationId: Ulid) {
    const operation = await optionalRecord(database, "memory-search-provisioning", {
      id: operationId,
      organizationId,
    });
    if (!operation || operation.data.phase !== "ready" || operation.data.status !== "waiting") {
      throw new MemorySearchControlPlaneError("Memory search migration is not ready to complete.");
    }
    return activateProvisioning(organizationId, operationId, operation.data.actionGeneration);
  }

  return {
    abortProvisioning,
    completeMigration,
    prepareProvisioning,
    registerCatalog,
    requestProvisioning,
  };
}
