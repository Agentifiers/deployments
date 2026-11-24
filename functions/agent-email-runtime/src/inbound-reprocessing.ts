import {
  agentEmailTenantObjectPrefix,
  buildAgentEmailDomainEvent,
  type AgentEmailBlobStore,
  type AgentEmailDomainEvent,
  type AgentEmailMessageRecord,
} from "@deployments-ai/agent-email";
import {
  deterministicAgentEmailUlid,
  externalizeInboundAgentEmailBodies,
  parseInboundAgentEmail,
  type ParsedInboundAgentEmail,
} from "@deployments-ai/agent-email/aws";
import {
  InboxMailErasedError,
  makeAgentEmailDynamoRepository,
  makeInboundPersistence,
  type AgentEmailAttachmentBlob,
  type AgentEmailContentCleanup,
  type AgentEmailEndUserKeys,
  type AgentEmailMessageBodyReferenceUpdate,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid as UlidValue,
} from "@deployments-ai/db";

import {
  databaseRecord,
  messageAttachmentRecords,
  reprocessCommand,
  ulid,
} from "./inbound-receipt-routing.ts";
import { definedFields } from "./record-fields.ts";

type InboxMessagePlatformRecord = Extract<PlatformRecord, { readonly itemType: "inbox-message" }>;
type InboxAttachmentPlatformRecord = Extract<
  PlatformRecord,
  { readonly itemType: "inbox-attachment" }
>;

export interface AgentEmailReprocessCommand {
  readonly environmentId: UlidValue;
  readonly inboxId: UlidValue;
  readonly messageId: UlidValue;
  readonly organizationId: UlidValue;
  readonly projectId: UlidValue;
  readonly reprocessId: string;
}

export interface AgentEmailReprocessDependencies {
  readonly blobs: AgentEmailBlobStore;
  readonly bucket: string;
  readonly completeContentCleanup: (
    cleanup: Extract<PlatformRecord, { readonly itemType: "inbox-content-cleanup" }>,
    completedAt: string,
  ) => Promise<unknown>;
  readonly loadContentCleanup: (
    cleanupId: string,
  ) => Promise<Extract<PlatformRecord, { readonly itemType: "inbox-content-cleanup" }> | undefined>;
  readonly loadDurableMessage: () => Promise<InboxMessagePlatformRecord | undefined>;
  readonly now?: () => Date;
  readonly updateMessage: (
    previous: InboxMessagePlatformRecord,
    message: AgentEmailMessageRecord,
    event: AgentEmailDomainEvent,
    bodyReferences: AgentEmailMessageBodyReferenceUpdate,
    attachments: readonly AgentEmailAttachmentBlob[],
    cleanup: AgentEmailContentCleanup,
  ) => Promise<unknown>;
}

function sameBlobReference(
  actual: InboxMessagePlatformRecord["data"]["htmlBodyRef"],
  expected: InboxMessagePlatformRecord["data"]["htmlBodyRef"],
) {
  if (!actual || !expected) return actual === expected;
  return (
    actual.bucket === expected.bucket &&
    actual.key === expected.key &&
    actual.versionId === expected.versionId &&
    actual.sha256 === expected.sha256 &&
    actual.byteSize === expected.byteSize
  );
}

function durableReprocessMatches(
  durable: InboxMessagePlatformRecord | undefined,
  previous: InboxMessagePlatformRecord,
  updated: AgentEmailMessageRecord,
  bodyReferences: AgentEmailMessageBodyReferenceUpdate,
) {
  return (
    durable?.data.id === previous.data.id &&
    durable.data.inboxId === previous.data.inboxId &&
    durable.data.organizationId === previous.data.organizationId &&
    durable.data.projectId === previous.data.projectId &&
    durable.data.environmentId === previous.data.environmentId &&
    durable.data.version === previous.data.version + 1 &&
    durable.data.updatedAt === updated.updatedAt &&
    durable.data.lastReprocessedAt === updated.lastReprocessedAt &&
    durable.data.reprocessCount === updated.reprocessCount &&
    durable.data.subject === updated.subject &&
    durable.data.htmlBody === updated.htmlBody &&
    durable.data.textBody === updated.textBody &&
    sameBlobReference(durable.data.htmlBodyRef, bodyReferences.htmlBodyRef ?? undefined) &&
    sameBlobReference(durable.data.textBodyRef, bodyReferences.textBodyRef ?? undefined)
  );
}

async function cleanUpCreatedVersions(
  blobs: AgentEmailBlobStore,
  references: readonly {
    readonly bucket: string;
    readonly key: string;
    readonly versionId: string;
  }[],
  cause: unknown,
) {
  const cleanup = await Promise.allSettled(
    references.map((reference) =>
      blobs.delete(reference.key, reference.bucket, reference.versionId),
    ),
  );
  const failures = cleanup.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(
      [cause, ...failures],
      "Failed to reprocess and clean up agent email content.",
      { cause },
    );
  }
}

async function finishContentCleanup(
  cleanup: Extract<PlatformRecord, { readonly itemType: "inbox-content-cleanup" }>,
  dependencies: AgentEmailReprocessDependencies,
) {
  if (cleanup.data.status === "completed") return;
  await Promise.all(
    cleanup.data.references.map((reference) =>
      dependencies.blobs.delete(reference.key, reference.bucket, reference.versionId),
    ),
  );
  await dependencies.completeContentCleanup(
    cleanup,
    (dependencies.now ?? (() => new Date()))().toISOString(),
  );
}

export async function persistAgentEmailReprocess(
  command: AgentEmailReprocessCommand,
  previous: InboxMessagePlatformRecord,
  oldAttachments: readonly InboxAttachmentPlatformRecord[],
  parsed: ParsedInboundAgentEmail,
  dependencies: AgentEmailReprocessDependencies,
): Promise<"erased" | "reprocessed"> {
  const cleanupId = deterministicAgentEmailUlid(
    previous.data.createdAt,
    "reprocess-content-cleanup-v1",
    command.messageId,
    command.reprocessId,
  );
  const existingCleanup = await dependencies.loadContentCleanup(cleanupId);
  if (existingCleanup) {
    await finishContentCleanup(existingCleanup, dependencies);
    return "reprocessed";
  }
  const uploadedAttachments: {
    readonly blob: AgentEmailAttachmentBlob;
    readonly created: boolean;
  }[] = [];
  const createdVersions: {
    readonly bucket: string;
    readonly key: string;
    readonly versionId: string;
  }[] = [];
  let cleanupOnFailure = true;
  const orderedOldAttachments = [...oldAttachments].sort(
    (left, right) =>
      (left.data.ordinal ?? Number.MAX_SAFE_INTEGER) -
      (right.data.ordinal ?? Number.MAX_SAFE_INTEGER),
  );
  const canReuseAttachmentIds = orderedOldAttachments.every(
    (attachment, index) => attachment.data.ordinal === index,
  );

  try {
    for (const [index, attachment] of parsed.attachments.entries()) {
      const id =
        (canReuseAttachmentIds ? orderedOldAttachments[index]?.data.id : undefined) ??
        deterministicAgentEmailUlid(
          previous.data.createdAt,
          "reprocess-attachment-slot-v1",
          command.messageId,
          String(index),
        );
      const revision = deterministicAgentEmailUlid(
        previous.data.createdAt,
        "reprocess-attachment-revision-v1",
        command.messageId,
        command.reprocessId,
        String(index),
      );
      const tenantPrefix = agentEmailTenantObjectPrefix(command);
      const key = `${tenantPrefix}/attachments/${command.inboxId}/${command.messageId}/${id}/${revision}`;
      // eslint-disable-next-line no-await-in-loop -- Each upload is tracked for precise compensation.
      const stored = await dependencies.blobs.put({
        body: attachment.content,
        contentType: attachment.contentType,
        ifAbsent: true,
        key,
        metadata: { sha256: attachment.sha256 },
      });
      const blob = {
        bucket: dependencies.bucket,
        byteSize: attachment.byteSize,
        ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
        contentType: attachment.contentType,
        disposition: attachment.disposition,
        ...(stored?.etag ? { etag: stored.etag } : {}),
        fileName: attachment.fileName,
        id: ulid(id),
        key,
        sha256: attachment.sha256,
        ...(stored?.versionId ? { versionId: stored.versionId } : {}),
      };
      uploadedAttachments.push({ blob, created: stored?.created === true });
      if (stored?.created === true && stored.versionId) {
        createdVersions.push({
          bucket: dependencies.bucket,
          key,
          versionId: stored.versionId,
        });
      }
    }

    const externalized = await externalizeInboundAgentEmailBodies(parsed, {
      attemptId: command.reprocessId,
      blobs: dependencies.blobs,
      bucket: dependencies.bucket,
      keyPrefix: `${agentEmailTenantObjectPrefix(command)}/bodies/${command.inboxId}/${command.messageId}`,
    });
    createdVersions.push(
      ...externalized.createdBodyReferences.flatMap((reference) =>
        reference.versionId
          ? [
              {
                bucket: reference.bucket,
                key: reference.key,
                versionId: reference.versionId,
              },
            ]
          : [],
      ),
    );
    const {
      environmentId: _environmentId,
      htmlBodyRef: oldHtmlBodyRef,
      priority: _priority,
      projectId: _projectId,
      rawReference: _rawReference,
      textBodyRef: oldTextBodyRef,
      version: _version,
      ...messageData
    } = previous.data;
    const current: AgentEmailMessageRecord = {
      ...definedFields(messageData),
      attachments: uploadedAttachments.map(({ blob }) => ({
        byteSize: blob.byteSize,
        ...(blob.contentId ? { contentId: blob.contentId } : {}),
        contentType: blob.contentType,
        disposition: blob.disposition,
        fileName: blob.fileName,
        id: blob.id,
        messageId: command.messageId,
        sha256: blob.sha256,
      })),
    };
    const { htmlBody: _currentHtmlBody, textBody: _currentTextBody, ...withoutBodies } = current;
    const updatedAt = (dependencies.now ?? (() => new Date()))().toISOString();
    const updated: AgentEmailMessageRecord = {
      ...withoutBodies,
      bccAddresses: externalized.parsed.bccAddresses,
      ccAddresses: externalized.parsed.ccAddresses,
      fromAddress: externalized.parsed.fromAddress,
      ...(externalized.parsed.htmlBody ? { htmlBody: externalized.parsed.htmlBody } : {}),
      ...(externalized.parsed.inReplyTo ? { inReplyTo: externalized.parsed.inReplyTo } : {}),
      ...(externalized.parsed.internetMessageId
        ? { internetMessageId: externalized.parsed.internetMessageId }
        : {}),
      lastReprocessedAt: updatedAt,
      references: externalized.parsed.references,
      reprocessCount: current.reprocessCount + 1,
      replyToAddresses: externalized.parsed.replyToAddresses,
      subject: externalized.parsed.subject,
      ...(externalized.parsed.textBody !== undefined
        ? { textBody: externalized.parsed.textBody }
        : {}),
      threadKey: externalized.parsed.threadKey,
      toAddresses: externalized.parsed.toAddresses,
      updatedAt,
    };
    const bodyReferences = {
      htmlBodyRef: externalized.bodyReferences.htmlBodyRef ?? null,
      textBodyRef: externalized.bodyReferences.textBodyRef ?? null,
    } satisfies AgentEmailMessageBodyReferenceUpdate;
    const eventId = deterministicAgentEmailUlid(
      current.createdAt,
      "reprocess-v1",
      command.messageId,
      command.reprocessId,
    );
    const currentAttachmentKeys = new Set(
      uploadedAttachments.map(({ blob }) => `${blob.bucket}\u0000${blob.key}`),
    );
    const cleanupReferences = [
      ...oldAttachments.map((attachment) => attachment.data.storage),
      oldHtmlBodyRef,
      oldTextBodyRef,
    ].filter(
      (reference): reference is NonNullable<typeof oldHtmlBodyRef> =>
        reference !== undefined &&
        !currentAttachmentKeys.has(`${reference.bucket}\u0000${reference.key}`) &&
        reference.key !== externalized.bodyReferences.htmlBodyRef?.key &&
        reference.key !== externalized.bodyReferences.textBodyRef?.key,
    );
    const cleanup: AgentEmailContentCleanup = {
      createdAt: updatedAt,
      id: ulid(cleanupId),
      references: cleanupReferences,
      resourceId: command.messageId,
      resourceType: "message",
    };
    cleanupOnFailure = false;
    try {
      await dependencies.updateMessage(
        previous,
        updated,
        buildAgentEmailDomainEvent({
          aggregateId: updated.id,
          eventId,
          eventType: "agent-email.received",
          payload: {
            address: updated.toAddresses[0] ?? "",
            context: {
              environmentId: command.environmentId,
              projectId: command.projectId,
            },
            direction: "inbound",
            fromAddress: updated.fromAddress,
            inboxId: updated.inboxId,
            messageId: updated.id,
            occurredAt: updatedAt,
            organizationId: updated.organizationId,
            ...(updated.providerMessageId ? { providerMessageId: updated.providerMessageId } : {}),
            status: updated.status,
            subject: updated.subject,
            toAddresses: updated.toAddresses,
            version: 2,
          },
        }),
        bodyReferences,
        uploadedAttachments.map(({ blob }) => blob),
        cleanup,
      );
    } catch (cause) {
      const durable = await dependencies.loadDurableMessage();
      if (!durableReprocessMatches(durable, previous, updated, bodyReferences)) {
        cleanupOnFailure = true;
        throw cause;
      }
    }
    const durableCleanup = await dependencies.loadContentCleanup(cleanupId);
    if (!durableCleanup) {
      throw new Error("Committed agent email reprocessing cleanup work is missing.");
    }
    await finishContentCleanup(durableCleanup, dependencies);
    return "reprocessed";
  } catch (cause) {
    if (!cleanupOnFailure) throw cause;
    await cleanUpCreatedVersions(dependencies.blobs, createdVersions, cause);
    if (cause instanceof InboxMailErasedError) return "erased";
    throw cause;
  }
}

export async function loadRetainedAgentEmailRaw(
  previous: Extract<PlatformRecord, { readonly itemType: "inbox-message" }>,
  input: {
    readonly blobs: AgentEmailBlobStore;
    readonly bucket: string;
    readonly checkedAt: string;
    readonly legacyBuckets?: readonly string[];
  },
) {
  const rawReference = previous.data.rawReference;
  const tenantRawPrefix = `raw/${agentEmailTenantObjectPrefix(previous.data)}/`;
  if (
    !rawReference ||
    (rawReference.bucket !== input.bucket && !input.legacyBuckets?.includes(rawReference.bucket)) ||
    !rawReference.key.startsWith(tenantRawPrefix) ||
    previous.data.rawPurgedAt ||
    !previous.data.rawRetentionExpiresAt ||
    previous.data.rawRetentionExpiresAt <= input.checkedAt
  ) {
    throw new Error("Agent email reprocess raw reference is unavailable.");
  }
  return input.blobs.get(rawReference.key, rawReference.versionId, rawReference.bucket);
}

export interface AgentEmailReprocessRuntime {
  readonly blobs: AgentEmailBlobStore;
  readonly bucket: string;
  readonly database: DynamoDatabaseService;
  readonly endUserKeys: AgentEmailEndUserKeys;
  readonly legacyBuckets: readonly string[];
  readonly now?: () => Date;
}

export async function reprocessAgentEmailMessage(
  value: unknown,
  runtime: AgentEmailReprocessRuntime,
): Promise<"erased" | "reprocessed"> {
  const { database } = runtime;
  const command = reprocessCommand(value);
  const environmentRecord = await makeInboundPersistence({ database }).loadEnvironment(command);
  if (environmentRecord?.data.status !== "active") {
    throw new Error("Agent email reprocessing requires an active environment.");
  }
  const repository = makeAgentEmailDynamoRepository(
    database,
    {
      environmentId: command.environmentId,
      organizationId: command.organizationId,
      projectId: command.projectId,
    },
    runtime.endUserKeys,
  );
  const loadDurableMessage = () =>
    databaseRecord(database, "execution", {
      pk: `ORG#${command.organizationId}#INBOX#${command.inboxId}`,
      sk: `INBOX-MESSAGE#${command.messageId}`,
    }).then((record) => (record?.itemType === "inbox-message" ? record : undefined));
  const previous = await loadDurableMessage();
  if (!previous) return "erased";
  if (
    previous.data.organizationId !== command.organizationId ||
    previous.data.projectId !== command.projectId ||
    previous.data.environmentId !== command.environmentId ||
    previous.data.inboxId !== command.inboxId
  ) {
    throw new Error("Agent email reprocess message scope is invalid.");
  }
  const now = runtime.now ?? (() => new Date());
  const raw = await loadRetainedAgentEmailRaw(previous, {
    blobs: runtime.blobs,
    bucket: runtime.bucket,
    checkedAt: now().toISOString(),
    legacyBuckets: runtime.legacyBuckets,
  });
  const parsed = await parseInboundAgentEmail(
    raw,
    previous.data.providerMessageId ?? command.messageId,
  );
  const oldAttachments = await messageAttachmentRecords(database, command);
  return persistAgentEmailReprocess(command, previous, oldAttachments, parsed, {
    blobs: runtime.blobs,
    bucket: runtime.bucket,
    completeContentCleanup: (cleanup, completedAt) =>
      repository.completeContentCleanup(cleanup, completedAt),
    loadContentCleanup: (cleanupId) => repository.getContentCleanup(command.messageId, cleanupId),
    loadDurableMessage,
    now,
    updateMessage: (current, updated, event, bodyReferences, attachments, cleanup) =>
      repository.updateMessage(current, updated, event, bodyReferences, attachments, cleanup),
  });
}
