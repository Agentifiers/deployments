import type { ThreadStreamEvent } from "@deployments-ai/streaming";
import { conversationMessageIsTransient } from "./message-visibility.ts";
import { ConversationError, type ConversationServiceOptions } from "./submission.ts";

const ACCEPTANCE_STREAM_TIMEOUT_MS = 1_000;

/**
 * Publishes the durable `user-message.accepted` event to the thread stream after the turn has
 * committed. Transient messages never reach the stream.
 */
export async function appendAcceptedThreadEvent(
  options: Pick<ConversationServiceOptions, "appendThreadEvent">,
  event: ThreadStreamEvent,
  messageMetadata: unknown,
  parentSignal?: AbortSignal,
): Promise<void> {
  if (conversationMessageIsTransient(messageMetadata)) return;
  if (!options.appendThreadEvent) return;
  const timeoutSignal = AbortSignal.timeout(ACCEPTANCE_STREAM_TIMEOUT_MS);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
  try {
    const result = await Promise.race([
      options.appendThreadEvent(event, signal).then(() => "appended" as const),
      new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
    if (result !== "appended") throw new Error("Acceptance stream publication timed out.");
  } catch (cause) {
    console.error("Conversation acceptance stream publication failed after durable commit.", {
      errorType: cause instanceof Error ? cause.name : "UnknownError",
      eventId: event.eventId,
    });
    throw new ConversationError(
      "stream_unavailable",
      "Conversation acceptance stream publication is temporarily unavailable.",
      { cause },
    );
  }
}
