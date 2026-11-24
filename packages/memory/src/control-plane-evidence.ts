import {
  MemorySearchEvidenceManifestRecord,
  canonicalRecordKeys,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
  memoryPersistence,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import type { MemorySearchProviderClient, MemorySearchTarget } from "./provider.ts";
import {
  acquireProvisioningEvidenceMutationClaim,
  currentProvisioningEvidenceMutationClaim,
  providerMutationSignal,
  resolveMemoryProviderMutationClaim,
} from "./provider-mutation-claim.ts";
import type { CanonicalMemoryRecord } from "./memory-record.ts";

type Provisioning = Extract<PlatformRecord, { readonly itemType: "memory-search-provisioning" }>;

export type ProvisioningEvidenceEmbedder = (input: {
  readonly content: string;
  readonly embeddingProfileId: Ulid;
  readonly environmentId: Ulid;
  readonly operationId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
}) => Promise<{
  readonly embedding: readonly number[];
  readonly model: string;
  readonly provider: string;
}>;

async function requiredRecord<ItemType extends PlatformRecord["itemType"]>(
  database: DynamoDatabaseService,
  itemType: ItemType,
  data: Readonly<Record<string, unknown>>,
) {
  const keys = canonicalRecordKeys({ data, itemType }, "control");
  const value = await memoryPersistence.read(database, "control", keys, true);
  if (!value || value.itemType !== itemType) throw new Error(`${itemType} is unavailable.`);
  return value as Extract<PlatformRecord, { readonly itemType: ItemType }>;
}

export async function requireCleanProvisioningEvidence(
  database: DynamoDatabaseService,
  operation: Provisioning,
) {
  if (!operation.data.evidenceManifestId) {
    throw new Error("Provisioning operation has no evidence manifest.");
  }
  const manifest = await requiredRecord(database, "memory-search-evidence-manifest", {
    id: operation.data.evidenceManifestId,
    operationId: operation.data.id,
    organizationId: operation.data.organizationId,
  });
  if (
    manifest.data.operationId !== operation.data.id ||
    manifest.data.organizationId !== operation.data.organizationId ||
    manifest.data.targetId !== operation.data.target.targetId ||
    manifest.data.status !== "clean"
  ) {
    throw new Error("Provisioning evidence has not passed and cleaned up.");
  }
  return manifest;
}

export async function verifyProvisioningEvidence(args: {
  readonly database: DynamoDatabaseService;
  readonly embed: ProvisioningEvidenceEmbedder;
  readonly generateId: () => Promise<Ulid>;
  readonly now: () => Date;
  readonly operation: Provisioning;
  readonly provider: MemorySearchProviderClient;
  readonly target: MemorySearchTarget;
}) {
  const { database, operation, provider, target } = args;
  if (!operation.data.evidenceManifestId) throw new Error("Provisioning evidence is unavailable.");
  const manifest = await requiredRecord(database, "memory-search-evidence-manifest", {
    id: operation.data.evidenceManifestId,
    operationId: operation.data.id,
    organizationId: operation.data.organizationId,
  });
  if (
    manifest.data.operationId !== operation.data.id ||
    manifest.data.organizationId !== operation.data.organizationId ||
    manifest.data.targetId !== target.targetId ||
    manifest.data.evidenceKeys.length === 0
  ) {
    throw new Error("Provisioning evidence manifest does not own this target.");
  }
  if (manifest.data.status === "clean") return manifest;
  if (manifest.data.status !== "manifested" && manifest.data.status !== "cleanup-pending") {
    throw new Error("Provisioning evidence manifest is not ready for verification.");
  }
  const profile = await requiredRecord(database, "memory-embedding-profile", {
    id: target.embeddingProfileId,
  });
  if (profile.data.status !== "active" || profile.data.dimensions < 1) {
    throw new Error("Provisioning evidence requires an active embedding profile.");
  }
  let checkpoint = manifest;
  const persistedEvidenceId = manifest.data.componentLocations.find(
    (location) =>
      typeof location === "object" &&
      location !== null &&
      typeof (location as Readonly<Record<string, unknown>>).evidenceMemoryId === "string",
  ) as Readonly<Record<string, unknown>> | undefined;
  const evidenceId =
    (persistedEvidenceId?.evidenceMemoryId as Ulid | undefined) ?? (await args.generateId());
  const timestamp = args.now().toISOString();
  if (!persistedEvidenceId) {
    checkpoint = Schema.decodeUnknownSync(MemorySearchEvidenceManifestRecord)(
      withCanonicalRecordKeys({
        data: {
          ...manifest.data,
          componentLocations: [
            ...manifest.data.componentLocations,
            { checkpointedAt: timestamp, evidenceMemoryId: evidenceId },
          ],
          updatedAt: timestamp,
          version: manifest.data.version + 1,
        },
        itemType: "memory-search-evidence-manifest" as const,
      }),
    );
    await memoryPersistence.commit(database, [
      { kind: "put", previousRecord: manifest, record: checkpoint },
    ]);
  }
  const content = `provider readiness evidence ${operation.data.id}`;
  const contentHash = createHash("sha256").update(content).digest("hex");
  const memory = withCanonicalRecordKeys({
    data: {
      body: content,
      contentHash,
      createdAt: timestamp,
      environmentId: evidenceId,
      id: evidenceId,
      memorySpaceId: evidenceId,
      organizationId: operation.data.organizationId,
      projectId: evidenceId,
      reviewStatus: "approved" as const,
      scope: "organization" as const,
      searchKey: `organization:${operation.data.organizationId}`,
      sensitivity: "public" as const,
      source: "provider-provisioning-evidence",
      status: "active" as const,
      updatedAt: timestamp,
      version: 0,
    },
    itemType: "memory" as const,
  }) as CanonicalMemoryRecord;
  const embedded = await args.embed({
    content,
    embeddingProfileId: profile.data.id,
    environmentId: evidenceId,
    operationId: operation.data.id,
    organizationId: operation.data.organizationId,
    projectId: evidenceId,
  });
  if (
    embedded.model !== profile.data.gatewayModel ||
    embedded.embedding.length !== profile.data.dimensions ||
    embedded.embedding.some((value) => !Number.isFinite(value)) ||
    !embedded.provider.trim()
  ) {
    throw new Error("Provisioning evidence embedding does not match its immutable profile.");
  }
  const embedding = embedded.embedding;
  const query = {
    allowedScopeKeys: [`organization:${operation.data.organizationId}`],
    allowedSensitivities: ["public" as const],
    embedding,
    environmentId: evidenceId,
    memorySpaceIds: [evidenceId],
    now: args.now(),
    organizationId: operation.data.organizationId,
    projectId: evidenceId,
    searchKeys: [memory.data.searchKey],
    topK: 10,
  };
  const evidence = {
    operationId: operation.data.id,
    targetId: target.targetId,
  };
  if (
    !provider.writeEvidence ||
    !provider.deleteEvidence ||
    !provider.queryEvidence ||
    !provider.queryEvidenceExact ||
    (provider.capabilities.lexical && !provider.queryEvidenceLexical)
  ) {
    throw new Error("Provider does not implement isolated synthetic evidence operations.");
  }
  const { body: _evidenceBody, ...deletedData } = memory.data;
  const deletedMemory = withCanonicalRecordKeys({
    data: {
      ...deletedData,
      deletedAt: args.now().toISOString(),
      status: "deleted" as const,
      updatedAt: args.now().toISOString(),
      version: 1,
    },
    itemType: "memory" as const,
  }) as CanonicalMemoryRecord;
  const claimIdentity = {
    database,
    operationId: operation.data.id,
    organizationId: operation.data.organizationId,
    targetId: target.targetId,
  };
  const abandonedClaim = await currentProvisioningEvidenceMutationClaim(claimIdentity);
  if (
    abandonedClaim &&
    (abandonedClaim.data.status === "claimed" || abandonedClaim.data.status === "ambiguous")
  ) {
    const ambiguityUntil = abandonedClaim.data.ambiguityUntil
      ? Date.parse(abandonedClaim.data.ambiguityUntil)
      : Number.NaN;
    if (!Number.isFinite(ambiguityUntil) || args.now().getTime() < ambiguityUntil) {
      throw new Error(
        "Provisioning evidence mutation claim is still inside its ambiguity horizon.",
      );
    }
    const recoverySignal = AbortSignal.timeout(60_000);
    const cleanup = await provider.deleteEvidence({
      evidence,
      memory: deletedMemory,
      signal: recoverySignal,
      synchronizationGeneration: 2,
    });
    if (cleanup.status !== "synchronized" && cleanup.status !== "written") {
      throw new Error("Abandoned provisioning evidence cleanup was not applied.");
    }
    const remaining = await provider.queryEvidenceExact({
      ...query,
      evidence,
      memoryIds: [evidenceId],
      signal: recoverySignal,
    });
    if (remaining.some((row) => row.id === evidenceId)) {
      throw new Error("Abandoned provisioning evidence remains queryable after cleanup.");
    }
    const recoveredClaim = resolveMemoryProviderMutationClaim(abandonedClaim, "failed", args.now());
    await memoryPersistence.commit(database, [
      { kind: "put", previousRecord: abandonedClaim, record: recoveredClaim },
    ]);
  }
  const mutationClaim = await acquireProvisioningEvidenceMutationClaim({
    ...claimIdentity,
    now: args.now(),
  });
  const mutationSignal = providerMutationSignal(mutationClaim, args.now());
  try {
    if (checkpoint.data.status === "manifested") {
      const write = await provider.writeEvidence({
        content,
        evidence,
        embedding,
        embeddingContentHash: contentHash,
        embeddingModel: embedded.model,
        embeddingProvider: embedded.provider,
        memory,
        signal: mutationSignal,
        synchronizationGeneration: 1,
      });
      if (
        write.status !== "written" &&
        write.status !== "synchronized" &&
        write.status !== "not-applied"
      ) {
        throw new Error("Provisioning evidence write was not applied.");
      }
      const dense = await provider.queryEvidence({
        ...query,
        evidence,
        signal: mutationSignal,
      });
      const exact = await provider.queryEvidenceExact({
        ...query,
        evidence,
        memoryIds: [evidenceId],
        signal: mutationSignal,
      });
      const lexical = provider.queryEvidenceLexical
        ? await provider.queryEvidenceLexical({
            ...query,
            evidence,
            query: content,
            signal: mutationSignal,
          })
        : [];
      if (
        !dense.some((row) => row.id === evidenceId) ||
        !exact.some((row) => row.id === evidenceId) ||
        (provider.capabilities.lexical && !lexical.some((row) => row.id === evidenceId))
      ) {
        throw new Error("Provisioning evidence queries did not recover the synthetic row.");
      }
    }
    const deletionResult = await provider.deleteEvidence({
      evidence,
      memory: deletedMemory,
      signal: mutationSignal,
      synchronizationGeneration: 2,
    });
    if (deletionResult.status !== "synchronized" && deletionResult.status !== "written") {
      throw new Error("Provisioning evidence cleanup was not applied.");
    }
    const remaining = await provider.queryEvidenceExact({
      ...query,
      evidence,
      memoryIds: [evidenceId],
      signal: mutationSignal,
    });
    if (remaining.some((row) => row.id === evidenceId)) {
      throw new Error("Provisioning evidence remained queryable after cleanup.");
    }
    const verifiedAt = args.now().toISOString();
    const clean = Schema.decodeUnknownSync(MemorySearchEvidenceManifestRecord)(
      withCanonicalRecordKeys({
        data: {
          ...checkpoint.data,
          componentLocations: [
            ...checkpoint.data.componentLocations,
            { evidenceMemoryId: evidenceId, verifiedAt },
          ],
          status: "clean" as const,
          updatedAt: verifiedAt,
          version: checkpoint.data.version + 1,
        },
        itemType: "memory-search-evidence-manifest" as const,
      }),
    );
    const appliedClaim = resolveMemoryProviderMutationClaim(mutationClaim, "applied", args.now());
    await memoryPersistence.commit(database, [
      { kind: "put", previousRecord: checkpoint, record: clean },
      { kind: "put", previousRecord: mutationClaim, record: appliedClaim },
    ]);
    return clean;
  } catch (cause) {
    try {
      const cleanup = await provider.deleteEvidence({
        evidence,
        memory: deletedMemory,
        signal: mutationSignal,
        synchronizationGeneration: 2,
      });
      if (cleanup.status !== "synchronized" && cleanup.status !== "written") throw cause;
      const remaining = await provider.queryEvidenceExact({
        ...query,
        evidence,
        memoryIds: [evidenceId],
        signal: mutationSignal,
      });
      if (remaining.some((row) => row.id === evidenceId)) throw cause;
      const ambiguousClaim = resolveMemoryProviderMutationClaim(
        mutationClaim,
        "ambiguous",
        args.now(),
      );
      await memoryPersistence.commit(database, [
        {
          kind: "put",
          previousRecord: mutationClaim,
          record: ambiguousClaim,
        },
      ]);
    } catch {
      // Keep the claim active when cleanup cannot prove absence; erasure must remain blocked.
    }
    throw cause;
  }
}
