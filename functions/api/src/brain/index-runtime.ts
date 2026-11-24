import {
  BrainIndexRejectedBeforeWriteError,
  BrainIndexStaleError,
  brainTextRendition,
  brainTextRenditionKind,
  indexBrainDocument,
  rethrowRejectedBeforeWrite,
  type BrainEmbeddingPort,
  type BrainIndexCanonicalSnapshot,
  type BrainGraphProjectionPort,
  type BrainRepository,
  type BrainSearchProviderRegistry,
  type BrainSearchTarget,
} from "@deployments-ai/brains";
import {
  claimBrainIndexJob,
  claimBrainProviderMutation,
  completeBrainIndexSuppression,
  completeBrainProviderMutation,
  failBrainIndexJob,
  getBrainIndexJob,
  getBrainIndexState,
  getBrainSearchPlacement,
  isDatabaseWriteConflict,
  isTerminalBrainIndexJob,
  makeBrainIndexStatePort,
  markBrainProviderMutationUnknown,
  recoverExpiredBrainIndexJob,
  requeueBrainIndexJob,
  resumeBrainProviderMutation,
  skipBrainIndexJob,
  type BrainIndexJob,
  type DynamoDatabaseService,
  makeOrganizationHoldReader,
} from "@deployments-ai/db";
import type { FileTextExtractor } from "@deployments-ai/file-text";
import { backgroundWorkSuspended } from "../background-standing.ts";
import { ensureBrainTextRendition, type BrainTextRenditionStore } from "./index-text-rendition.ts";

export const BRAIN_INDEX_LEASE_MS = 10 * 60_000;

export interface BrainIndexQueueMessage {
  readonly documentId: string;
  readonly idempotencyKey: string;
  readonly organizationId: string;
}

export interface BrainIndexRuntimeDependencies {
  readonly database: DynamoDatabaseService;
  readonly embeddings: (job: BrainIndexJob) => BrainEmbeddingPort;
  readonly extractor: FileTextExtractor;
  readonly graph?: BrainGraphProjectionPort;
  readonly loadRendition: (
    snapshot: BrainIndexCanonicalSnapshot,
    signal?: AbortSignal,
  ) => Promise<Uint8Array>;
  readonly now?: () => Date;
  readonly providers: BrainSearchProviderRegistry;
  readonly repository: BrainRepository;
  readonly textRenditionStore: BrainTextRenditionStore;
  readonly workerId: string;
}

function targetForJob(
  job: BrainIndexJob,
  placement: NonNullable<Awaited<ReturnType<typeof getBrainSearchPlacement>>>,
): BrainSearchTarget {
  const target = [placement.data.writeTarget, placement.data.candidateTarget].find(
    (candidate) => candidate?.targetId === job.data.targetId,
  );
  if (
    placement.data.phase !== "active" ||
    !(
      placement.data.generation === job.data.placementGeneration ||
      (placement.data.generation === job.data.placementGeneration + 1 &&
        placement.data.writeTarget?.targetId === job.data.targetId)
    ) ||
    !target ||
    target.targetId !== job.data.targetId ||
    target.providerId !== job.data.provider ||
    target.schemaGeneration !== job.data.schemaGeneration ||
    target.embeddingProfileId !== job.data.embeddingProfileId
  ) {
    throw new BrainIndexStaleError();
  }
  return {
    embeddingProfileId: target.embeddingProfileId,
    location: target.location,
    providerId: target.providerId,
    schemaGeneration: target.schemaGeneration,
    targetId: target.targetId,
  };
}

async function canonicalSnapshot(repository: BrainRepository, job: BrainIndexJob) {
  const [brain, document, source, version] = await Promise.all([
    repository.get(job.data.organizationId, job.data.brainId),
    repository.getDocument(job.data.organizationId, job.data.brainId, job.data.documentId),
    repository.getSource(job.data.organizationId, job.data.brainId, job.data.sourceId),
    repository.getDocumentVersion(
      job.data.organizationId,
      job.data.documentId,
      job.data.documentVersionId,
    ),
  ]);
  if (
    !brain ||
    brain.status !== "active" ||
    !document ||
    !source ||
    source.status !== "active" ||
    !version
  ) {
    throw new BrainIndexStaleError();
  }
  if (job.data.operation === "suppress") return { brain, document, source, version };
  if (!job.data.renditionId) throw new BrainIndexStaleError();
  const rendition = await repository.getDocumentRendition(
    job.data.organizationId,
    job.data.documentVersionId,
    job.data.renditionId,
  );
  if (!rendition) throw new BrainIndexStaleError();
  return { brain, document, rendition, source, version };
}

/**
 * Stale input is permanent once the job can never become current: its Brain was archived or
 * erased, its document was erased or moved to a newer projection generation (which owns a newer
 * job), or the search placement no longer routes the job's target. Any other staleness, such as
 * a concurrent Brain or source version change, is an optimistic-concurrency race worth retrying.
 */
async function permanentlyStale(dependencies: BrainIndexRuntimeDependencies, job: BrainIndexJob) {
  const [brain, document, placement] = await Promise.all([
    dependencies.repository.get(job.data.organizationId, job.data.brainId),
    dependencies.repository.getDocument(
      job.data.organizationId,
      job.data.brainId,
      job.data.documentId,
    ),
    getBrainSearchPlacement(dependencies.database, job.data.organizationId),
  ]);
  if (
    brain?.status !== "active" ||
    document?.projectionGeneration !== job.data.expectedProjectionGeneration ||
    !placement
  ) {
    return true;
  }
  try {
    targetForJob(job, placement);
    return false;
  } catch (cause) {
    if (cause instanceof BrainIndexStaleError) return true;
    throw cause;
  }
}

/**
 * Resolves the message's job to a claimed lease or to an outcome for the message. A job that is
 * not yet runnable is deferred with the time it next can run, so the message returns then instead
 * of waiting for the dispatcher sweep; a message that races another writer is acknowledged.
 */
async function runnableJob(
  dependencies: BrainIndexRuntimeDependencies,
  message: BrainIndexQueueMessage,
  now: string,
) {
  let job = await getBrainIndexJob(dependencies.database, message);
  if (!job || isTerminalBrainIndexJob(job)) return { outcome: "ignored" as const };
  if (
    await backgroundWorkSuspended(
      makeOrganizationHoldReader(dependencies.database),
      job.data.organizationId,
    )
  ) {
    return { outcome: "suspended" as const };
  }
  const deferredUntil = (retryAt: string | undefined) => ({
    outcome: "deferred" as const,
    ...(retryAt ? { retryAt } : {}),
  });
  try {
    if (job.data.status === "running") {
      const recovered = await recoverExpiredBrainIndexJob({
        database: dependencies.database,
        job,
        now,
      });
      if (!recovered) return deferredUntil(job.data.leaseExpiresAt);
      if (isTerminalBrainIndexJob(recovered)) return { outcome: "retries-exhausted" as const };
      job = recovered;
    }
    if (job.data.status === "failed") {
      if (job.data.nextDueAt && job.data.nextDueAt > now) return deferredUntil(job.data.nextDueAt);
      job = await requeueBrainIndexJob({ database: dependencies.database, job, now });
    }
  } catch (cause) {
    if (isDatabaseWriteConflict(cause)) return { outcome: "superseded" as const };
    throw cause;
  }
  return (
    (await claimBrainIndexJob({
      database: dependencies.database,
      job,
      leaseExpiresAt: new Date(Date.parse(now) + BRAIN_INDEX_LEASE_MS).toISOString(),
      leaseOwner: dependencies.workerId,
      now,
    })) ?? deferredUntil(job.data.status === "queued" ? job.data.nextDueAt : undefined)
  );
}

export async function processBrainIndexMessage(
  message: BrainIndexQueueMessage,
  dependencies: BrainIndexRuntimeDependencies,
  signal?: AbortSignal,
) {
  const now = (dependencies.now ?? (() => new Date()))().toISOString();
  const claim = await runnableJob(dependencies, message, now);
  if (claim.outcome === "deferred") return claim;
  if (claim.outcome !== "claimed") return { outcome: claim.outcome };
  const job = claim.job;
  let mutationClaim: Awaited<ReturnType<typeof claimBrainProviderMutation>>["claim"] | undefined;
  try {
    const placement = await getBrainSearchPlacement(dependencies.database, job.data.organizationId);
    if (!placement) throw new BrainIndexStaleError();
    const target = targetForJob(job, placement);
    const provider = await dependencies.providers.resolve(target);
    const initialReadiness = await provider.inspect({ organizationId: job.data.organizationId });
    if (!initialReadiness.ready) {
      if (!provider.prepare) throw new Error("Brain provider target is not ready.");
      await provider.prepare({
        organizationId: job.data.organizationId,
        ...(signal ? { signal } : {}),
      });
      const preparedReadiness = await provider.inspect({
        organizationId: job.data.organizationId,
        ...(signal ? { signal } : {}),
      });
      if (!preparedReadiness.ready) throw new Error("Brain provider target is not ready.");
    }
    const snapshot = await canonicalSnapshot(dependencies.repository, job);
    const mutation = await claimBrainProviderMutation({
      database: dependencies.database,
      job,
      leaseExpiresAt: new Date(Date.parse(now) + BRAIN_INDEX_LEASE_MS).toISOString(),
      leaseOwner: dependencies.workerId,
      now,
    });
    mutationClaim = mutation.claim;
    if (mutation.outcome === "stale") {
      await skipBrainIndexJob({
        database: dependencies.database,
        job,
        now,
        reason: "A newer or stronger provider mutation already committed.",
      });
      return { outcome: "stale" as const };
    }
    if (mutation.outcome === "unknown" && mutation.claim.data.jobId === job.data.id) {
      const unknown =
        mutation.claim.data.status === "active"
          ? await markBrainProviderMutationUnknown({
              claim: mutation.claim,
              database: dependencies.database,
              now,
            })
          : mutation.claim;
      mutationClaim = await resumeBrainProviderMutation({
        claim: unknown,
        database: dependencies.database,
        job,
        leaseExpiresAt: new Date(Date.parse(now) + BRAIN_INDEX_LEASE_MS).toISOString(),
        leaseOwner: dependencies.workerId,
        now,
      });
    } else if (mutation.outcome !== "claimed") {
      throw new Error(`Brain provider mutation is ${mutation.outcome}.`);
    }
    const activeMutationClaim = mutationClaim;
    if (!activeMutationClaim || activeMutationClaim.data.status !== "active") {
      throw new Error("Brain provider mutation did not acquire an active lease.");
    }

    const previousState = await getBrainIndexState(
      dependencies.database,
      job.data.organizationId,
      job.data.documentId,
    );
    if (job.data.operation === "suppress") {
      await provider.deleteDocument({
        brainId: job.data.brainId,
        chunkIds: previousState?.data.chunkIds ?? [],
        documentId: job.data.documentId,
        organizationId: job.data.organizationId,
        ...(signal ? { signal } : {}),
      });
      await completeBrainIndexSuppression({
        claim: activeMutationClaim,
        database: dependencies.database,
        document: snapshot.document,
        job,
        now,
        ...(previousState ? { previousState } : {}),
      });
      return { outcome: "suppressed" as const };
    }
    if (!("rendition" in snapshot) || !snapshot.rendition) throw new BrainIndexStaleError();
    const indexSnapshot: BrainIndexCanonicalSnapshot = {
      brain: snapshot.brain,
      document: snapshot.document,
      rendition:
        brainTextRenditionKind(snapshot.version.mediaType) === "normalized"
          ? await ensureBrainTextRendition({
              database: dependencies.database,
              extractor: dependencies.extractor,
              now,
              repository: dependencies.repository,
              ...(signal ? { signal } : {}),
              snapshot,
              store: dependencies.textRenditionStore,
            }).catch(rethrowRejectedBeforeWrite)
          : snapshot.rendition,
      source: snapshot.source,
      version: snapshot.version,
    };
    const bytes = await dependencies.loadRendition(indexSnapshot, signal);
    const indexed = await indexBrainDocument({
      attemptId: job.data.id,
      bytes,
      embeddings: dependencies.embeddings(job),
      ...(dependencies.graph ? { graph: dependencies.graph } : {}),
      previousChunkIds: previousState?.data.chunkIds ?? [],
      provider,
      revalidate: async () => {
        const current = await canonicalSnapshot(dependencies.repository, job);
        const rendition =
          "rendition" in current && current.rendition
            ? await brainTextRendition(dependencies.repository, current.version)
            : undefined;
        if (!rendition) throw new BrainIndexStaleError();
        return {
          brain: current.brain,
          document: current.document,
          rendition,
          source: current.source,
          version: current.version,
        };
      },
      ...(signal ? { signal } : {}),
      snapshot: indexSnapshot,
      state: makeBrainIndexStatePort({
        database: dependencies.database,
        job,
        mutationClaim: activeMutationClaim,
        now: () => (dependencies.now ?? (() => new Date()))().toISOString(),
        snapshot: indexSnapshot,
      }),
      target,
    });
    return { chunkCount: indexed.chunkCount, outcome: "indexed" as const };
  } catch (cause) {
    const permanent = cause instanceof BrainIndexRejectedBeforeWriteError;
    if (
      (permanent || cause instanceof BrainIndexStaleError) &&
      mutationClaim?.data.status === "active"
    ) {
      await completeBrainProviderMutation({
        claim: mutationClaim,
        database: dependencies.database,
        now,
      });
    }
    if (cause instanceof BrainIndexStaleError && (await permanentlyStale(dependencies, job))) {
      await skipBrainIndexJob({
        database: dependencies.database,
        job,
        now,
        reason: cause.message,
      });
      return { outcome: "stale" as const };
    }
    await failBrainIndexJob({ cause, database: dependencies.database, job, now, permanent });
    throw cause;
  }
}
