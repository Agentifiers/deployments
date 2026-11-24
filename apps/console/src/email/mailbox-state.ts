import { oneOf } from "../observability/range.ts";
import type { AgentEmailMessage } from "./compose-state.ts";
import { DRAFT_STATUSES, type DraftStatus } from "./draft-lifecycle.ts";

export type MessageStatus = AgentEmailMessage["status"];
type MessageDirection = AgentEmailMessage["direction"];

export const MESSAGE_DIRECTIONS = [
  "inbound",
  "outbound",
] as const satisfies readonly MessageDirection[];
export const MESSAGE_STATUSES = [
  "received",
  "scheduled",
  "queued",
  "sending",
  "accepted",
  "delivered",
  "bounced",
  "complained",
  "failed",
] as const satisfies readonly MessageStatus[];

export const MAILBOX_PAGE_SIZE = 25;

const MAX_QUERY_LENGTH = 200;

function query(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, MAX_QUERY_LENGTH);
  return trimmed === "" ? undefined : trimmed;
}

export interface MessageSearch {
  readonly direction?: MessageDirection;
  readonly q?: string;
  readonly status?: MessageStatus;
}

export function parseMessageSearch(search: Readonly<Record<string, unknown>>): MessageSearch {
  const direction = oneOf(MESSAGE_DIRECTIONS, search.direction);
  const status = oneOf(MESSAGE_STATUSES, search.status);
  const q = query(search.q);
  return {
    ...(direction === undefined ? {} : { direction }),
    ...(status === undefined ? {} : { status }),
    ...(q === undefined ? {} : { q }),
  };
}

export interface ThreadSearch {
  readonly q?: string;
}

export function parseThreadSearch(search: Readonly<Record<string, unknown>>): ThreadSearch {
  const q = query(search.q);
  return q === undefined ? {} : { q };
}

export interface DraftSearch {
  readonly status?: DraftStatus;
}

export function parseDraftSearch(search: Readonly<Record<string, unknown>>): DraftSearch {
  const status = oneOf(DRAFT_STATUSES, search.status);
  return status === undefined ? {} : { status };
}

export function subjectLabel(subject: string): string {
  return subject || "(no subject)";
}

const IN_FLIGHT: ReadonlySet<MessageStatus> = new Set(["queued", "scheduled", "sending"]);

export function messageInFlight(message: Pick<AgentEmailMessage, "status">): boolean {
  return IN_FLIGHT.has(message.status);
}

type RawFacts = Pick<AgentEmailMessage, "rawPurgedAt" | "rawRetentionExpiresAt">;

export type RawState = "absent" | "expired" | "purged" | "stored";

/**
 * Whether the original MIME is still stored. The runtime refuses raw links and reprocessing
 * without a retention time, and outbound mail has none.
 */
export function rawState(message: RawFacts, now: Date): RawState {
  if (message.rawPurgedAt !== undefined) return "purged";
  if (message.rawRetentionExpiresAt === undefined) return "absent";
  return Date.parse(message.rawRetentionExpiresAt) > now.getTime() ? "stored" : "expired";
}

export function canReprocess(
  message: RawFacts & Pick<AgentEmailMessage, "direction">,
  now: Date,
): boolean {
  return message.direction === "inbound" && rawState(message, now) === "stored";
}

export type MailBodyView =
  | { readonly kind: "empty" }
  | { readonly kind: "text"; readonly text: string; readonly html?: string }
  | { readonly kind: "html_only"; readonly html: string };

export function mailBodyView(
  message: Pick<AgentEmailMessage, "htmlBody" | "textBody">,
): MailBodyView {
  const text = message.textBody || undefined;
  const html = message.htmlBody || undefined;
  if (text !== undefined) {
    return html === undefined ? { kind: "text", text } : { html, kind: "text", text };
  }
  if (html === undefined) return { kind: "empty" };
  return { html, kind: "html_only" };
}

/**
 * Types a browser shows without running the sender's code. Attachment links serve the sender's
 * Content-Type with no attachment disposition, so anything else would render live in the tab.
 */
const INERT_TYPES: Readonly<Record<string, true>> = {
  "application/pdf": true,
  "image/gif": true,
  "image/jpeg": true,
  "image/png": true,
  "image/webp": true,
  "text/plain": true,
};

/** One type and its parameters; Chromium reads the last type of a comma-separated list. */
const SINGLE_MIME_TYPE = /^\s*([\w!#$%&'*+.^`|~-]+\/[\w!#$%&'*+.^`|~-]+)\s*(?:;[^,]*)?$/;

export function opensInBrowser(contentType: string): boolean {
  const essence = SINGLE_MIME_TYPE.exec(contentType)?.[1]?.toLowerCase();
  return essence !== undefined && INERT_TYPES[essence] === true;
}
