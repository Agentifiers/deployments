import { MAX_CONSOLE_REQUEST_BYTES } from "../console-request.ts";
import type { EnvironmentSummary } from "../server/console-data.ts";
import type { RouteResponse } from "../server/platform-api.ts";
import { parseAddresses } from "./addresses.ts";
import type { AgentEmailDraft } from "./draft-lifecycle.ts";

export type AgentEmailMessage = RouteResponse<"getAgentEmailMessage">;

export type ComposeMode =
  | { readonly kind: "send" }
  | { readonly kind: "reply"; readonly message: AgentEmailMessage; readonly all: boolean }
  | { readonly kind: "forward"; readonly message: AgentEmailMessage }
  | { readonly kind: "draft"; readonly draft?: AgentEmailDraft };

interface ComposeShape {
  readonly to: "typed" | "derived";
  readonly toRequired: boolean;
  readonly subject: boolean;
  readonly attachments: boolean;
  readonly includeOriginal: boolean;
}

export const COMPOSE_SHAPES: Readonly<Record<ComposeMode["kind"], ComposeShape>> = {
  send: { attachments: true, includeOriginal: false, subject: true, to: "typed", toRequired: true },
  reply: {
    attachments: true,
    includeOriginal: false,
    subject: false,
    to: "derived",
    toRequired: false,
  },
  forward: {
    attachments: true,
    includeOriginal: true,
    subject: false,
    to: "typed",
    toRequired: true,
  },
  draft: {
    attachments: false,
    includeOriginal: false,
    subject: true,
    to: "typed",
    toRequired: false,
  },
};

interface ComposeFields {
  readonly bcc: string;
  readonly cc: string;
  readonly includeOriginal: boolean;
  /** A `datetime-local` value in the browser's zone, or blank to send now. */
  readonly scheduledAt: string;
  readonly subject: string;
  readonly text: string;
  readonly to: string;
}

export interface AttachmentInput {
  readonly contentBase64: string;
  readonly contentType: string;
  readonly fileName: string;
}

export interface ComposeBody {
  readonly attachments?: readonly AttachmentInput[];
  readonly bcc?: readonly string[];
  readonly cc?: readonly string[];
  readonly includeOriginal?: boolean;
  readonly scheduledAt?: string;
  readonly subject?: string;
  readonly text?: string;
  readonly to?: readonly string[];
}

type ComposeResult =
  | { readonly ok: true; readonly body: ComposeBody; readonly recipients: readonly string[] }
  | { readonly ok: false; readonly message: string };

const MAX_FIELD_ADDRESSES = 50;
const MAX_SUBJECT_LENGTH = 998;
const MAX_ATTACHMENTS = 35;

function dateTimeLocal(instant: string): string {
  const date = new Date(instant);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function composeFields(mode: ComposeMode): ComposeFields {
  const blank = {
    bcc: "",
    cc: "",
    includeOriginal: true,
    scheduledAt: "",
    subject: "",
    text: "",
    to: "",
  };
  if (mode.kind !== "draft" || mode.draft === undefined) return blank;
  const { draft } = mode;
  return {
    ...blank,
    bcc: draft.bccAddresses.join(", "),
    cc: draft.ccAddresses.join(", "),
    scheduledAt: draft.scheduledAt === undefined ? "" : dateTimeLocal(draft.scheduledAt),
    subject: draft.subject,
    text: draft.textBody ?? "",
    to: draft.toAddresses.join(", "),
  };
}

/**
 * Who a reply goes to, mirroring the runtime's `agentEmailReplyRecipients`: the original's
 * recipients when this inbox sent it, else its Reply-To or sender; reply-all adds To and Cc.
 */
export function replyRecipients(
  message: AgentEmailMessage,
  inboxAddress: string,
  all: boolean,
): readonly string[] {
  const primary =
    message.direction === "outbound"
      ? message.toAddresses
      : message.replyToAddresses.length > 0
        ? message.replyToAddresses
        : [message.fromAddress];
  const candidates = all ? [...primary, ...message.toAddresses, ...message.ccAddresses] : primary;
  const own = inboxAddress.trim().toLowerCase();
  const normalized = candidates.map((address) => address.trim().toLowerCase());
  return [...new Set(normalized)].filter((address) => address !== "" && address !== own);
}

type BudgetProblem = "too_many" | "policy_limit" | "console_limit" | "request_limit";

/** `textBytes` is what the request's text and HTML parts take in the platform's Lambda event. */
export function requestBudget(
  files: readonly { readonly size: number }[],
  policyMaxBytes: number,
  textBytes: number,
): { readonly ok: true } | { readonly ok: false; readonly reason: BudgetProblem } {
  if (files.length > MAX_ATTACHMENTS) return { ok: false, reason: "too_many" };
  const rawBytes = files.reduce((total, file) => total + file.size, 0);
  if (rawBytes > policyMaxBytes) return { ok: false, reason: "policy_limit" };
  const encodedBytes = files.reduce((total, file) => total + 4 * Math.ceil(file.size / 3), 0);
  if (encodedBytes > MAX_CONSOLE_REQUEST_BYTES) return { ok: false, reason: "console_limit" };
  if (encodedBytes + textBytes > MAX_CONSOLE_REQUEST_BYTES) {
    return { ok: false, reason: "request_limit" };
  }
  return { ok: true };
}

/**
 * The email Lambda sits behind an HTTP API whose event carries the request's JSON as an escaped
 * string, so quotes, backslashes, and control characters are escaped twice.
 */
function eventBytes(parts: readonly string[]): number {
  return new TextEncoder().encode(JSON.stringify(JSON.stringify(parts))).length;
}

const REQUEST_PROBLEMS: Readonly<Record<BudgetProblem, string>> = {
  console_limit: "Attachments sent from the console must total under about 3.3 MB.",
  policy_limit: "The attachments exceed the email policy's attachment size limit.",
  request_limit:
    "The message is too large to send from the console. Shorten the text or remove attachments.",
  too_many: `At most ${MAX_ATTACHMENTS} attachments are allowed.`,
};

const FORWARD_TOO_LARGE =
  "The original message and the attachments are too large to forward with a note. Remove attachments, or clear the note so the platform quotes the original itself.";

function addressField(
  text: string,
  label: string,
):
  | { readonly ok: true; readonly addresses: readonly string[] }
  | { readonly ok: false; readonly message: string } {
  const parsed = parseAddresses(text, MAX_FIELD_ADDRESSES);
  return parsed.ok ? parsed : { message: `${label}: ${parsed.message}`, ok: false };
}

function scheduledInstant(value: string, now: Date): string | undefined | Error {
  if (value.trim() === "") return undefined;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return new Error("The send time is not a valid date.");
  if (instant.getTime() <= now.getTime()) return new Error("The send time must be in the future.");
  return instant.toISOString();
}

/** The request body for the mode without attachments, which the browser encodes on submit. */
export function readCompose(
  mode: ComposeMode,
  fields: ComposeFields,
  context: {
    readonly attachments: readonly { readonly size: number }[];
    readonly inboxAddress: string;
    readonly now: Date;
    readonly policyMaxAttachmentBytes: number;
  },
): ComposeResult {
  const shape = COMPOSE_SHAPES[mode.kind];
  const to = addressField(fields.to, "To");
  const cc = addressField(fields.cc, "Cc");
  const bcc = addressField(fields.bcc, "Bcc");
  if (!to.ok) return to;
  if (!cc.ok) return cc;
  if (!bcc.ok) return bcc;
  const typedTo = shape.to === "typed" ? to.addresses : [];
  if (shape.toRequired && typedTo.length === 0)
    return { message: "Add at least one recipient.", ok: false };
  const subject = fields.subject.trim();
  if (shape.subject && subject.length > MAX_SUBJECT_LENGTH) {
    return { message: `The subject is longer than ${MAX_SUBJECT_LENGTH} characters.`, ok: false };
  }
  const editing = mode.kind === "draft" ? mode.draft : undefined;
  if (editing?.scheduledAt !== undefined && fields.scheduledAt.trim() === "") {
    return {
      message: "A saved send time cannot be removed. Choose a new one in the future.",
      ok: false,
    };
  }
  const savedSchedule =
    editing?.scheduledAt === undefined ? "" : dateTimeLocal(editing.scheduledAt);
  const scheduledAt =
    fields.scheduledAt === savedSchedule
      ? undefined
      : scheduledInstant(fields.scheduledAt, context.now);
  if (scheduledAt instanceof Error) return { message: scheduledAt.message, ok: false };
  const attachments = shape.attachments ? context.attachments : [];
  const savedText = editing === undefined ? "" : (editing.textBody ?? "");
  const text = fields.text === savedText ? undefined : fields.text;
  const quoted =
    mode.kind === "forward" && fields.includeOriginal && fields.text !== ""
      ? forwardParts(fields.text, mode.message)
      : undefined;
  const budget = requestBudget(
    attachments,
    context.policyMaxAttachmentBytes,
    eventBytes(quoted === undefined ? [text ?? ""] : [quoted.text, quoted.html]),
  );
  if (!budget.ok) {
    return {
      message:
        budget.reason === "request_limit" && quoted !== undefined
          ? FORWARD_TOO_LARGE
          : REQUEST_PROBLEMS[budget.reason],
      ok: false,
    };
  }
  const derived =
    mode.kind === "reply" ? replyRecipients(mode.message, context.inboxAddress, mode.all) : [];
  if (mode.kind === "reply" && derived.length === 0) {
    return { message: "The original message has no one to reply to.", ok: false };
  }
  const body: ComposeBody = {
    ...(shape.to === "typed" ? { to: typedTo } : {}),
    ...(cc.addresses.length > 0 || editing ? { cc: cc.addresses } : {}),
    ...(bcc.addresses.length > 0 || editing ? { bcc: bcc.addresses } : {}),
    ...(shape.subject ? { subject } : {}),
    ...(text === undefined ? {} : { text }),
    ...(scheduledAt === undefined ? {} : { scheduledAt }),
    ...(shape.includeOriginal ? { includeOriginal: fields.includeOriginal } : {}),
  };
  return {
    body,
    ok: true,
    recipients: [...new Set([...typedTo, ...derived, ...cc.addresses, ...bcc.addresses])],
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * A forward's note above the quoted original, as both parts. The runtime quotes the original only
 * into a part the request leaves out, so a note sent alone would leave text and HTML disagreeing.
 * The quote mirrors the runtime's `agentEmailForwardText` and `agentEmailForwardHtml`.
 */
export function forwardParts(
  note: string,
  original: Pick<
    AgentEmailMessage,
    "fromAddress" | "htmlBody" | "subject" | "textBody" | "toAddresses"
  >,
): { readonly html: string; readonly text: string } {
  const recipients = original.toAddresses.join(", ");
  const quotedHtml = original.htmlBody ?? `<pre>${escapeHtml(original.textBody ?? "")}</pre>`;
  return {
    html: `<div>${escapeHtml(note).replaceAll("\n", "<br>")}</div><br><div>---------- Forwarded message ----------<br><strong>From:</strong> ${escapeHtml(original.fromAddress)}<br><strong>To:</strong> ${escapeHtml(recipients)}<br><strong>Subject:</strong> ${escapeHtml(original.subject)}<br><br>${quotedHtml}</div>`,
    text: [
      note,
      "---------- Forwarded message ----------",
      `From: ${original.fromAddress}`,
      `To: ${recipients}`,
      `Subject: ${original.subject}`,
      "",
      original.textBody ?? "",
    ].join("\n"),
  };
}

export type RecipientClass = "environment_inbox" | "allowlisted" | "external";

/**
 * An active inbox on the sender's domain and an allowlisted address count as verified recipients
 * in the runtime's warmup check; anything else leaves the platform as real mail.
 */
export function classifyRecipients(
  addresses: readonly string[],
  ownInboxes: ReadonlySet<string>,
  allowlist: readonly string[],
): ReadonlyMap<string, RecipientClass> {
  const allowed = new Set(allowlist.map((address) => address.trim().toLowerCase()));
  return new Map(
    addresses.map((address) => {
      const normalized = address.trim().toLowerCase();
      const recipientClass: RecipientClass = ownInboxes.has(normalized)
        ? "environment_inbox"
        : allowed.has(normalized)
          ? "allowlisted"
          : "external";
      return [normalized, recipientClass] as const;
    }),
  );
}

/**
 * The word to type before mail leaves the environment's own inboxes, or in production. An
 * allowlisted address only passes the warmup check; it still receives real mail.
 */
export function sendConfirmation(
  classes: ReadonlyMap<string, RecipientClass>,
  environmentType: EnvironmentSummary["type"],
): string | undefined {
  const leaves = [...classes.values()].some(
    (recipientClass) => recipientClass !== "environment_inbox",
  );
  return leaves || environmentType === "production" ? "send" : undefined;
}

export type ComposeContextState<Context> =
  | { readonly kind: "reading" }
  | { readonly kind: "failed"; readonly error: Error }
  | { readonly kind: "ready"; readonly context: Context };

/**
 * The environment's inboxes and allowlist as the compose dialogs use them. A read that succeeded
 * stays usable after a failed background refetch, which TanStack reports with the cached data.
 */
export function composeContext<Context>(query: {
  readonly data: Context | undefined;
  readonly error: Error | null;
}): ComposeContextState<Context> {
  if (query.data !== undefined) return { context: query.data, kind: "ready" };
  return query.error === null ? { kind: "reading" } : { error: query.error, kind: "failed" };
}
