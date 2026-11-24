import {
  MessagePublicationRecord,
  MessageRecord,
  RuntimeLeaseRecord,
  ThreadRecord,
  conversationMessageIsNonReplayable,
  conversationMessageIsTransient,
  visibleConversationMessageMetadata,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import {
  DEFAULT_DURABLE_STREAM_MAX_APPEND_BATCH_BYTES,
  createThreadStreamEvent,
  threadStreamEventJson,
  type ThreadStreamEvent,
} from "@deployments-ai/streaming";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import {
  ConversationError,
  content,
  queueIdempotencyKey,
  streamActor,
  type ConversationMessage,
  type ConversationRun,
  type ConversationThread,
} from "./submission.ts";

const DELIVERY_PUBLICATION_METADATA_KEY = "deploymentsAiDeliveryPublication";
const PUBLICATION_LEASE_OWNER_PREFIX = "message-publication/";
const PUBLICATION_BARRIER_EXPIRES_AT = "9999-12-31T23:59:59.999Z";

export type ConversationMessagePublication = Extract<
  PlatformRecord,
  { readonly itemType: "message-publication" }
>;

export type ThreadExecutionLease = Extract<PlatformRecord, { readonly itemType: "runtime-lease" }>;

export interface PublishConversationRunMessageInput {
  readonly actor: {
    readonly id?: Ulid;
    readonly type: "principal" | "service-account" | "system";
  };
  readonly content: string;
  readonly idempotencyKey: string;
  readonly run: ConversationRun;
  readonly signal?: AbortSignal;
  readonly sourceMessage: ConversationMessage;
  readonly thread: ConversationThread;
}

export interface NormalizedPublicationCommand {
  readonly commandHash: string;
  readonly deliveredContent: string;
  readonly safeContent: string;
}

export function publicationContentHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function publicationCommandHash(
  input: PublishConversationRunMessageInput,
  requestIdempotencyKey: string,
  deliveredContent: string,
) {
  return publicationContentHash(
    JSON.stringify({
      action: "confirmed-external-delivery",
      actor: { id: input.actor.id ?? null, type: input.actor.type },
      deliveredContentHash: publicationContentHash(deliveredContent),
      requestIdempotencyKey,
      runId: input.run.data.id,
      sourceContentHash: input.sourceMessage.data.contentHash,
      sourceMessageId: input.sourceMessage.data.id,
      sourceMessageSequence: input.sourceMessage.data.sequence,
      threadId: input.thread.data.id,
    }),
  );
}

function publishedContent(input: PublishConversationRunMessageInput, deliveredContent: string) {
  if (!conversationMessageIsNonReplayable(input.sourceMessage.data.metadata)) {
    return deliveredContent;
  }
  if (input.sourceMessage.data.body === undefined) {
    throw new ConversationError(
      "publication_unavailable",
      "A replay-protected automation result requires an inline authorization-safe reference.",
    );
  }
  return input.sourceMessage.data.body;
}

export function normalizePublicationCommand(
  input: PublishConversationRunMessageInput,
): NormalizedPublicationCommand {
  const deliveredContent = content(input.content);
  const safeContent = publishedContent(input, deliveredContent);
  const normalizedKey = queueIdempotencyKey(input.idempotencyKey);
  return {
    commandHash: publicationCommandHash(input, normalizedKey, deliveredContent),
    deliveredContent,
    safeContent,
  };
}

export function requireReservableThread(thread: ConversationThread) {
  if (thread.data.archived) {
    throw new ConversationError("thread_archived", "Archived threads cannot receive messages.");
  }
}

export function validatePublicationInput(input: PublishConversationRunMessageInput) {
  const { run, sourceMessage, thread } = input;
  if (
    run.data.status !== "completed" ||
    (run.data.trigger !== "heartbeat" &&
      run.data.trigger !== "schedule" &&
      run.data.responsePublication !== "external")
  ) {
    throw new ConversationError(
      "publication_unavailable",
      "Only completed automation or externally published run messages can be published.",
    );
  }
  if (run.data.responsePublication === "external" && run.data.userMessageSequence === undefined) {
    throw new ConversationError(
      "publication_unavailable",
      "An externally published run must identify its triggering user message.",
    );
  }
  if (!conversationMessageIsTransient(sourceMessage.data.metadata)) {
    throw new ConversationError(
      "publication_unavailable",
      "The canonical run message is not a provisional automation result.",
    );
  }
  if (
    sourceMessage.data.role !== "assistant" ||
    sourceMessage.data.runId !== run.data.id ||
    sourceMessage.data.threadId !== run.data.threadId ||
    sourceMessage.data.sequence > thread.data.version ||
    thread.data.id !== run.data.threadId ||
    sourceMessage.data.organizationId !== run.data.organizationId ||
    sourceMessage.data.projectId !== run.data.projectId ||
    sourceMessage.data.environmentId !== run.data.environmentId ||
    thread.data.organizationId !== run.data.organizationId ||
    thread.data.projectId !== run.data.projectId ||
    thread.data.environmentId !== run.data.environmentId ||
    thread.data.agentDeploymentId !== run.data.agentDeploymentId ||
    sourceMessage.data.agentDeploymentId !== run.data.agentDeploymentId
  ) {
    throw new ConversationError(
      "scope_mismatch",
      "Run message publication does not match its canonical conversation scope.",
    );
  }
}

function publicationMetadata(source: ConversationMessage) {
  return {
    ...visibleConversationMessageMetadata(source.data.metadata),
    [DELIVERY_PUBLICATION_METADATA_KEY]: {
      kind: "confirmed-external-delivery",
      sourceMessageId: source.data.id,
      sourceMessageSequence: source.data.sequence,
      sourceRunId: source.data.runId!,
    },
  };
}

export function publishedMessage(input: {
  readonly content: string;
  readonly now: Date;
  readonly publication: ConversationMessagePublication;
  readonly source: ConversationMessage;
}) {
  return Schema.decodeUnknownSync(MessageRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: input.source.data.agentDeploymentId,
        body: input.content,
        contentHash: publicationContentHash(input.content),
        createdAt: input.now.toISOString(),
        environmentId: input.publication.data.environmentId,
        id: input.publication.data.messageId,
        metadata: publicationMetadata(input.source),
        organizationId: input.publication.data.organizationId,
        projectId: input.publication.data.projectId,
        role: "assistant" as const,
        runId: input.publication.data.runId,
        sequence: input.publication.data.messageSequence,
        streamEventId: input.publication.data.streamEventId,
        threadId: input.publication.data.threadId,
      },
      itemType: "message" as const,
    }),
  );
}

export function advancedPublicationThread(previous: ConversationThread, now: Date) {
  return Schema.decodeUnknownSync(ThreadRecord)(
    withCanonicalRecordKeys({
      data: {
        ...previous.data,
        updatedAt: new Date(
          Math.max(now.getTime(), Date.parse(previous.data.updatedAt) || now.getTime()),
        ).toISOString(),
        version: previous.data.version + 1,
      },
      itemType: "thread" as const,
    }),
  );
}

export function publicationStreamEvent(
  message: ConversationMessage,
  sourceMessage: ConversationMessage,
  actor: PublishConversationRunMessageInput["actor"],
) {
  return createThreadStreamEvent({
    actor: streamActor(actor),
    environmentId: message.data.environmentId,
    eventId: message.data.streamEventId!,
    eventType: "assistant-message.finalized",
    messageId: message.data.id,
    occurredAt: message.data.createdAt,
    organizationId: message.data.organizationId,
    payload: {
      body: message.data.body!,
      contentHash: message.data.contentHash,
      messageId: message.data.id,
      runId: message.data.runId!,
      sequence: message.data.sequence,
      sourceMessageId: sourceMessage.data.id,
      sourceMessageSequence: sourceMessage.data.sequence,
      streamEventId: message.data.streamEventId!,
    },
    projectId: message.data.projectId,
    runId: message.data.runId!,
    threadId: message.data.threadId,
  });
}

export function requireStreamablePublication(event: ThreadStreamEvent) {
  const appendBytes = new TextEncoder().encode(`[${threadStreamEventJson(event)}]`).byteLength;
  if (appendBytes > DEFAULT_DURABLE_STREAM_MAX_APPEND_BATCH_BYTES) {
    throw new ConversationError(
      "message_too_large",
      "Delivered message cannot fit in one canonical conversation stream event.",
    );
  }
}

export function publicationMetadataMatches(
  message: ConversationMessage,
  source: ConversationMessage,
) {
  const metadata = message.data.metadata?.[DELIVERY_PUBLICATION_METADATA_KEY];
  const publication = metadata as Readonly<Record<string, unknown>> | undefined;
  return (
    publication !== undefined &&
    publication !== null &&
    typeof publication === "object" &&
    !Array.isArray(publication) &&
    publication.kind === "confirmed-external-delivery" &&
    publication.sourceMessageId === source.data.id &&
    publication.sourceMessageSequence === source.data.sequence &&
    publication.sourceRunId === source.data.runId
  );
}

export function reservedPublication(input: {
  readonly commandHash: string;
  readonly deliveredContentHash: string;
  readonly id: Ulid;
  readonly messageId: Ulid;
  readonly now: Date;
  readonly run: ConversationRun;
  readonly safeContentHash: string;
  readonly sequence: number;
  readonly source: ConversationMessage;
  readonly streamEventId: Ulid;
  readonly actor: PublishConversationRunMessageInput["actor"];
}) {
  return Schema.decodeUnknownSync(MessagePublicationRecord)(
    withCanonicalRecordKeys({
      data: {
        actor: input.actor,
        agentDeploymentId: input.run.data.agentDeploymentId,
        commandHash: input.commandHash,
        createdAt: input.now.toISOString(),
        deliveredContentHash: input.deliveredContentHash,
        environmentId: input.run.data.environmentId,
        id: input.id,
        messageId: input.messageId,
        messageSequence: input.sequence,
        organizationId: input.run.data.organizationId,
        projectId: input.run.data.projectId,
        runId: input.run.data.id,
        safeContentHash: input.safeContentHash,
        sourceMessageId: input.source.data.id,
        sourceMessageSequence: input.source.data.sequence,
        status: "reserved" as const,
        streamEventId: input.streamEventId,
        threadId: input.run.data.threadId,
        updatedAt: input.now.toISOString(),
        version: 0,
      },
      itemType: "message-publication" as const,
    }),
  );
}

export function publicationLease(publication: ConversationMessagePublication) {
  return Schema.decodeUnknownSync(RuntimeLeaseRecord)(
    withCanonicalRecordKeys({
      data: {
        acquiredAt: publication.data.createdAt,
        environmentId: publication.data.environmentId,
        // External providers do not accept an idempotency key. Only an explicit publish or release
        // may clear this barrier; elapsed wall-clock time can never prove a send did not happen.
        expiresAt: PUBLICATION_BARRIER_EXPIRES_AT,
        id: publication.data.threadId,
        leaseKey: `agent-run-thread/${publication.data.threadId}`,
        organizationId: publication.data.organizationId,
        owner: `${PUBLICATION_LEASE_OWNER_PREFIX}${publication.data.id}`,
        projectId: publication.data.projectId,
        runId: publication.data.runId,
        threadId: publication.data.threadId,
        version: 0,
      },
      itemType: "runtime-lease" as const,
    }),
  );
}

export function leaseMatchesPublication(
  lease: ThreadExecutionLease | undefined,
  publication: ConversationMessagePublication,
): lease is ThreadExecutionLease {
  return (
    lease?.data.id === publication.data.threadId &&
    lease.data.runId === publication.data.runId &&
    lease.data.owner === `${PUBLICATION_LEASE_OWNER_PREFIX}${publication.data.id}` &&
    lease.data.version === 0
  );
}

export function leaseIsMessagePublicationBarrier(lease: ThreadExecutionLease | undefined) {
  return lease?.data.owner.startsWith(PUBLICATION_LEASE_OWNER_PREFIX) === true;
}

export function transitionedPublication(
  previous: ConversationMessagePublication,
  status: "committed" | "published" | "released",
  timestamp: Date,
) {
  return Schema.decodeUnknownSync(MessagePublicationRecord)(
    withCanonicalRecordKeys({
      ...previous,
      data: {
        ...previous.data,
        ...(status === "committed" ? { committedAt: timestamp.toISOString() } : {}),
        ...(status === "published" ? { publishedAt: timestamp.toISOString() } : {}),
        ...(status === "released" ? { releasedAt: timestamp.toISOString() } : {}),
        status,
        updatedAt: timestamp.toISOString(),
        version: previous.data.version + 1,
      },
    }),
  );
}

export function requireMatchingPublication(
  input: PublishConversationRunMessageInput,
  publication: ConversationMessagePublication,
  command: NormalizedPublicationCommand,
) {
  if (
    publication.data.commandHash !== command.commandHash ||
    publication.data.deliveredContentHash !== publicationContentHash(command.deliveredContent) ||
    publication.data.safeContentHash !== publicationContentHash(command.safeContent)
  ) {
    throw new ConversationError(
      "idempotency_conflict",
      "Message publication reservation belongs to another delivery command.",
    );
  }
  if (
    publication.data.runId !== input.run.data.id ||
    publication.data.threadId !== input.thread.data.id ||
    publication.data.sourceMessageId !== input.sourceMessage.data.id ||
    publication.data.sourceMessageSequence !== input.sourceMessage.data.sequence ||
    publication.data.organizationId !== input.run.data.organizationId ||
    publication.data.projectId !== input.run.data.projectId ||
    publication.data.environmentId !== input.run.data.environmentId ||
    publication.data.agentDeploymentId !== input.run.data.agentDeploymentId
  ) {
    throw new ConversationError(
      "scope_mismatch",
      "Message publication reservation does not match its canonical source.",
    );
  }
}
