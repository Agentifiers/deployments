import type { RouteResponse } from "../server/platform-api.ts";
import { parseAddresses } from "./addresses.ts";

export type EmailTenant = RouteResponse<"getEmailTenant">;
export type TenantStatus = EmailTenant["status"];
export type EmailDomain = RouteResponse<"getEmailDomain">;

export const TENANT_STATUS_CHANGE: Readonly<
  Record<TenantStatus, { readonly label: string; readonly next: TenantStatus }>
> = {
  active: { label: "Pause tenant", next: "paused" },
  paused: { label: "Resume tenant", next: "active" },
};

const MAX_RECIPIENTS = 50;
const MAX_BODY_BYTES = 1_048_576;
const LOCAL_PART = /^[^\s@<>"]{1,64}$/u;

export interface SendDraft {
  readonly bcc: string;
  readonly cc: string;
  readonly domain: string;
  readonly localPart: string;
  readonly subject: string;
  readonly text: string;
  readonly to: string;
}

export interface SendBody {
  readonly bcc?: readonly string[];
  readonly cc?: readonly string[];
  readonly from: string;
  readonly subject: string;
  readonly text: string;
  readonly to: readonly string[];
}

export function readSendDraft(
  draft: SendDraft,
):
  | { readonly ok: true; readonly body: SendBody }
  | { readonly ok: false; readonly message: string } {
  const localPart = draft.localPart.trim();
  if (draft.domain === "") return { message: "Choose a verified domain to send from.", ok: false };
  if (!LOCAL_PART.test(localPart)) {
    return { message: "Enter the From address's text before @, with no spaces.", ok: false };
  }
  const lists = { bcc: draft.bcc, cc: draft.cc, to: draft.to };
  const parsed: Record<keyof typeof lists, readonly string[]> = { bcc: [], cc: [], to: [] };
  for (const field of ["to", "cc", "bcc"] as const) {
    const list = parseAddresses(lists[field], MAX_RECIPIENTS);
    if (!list.ok) return { message: list.message, ok: false };
    parsed[field] = list.addresses;
  }
  if (parsed.to.length === 0) return { message: "Add at least one To address.", ok: false };
  if (parsed.to.length + parsed.cc.length + parsed.bcc.length > MAX_RECIPIENTS) {
    return { message: `A message can have at most ${MAX_RECIPIENTS} recipients.`, ok: false };
  }
  if (/[\r\n]/u.test(draft.subject) || draft.subject.length > 998) {
    return { message: "The subject is one line of at most 998 characters.", ok: false };
  }
  if (draft.text.trim() === "") return { message: "Write a message body.", ok: false };
  if (new TextEncoder().encode(draft.text).byteLength > MAX_BODY_BYTES) {
    return { message: "The body must be at most 1 MiB.", ok: false };
  }
  return {
    body: {
      ...(parsed.bcc.length === 0 ? {} : { bcc: parsed.bcc }),
      ...(parsed.cc.length === 0 ? {} : { cc: parsed.cc }),
      from: `${localPart}@${draft.domain}`,
      subject: draft.subject,
      text: draft.text,
      to: parsed.to,
    },
    ok: true,
  };
}
