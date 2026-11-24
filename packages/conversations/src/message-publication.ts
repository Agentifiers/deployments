/* eslint-disable no-await-in-loop -- Publication transitions serialize against the thread CAS. */

import {
  conversationMessageIsTransient,
  makeConversationMessagePublicationPersistence,
  makeConversationPersistence,
  type DynamoDatabaseService,
  type Ulid,
} from "@deployments-ai/db";
import { internalSemanticEventPayload, makeSemanticEventRecord } from "@deployments-ai/events";
import type { ThreadStreamEvent } from "@deployments-ai/streaming";
import { ConversationError, expected, type ConversationMessage } from "./submission.ts";
import {
  advancedPublicationThread,
  leaseMatchesPublication,
  normalizePublicationCommand,
  publicationContentHash,
  publicationLease,
  publicationMetadataMatches,
  publicationStreamEvent,
  publishedMessage,
  requireMatchingPublication,
  requireReservableThread,
  requireStreamablePublication,
  reservedPublication,
  transitionedPublication,
  validatePublicationInput,
  type ConversationMessagePublication,
  type PublishConversationRunMessageInput,
} from "./message-publication-state.ts";

export type {
  ConversationMessagePublication,
  PublishConversationRunMessageInput,
} from "./message-publication-state.ts";

const MAX_THREAD_CONFLICT_RETRIES = 3;
const PUBLICATION_STREAM_TIMEOUT_MS = 1_000;

export interface ConversationMessagePublicationServiceOptions {
  readonly appendThreadEvent?: (event: ThreadStreamEvent, signal?: AbortSignal) => Promise<void>;
  readonly database: DynamoDatabaseService;
  readonly generateId: () => Promise<Ulid>;
  readonly now?: () => Date;
}

export interface ReserveConversationRunMessageResult {
  readonly created: boolean;
  readonly publication: ConversationMessagePublication;
}

export interface PublishConversationRunMessageResult {
  readonly created: boolean;
  readonly message: ConversationMessage;
  readonly publication: ConversationMessagePublication;
  readonly streamEvent: ThreadStreamEvent;
}

export interface ReleaseConversationRunMessageResult {
  readonly changed: boolean;
  readonly publication: ConversationMessagePublication;
}

export function createConversationMessagePublicationService(
  options: ConversationMessagePublicationServiceOptions,
) {
  const persistence = makeConversationPersistence(options.database);
  const publicationPersistence = makeConversationMessagePublicationPersistence(options.database);

  async function loadPublication(input: PublishConversationRunMessageInput) {
    return publicationPersistence.load({
      organizationId: input.run.data.organizationId,
      runId: input.run.data.id,
      threadId: input.run.data.threadId,
    });
  }

  async function requireUnsupersededExternalRun(input: PublishConversationRunMessageInput) {
    if (input.run.data.responsePublication !== "external") return;
    if (
      await persistence.hasUserMessageAfter(
        {
          organizationId: input.run.data.organizationId,
          threadId: input.run.data.threadId,
        },
        input.run.data.userMessageSequence!,
        input.signal,
      )
    ) {
      throw new ConversationError(
        "publication_superseded",
        "A newer user message superseded this provisional response.",
      );
    }
  }

  async function loadPublishedResult(
    input: PublishConversationRunMessageInput,
    publication: ConversationMessagePublication,
    expectedContent: string,
  ): Promise<PublishConversationRunMessageResult> {
    const message = expected(
      await persistence.get({
        kind: "message",
        messageId: publication.data.messageId,
        organizationId: input.run.data.organizationId,
        sequence: publication.data.messageSequence,
        threadId: input.run.data.threadId,
      }),
      "message",
      "Published message",
    );
    if (
      message.data.streamEventId !== publication.data.streamEventId ||
      message.data.runId !== input.run.data.id ||
      message.data.role !== "assistant" ||
      message.data.contentHash !== publicationContentHash(expectedContent) ||
      message.data.body !== expectedContent ||
      message.data.bodyRef !== undefined ||
      conversationMessageIsTransient(message.data.metadata) ||
      !publicationMetadataMatches(message, input.sourceMessage)
    ) {
      throw new ConversationError(
        "idempotency_corrupt",
        "Published message does not match its canonical reservation.",
      );
    }
    return {
      created: false,
      message,
      publication,
      streamEvent: publicationStreamEvent(message, input.sourceMessage, input.actor),
    };
  }

  async function appendPublishedEvent(
    result: PublishConversationRunMessageResult,
    parentSignal?: AbortSignal,
  ) {
    if (!options.appendThreadEvent) {
      throw new ConversationError(
        "stream_unavailable",
        "Conversation message publication requires a durable stream appender.",
      );
    }
    const timeoutSignal = AbortSignal.timeout(PUBLICATION_STREAM_TIMEOUT_MS);
    const signal = parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
    try {
      const outcome = await Promise.race([
        options.appendThreadEvent(result.streamEvent, signal).then(() => "appended" as const),
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
      if (outcome !== "appended") throw new Error("Message publication stream append timed out.");
    } catch (cause) {
      console.error("Delivered message stream publication failed after durable commit.", {
        errorType: cause instanceof Error ? cause.name : "UnknownError",
        eventId: result.streamEvent.eventId,
      });
      throw new ConversationError(
        "stream_unavailable",
        "Conversation message publication is temporarily unavailable.",
        { cause },
      );
    }
  }

  return {
    async reserve(
      input: PublishConversationRunMessageInput,
    ): Promise<ReserveConversationRunMessageResult> {
      validatePublicationInput(input);
      const command = normalizePublicationCommand(input);
      const existing = await loadPublication(input);
      if (existing) {
        requireMatchingPublication(input, existing, command);
        if (existing.data.status === "reserved" || existing.data.status === "committed") {
          const lease = await publicationPersistence.loadThreadExecutionLease(input.thread.data.id);
          if (!leaseMatchesPublication(lease, existing)) {
            throw new ConversationError(
              "publication_barrier_lost",
              "Message publication reservation no longer owns its delivery barrier.",
            );
          }
        }
        return { created: false, publication: existing };
      }

      requireReservableThread(input.thread);
      const occupiedLease = await publicationPersistence.loadThreadExecutionLease(
        input.thread.data.id,
      );
      if (occupiedLease) {
        throw new ConversationError(
          "publication_busy",
          "The conversation is still processing an earlier run or delivery.",
        );
      }
      const [publicationId, messageId, streamEventId, semanticEventId] = await Promise.all([
        options.generateId(),
        options.generateId(),
        options.generateId(),
        options.generateId(),
      ]);
      let currentThread = input.thread;
      for (let attempt = 0; attempt <= MAX_THREAD_CONFLICT_RETRIES; attempt += 1) {
        requireReservableThread(currentThread);
        await requireUnsupersededExternalRun(input);
        const timestamp = options.now?.() ?? new Date();
        const thread = advancedPublicationThread(currentThread, timestamp);
        const publication = reservedPublication({
          actor: input.actor,
          commandHash: command.commandHash,
          deliveredContentHash: publicationContentHash(command.deliveredContent),
          id: publicationId,
          messageId,
          now: timestamp,
          run: input.run,
          safeContentHash: publicationContentHash(command.safeContent),
          sequence: thread.data.version,
          source: input.sourceMessage,
          streamEventId,
        });
        const message = publishedMessage({
          content: command.safeContent,
          now: timestamp,
          publication,
          source: input.sourceMessage,
        });
        requireStreamablePublication(
          publicationStreamEvent(message, input.sourceMessage, input.actor),
        );
        const lease = publicationLease(publication);
        const event = makeSemanticEventRecord({
          actor: input.actor,
          aggregateId: thread.data.id,
          aggregateType: "thread",
          aggregateVersion: thread.data.version + 1,
          environmentId: thread.data.environmentId,
          eventId: semanticEventId,
          eventType: "assistant-message.publication-reserved",
          occurredAt: timestamp,
          organizationId: thread.data.organizationId,
          payload: internalSemanticEventPayload({
            messageId: publication.data.messageId,
            runId: publication.data.runId,
            sequence: publication.data.messageSequence,
            sourceMessageId: publication.data.sourceMessageId,
          }),
          projectId: thread.data.projectId,
        });
        try {
          await publicationPersistence.reserve(
            {
              event,
              lease,
              previousThread: currentThread,
              publication,
              run: input.run,
              sourceMessage: input.sourceMessage,
              thread,
            },
            input.signal,
          );
          return { created: true, publication };
        } catch (cause) {
          const reconciled = await loadPublication(input);
          if (reconciled) {
            requireMatchingPublication(input, reconciled, command);
            return { created: false, publication: reconciled };
          }
          const latestLease = await publicationPersistence.loadThreadExecutionLease(
            input.thread.data.id,
          );
          if (latestLease) {
            throw new ConversationError(
              "publication_busy",
              "The conversation is still processing an earlier run or delivery.",
              { cause },
            );
          }
          const latest = expected(
            await persistence.get({
              kind: "thread",
              organizationId: input.run.data.organizationId,
              threadId: input.run.data.threadId,
            }),
            "thread",
            "Thread",
          );
          requireReservableThread(latest);
          await requireUnsupersededExternalRun(input);
          if (
            latest.data.version > currentThread.data.version &&
            attempt < MAX_THREAD_CONFLICT_RETRIES
          ) {
            currentThread = latest;
            continue;
          }
          throw new ConversationError(
            "write_failed",
            "Conversation message publication could not be reserved.",
            { cause },
          );
        }
      }
      throw new ConversationError(
        "write_failed",
        "Conversation message publication reservation retry limit was exhausted.",
      );
    },

    async publish(
      input: PublishConversationRunMessageInput,
    ): Promise<PublishConversationRunMessageResult> {
      validatePublicationInput(input);
      const command = normalizePublicationCommand(input);
      let publication = await loadPublication(input);
      if (!publication) {
        throw new ConversationError(
          "publication_unavailable",
          "External delivery must reserve a conversation position before it is published.",
        );
      }
      requireMatchingPublication(input, publication, command);
      if (publication.data.status === "released") {
        throw new ConversationError(
          "publication_released",
          "Released message publication reservations cannot be published.",
        );
      }
      if (publication.data.status === "published") {
        return loadPublishedResult(input, publication, command.safeContent);
      }
      let lease = await publicationPersistence.loadThreadExecutionLease(input.thread.data.id);
      if (!leaseMatchesPublication(lease, publication)) {
        throw new ConversationError(
          "publication_barrier_lost",
          "Message publication reservation no longer owns the thread delivery barrier.",
        );
      }
      let currentThread = input.thread;
      let result: PublishConversationRunMessageResult | undefined;
      if (publication.data.status === "reserved") {
        const semanticEventId = await options.generateId();
        for (let attempt = 0; attempt <= MAX_THREAD_CONFLICT_RETRIES; attempt += 1) {
          const timestamp = options.now?.() ?? new Date();
          // Confirmation finishes an external delivery that began while the thread was active.
          // Archival after reservation therefore cannot invalidate the confirmation.
          const thread = advancedPublicationThread(currentThread, timestamp);
          const message = publishedMessage({
            content: command.safeContent,
            now: timestamp,
            publication,
            source: input.sourceMessage,
          });
          const streamEvent = publicationStreamEvent(message, input.sourceMessage, input.actor);
          requireStreamablePublication(streamEvent);
          const committed = transitionedPublication(publication, "committed", timestamp);
          const event = makeSemanticEventRecord({
            actor: input.actor,
            aggregateId: thread.data.id,
            aggregateType: "thread",
            aggregateVersion: thread.data.version + 1,
            environmentId: thread.data.environmentId,
            eventId: semanticEventId,
            eventType: "assistant-message.finalized",
            occurredAt: timestamp,
            organizationId: thread.data.organizationId,
            payload: {
              messageId: message.data.id,
              runId: message.data.runId!,
              sequence: message.data.sequence,
              sourceMessageId: input.sourceMessage.data.id,
              sourceMessageSequence: input.sourceMessage.data.sequence,
              streamEventId: message.data.streamEventId!,
            },
            projectId: thread.data.projectId,
          });
          try {
            await publicationPersistence.commit(
              {
                event,
                lease,
                message,
                previousPublication: publication,
                previousThread: currentThread,
                publication: committed,
                run: input.run,
                sourceMessage: input.sourceMessage,
                thread,
              },
              input.signal,
            );
            publication = committed;
            currentThread = thread;
            result = { created: true, message, publication: committed, streamEvent };
            break;
          } catch (cause) {
            const reconciled = await loadPublication(input);
            if (reconciled?.data.status === "committed") {
              requireMatchingPublication(input, reconciled, command);
              publication = reconciled;
              result = await loadPublishedResult(input, reconciled, command.safeContent);
              currentThread = expected(
                await persistence.get({
                  kind: "thread",
                  organizationId: input.run.data.organizationId,
                  threadId: input.run.data.threadId,
                }),
                "thread",
                "Thread",
              );
              break;
            }
            if (reconciled?.data.status === "published") {
              requireMatchingPublication(input, reconciled, command);
              return loadPublishedResult(input, reconciled, command.safeContent);
            }
            if (reconciled?.data.status === "released") {
              throw new ConversationError(
                "publication_released",
                "Message publication reservation was released concurrently.",
                { cause },
              );
            }
            const latestLease = await publicationPersistence.loadThreadExecutionLease(
              input.thread.data.id,
            );
            if (!leaseMatchesPublication(latestLease, publication)) {
              throw new ConversationError(
                "publication_barrier_lost",
                "Message publication reservation lost its thread delivery barrier.",
                { cause },
              );
            }
            const latest = expected(
              await persistence.get({
                kind: "thread",
                organizationId: input.run.data.organizationId,
                threadId: input.run.data.threadId,
              }),
              "thread",
              "Thread",
            );
            if (
              latest.data.version > currentThread.data.version &&
              attempt < MAX_THREAD_CONFLICT_RETRIES
            ) {
              currentThread = latest;
              publication = reconciled ?? publication;
              lease = latestLease;
              continue;
            }
            throw new ConversationError(
              "write_failed",
              "Delivered conversation message could not be committed.",
              { cause },
            );
          }
        }
      }
      if (publication.data.status === "reserved" && !result) {
        throw new ConversationError(
          "write_failed",
          "Delivered conversation message commit retry limit was exhausted.",
        );
      }
      if (!result) {
        result = await loadPublishedResult(input, publication, command.safeContent);
        currentThread = expected(
          await persistence.get({
            kind: "thread",
            organizationId: input.run.data.organizationId,
            threadId: input.run.data.threadId,
          }),
          "thread",
          "Thread",
        );
      }
      await appendPublishedEvent(result, input.signal);

      const semanticEventId = await options.generateId();
      for (let attempt = 0; attempt <= MAX_THREAD_CONFLICT_RETRIES; attempt += 1) {
        const timestamp = options.now?.() ?? new Date();
        const thread = advancedPublicationThread(currentThread, timestamp);
        const published = transitionedPublication(publication, "published", timestamp);
        const event = makeSemanticEventRecord({
          actor: input.actor,
          aggregateId: thread.data.id,
          aggregateType: "thread",
          aggregateVersion: thread.data.version + 1,
          environmentId: thread.data.environmentId,
          eventId: semanticEventId,
          eventType: "assistant-message.publication-published",
          occurredAt: timestamp,
          organizationId: thread.data.organizationId,
          payload: internalSemanticEventPayload({
            messageId: publication.data.messageId,
            runId: publication.data.runId,
            sequence: publication.data.messageSequence,
            sourceMessageId: publication.data.sourceMessageId,
          }),
          projectId: thread.data.projectId,
        });
        try {
          await publicationPersistence.finalize(
            {
              event,
              lease,
              previousPublication: publication,
              previousThread: currentThread,
              publication: published,
              run: input.run,
              sourceMessage: input.sourceMessage,
              thread,
            },
            input.signal,
          );
          return { ...result, publication: published };
        } catch (cause) {
          const reconciled = await loadPublication(input);
          if (reconciled?.data.status === "published") {
            requireMatchingPublication(input, reconciled, command);
            return { ...result, publication: reconciled };
          }
          if (reconciled?.data.status !== "committed") {
            throw new ConversationError(
              "write_failed",
              "Committed conversation message lost its publication state.",
              { cause },
            );
          }
          requireMatchingPublication(input, reconciled, command);
          const latestLease = await publicationPersistence.loadThreadExecutionLease(
            input.thread.data.id,
          );
          if (!leaseMatchesPublication(latestLease, reconciled)) {
            throw new ConversationError(
              "publication_barrier_lost",
              "Committed message publication lost its thread delivery barrier.",
              { cause },
            );
          }
          const latest = expected(
            await persistence.get({
              kind: "thread",
              organizationId: input.run.data.organizationId,
              threadId: input.run.data.threadId,
            }),
            "thread",
            "Thread",
          );
          if (
            latest.data.version > currentThread.data.version &&
            attempt < MAX_THREAD_CONFLICT_RETRIES
          ) {
            currentThread = latest;
            publication = reconciled;
            lease = latestLease;
            continue;
          }
          throw new ConversationError(
            "write_failed",
            "Committed conversation message could not finish publication.",
            { cause },
          );
        }
      }
      throw new ConversationError("write_failed", "Message publication retry limit was exhausted.");
    },

    async release(
      input: PublishConversationRunMessageInput,
    ): Promise<ReleaseConversationRunMessageResult> {
      validatePublicationInput(input);
      const command = normalizePublicationCommand(input);
      let publication = await loadPublication(input);
      if (!publication) {
        throw new ConversationError(
          "publication_not_reserved",
          "Message publication reservation was not found.",
        );
      }
      requireMatchingPublication(input, publication, command);
      if (publication.data.status === "committed") {
        throw new ConversationError(
          "publication_unavailable",
          "A confirmed external delivery must finish publication instead of being released.",
        );
      }
      if (publication.data.status !== "reserved") {
        return { changed: false, publication };
      }
      const semanticEventId = await options.generateId();
      let currentThread = input.thread;
      for (let attempt = 0; attempt <= MAX_THREAD_CONFLICT_RETRIES; attempt += 1) {
        const timestamp = options.now?.() ?? new Date();
        const thread = advancedPublicationThread(currentThread, timestamp);
        const released = transitionedPublication(publication, "released", timestamp);
        const candidateLease = await publicationPersistence.loadThreadExecutionLease(
          input.thread.data.id,
        );
        const lease = leaseMatchesPublication(candidateLease, publication)
          ? candidateLease
          : undefined;
        const event = makeSemanticEventRecord({
          actor: input.actor,
          aggregateId: thread.data.id,
          aggregateType: "thread",
          aggregateVersion: thread.data.version + 1,
          environmentId: thread.data.environmentId,
          eventId: semanticEventId,
          eventType: "assistant-message.publication-released",
          occurredAt: timestamp,
          organizationId: thread.data.organizationId,
          payload: internalSemanticEventPayload({
            messageId: publication.data.messageId,
            runId: publication.data.runId,
            sequence: publication.data.messageSequence,
            sourceMessageId: publication.data.sourceMessageId,
          }),
          projectId: thread.data.projectId,
        });
        try {
          await publicationPersistence.release(
            {
              event,
              ...(lease ? { lease } : {}),
              previousPublication: publication,
              previousThread: currentThread,
              publication: released,
              run: input.run,
              sourceMessage: input.sourceMessage,
              thread,
            },
            input.signal,
          );
          return { changed: true, publication: released };
        } catch (cause) {
          const reconciled = await loadPublication(input);
          if (reconciled?.data.status === "committed") {
            requireMatchingPublication(input, reconciled, command);
            throw new ConversationError(
              "publication_unavailable",
              "A concurrently confirmed delivery must finish publication instead of being released.",
              { cause },
            );
          }
          if (reconciled?.data.status === "published" || reconciled?.data.status === "released") {
            requireMatchingPublication(input, reconciled, command);
            return { changed: false, publication: reconciled };
          }
          const latest = expected(
            await persistence.get({
              kind: "thread",
              organizationId: input.run.data.organizationId,
              threadId: input.run.data.threadId,
            }),
            "thread",
            "Thread",
          );
          if (
            latest.data.version > currentThread.data.version &&
            attempt < MAX_THREAD_CONFLICT_RETRIES
          ) {
            currentThread = latest;
            publication = reconciled ?? publication;
            continue;
          }
          throw new ConversationError(
            "write_failed",
            "Conversation message publication reservation could not be released.",
            { cause },
          );
        }
      }
      throw new ConversationError(
        "write_failed",
        "Conversation message publication release retry limit was exhausted.",
      );
    },
  };
}
