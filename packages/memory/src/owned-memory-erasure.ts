import { memoryPersistence } from "@deployments-ai/db";
import type { DynamoDatabaseService, PlatformRecord, Ulid } from "@deployments-ai/db";
import type { MemorySearchPlacementResolver } from "./provider.ts";

type MemoryRecordValue = Extract<PlatformRecord, { readonly itemType: "memory" }>;

export type MemoryErasureOwner =
  | { readonly brainId: Ulid; readonly kind: "brain" }
  | { readonly kind: "thread"; readonly threadId: Ulid };

function ownedBy(memory: MemoryRecordValue, owner: MemoryErasureOwner) {
  return owner.kind === "brain"
    ? memory.data.brainProvenance?.some((citation) => citation.brainId === owner.brainId) === true
    : memory.data.threadId === owner.threadId ||
        memory.data.observability?.sessionId === owner.threadId;
}

export async function purgeOwnedMemories(input: {
  readonly database: DynamoDatabaseService;
  readonly memories: readonly { readonly pk: string; readonly sk: string }[];
  readonly now?: () => Date;
  readonly operationId: Ulid;
  readonly organizationId: Ulid;
  readonly owner: MemoryErasureOwner;
  readonly resolvePlacement: MemorySearchPlacementResolver;
}) {
  const records: MemoryRecordValue[] = [];
  for (const recordKey of input.memories) {
    const value = await memoryPersistence.read(input.database, "control", recordKey, true);
    if (
      value?.itemType !== "memory" ||
      value.data.organizationId !== input.organizationId ||
      !ownedBy(value, input.owner)
    ) {
      throw new Error("Owned memory purge target changed or crossed its tenant fence.");
    }
    records.push(value);
  }
  const placement = await input.resolvePlacement(input.organizationId);
  const providers = [placement.read, ...placement.writes].filter(
    (provider, index, all) =>
      all.findIndex((candidate) => candidate.target.targetId === provider.target.targetId) ===
      index,
  );
  const synchronizationGeneration = (input.now ?? (() => new Date()))().getTime() * 1_000 + 999;
  if (!Number.isSafeInteger(synchronizationGeneration)) {
    throw new Error("Owned memory purge generation is outside the safe integer range.");
  }
  const targets = [];
  for (const provider of providers) {
    for (const memory of records) {
      await provider.delete({ memory, synchronizationGeneration });
    }
    targets.push({
      contentPurged: true as const,
      memoryCount: records.length,
      providerId: provider.providerId,
      targetId: provider.target.targetId,
    });
  }
  return {
    ...(input.owner.kind === "brain"
      ? { brainId: input.owner.brainId }
      : { threadId: input.owner.threadId }),
    operationId: input.operationId,
    targets,
  };
}
