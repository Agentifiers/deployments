import { PlatformTransportError, type PlatformStreamPage } from "./index.ts";

interface DurableStreamControl {
  readonly streamCursor?: unknown;
  readonly streamClosed?: unknown;
  readonly streamNextOffset?: unknown;
  readonly upToDate?: unknown;
}

function parseJson(payload: string, label: string): unknown {
  try {
    return JSON.parse(payload);
  } catch (cause) {
    throw new PlatformTransportError(`The stream gateway sent a malformed ${label} event.`, cause);
  }
}

function controlPage<T>(
  payload: string,
  items: readonly T[],
  requestId: string,
): PlatformStreamPage<T> {
  const control = parseJson(payload, "control");
  if (!control || typeof control !== "object" || Array.isArray(control)) {
    throw new PlatformTransportError(
      "The stream gateway sent a malformed control event.",
      new TypeError("Control events must be JSON objects."),
    );
  }
  const { streamCursor, streamClosed, streamNextOffset, upToDate }: DurableStreamControl = control;
  if (typeof streamNextOffset !== "string" || !streamNextOffset) {
    throw new PlatformTransportError(
      "The stream gateway sent a control event without an offset.",
      new TypeError("streamNextOffset must be a non-empty string."),
    );
  }
  const closed = streamClosed === true;
  return {
    items,
    nextOffset: streamNextOffset,
    requestId,
    ...(typeof streamCursor === "string" && streamCursor ? { cursor: streamCursor } : {}),
    upToDate: closed || upToDate === true,
    closed,
  };
}

/**
 * Parses a Durable Streams SSE response. Data events carry JSON arrays of entries and only become
 * durable once the control event that follows them reports the next offset, so entries are
 * yielded with that control event and any trailing entries without one are dropped; a reader
 * resuming from the last yielded offset receives them again.
 */
export async function* durableStreamSseBatches<T>(
  lines: AsyncIterable<string>,
  requestId: string,
): AsyncIterable<PlatformStreamPage<T>> {
  let pending: T[] = [];
  let eventType: string | undefined;
  let dataLines: string[] = [];
  for await (const line of lines) {
    if (line === "") {
      const payload = dataLines.join("\n");
      if (eventType === "data" && payload.trim()) {
        const entries = parseJson(payload, "data");
        if (Array.isArray(entries)) pending.push(...(entries as T[]));
        else pending.push(entries as T);
      } else if (eventType === "control" && dataLines.length > 0) {
        const page = controlPage(payload, pending, requestId);
        pending = [];
        yield page;
        if (page.closed) return;
      }
      eventType = undefined;
      dataLines = [];
      continue;
    }
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /u, "");
    if (field === "event") eventType = value;
    else if (field === "data") dataLines.push(value);
  }
}
