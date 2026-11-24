import { Schema } from "effect";
import { Cursor, PageLimit, PublicId, Timestamp } from "./primitives.ts";

const domainPattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/u;
const encoder = new TextEncoder();

/** Canonical DNS name used for ownership claims, including internationalized names. */
export function normalizeEmailDomain(value: string): string {
  const input = value.trim().toLowerCase().replace(/\.$/u, "");
  if (!input || /[\s/@:#?%\\]/u.test(input)) throw new TypeError("Domain is invalid.");
  let domain: string;
  try {
    domain = new URL(`https://${input}`).hostname;
  } catch {
    throw new TypeError("Domain is invalid.");
  }
  if (!domainPattern.test(domain)) throw new TypeError("Domain is invalid.");
  return domain;
}

/** Render a display name as an RFC 5322 quoted string or RFC 2047 encoded words. */
function encodeMailboxDisplayName(value: string): string {
  if (/^[\x20-\x7e]*$/u.test(value) && !value.includes("=?")) {
    return `"${value.replace(/["\\]/gu, "\\$&")}"`;
  }
  const bytes = encoder.encode(value);
  const words: string[] = [];
  for (let start = 0; start < bytes.length; ) {
    // 45 UTF-8 bytes fit in a 72-character encoded word (RFC 2047 permits 75).
    let end = Math.min(start + 45, bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    words.push(`=?UTF-8?B?${btoa(String.fromCharCode(...bytes.subarray(start, end)))}?=`);
    start = end;
  }
  return words.join(" ");
}

/** Validate one mailbox and produce ASCII wire syntax and its exact authorization domain. */
export function normalizeEmailMailbox(value: string): {
  readonly mailbox: string;
  readonly domain: string;
} {
  if (value !== value.trim() || /[\p{Cc}\p{Cs}]/u.test(value)) {
    throw new TypeError("Expected a single mailbox without control characters or invalid Unicode.");
  }
  const display = /^("(?:[^"\\]|\\["\\])*"|[^"<>,;:]+)\s*<([^<>]+)>$/u.exec(value);
  const address = display ? display[2]! : value;
  const match =
    /^([a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+)*)@([^\s<>@,;]+)$/u.exec(
      address,
    );
  if (!match || match[1]!.length > 64 || address.length > 320 || value.length > 998) {
    throw new TypeError("Expected a single mailbox.");
  }
  const domain = normalizeEmailDomain(match[2]!);
  const canonicalAddress = `${match[1]}@${domain}`;
  // SMTP paths allow 256 octets including angle brackets; IDN expansion counts.
  if (canonicalAddress.length > 254) throw new TypeError("Mailbox address is too long.");
  let mailbox = canonicalAddress;
  if (display) {
    const phrase = display[1]!.trimEnd();
    const name = phrase.startsWith('"') ? phrase.slice(1, -1).replace(/\\(["\\])/gu, "$1") : phrase;
    mailbox = `${encodeMailboxDisplayName(name)} <${canonicalAddress}>`;
  }
  if (mailbox.length > 998) throw new TypeError("Encoded mailbox is too long.");
  return { mailbox, domain };
}

const Name = Schema.String.pipe(
  Schema.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(120)),
);
const TenantStatus = Schema.Literals(["active", "paused"]);
const Domain = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter<string>((value) => {
      try {
        normalizeEmailDomain(value);
        return undefined;
      } catch {
        return "Expected a valid DNS domain.";
      }
    }),
  ),
);
const Mailbox = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter<string>((value) => {
      try {
        normalizeEmailMailbox(value);
        return undefined;
      } catch {
        return "Expected a single mailbox without header injection.";
      }
    }),
  ),
);
const Mailboxes = Schema.Array(Mailbox).pipe(Schema.check(Schema.isMaxLength(50)));

export const EmailListQuery = Schema.Struct({
  cursor: Schema.optional(Cursor),
  limit: Schema.optional(PageLimit),
});
export const CreateEmailTenantRequest = Schema.Struct({ name: Name });
export const UpdateEmailTenantRequest = Schema.Struct({
  name: Schema.optional(Name),
  status: Schema.optional(TenantStatus),
}).pipe(
  Schema.check(
    Schema.makeFilter<{ readonly name?: string | undefined; readonly status?: string | undefined }>(
      (input) =>
        input.name !== undefined || input.status !== undefined
          ? undefined
          : "Provide name or status.",
    ),
  ),
);
export const CreateEmailDomainRequest = Schema.Struct({ domain: Domain });
export const SendEmailRequest = Schema.Struct({
  from: Mailbox,
  to: Mailboxes.pipe(Schema.check(Schema.isMinLength(1))),
  cc: Schema.optional(Mailboxes),
  bcc: Schema.optional(Mailboxes),
  replyTo: Schema.optional(Mailboxes),
  subject: Schema.String.pipe(
    Schema.check(Schema.isMaxLength(998), Schema.isPattern(/^[^\p{Cc}\p{Cs}]*$/u)),
  ),
  text: Schema.optional(Schema.String),
  html: Schema.optional(Schema.String),
}).pipe(
  Schema.check(
    Schema.makeFilter<{
      readonly to: readonly string[];
      readonly cc?: readonly string[] | undefined;
      readonly bcc?: readonly string[] | undefined;
      readonly text?: string | undefined;
      readonly html?: string | undefined;
    }>((input) => {
      if (input.to.length + (input.cc?.length ?? 0) + (input.bcc?.length ?? 0) > 50) {
        return "A message must not exceed 50 recipients.";
      }
      if (!input.text?.length && !input.html?.length) return "Provide at least one nonempty body.";
      if (
        encoder.encode(input.text ?? "").byteLength + encoder.encode(input.html ?? "").byteLength >
        1_048_576
      ) {
        return "Combined UTF-8 body size must not exceed 1 MiB.";
      }
      return undefined;
    }),
  ),
);

const commonFields = {
  id: PublicId,
  organizationId: PublicId,
  projectId: PublicId,
  environmentId: PublicId,
  createdAt: Timestamp,
  updatedAt: Timestamp,
};
export const EmailTenantResponse = Schema.Struct({
  ...commonFields,
  name: Name,
  status: TenantStatus,
  region: Schema.String,
  providerName: Schema.String,
  configurationSetName: Schema.String,
  sendingStatus: Schema.Literals(["provisioning", "enabled", "reinstated", "disabled"]),
  providerId: Schema.optional(Schema.String),
  providerArn: Schema.optional(Schema.String),
});
export const EmailDomainResponse = Schema.Struct({
  ...commonFields,
  tenantId: PublicId,
  domain: Domain,
  status: Schema.Literals([
    "pending",
    "provisioning",
    "pending_dns",
    "verified",
    "failed",
    "revoked",
  ]),
  dnsRecords: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      type: Schema.Literals(["CNAME", "MX", "TXT"]),
      value: Schema.String,
      priority: Schema.optional(
        Schema.Number.pipe(
          Schema.check(
            Schema.isInt(),
            Schema.isGreaterThanOrEqualTo(0),
            Schema.isLessThanOrEqualTo(65_535),
          ),
        ),
      ),
    }),
  ),
  mailFromDomain: Schema.String,
  failureReason: Schema.optional(Schema.String),
  lastCheckedAt: Schema.optional(Timestamp),
  verifiedAt: Schema.optional(Timestamp),
});
export const EmailSendResponse = Schema.Struct({
  id: PublicId,
  tenantId: PublicId,
  status: Schema.Literal("accepted"),
  providerMessageId: Schema.String,
  acceptedAt: Timestamp,
});
export const EmailTenantPageResponse = Schema.Struct({
  items: Schema.Array(EmailTenantResponse),
  nextCursor: Schema.optional(Cursor),
});
export const EmailDomainPageResponse = Schema.Struct({
  items: Schema.Array(EmailDomainResponse),
  nextCursor: Schema.optional(Cursor),
});

export type CreateEmailTenantRequest = typeof CreateEmailTenantRequest.Type;
export type UpdateEmailTenantRequest = typeof UpdateEmailTenantRequest.Type;
export type CreateEmailDomainRequest = typeof CreateEmailDomainRequest.Type;
export type SendEmailRequest = typeof SendEmailRequest.Type;
export type EmailTenantResponse = typeof EmailTenantResponse.Type;
export type EmailDomainResponse = typeof EmailDomainResponse.Type;
export type EmailSendResponse = typeof EmailSendResponse.Type;
export type EmailTenantPageResponse = typeof EmailTenantPageResponse.Type;
export type EmailDomainPageResponse = typeof EmailDomainPageResponse.Type;
export type EmailListQuery = typeof EmailListQuery.Type;

export const EMAIL_API_SCHEMAS = {
  CreateEmailTenantRequest,
  UpdateEmailTenantRequest,
  CreateEmailDomainRequest,
  SendEmailRequest,
  EmailTenantResponse,
  EmailDomainResponse,
  EmailSendResponse,
  EmailTenantPageResponse,
  EmailDomainPageResponse,
  EmailListQuery,
} as const;
export type EmailApiSchemaName = keyof typeof EMAIL_API_SCHEMAS;
