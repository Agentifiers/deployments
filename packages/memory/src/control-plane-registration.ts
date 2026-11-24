import {
  MemoryEmbeddingProfileRecord,
  MemoryProviderMutationGateRecord,
  MemorySearchComponentRecord,
  MemorySearchTargetIdentityRecord,
  MemorySearchGenerationLiveShardRecord,
  MemorySearchGenerationLiveTargetRecord,
  MemorySearchGenerationRecord,
  MemorySearchGenerationTargetRecord,
  MemorySearchGenerationTargetShardRecord,
  canonicalRecordKeys,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type MemorySearchProviderId,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
  memoryPersistence,
} from "@deployments-ai/db";
import { Schema } from "effect";
import {
  AWS_NATIVE_AUTOMATED_SNAPSHOT_RETENTION_HOURS,
  AWS_NATIVE_BACKUP_SAFETY_MARGIN_MINUTES,
  requireAwsNativeBackupPolicy,
} from "./aws-native-contracts.ts";
import type { MemorySearchTarget } from "./provider.ts";
import { memorySearchMembershipShard } from "./membership.ts";
import { memorySearchTargetIdentity } from "./target-identity.ts";
import {
  physicalLocationHash,
  physicalOwnerRegistrationOperation,
  physicalOwnerRemovalOperation,
  requiredPhysicalField,
} from "./control-plane-physical-ownership.ts";

type Placement = Extract<PlatformRecord, { readonly itemType: "memory-search-placement" }>;
type LiveReference = Extract<
  PlatformRecord,
  { readonly itemType: "memory-search-generation-live-target" }
>;
type CatalogRecord = Extract<
  PlatformRecord,
  { readonly itemType: "memory-search-component" | "memory-search-generation" }
>;

/** An immutable embedding profile, provider generations, and components registered together. */
export interface MemorySearchCatalogRegistration {
  readonly components: readonly {
    readonly componentKind: "dense" | "lexical" | "namespace";
    readonly embeddingProfileId?: Ulid;
    readonly generationId: Ulid;
    readonly id: Ulid;
    readonly location: Readonly<Record<string, boolean | number | string>>;
    readonly providerId: MemorySearchProviderId;
    readonly schemaGeneration: number;
  }[];
  readonly generations: readonly {
    readonly componentKind: "dense" | "lexical" | "namespace";
    readonly generation: number;
    readonly id: Ulid;
    readonly location: Readonly<Record<string, boolean | number | string>>;
    readonly providerId: MemorySearchProviderId;
  }[];
  readonly profile: {
    readonly dimensions: number;
    readonly distanceMetric: "cosine" | "dot-product" | "euclidean";
    readonly gatewayModel: string;
    readonly gatewayRoute: string;
    readonly id: Ulid;
    readonly normalization: "l2" | "none";
    readonly processingBoundary: "aws" | "platform-approved";
  };
}

function canonicalLocationValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalLocationValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalLocationValue(entry)]),
    );
  }
  return value;
}

function canonicalLocation(location: Readonly<Record<string, unknown>>) {
  return JSON.stringify(canonicalLocationValue(location));
}

function decode<RecordType>(schema: Schema.Codec<RecordType, unknown>, value: unknown) {
  return Schema.decodeUnknownSync(schema)(withCanonicalRecordKeys(value as never));
}

async function optionalRecord<ItemType extends PlatformRecord["itemType"]>(
  database: DynamoDatabaseService,
  itemType: ItemType,
  data: Readonly<Record<string, unknown>>,
): Promise<Extract<PlatformRecord, { readonly itemType: ItemType }> | undefined> {
  const keys = canonicalRecordKeys({ data, itemType }, "control");
  const value = await memoryPersistence.read(
    database,
    "control",
    { pk: keys.pk, sk: keys.sk },
    true,
  );
  return value?.itemType === itemType
    ? (value as Extract<PlatformRecord, { readonly itemType: ItemType }>)
    : undefined;
}

export function makeMemorySearchRegistration(args: {
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
  readonly now: () => Date;
}) {
  const { database, membershipDigest, now } = args;

  async function registerCatalog(input: MemorySearchCatalogRegistration) {
    if (input.components.length === 0 || input.components.length > 4) {
      throw new Error("A generation requires one to four components.");
    }
    if (input.generations.length === 0 || input.generations.length > 4) {
      throw new Error("A catalog requires one to four generations.");
    }
    for (const entry of [...input.components, ...input.generations]) {
      if (entry.providerId === "aws-native") requireAwsNativeBackupPolicy(entry.location);
    }
    const timestamp = now().toISOString();
    const profile = decode(MemoryEmbeddingProfileRecord, {
      data: {
        ...input.profile,
        createdAt: timestamp,
        status: "active" as const,
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "memory-embedding-profile" as const,
    });
    const generations = input.generations.map((generation) =>
      decode(MemorySearchGenerationRecord, {
        data: {
          ...generation,
          createdAt: timestamp,
          status: "active" as const,
          updatedAt: timestamp,
          version: 0,
        },
        itemType: "memory-search-generation" as const,
      }),
    );
    const generationsById = new Map(
      generations.map((generation) => [generation.data.id, generation]),
    );
    const components = input.components.map((component) =>
      decode(MemorySearchComponentRecord, {
        data: {
          ...component,
          createdAt: timestamp,
          status: "active" as const,
          updatedAt: timestamp,
          version: 0,
        },
        itemType: "memory-search-component" as const,
      }),
    );
    for (const component of components) {
      const generation = generationsById.get(component.data.generationId);
      if (
        !generation ||
        generation.data.componentKind !== component.data.componentKind ||
        generation.data.providerId !== component.data.providerId ||
        generation.data.generation !== component.data.schemaGeneration ||
        canonicalLocation(generation.data.location) !== canonicalLocation(component.data.location)
      ) {
        throw new Error("Every component requires a matching provider generation and location.");
      }
    }
    await memoryPersistence.commit(
      database,
      [profile, ...generations, ...components].map((record) => ({
        conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        kind: "put" as const,
        record,
      })),
    );
    return { components, generations, profile };
  }

  async function registrationOperations(input: {
    readonly operationId: Ulid;
    readonly organizationId: Ulid;
    readonly placementGeneration: number;
    readonly target: MemorySearchTarget;
    readonly timestamp: string;
  }) {
    const profile = await optionalRecord(database, "memory-embedding-profile", {
      id: input.target.embeddingProfileId,
    });
    if (!profile || profile.data.status !== "active") {
      throw new Error("Target embedding profile is unavailable or inactive.");
    }
    const { digest, keyVersion } = await membershipDigest(input.target.targetId);
    const directoryShard = memorySearchMembershipShard(digest);
    const operations: TransactionOperation[] = [];
    const catalogConditions = new Map<string, TransactionOperation>();
    const catalogLocationEntries = new Set<string>();
    const componentKinds = new Set<string>();
    const targetIdentityHash = memorySearchTargetIdentity(input.target);
    const targetIdentity = await optionalRecord(database, "memory-search-target-identity", {
      targetId: input.target.targetId,
    });
    if (targetIdentity && targetIdentity.data.identityHash !== targetIdentityHash) {
      throw new Error("Memory search target ID has a conflicting immutable identity.");
    }
    operations.push(
      targetIdentity
        ? {
            conditionExpression:
              "#data.#version = :version AND #data.#identityHash = :identityHash AND #itemType = :itemType",
            expressionAttributeNames: {
              "#data": "data",
              "#identityHash": "identityHash",
              "#itemType": "itemType",
              "#version": "version",
            },
            expressionAttributeValues: {
              ":identityHash": targetIdentityHash,
              ":itemType": "memory-search-target-identity",
              ":version": targetIdentity.data.version,
            },
            key: { pk: targetIdentity.pk, sk: targetIdentity.sk },
            kind: "condition-check",
            table: "control",
          }
        : {
            conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
            kind: "put",
            record: decode(MemorySearchTargetIdentityRecord, {
              data: {
                createdAt: input.timestamp,
                identityHash: targetIdentityHash,
                targetId: input.target.targetId,
                updatedAt: input.timestamp,
                version: 0,
              },
              itemType: "memory-search-target-identity" as const,
            }),
          },
    );
    const fenceCatalogRecord = (record: CatalogRecord) => {
      catalogConditions.set(`${record.pk}\0${record.sk}`, {
        conditionExpression:
          "#data.#version = :version AND #data.#status = :active AND #itemType = :itemType",
        expressionAttributeNames: {
          "#data": "data",
          "#itemType": "itemType",
          "#status": "status",
          "#version": "version",
        },
        expressionAttributeValues: {
          ":active": "active",
          ":itemType": record.itemType,
          ":version": record.data.version,
        },
        key: { pk: record.pk, sk: record.sk },
        kind: "condition-check",
        table: "control",
      });
    };
    const gate = decode(MemoryProviderMutationGateRecord, {
      data: {
        createdAt: input.timestamp,
        drainEpoch: 0,
        organizationId: input.organizationId,
        status: "open" as const,
        targetId: input.target.targetId,
        updatedAt: input.timestamp,
        version: 0,
      },
      itemType: "memory-provider-mutation-gate" as const,
    });
    operations.push({
      conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      kind: "put",
      record: gate,
    });
    for (const componentId of input.target.componentIds) {
      const component = await optionalRecord(database, "memory-search-component", {
        id: componentId,
      });
      if (!component) throw new Error("Target component is not registered.");
      if (componentKinds.has(component.data.componentKind)) {
        throw new Error("A target cannot contain duplicate component kinds.");
      }
      componentKinds.add(component.data.componentKind);
      if (
        component.data.status !== "active" ||
        component.data.providerId !== input.target.providerId ||
        component.data.schemaGeneration !== input.target.schemaGeneration ||
        (component.data.componentKind === "dense" &&
          component.data.embeddingProfileId !== input.target.embeddingProfileId) ||
        Object.entries(component.data.location).some(
          ([name, value]) => input.target.location[name] !== value,
        )
      ) {
        throw new Error("Target component does not match the immutable target catalog.");
      }
      for (const [name, value] of Object.entries(component.data.location)) {
        catalogLocationEntries.add(`${name}\0${JSON.stringify(value)}`);
      }
      if (
        component.data.providerId === "aws-native" &&
        (component.data.componentKind !== "dense" ||
          component.data.location.automatedSnapshotRetentionHours !==
            AWS_NATIVE_AUTOMATED_SNAPSHOT_RETENTION_HOURS ||
          component.data.location.backupSafetyMarginMinutes !==
            AWS_NATIVE_BACKUP_SAFETY_MARGIN_MINUTES ||
          !requiredPhysicalField(component.data.location, "region") ||
          !requiredPhysicalField(component.data.location, "openSearchEndpoint") ||
          !requiredPhysicalField(component.data.location, "openSearchIndex"))
      ) {
        throw new Error("AWS-native components must catalog their complete physical location.");
      }
      fenceCatalogRecord(component);
      const generation = await optionalRecord(database, "memory-search-generation", {
        id: component.data.generationId,
      });
      if (
        !generation ||
        generation.data.status !== "active" ||
        generation.data.providerId !== input.target.providerId ||
        generation.data.componentKind !== component.data.componentKind
      ) {
        throw new Error("Target generation is not active.");
      }
      fenceCatalogRecord(generation);
      const membership = decode(MemorySearchGenerationTargetRecord, {
        data: {
          createdAt: input.timestamp,
          generationId: component.data.generationId,
          keyVersion,
          membershipShard: directoryShard,
          providerId: input.target.providerId,
          targetDigest: digest,
          updatedAt: input.timestamp,
          version: 0,
        },
        itemType: "memory-search-generation-target" as const,
      });
      const membershipHead = await optionalRecord(
        database,
        "memory-search-generation-target-shard",
        {
          generationId: component.data.generationId,
          membershipShard: directoryShard,
        },
      );
      const nextMembershipHead = decode(MemorySearchGenerationTargetShardRecord, {
        data: {
          count: (membershipHead?.data.count ?? 0) + 1,
          createdAt: membershipHead?.data.createdAt ?? input.timestamp,
          generationId: component.data.generationId,
          membershipShard: directoryShard,
          mutationWatermark: (membershipHead?.data.mutationWatermark ?? 0) + 1,
          updatedAt: input.timestamp,
          version: (membershipHead?.data.version ?? -1) + 1,
        },
        itemType: "memory-search-generation-target-shard" as const,
      });
      const live = decode(MemorySearchGenerationLiveTargetRecord, {
        data: {
          componentId,
          createdAt: input.timestamp,
          generationId: component.data.generationId,
          liveShard: directoryShard,
          operationId: input.operationId,
          organizationId: input.organizationId,
          placementGeneration: input.placementGeneration,
          referenceRole: "candidate" as const,
          targetId: input.target.targetId,
          updatedAt: input.timestamp,
          version: 0,
        },
        itemType: "memory-search-generation-live-target" as const,
      });
      const liveHead = await optionalRecord(database, "memory-search-generation-live-shard", {
        generationId: component.data.generationId,
        liveShard: directoryShard,
      });
      const nextLiveHead = decode(MemorySearchGenerationLiveShardRecord, {
        data: {
          count: (liveHead?.data.count ?? 0) + 1,
          createdAt: liveHead?.data.createdAt ?? input.timestamp,
          generationId: component.data.generationId,
          liveShard: directoryShard,
          mutationWatermark: (liveHead?.data.mutationWatermark ?? 0) + 1,
          updatedAt: input.timestamp,
          version: (liveHead?.data.version ?? -1) + 1,
        },
        itemType: "memory-search-generation-live-shard" as const,
      });
      if (component.data.componentKind !== "namespace") {
        operations.push(
          await physicalOwnerRegistrationOperation({
            component,
            database,
            organizationId: input.organizationId,
            targetId: input.target.targetId,
            timestamp: input.timestamp,
          }),
        );
      }
      operations.push(
        {
          conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          kind: "put",
          record: membership,
        },
        {
          kind: "put",
          ...(membershipHead ? { previousRecord: membershipHead } : {}),
          record: nextMembershipHead,
        },
        {
          conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          kind: "put",
          record: live,
        },
        {
          kind: "put",
          ...(liveHead ? { previousRecord: liveHead } : {}),
          record: nextLiveHead,
        },
      );
    }
    if (
      Object.entries(input.target.location).some(
        ([name, value]) => !catalogLocationEntries.has(`${name}\0${JSON.stringify(value)}`),
      )
    ) {
      throw new Error("Target location contains fields outside the immutable component catalog.");
    }
    const expectedKinds = input.target.providerId === "aws-native" ? ["dense"] : ["namespace"];
    if (
      componentKinds.size !== expectedKinds.length ||
      expectedKinds.some((kind) => !componentKinds.has(kind))
    ) {
      throw new Error("Target components do not match the provider's required component set.");
    }
    return [...catalogConditions.values(), ...operations];
  }

  async function mutateLiveReferences(input: {
    readonly mode: "remove" | "transition";
    readonly operationId?: Ulid;
    readonly placementGeneration: number;
    readonly targets: readonly {
      readonly mode?: "remove" | "transition";
      readonly role: LiveReference["data"]["referenceRole"];
      readonly target: MemorySearchTarget;
    }[];
    readonly timestamp: string;
  }) {
    const operations: TransactionOperation[] = [];
    const heads = new Map<
      string,
      {
        countDelta: number;
        generationId: Ulid;
        mutationDelta: number;
        previous: Extract<
          PlatformRecord,
          { readonly itemType: "memory-search-generation-live-shard" }
        >;
        shard: number;
      }
    >();
    for (const { mode: targetMode, role, target } of input.targets) {
      const mode = targetMode ?? input.mode;
      const digestCandidates = args.membershipDigests
        ? await args.membershipDigests(target.targetId)
        : [await membershipDigest(target.targetId)];
      if (digestCandidates.length === 0) {
        throw new Error("No memory membership key is available for the target.");
      }
      let selectedDigest: string | undefined;
      for (const componentId of target.componentIds) {
        const component = await optionalRecord(database, "memory-search-component", {
          id: componentId,
        });
        if (!component) throw new Error("Live target component is unavailable.");
        let live: LiveReference | undefined;
        let liveShard: number | undefined;
        for (const { digest } of selectedDigest ? [{ digest: selectedDigest }] : digestCandidates) {
          const candidateShard = memorySearchMembershipShard(digest);
          live = await optionalRecord(database, "memory-search-generation-live-target", {
            componentId,
            generationId: component.data.generationId,
            liveShard: candidateShard,
            targetId: target.targetId,
          });
          if (live) {
            selectedDigest = digest;
            liveShard = candidateShard;
            break;
          }
        }
        if (!live) {
          if (mode === "remove") continue;
          throw new Error("Authoritative live target reference is unavailable.");
        }
        if (liveShard === undefined) {
          throw new Error("Authoritative live target shard is unavailable.");
        }
        if (mode === "remove" && component.data.componentKind !== "namespace") {
          const owner = await optionalRecord(database, "memory-search-physical-owner", {
            physicalLocationHash: physicalLocationHash(
              component.data.componentKind,
              component.data.location,
            ),
          });
          if (!owner) {
            throw new Error("Physical target ownership is unavailable for safe cleanup.");
          }
          operations.push(
            physicalOwnerRemovalOperation({
              component,
              owner,
              organizationId: live.data.organizationId,
              targetId: target.targetId,
              timestamp: input.timestamp,
            }),
          );
        }
        if (
          mode === "transition" &&
          live.data.referenceRole === role &&
          live.data.placementGeneration === input.placementGeneration
        ) {
          continue;
        }
        operations.push(
          mode === "remove"
            ? { kind: "delete", record: live }
            : {
                kind: "put",
                previousRecord: live,
                record: decode(MemorySearchGenerationLiveTargetRecord, {
                  data: {
                    ...live.data,
                    ...(input.operationId ? { operationId: input.operationId } : {}),
                    placementGeneration: input.placementGeneration,
                    referenceRole: role,
                    updatedAt: input.timestamp,
                    version: live.data.version + 1,
                  },
                  itemType: "memory-search-generation-live-target" as const,
                }),
              },
        );
        const headKey = `${component.data.generationId}:${liveShard}`;
        let aggregate = heads.get(headKey);
        if (!aggregate) {
          const previous = await optionalRecord(database, "memory-search-generation-live-shard", {
            generationId: component.data.generationId,
            liveShard,
          });
          if (!previous) throw new Error("Authoritative live target shard is unavailable.");
          aggregate = {
            countDelta: 0,
            generationId: component.data.generationId,
            mutationDelta: 0,
            previous,
            shard: liveShard,
          };
          heads.set(headKey, aggregate);
        }
        aggregate.mutationDelta += 1;
        if (mode === "remove") aggregate.countDelta -= 1;
      }
    }
    for (const head of heads.values()) {
      if (head.previous.data.count + head.countDelta < 0) {
        throw new Error("Live target shard count would become negative.");
      }
      operations.push({
        kind: "put",
        previousRecord: head.previous,
        record: decode(MemorySearchGenerationLiveShardRecord, {
          data: {
            ...head.previous.data,
            count: head.previous.data.count + head.countDelta,
            mutationWatermark: head.previous.data.mutationWatermark + head.mutationDelta,
            updatedAt: input.timestamp,
            version: head.previous.data.version + 1,
          },
          itemType: "memory-search-generation-live-shard" as const,
        }),
      });
    }
    return operations;
  }

  function placementLiveTargets(placement: Placement) {
    const targets = new Map<
      Ulid,
      {
        role: LiveReference["data"]["referenceRole"];
        target: MemorySearchTarget;
      }
    >();
    if (placement.data.candidateTarget) {
      targets.set(placement.data.candidateTarget.targetId, {
        role: "candidate",
        target: placement.data.candidateTarget,
      });
    }
    for (const target of placement.data.writeTargets) {
      targets.set(target.targetId, { role: "write", target });
    }
    if (placement.data.readTarget) {
      targets.set(placement.data.readTarget.targetId, {
        role: "read",
        target: placement.data.readTarget,
      });
    }
    return [...targets.values()];
  }

  function liveReferenceOperations(placement: Placement, operationId: Ulid, timestamp: string) {
    return mutateLiveReferences({
      mode: "transition",
      operationId,
      placementGeneration: placement.data.generation,
      targets: placementLiveTargets(placement),
      timestamp,
    });
  }

  function removeLiveReferenceOperations(target: MemorySearchTarget, timestamp: string) {
    return mutateLiveReferences({
      mode: "remove",
      placementGeneration: 0,
      targets: [{ role: "cleanup", target }],
      timestamp,
    });
  }

  return {
    liveReferenceOperations,
    registerCatalog,
    registrationOperations,
    removeLiveReferenceOperations,
  };
}
