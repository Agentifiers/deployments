export const ALL_EVENT_TYPES = "*";

const MAX_EVENT_TYPES = 100;
const MAX_EVENT_TYPE_LENGTH = 128;

export type ParsedEventTypes =
  | { readonly ok: true; readonly value: readonly string[] }
  | { readonly ok: false; readonly message: string };

export function parseEventTypes(text: string, all: boolean): ParsedEventTypes {
  if (all) return { ok: true, value: [ALL_EVENT_TYPES] };
  const values = [
    ...new Set(
      text
        .split(/[,\n]/u)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (values.includes(ALL_EVENT_TYPES)) return { ok: true, value: [ALL_EVENT_TYPES] };
  if (values.length === 0) {
    return { message: "Enter at least one event type, or subscribe to all events.", ok: false };
  }
  if (values.length > MAX_EVENT_TYPES) {
    return { message: `Enter at most ${MAX_EVENT_TYPES} event types.`, ok: false };
  }
  const tooLong = values.find((value) => value.length > MAX_EVENT_TYPE_LENGTH);
  if (tooLong !== undefined) {
    return {
      message: `Event types are at most ${MAX_EVENT_TYPE_LENGTH} characters; "${tooLong.slice(0, 32)}…" is longer.`,
      ok: false,
    };
  }
  return { ok: true, value: values };
}

export function formatEventTypes(eventTypes: readonly string[]): string {
  return eventTypes.includes(ALL_EVENT_TYPES) ? "All events" : eventTypes.join(", ");
}
