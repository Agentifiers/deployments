import {
  chatCompletionProviderErrorDiagnostic,
  providerErrorMessageSuffix,
} from "./provider-errors.ts";
import {
  type ProviderAttemptResult,
  RETRYABLE_PROVIDER_ERROR_CODES,
  retryableProviderStatus,
} from "./provider-retry.ts";
import { ModelGatewayRequestError, isRecord } from "./types.ts";

/**
 * Longest silence tolerated between bytes of a streamed completion. Any bytes count, including the
 * SSE comment keepalives OpenRouter sends while a provider is still thinking.
 */
export const CHAT_COMPLETION_STREAM_IDLE_TIMEOUT_MS = 300_000;

const DONE_SENTINEL = "[DONE]";

interface ToolCallAccumulator {
  arguments: string;
  readonly extra: Record<string, unknown>;
  id?: string;
  name?: string;
  type?: string;
}

interface ChoiceAccumulator {
  readonly fields: Record<string, unknown>;
  readonly index: number;
  readonly message: Record<string, unknown>;
  /** Keyed by index and type in first-seen order: Gemini streams two block types at one index. */
  readonly reasoningDetails: Map<string, Record<string, unknown>>;
  readonly toolCalls: Map<number, ToolCallAccumulator>;
}

function deltaIndex(value: unknown, position: number) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : position;
}

/** Later non-null values win; nested records merge so per-chunk metadata accumulates. */
function mergeValue(target: Record<string, unknown>, key: string, value: unknown) {
  if (value === undefined) return;
  if (value === null) {
    if (!(key in target)) target[key] = null;
    return;
  }
  const existing = target[key];
  if (isRecord(existing) && isRecord(value)) {
    const merged = { ...existing };
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      mergeValue(merged, nestedKey, nestedValue);
    }
    target[key] = merged;
    return;
  }
  target[key] = value;
}

/** Delta text fields (content, reasoning, refusal) and part arrays append; other fields merge. */
function appendDeltaValue(target: Record<string, unknown>, key: string, value: unknown) {
  const existing = target[key];
  if (key !== "role" && typeof existing === "string" && typeof value === "string") {
    target[key] = existing + value;
  } else if (Array.isArray(existing) && Array.isArray(value)) {
    target[key] = [...existing, ...value];
  } else {
    mergeValue(target, key, value);
  }
}

function appendToolCallDelta(choice: ChoiceAccumulator, delta: unknown, position: number) {
  if (!isRecord(delta)) return;
  const index = deltaIndex(delta.index, position);
  let toolCall = choice.toolCalls.get(index);
  if (!toolCall) {
    toolCall = { arguments: "", extra: {} };
    choice.toolCalls.set(index, toolCall);
  }
  for (const [key, value] of Object.entries(delta)) {
    if (key === "index") continue;
    if (key === "id") {
      if (typeof value === "string" && value && toolCall.id === undefined) toolCall.id = value;
    } else if (key === "type") {
      if (typeof value === "string" && value) toolCall.type = value;
    } else if (key === "function" && isRecord(value)) {
      if (typeof value.name === "string" && value.name && toolCall.name === undefined) {
        toolCall.name = value.name;
      }
      if (typeof value.arguments === "string") toolCall.arguments += value.arguments;
    } else {
      mergeValue(toolCall.extra, key, value);
    }
  }
}

function appendReasoningDetailDelta(choice: ChoiceAccumulator, delta: unknown, position: number) {
  if (!isRecord(delta)) return;
  const key = `${deltaIndex(delta.index, position)}:${String(delta.type)}`;
  let detail = choice.reasoningDetails.get(key);
  if (!detail) {
    detail = {};
    choice.reasoningDetails.set(key, detail);
  }
  for (const [field, value] of Object.entries(delta)) {
    if (value === null || value === undefined) continue;
    const existing = detail[field];
    detail[field] =
      (field === "text" || field === "summary") &&
      typeof existing === "string" &&
      typeof value === "string"
        ? existing + value
        : value;
  }
}

/**
 * Folds `chat.completion.chunk` events into the body a non-streamed `chat.completion` would have
 * returned, so the existing response, usage, and routing parsers read streamed calls unchanged.
 */
class ChatCompletionStreamAggregator {
  readonly #choices = new Map<number, ChoiceAccumulator>();
  readonly #top: Record<string, unknown> = {};

  /** Applies one chunk and returns the primary choice's new assistant text, if any. */
  push(chunk: Record<string, unknown>): string | undefined {
    let text: string | undefined;
    for (const [key, value] of Object.entries(chunk)) {
      if (key === "choices" || key === "object") continue;
      // Providers that report usage more than once send cumulative snapshots; keep the latest.
      if (key === "usage" && isRecord(value)) this.#top.usage = value;
      else mergeValue(this.#top, key, value);
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const [position, rawChoice] of choices.entries()) {
      if (!isRecord(rawChoice)) continue;
      const index = deltaIndex(rawChoice.index, position);
      let choice = this.#choices.get(index);
      if (!choice) {
        choice = {
          fields: {},
          index,
          message: {},
          reasoningDetails: new Map(),
          toolCalls: new Map(),
        };
        this.#choices.set(index, choice);
      }
      for (const [key, value] of Object.entries(rawChoice)) {
        if (key !== "delta" && key !== "index") mergeValue(choice.fields, key, value);
      }
      const delta = isRecord(rawChoice.delta) ? rawChoice.delta : {};
      for (const [key, value] of Object.entries(delta)) {
        if (key === "tool_calls") {
          if (Array.isArray(value)) {
            for (const [toolPosition, toolDelta] of value.entries()) {
              appendToolCallDelta(choice, toolDelta, toolPosition);
            }
          }
        } else if (key === "reasoning_details") {
          if (Array.isArray(value)) {
            for (const [detailPosition, detailDelta] of value.entries()) {
              appendReasoningDetailDelta(choice, detailDelta, detailPosition);
            }
          }
        } else {
          appendDeltaValue(choice.message, key, value);
        }
      }
      if (index === 0 && typeof delta.content === "string" && delta.content) {
        text = (text ?? "") + delta.content;
      }
    }
    return text;
  }

  get finished(): boolean {
    return [...this.#choices.values()].some(
      (choice) => typeof choice.fields.finish_reason === "string",
    );
  }

  body(): Record<string, unknown> {
    const choices = [...this.#choices.values()]
      .toSorted((left, right) => left.index - right.index)
      .map((choice) => {
        const toolCalls = [...choice.toolCalls.entries()]
          .toSorted(([left], [right]) => left - right)
          .map(([, toolCall]) => ({
            ...toolCall.extra,
            ...(toolCall.id === undefined ? {} : { id: toolCall.id }),
            type: toolCall.type ?? "function",
            function: {
              arguments: toolCall.arguments,
              ...(toolCall.name === undefined ? {} : { name: toolCall.name }),
            },
          }));
        const reasoningDetails = [...choice.reasoningDetails.values()];
        return {
          ...choice.fields,
          index: choice.index,
          message: {
            role: "assistant",
            ...choice.message,
            ...(reasoningDetails.length > 0 ? { reasoning_details: reasoningDetails } : {}),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
        };
      });
    return { ...this.#top, choices, object: "chat.completion" };
  }
}

type StreamRead = { readonly done: boolean; readonly value?: Uint8Array | undefined } | "idle";

async function readWithin(
  reader: { read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }> },
  idleTimeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<StreamRead> {
  signal?.throwIfAborted();
  return await new Promise<StreamRead>((resolve, reject) => {
    const settle = (complete: () => void) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = () => settle(() => reject(signal?.reason));
    const timeout = setTimeout(() => settle(() => resolve("idle")), idleTimeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => settle(() => resolve(result)),
      (cause: unknown) => settle(() => reject(cause)),
    );
  });
}

function providerErrorStatus(payload: Record<string, unknown>): number | undefined {
  const error = isRecord(payload.error) ? payload.error : undefined;
  return [payload.status_code, error?.status_code, error?.code].find(
    (value): value is number => Number.isSafeInteger(value) && Number(value) >= 100,
  );
}

export interface ChatCompletionEventStreamRequest {
  readonly endpoint: string;
  readonly errorContext: string;
  readonly idleTimeoutMs: number;
  /** Receives primary-choice assistant text as it arrives; the aggregate is unaffected. */
  readonly onTextDelta?: (text: string) => void;
  readonly response: Response;
  readonly signal?: AbortSignal;
}

/**
 * Reads one streamed completion attempt. Transient failures are reported as retryable only while
 * no assistant text has reached `onTextDelta`: replaying the request after visible output would
 * repeat that text under the same model call, so such failures are thrown instead.
 */
export async function readChatCompletionEventStream(
  request: ChatCompletionEventStreamRequest,
): Promise<ProviderAttemptResult<unknown>> {
  const { endpoint, errorContext, response } = request;
  if (!response.body) {
    throw new ModelGatewayRequestError({
      endpoint,
      message: `${errorContext} returned an empty event stream.`,
    });
  }
  const aggregator = new ChatCompletionStreamAggregator();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let deliveredText = false;
  const transientFailure = (failure: ModelGatewayRequestError): ProviderAttemptResult<unknown> => {
    if (deliveredText) throw failure;
    return { failure, headers: response.headers, kind: "retryable" };
  };
  let buffer = "";
  let dataLines: string[] = [];
  let eventName = "";

  // Returns a terminal attempt result once the stream reports [DONE] or a provider error.
  const dispatch = (): ProviderAttemptResult<unknown> | "done" | undefined => {
    if (dataLines.length === 0) {
      eventName = "";
      return undefined;
    }
    const data = dataLines.join("\n");
    const name = eventName;
    dataLines = [];
    eventName = "";
    if (data.trim() === DONE_SENTINEL) return "done";
    let payload: unknown;
    try {
      payload = JSON.parse(data) as unknown;
    } catch {
      throw new ModelGatewayRequestError({
        endpoint,
        message: `${errorContext} stream contained an invalid JSON event.`,
      });
    }
    if (!isRecord(payload)) {
      throw new ModelGatewayRequestError({
        endpoint,
        message: `${errorContext} stream contained a non-object event.`,
      });
    }
    const { code, error, message } = chatCompletionProviderErrorDiagnostic(payload);
    if (error || name === "error") {
      const status = providerErrorStatus(payload);
      const failure = new ModelGatewayRequestError({
        endpoint,
        message: `${errorContext} stream returned a provider error${providerErrorMessageSuffix(code, message)}.`,
        ...(code ? { providerCode: code } : {}),
        ...(message ? { providerMessage: message } : {}),
        ...(status === undefined ? {} : { status }),
      });
      const retryable =
        (code !== undefined && RETRYABLE_PROVIDER_ERROR_CODES[code] === true) ||
        (status !== undefined && retryableProviderStatus(status, message, code));
      if (!retryable) throw failure;
      return transientFailure(failure);
    }
    const text = aggregator.push(payload);
    if (text !== undefined) {
      deliveredText = true;
      request.onTextDelta?.(text);
    }
    return undefined;
  };

  const processLine = (line: string) => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return undefined;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const rawValue = separator === -1 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "data") dataLines.push(value);
    else if (field === "event") eventName = value;
    return undefined;
  };

  try {
    while (true) {
      const read = await readWithin(reader, request.idleTimeoutMs, request.signal);
      if (read === "idle") {
        return transientFailure(
          new ModelGatewayRequestError({
            endpoint,
            message: `${errorContext} stream was idle for ${Math.round(request.idleTimeoutMs / 1_000)} s.`,
          }),
        );
      }
      if (read.done || !read.value) break;
      buffer += decoder.decode(read.value, { stream: true });
      while (true) {
        const newline = /\r\n|\r|\n/u.exec(buffer);
        // A trailing CR may be the first half of a CRLF split across reads.
        if (!newline || (newline[0] === "\r" && newline.index === buffer.length - 1)) break;
        const line = buffer.slice(0, newline.index);
        buffer = buffer.slice(newline.index + newline[0].length);
        const outcome = processLine(line);
        if (outcome === "done") return { kind: "succeeded", value: aggregator.body() };
        if (outcome) return outcome;
      }
    }
    buffer += decoder.decode();
    for (const line of [...buffer.split(/\r\n|\r|\n/u), ""]) {
      const outcome = processLine(line);
      if (outcome === "done") return { kind: "succeeded", value: aggregator.body() };
      if (outcome) return outcome;
    }
    if (aggregator.finished) return { kind: "succeeded", value: aggregator.body() };
    throw new ModelGatewayRequestError({
      endpoint,
      message: `${errorContext} stream ended before the completion finished.`,
    });
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
