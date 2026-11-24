import {
  captureBrainContent,
  captureBrainDocumentLifecycle,
  type BrainBlobReference,
  type BrainRepository,
  type BrainSource,
} from "@deployments-ai/brains";
import {
  activeBrainCondition,
  activeHumanCondition,
  activeMemberCondition,
  activeOrganizationCondition,
  activeOwnerGrantCondition,
  brainGrantPlatformRecord,
  brainPlatformRecord,
  brainSourcePlatformRecord,
  brainUlid,
  BrainSyncJobRecord,
  githubConnectionAuthorization,
  key,
  makeSemanticEventRecord,
  transactWithSemanticEvents,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  withCanonicalRecordKeys,
  apiPersistence,
  makeOrganizationHoldReader,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { backgroundWorkSuspended } from "../background-standing.ts";

export type BrainSyncJob = Extract<PlatformRecord, { readonly itemType: "brain-sync-job" }>;

export interface BrainGitHubSnapshot {
  readonly committedAt: string;
  readonly cursor: string;
  readonly files: readonly {
    readonly path: string;
    readonly read: (signal?: AbortSignal) => Promise<Uint8Array>;
    readonly sha: string;
    readonly size: number;
  }[];
}

export interface BrainSyncRuntimeDependencies {
  readonly database: DynamoDatabaseService;
  readonly generateId: () => Promise<string>;
  readonly loadGitHubSnapshot: (input: {
    readonly accessToken: string;
    readonly signal?: AbortSignal;
    readonly source: BrainSource;
  }) => Promise<BrainGitHubSnapshot>;
  readonly now?: () => string;
  readonly readGitHubAccessToken: (input: {
    readonly connection: Extract<PlatformRecord, { readonly itemType: "provider-connection" }>;
    readonly expectedGeneration: number;
  }) => Promise<string>;
  readonly repository: BrainRepository;
  readonly upload: (input: {
    readonly brainId: string;
    readonly bytes: Uint8Array;
    readonly contentHash: string;
    readonly contentType: string;
    readonly objectKey: string;
    readonly organizationId: string;
    readonly signal?: AbortSignal;
  }) => Promise<BrainBlobReference>;
  readonly workerId: string;
}

export interface BrainSyncQueueMessage {
  readonly brainId: string;
  readonly idempotencyKey: string;
  readonly organizationId: string;
}

function jobRecord(job: BrainSyncJob, data: BrainSyncJob["data"]): BrainSyncJob {
  return Schema.decodeUnknownSync(BrainSyncJobRecord)(withCanonicalRecordKeys({ ...job, data }));
}

async function loadJob(database: DynamoDatabaseService, message: BrainSyncQueueMessage) {
  const value = await apiPersistence.read(
    database,
    "execution",
    {
      pk: key("ORG", message.organizationId, "BRAIN", message.brainId),
      sk: key("BRAIN-SYNC-JOB", message.idempotencyKey),
    },
    true,
  );
  return value?.itemType === "brain-sync-job" ? value : undefined;
}

async function claimJob(
  database: DynamoDatabaseService,
  message: BrainSyncQueueMessage,
  workerId: string,
  now: string,
) {
  let job = await loadJob(database, message);
  if (!job || job.data.status === "succeeded") return undefined;
  if (job.data.status === "running") {
    if (!job.data.leaseExpiresAt || job.data.leaseExpiresAt > now) {
      throw new Error("Brain sync job already has an active lease.");
    }
  }
  if (job.data.nextDueAt > now) throw new Error("Brain sync retry is not due yet.");
  const claimed = jobRecord(job, {
    ...job.data,
    attempt: job.data.attempt + 1,
    leaseExpiresAt: new Date(Date.parse(now) + 10 * 60_000).toISOString(),
    leaseOwner: workerId,
    startedAt: now,
    status: "running",
    updatedAt: now,
    version: job.data.version + 1,
  });
  await apiPersistence.commit(database, [
    {
      conditionExpression: "#itemType = :itemType AND #data.#status = :active",
      expressionAttributeNames: { "#data": "data", "#itemType": "itemType", "#status": "status" },
      expressionAttributeValues: { ":active": "active", ":itemType": "brain" },
      key: {
        pk: key("ORG", job.data.organizationId),
        sk: key("BRAIN", job.data.brainId),
      },
      kind: "condition-check",
      table: "control",
    },
    { kind: "put", previousRecord: job, record: claimed },
  ]);
  return claimed;
}

async function allSourceDocuments(
  repository: BrainRepository,
  organizationId: string,
  brainId: string,
  sourceId: string,
) {
  const documents = [];
  let cursor: string | undefined;
  do {
    const page = await repository.listDocumentsBySource(organizationId, brainId, sourceId, {
      ...(cursor ? { cursor } : {}),
      limit: 100,
    });
    documents.push(...page.items);
    cursor = page.nextCursor;
    if (documents.length > 5_000) throw new Error("Brain source document inventory is too large.");
  } while (cursor);
  return documents;
}

async function completeSync(input: {
  readonly connection: Extract<PlatformRecord, { readonly itemType: "provider-connection" }>;
  readonly dependencies: BrainSyncRuntimeDependencies;
  readonly grant: NonNullable<Awaited<ReturnType<BrainRepository["getGrant"]>>>;
  readonly job: BrainSyncJob;
  readonly snapshot: BrainGitHubSnapshot;
  readonly source: BrainSource;
}) {
  const { connection, dependencies, grant, job, snapshot, source } = input;
  const now = (dependencies.now ?? (() => new Date().toISOString()))();
  const brain = await dependencies.repository.get(source.organizationId, source.brainId);
  if (!brain) throw new Error("Brain sync target is unavailable.");
  const { syncError: _syncError, ...sourceWithoutError } = source;
  const nextSource: BrainSource = {
    ...sourceWithoutError,
    lastSyncAt: now,
    status: "active",
    syncCursor: snapshot.cursor,
    updatedAt: now,
    updatedByPrincipalId: job.data.requestedByPrincipalId,
    version: source.version + 1,
  };
  const terminal = jobRecord(job, {
    ...job.data,
    completedAt: now,
    status: "succeeded",
    updatedAt: now,
    version: job.data.version + 1,
  });
  const nextId = await dependencies.generateId();
  const nextJob = Schema.decodeUnknownSync(BrainSyncJobRecord)(
    withCanonicalRecordKeys({
      data: {
        attempt: 0,
        authorizingGrantId: job.data.authorizingGrantId,
        brainId: job.data.brainId,
        connectionCredentialGeneration:
          connection.data.credentialRef && "generation" in connection.data.credentialRef
            ? connection.data.credentialRef.generation
            : job.data.connectionCredentialGeneration,
        connectionId: job.data.connectionId,
        createdAt: now,
        id: brainUlid(nextId),
        idempotencyKey: `${source.id}:scheduled:${nextId}`,
        nextDueAt: new Date(Date.parse(now) + 60 * 60_000).toISOString(),
        organizationId: job.data.organizationId,
        priority: 100,
        requestedByPrincipalId: job.data.requestedByPrincipalId,
        sourceId: job.data.sourceId,
        status: "queued" as const,
        syncCursor: snapshot.cursor,
        updatedAt: now,
        version: 0,
      },
      itemType: "brain-sync-job" as const,
    }),
  );
  const connector = await githubConnectionAuthorization(dependencies.database, source);
  const eventId = await dependencies.generateId();
  await transactWithSemanticEvents(
    dependencies.database,
    [
      activeOrganizationCondition(source.organizationId),
      activeHumanCondition(job.data.requestedByPrincipalId),
      activeMemberCondition(source.organizationId, job.data.requestedByPrincipalId),
      activeBrainCondition(brainPlatformRecord(brain)),
      activeOwnerGrantCondition(brainGrantPlatformRecord(grant)),
      connector.condition,
      {
        kind: "put",
        previousRecord: brainSourcePlatformRecord(source),
        record: brainSourcePlatformRecord(nextSource),
      },
      { kind: "put", previousRecord: job, record: terminal },
      { kind: "put", record: nextJob },
    ],
    [
      makeSemanticEventRecord({
        actor: { id: brainUlid(job.data.requestedByPrincipalId), type: "principal" },
        aggregateId: brainUlid(source.id),
        aggregateType: "brain-source",
        aggregateVersion: nextSource.version + 1,
        eventId: brainUlid(eventId),
        eventType: "brain-source.synchronized",
        occurredAt: now,
        organizationId: brainUlid(source.organizationId),
        payload: { brainId: source.brainId, cursor: snapshot.cursor, sourceId: source.id },
      }),
    ],
    eventId,
  );
}

async function failSync(
  dependencies: BrainSyncRuntimeDependencies,
  job: BrainSyncJob,
  source: BrainSource | undefined,
  cause: unknown,
) {
  const now = (dependencies.now ?? (() => new Date().toISOString()))();
  const message = (cause instanceof Error ? cause.message : String(cause)).slice(0, 1_000);
  const failed = jobRecord(job, {
    ...job.data,
    error: message || "Brain source synchronization failed.",
    nextDueAt: new Date(Date.parse(now) + 5 * 60_000).toISOString(),
    status: "failed",
    updatedAt: now,
    version: job.data.version + 1,
  });
  const operations: TransactionOperation[] = [{ kind: "put", previousRecord: job, record: failed }];
  if (source) {
    const nextSource: BrainSource = {
      ...source,
      syncError: message || "Brain source synchronization failed.",
      updatedAt: now,
      updatedByPrincipalId: job.data.requestedByPrincipalId,
      version: source.version + 1,
    };
    operations.push({
      kind: "put",
      previousRecord: brainSourcePlatformRecord(source),
      record: brainSourcePlatformRecord(nextSource),
    });
  }
  await apiPersistence.commit(dependencies.database, operations);
}

export async function processBrainSyncMessage(
  message: BrainSyncQueueMessage,
  dependencies: BrainSyncRuntimeDependencies,
  signal?: AbortSignal,
) {
  const now = (dependencies.now ?? (() => new Date().toISOString()))();
  if (
    await backgroundWorkSuspended(
      makeOrganizationHoldReader(dependencies.database),
      message.organizationId,
    )
  ) {
    return { outcome: "suspended" as const };
  }
  const job = await claimJob(dependencies.database, message, dependencies.workerId, now);
  if (!job) return { outcome: "ignored" as const };
  let source: BrainSource | undefined;
  try {
    const [brainValue, sourceValue, grant] = await Promise.all([
      dependencies.repository.get(job.data.organizationId, job.data.brainId),
      dependencies.repository.getSource(
        job.data.organizationId,
        job.data.brainId,
        job.data.sourceId,
      ),
      dependencies.repository.getGrant(
        job.data.organizationId,
        job.data.brainId,
        job.data.authorizingGrantId,
      ),
    ]);
    source = sourceValue;
    if (
      !brainValue ||
      !source ||
      source.kind !== "github" ||
      !grant ||
      grant.permission !== "owner" ||
      grant.status !== "active" ||
      grant.target.type !== "principal" ||
      grant.target.principalId !== job.data.requestedByPrincipalId
    ) {
      throw new Error("Brain GitHub sync authorization is unavailable.");
    }
    const connector = await githubConnectionAuthorization(dependencies.database, source);
    if (
      !connector.connection.data.credentialRef ||
      !("generation" in connector.connection.data.credentialRef) ||
      connector.connection.data.credentialRef.generation !== job.data.connectionCredentialGeneration
    ) {
      throw new Error("Brain GitHub sync credential generation changed before execution.");
    }
    const accessToken = await dependencies.readGitHubAccessToken({
      connection: connector.connection,
      expectedGeneration: job.data.connectionCredentialGeneration,
    });
    const snapshot = await dependencies.loadGitHubSnapshot({
      accessToken,
      ...(signal ? { signal } : {}),
      source,
    });
    const existing = await allSourceDocuments(
      dependencies.repository,
      source.organizationId,
      source.brainId,
      source.id,
    );
    const existingByPath = new Map(
      existing.map((document) => [document.externalItemIdentity, document]),
    );
    for (const file of snapshot.files) {
      const previous = existingByPath.get(file.path);
      const previousVersion = previous?.currentVersionId
        ? await dependencies.repository.getDocumentVersion(
            source.organizationId,
            previous.id,
            previous.currentVersionId,
          )
        : undefined;
      const sourceRevision = `${file.path}:${file.sha}`;
      if (previousVersion?.sourceRevision === sourceRevision && previous?.lifecycle === "active") {
        continue;
      }
      const bytes = await file.read(signal);
      await captureBrainContent({
        actor: { kind: "human", principalId: job.data.requestedByPrincipalId },
        authorizingGrant: grant,
        brain: brainValue,
        bytes,
        externalItemIdentity: file.path,
        generateId: dependencies.generateId,
        mediaType: file.path.endsWith(".json") ? "application/json" : "text/plain",
        ...(dependencies.now ? { now: dependencies.now } : {}),
        repository: dependencies.repository,
        source,
        sourceLocator: `https://github.com/${String(source.configuration?.owner)}/${String(source.configuration?.repository)}/blob/${snapshot.cursor}/${file.path}`,
        sourceRevision,
        sourceTimestamp: snapshot.committedAt,
        title: file.path.split("/").at(-1) ?? file.path,
        upload: ({ bytes: uploadBytes, ticket }) =>
          dependencies.upload({
            brainId: source!.brainId,
            bytes: uploadBytes,
            contentHash: ticket.expectedContentHash,
            contentType: ticket.mediaType,
            objectKey: ticket.objectKey,
            organizationId: source!.organizationId,
            ...(signal ? { signal } : {}),
          }),
      });
    }
    const currentPaths = new Set(snapshot.files.map((file) => file.path));
    for (const document of existing) {
      if (document.lifecycle !== "active" || currentPaths.has(document.externalItemIdentity))
        continue;
      await captureBrainDocumentLifecycle({
        actor: { kind: "human", principalId: job.data.requestedByPrincipalId },
        authorizingGrant: grant,
        brain: brainValue,
        externalItemIdentity: document.externalItemIdentity,
        generateId: dependencies.generateId,
        kind: "tombstone",
        ...(dependencies.now ? { now: dependencies.now } : {}),
        repository: dependencies.repository,
        source,
        sourceRevision: `deleted:${snapshot.cursor}:${document.externalItemIdentity}`,
        sourceTimestamp: snapshot.committedAt,
        transitionReason: "The file is absent from the current GitHub repository snapshot.",
      });
    }
    await completeSync({
      connection: connector.connection,
      dependencies,
      grant,
      job,
      snapshot,
      source,
    });
    return { imported: snapshot.files.length, outcome: "synchronized" as const };
  } catch (cause) {
    await failSync(dependencies, job, source, cause);
    throw cause;
  }
}
