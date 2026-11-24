import {
  ConversationError,
  createConversationMessagePublicationService,
  type ConversationMessage,
  type ConversationRun,
  type ConversationThread,
} from "@deployments-ai/conversations";
import {
  makeConversationPersistence,
  makeRunMessagePersistence,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import type { ThreadStreamEvent } from "@deployments-ai/streaming";

type ExternalDelivery = Extract<PlatformRecord, { readonly itemType: "channel-delivery" }>;

export interface ExternalResponsePublication {
  readonly publish: (delivery: ExternalDelivery, signal?: AbortSignal) => Promise<void>;
  readonly release: (delivery: ExternalDelivery, signal?: AbortSignal) => Promise<void>;
  readonly reserve: (
    delivery: ExternalDelivery,
    signal?: AbortSignal,
  ) => Promise<"reserved" | "superseded">;
}

export interface ExternalResponsePublicationOptions {
  readonly appendThreadEvent: (event: ThreadStreamEvent, signal?: AbortSignal) => Promise<void>;
  readonly database: DynamoDatabaseService;
  readonly generateId: () => Promise<Ulid>;
  readonly now?: () => Date;
}

export function isMissingExternalPublicationReservation(cause: unknown) {
  return cause instanceof ConversationError && cause.code === "publication_not_reserved";
}

function expected<ItemType extends PlatformRecord["itemType"]>(
  value: PlatformRecord | undefined,
  itemType: ItemType,
  label: string,
): Extract<PlatformRecord, { readonly itemType: ItemType }> {
  if (!value || value.itemType !== itemType) throw new Error(`${label} is unavailable.`);
  return value as Extract<PlatformRecord, { readonly itemType: ItemType }>;
}

function requireExternalDelivery(delivery: ExternalDelivery) {
  if (
    delivery.data.responsePublication !== "external" ||
    !delivery.data.publicationContent ||
    !delivery.data.sourceMessageId ||
    delivery.data.sourceMessageSequence === undefined
  ) {
    throw new Error("External delivery publication data is incomplete.");
  }
}

export function createExternalResponsePublication(
  options: ExternalResponsePublicationOptions,
): ExternalResponsePublication {
  const runMessages = makeRunMessagePersistence(options.database);
  const conversations = makeConversationPersistence(options.database);
  const publication = createConversationMessagePublicationService({
    appendThreadEvent: options.appendThreadEvent,
    database: options.database,
    generateId: options.generateId,
    ...(options.now ? { now: options.now } : {}),
  });

  async function command(delivery: ExternalDelivery, signal?: AbortSignal) {
    requireExternalDelivery(delivery);
    const lookup = expected(
      await runMessages.getRunLookup({
        organizationId: delivery.data.organizationId,
        runId: delivery.data.runId,
        threadId: delivery.data.threadId,
      }),
      "run-lookup",
      "External delivery run lookup",
    );
    const [run, sourceMessage, thread] = await Promise.all([
      runMessages.getRun({
        idempotencyKey: lookup.data.idempotencyKey,
        organizationId: delivery.data.organizationId,
        threadId: delivery.data.threadId,
      }),
      runMessages.getMessage({
        messageId: delivery.data.sourceMessageId!,
        organizationId: delivery.data.organizationId,
        sequence: delivery.data.sourceMessageSequence!,
        threadId: delivery.data.threadId,
      }),
      conversations.get({
        kind: "thread",
        organizationId: delivery.data.organizationId,
        threadId: delivery.data.threadId,
      }),
    ]);
    const scopedRun = expected(run, "run", "External delivery run") as ConversationRun;
    const scopedSource = expected(
      sourceMessage,
      "message",
      "External delivery source message",
    ) as ConversationMessage;
    const scopedThread = expected(
      thread,
      "thread",
      "External delivery thread",
    ) as ConversationThread;
    if (
      lookup.data.runId !== delivery.data.runId ||
      scopedRun.data.id !== delivery.data.runId ||
      scopedRun.data.threadId !== delivery.data.threadId ||
      scopedRun.data.responsePublication !== "external" ||
      scopedSource.data.id !== delivery.data.sourceMessageId ||
      scopedSource.data.sequence !== delivery.data.sourceMessageSequence ||
      scopedSource.data.runId !== scopedRun.data.id ||
      scopedThread.data.id !== delivery.data.threadId ||
      [scopedRun, scopedSource, scopedThread].some(
        (record) =>
          record.data.organizationId !== delivery.data.organizationId ||
          record.data.projectId !== delivery.data.projectId ||
          record.data.environmentId !== delivery.data.environmentId,
      )
    ) {
      throw new Error("External delivery publication scope does not match its run and message.");
    }
    return {
      actor: { type: "system" as const },
      content: delivery.data.publicationContent!,
      idempotencyKey: `channel-delivery-publication:${delivery.data.id}`,
      run: scopedRun,
      ...(signal ? { signal } : {}),
      sourceMessage: scopedSource,
      thread: scopedThread,
    };
  }

  return {
    async publish(delivery, signal) {
      await publication.publish(await command(delivery, signal));
    },
    async release(delivery, signal) {
      try {
        await publication.release(await command(delivery, signal));
      } catch (cause) {
        // A terminal delivery can legitimately predate reservation (for example, validation may
        // have failed before reserve). Every other state error is actionable: in particular, a
        // committed publication represents a confirmed provider send and must be published.
        if (isMissingExternalPublicationReservation(cause)) return;
        throw cause;
      }
    },
    async reserve(delivery, signal) {
      try {
        const result = await publication.reserve(await command(delivery, signal));
        if (result.publication.data.status === "released") {
          throw new Error("External delivery publication was already released.");
        }
        return "reserved";
      } catch (cause) {
        if (cause instanceof ConversationError && cause.code === "publication_superseded") {
          return "superseded";
        }
        throw cause;
      }
    },
  };
}
