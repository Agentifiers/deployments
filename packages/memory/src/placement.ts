import {
  canonicalRecordKeys,
  key,
  type DynamoDatabaseService,
  type Ulid,
  memoryPersistence,
} from "@deployments-ai/db";
import { Schema } from "effect";
import type {
  MemorySearchPlacementResolver,
  MemorySearchProviderRegistry,
  MemorySearchRoutingResolver,
} from "./provider.ts";

export class MemorySearchPlacementError extends Schema.TaggedErrorClass<MemorySearchPlacementError>()(
  "MemorySearchPlacementError",
  {
    message: Schema.String,
    organizationId: Schema.String,
    phase: Schema.optional(Schema.String),
  },
) {}

export function memorySearchPlacementKey(organizationId: Ulid) {
  return {
    pk: key("ORG", organizationId),
    sk: key("MEMORY-SEARCH-PLACEMENT", organizationId),
  };
}

export function memorySearchMutationFenceKey(organizationId: Ulid) {
  return {
    pk: key("ORG", organizationId),
    sk: key("MEMORY-SEARCH-MUTATION-FENCE", organizationId),
  };
}

export function memoryProviderMutationGateKey(organizationId: Ulid, targetId: Ulid) {
  return {
    pk: key("ORG", organizationId),
    sk: key("MEMORY-PROVIDER-MUTATION-GATE", targetId),
  };
}

export function memoryProviderMutationClaimPrefix(targetId: Ulid) {
  return `${key("MEMORY-PROVIDER-MUTATION-CLAIM", targetId)}#`;
}

export function memoryProviderMutationClaimKey(
  organizationId: Ulid,
  targetId: Ulid,
  messageGroup: string,
) {
  return canonicalRecordKeys(
    {
      data: { messageGroup, organizationId, targetId },
      itemType: "memory-provider-mutation-claim" as const,
    },
    "control",
  );
}

function fail(organizationId: Ulid, message: string, phase?: string): never {
  throw new MemorySearchPlacementError({
    message,
    organizationId,
    ...(phase ? { phase } : {}),
  });
}

export function makeMemorySearchPlacementResolver(
  database: DynamoDatabaseService,
  registry: MemorySearchProviderRegistry,
): MemorySearchPlacementResolver {
  const resolveRouting = makeMemorySearchRoutingResolver(database);
  return async (organizationId) => {
    const routing = await resolveRouting(organizationId);
    const read = await registry.resolve(routing.read.target);
    const writes = await Promise.all(
      routing.writes.map((target) => registry.resolve(target.target)),
    );
    const candidateRouting = routing.candidate;
    const candidate = candidateRouting
      ? await registry.resolve(candidateRouting.target)
      : undefined;
    if (
      read.providerId !== routing.read.providerId ||
      read.target.targetId !== routing.read.target.targetId ||
      (candidate &&
        (candidate.providerId !== candidateRouting!.providerId ||
          candidate.target.targetId !== candidateRouting!.target.targetId)) ||
      writes.some(
        (provider, index) =>
          provider.providerId !== routing.writes[index]!.providerId ||
          provider.target.targetId !== routing.writes[index]!.target.targetId,
      )
    ) {
      return fail(organizationId, "Provider registry returned a mismatched physical target.");
    }
    const { candidate: _candidate, ...baseRouting } = routing;
    return { ...baseRouting, ...(candidate ? { candidate } : {}), read, writes };
  };
}

export function makeMemorySearchRoutingResolver(
  database: DynamoDatabaseService,
): MemorySearchRoutingResolver {
  return async (organizationId) => {
    const record = await memoryPersistence.read(
      database,
      "control",
      memorySearchPlacementKey(organizationId),
      true,
    );
    if (!record || record.itemType !== "memory-search-placement") {
      return fail(organizationId, "Memory search placement is not configured.");
    }
    const placement = record.data;
    const fenceRecord = await memoryPersistence.read(
      database,
      "control",
      memorySearchMutationFenceKey(organizationId),
      true,
    );
    const fence =
      fenceRecord?.itemType === "memory-search-mutation-fence" ? fenceRecord.data : undefined;
    if (!placement.readTarget || placement.writeTargets.length === 0) {
      return fail(
        organizationId,
        "Memory search placement is not in a serving phase.",
        placement.phase,
      );
    }
    if (
      placement.writeTargets.length !== 1 ||
      placement.writeTargets[0]?.targetId !== placement.readTarget.targetId
    ) {
      return fail(
        organizationId,
        "Memory search placement has invalid write targets.",
        placement.phase,
      );
    }
    return {
      ...(placement.candidateTarget
        ? {
            candidate: {
              providerId: placement.candidateTarget.providerId,
              target: placement.candidateTarget,
            },
          }
        : {}),
      ...(fence ? { fenceEpoch: fence.epoch, fenceVersion: fence.version } : {}),
      placementGeneration: placement.generation,
      placementPhase: placement.phase,
      placementVersion: placement.version,
      read: {
        providerId: placement.readTarget.providerId,
        target: placement.readTarget,
      },
      writes: placement.writeTargets.map((target) => ({
        providerId: target.providerId,
        target,
      })),
    };
  };
}
