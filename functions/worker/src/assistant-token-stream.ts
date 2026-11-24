import type {
  RuntimeAssistantTextDelta,
  RuntimeAssistantTextStream,
} from "@deployments-ai/agent-runtime";
import { createThreadStreamEvent } from "@deployments-ai/streaming";
import { Buffer } from "node:buffer";
import { now, stableCompletionMessageId } from "./agent-run-input.ts";
import type { AgentRunWorkerDependencies, RunRecordValue } from "./types.ts";

/** Longest a streamed delta waits before its chunk is appended. */
export const ASSISTANT_TOKEN_FLUSH_INTERVAL_MS = 150;
/** Buffered UTF-8 bytes that trigger an immediate chunk append. */
export const ASSISTANT_TOKEN_FLUSH_BYTES = 4 * 1024;
/**
 * Undelivered text one run may hold. A model call that outruns delivery past this bound stops
 * streaming, which also keeps every chunk well below the Durable Streams batch limit.
 */
export const ASSISTANT_TOKEN_MAX_PENDING_BYTES = 256 * 1024;
const ASSISTANT_TOKEN_APPEND_TIMEOUT_MS = 2_000;

interface ModelCallStream {
  abandoned: boolean;
  nextSequence: number;
}

interface PendingText {
  readonly bytes: number;
  readonly modelCallId: string;
  readonly text: string;
}

/**
 * Coalesces one run's live assistant text into `assistant-token.chunk` events correlated to the
 * run's deterministic completion message (the id its `assistant-message.finalized` event uses).
 * Appends are serialized; failures are logged and stop streaming for that model call, leaving
 * readers a correct prefix until the finalized message replaces it. Returns undefined for runs
 * whose output is not published to the thread (heartbeat, schedule, and external-publication
 * runs finalize transient messages; see `planCompletion`).
 *
 * A chunk's `modelCallId` is the runtime model call id, the same id its invocation record keeps.
 * It includes the run attempt, which increments on every claim, so a requeued execution always
 * streams under a new id that supersedes stale partial text.
 */
export function createAssistantTokenStream(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
): RuntimeAssistantTextStream | undefined {
  const appendThreadEvent = dependencies.appendThreadEvent;
  if (
    !appendThreadEvent ||
    run.data.trigger === "heartbeat" ||
    run.data.trigger === "schedule" ||
    run.data.responsePublication === "external"
  ) {
    return undefined;
  }
  const messageId = stableCompletionMessageId(run.data.id);
  const calls = new Map<string, ModelCallStream>();
  let buffered: PendingText | undefined;
  let pendingBytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delivery = Promise.resolve();

  const stopStreaming = (modelCallId: string, call: ModelCallStream, reason: string) => {
    call.abandoned = true;
    console.warn(`Assistant token streaming stopped for a model call: ${reason}.`, {
      modelCallId,
      runId: run.data.id,
    });
  };

  const deliver = async (pending: PendingText) => {
    const call = calls.get(pending.modelCallId);
    try {
      if (!call || call.abandoned) return;
      const sequence = call.nextSequence;
      call.nextSequence += 1;
      await appendThreadEvent(
        createThreadStreamEvent({
          actor: { id: dependencies.workerId, type: "worker" },
          environmentId: run.data.environmentId,
          eventId: await dependencies.generateId(),
          eventType: "assistant-token.chunk",
          messageId,
          occurredAt: now(dependencies),
          organizationId: run.data.organizationId,
          payload: { modelCallId: pending.modelCallId, sequence, text: pending.text },
          projectId: run.data.projectId,
          runId: run.data.id,
          threadId: run.data.threadId,
        }),
        AbortSignal.timeout(ASSISTANT_TOKEN_APPEND_TIMEOUT_MS),
      );
    } catch (cause) {
      if (call) {
        stopStreaming(
          pending.modelCallId,
          call,
          `chunk append failed (${cause instanceof Error ? cause.name : "UnknownError"})`,
        );
      }
    } finally {
      pendingBytes -= pending.bytes;
    }
  };

  const enqueueBuffered = () => {
    clearTimeout(timer);
    timer = undefined;
    const pending = buffered;
    buffered = undefined;
    if (pending) delivery = delivery.then(() => deliver(pending));
  };

  const append = ({ modelCallId, text }: RuntimeAssistantTextDelta) => {
    if (!text) return;
    let call = calls.get(modelCallId);
    if (!call) {
      call = { abandoned: false, nextSequence: 0 };
      calls.set(modelCallId, call);
    }
    if (call.abandoned) return;
    const bytes = Buffer.byteLength(text, "utf8");
    if (pendingBytes + bytes > ASSISTANT_TOKEN_MAX_PENDING_BYTES) {
      if (buffered?.modelCallId === modelCallId) {
        pendingBytes -= buffered.bytes;
        buffered = undefined;
        clearTimeout(timer);
        timer = undefined;
      }
      stopStreaming(modelCallId, call, "undelivered text exceeded its bound");
      return;
    }
    if (buffered && buffered.modelCallId !== modelCallId) enqueueBuffered();
    buffered = buffered
      ? { bytes: buffered.bytes + bytes, modelCallId, text: buffered.text + text }
      : { bytes, modelCallId, text };
    pendingBytes += bytes;
    if (buffered.bytes >= ASSISTANT_TOKEN_FLUSH_BYTES) enqueueBuffered();
    else timer ??= setTimeout(enqueueBuffered, ASSISTANT_TOKEN_FLUSH_INTERVAL_MS);
  };

  return {
    append,
    flush: async (modelCallId) => {
      enqueueBuffered();
      await delivery;
      calls.delete(modelCallId);
    },
  };
}
