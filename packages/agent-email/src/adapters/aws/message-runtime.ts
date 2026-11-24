import { createHash, randomUUID } from "node:crypto";
import type { SendEmailCommandInput } from "@aws-sdk/client-sesv2";
import {
  MAX_AGENT_EMAIL_ATTACHMENTS,
  type AgentEmailAttachmentRecord,
  type AgentEmailBlobStore,
  type AgentEmailMessageRecord,
  type AgentEmailProviderTenantRecord,
} from "../../core/index.ts";
import PostalMime, { type Address, type Attachment, type Email } from "postal-mime";

const MAX_INBOUND_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_INBOUND_ADDRESS_BYTES = 320;
const MAX_INBOUND_ADDRESS_COUNT = 100;
const MAX_INBOUND_ADDRESS_LIST_BYTES = 16 * 1024;
const MAX_INBOUND_BODY_BYTES = 1024 * 1024;
const MAX_INBOUND_REFERENCES = 64;
const MAX_INBOUND_REFERENCES_BYTES = 8 * 1024;
const MAX_INBOUND_SUBJECT_LENGTH = 998;
const MAX_SES_MESSAGE_BYTES = 40_000_000;
const MAX_SES_ATTACHMENT_HEADER_LENGTH = 78;
const MAX_INBOUND_ATTACHMENT_CONTENT_ID_BYTES = 998;
const MAX_INBOUND_ATTACHMENT_CONTENT_TYPE_BYTES = 998;
const MAX_SES_ATTACHMENT_FILE_NAME_LENGTH = 255;
const SES_MIME_BASE_OVERHEAD_BYTES = 64 * 1024;
const SES_MIME_ATTACHMENT_OVERHEAD_BYTES = 512;
const MAX_THREAD_HEADER_BYTES = 512;
const MAX_SES_THREAD_HEADER_LENGTH = 900;

export interface ParsedInboundAgentEmail {
  readonly attachments: readonly {
    readonly byteSize: number;
    readonly content: Uint8Array;
    readonly contentId?: string;
    readonly contentType: string;
    readonly disposition: "attachment" | "inline";
    readonly fileName: string;
    readonly sha256: string;
  }[];
  readonly bccAddresses: readonly string[];
  readonly ccAddresses: readonly string[];
  readonly fromAddress: string;
  readonly htmlBody?: string;
  readonly inReplyTo?: string;
  readonly internetMessageId?: string;
  readonly references: readonly string[];
  readonly replyToAddresses: readonly string[];
  readonly subject: string;
  readonly textBody?: string;
  readonly threadKey: string;
  readonly toAddresses: readonly string[];
}

export interface ExternalizedAgentEmailBodyReference {
  readonly bucket: string;
  readonly byteSize: number;
  readonly contentType: string;
  readonly etag?: string;
  readonly key: string;
  readonly sha256: string;
  readonly versionId?: string;
}

function bytes(value: Attachment["content"]) {
  if (typeof value === "string") return Buffer.from(value, "base64");
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function safeAttachmentHeader(value: string, name: string) {
  if (value.includes("\r") || value.includes("\n")) {
    throw new Error(`Attachment ${name} must not contain line breaks.`);
  }
  return value;
}

function inboundAttachmentContentId(value: string | undefined) {
  if (!value) return undefined;
  safeAttachmentHeader(value, "Content-ID");
  if (Buffer.byteLength(value, "utf8") > MAX_INBOUND_ATTACHMENT_CONTENT_ID_BYTES) {
    throw new Error(
      `Attachment Content-ID exceeds ${MAX_INBOUND_ATTACHMENT_CONTENT_ID_BYTES} bytes.`,
    );
  }
  return value;
}

function validMimeType(value: string) {
  return /^[^\s/;]+\/[^\s/;]+(?:\s*;\s*[^\r\n]+)?$/u.test(value);
}

function inboundAttachmentContentType(value: string | undefined) {
  const contentType = value || "application/octet-stream";
  safeAttachmentHeader(contentType, "Content-Type");
  if (!validMimeType(contentType)) throw new Error("Attachment Content-Type is invalid.");
  if (Buffer.byteLength(contentType, "utf8") > MAX_INBOUND_ATTACHMENT_CONTENT_TYPE_BYTES) {
    throw new Error(
      `Attachment Content-Type exceeds ${MAX_INBOUND_ATTACHMENT_CONTENT_TYPE_BYTES} bytes.`,
    );
  }
  return contentType;
}

function sesAttachmentContentId(value: string | undefined) {
  if (!value) return undefined;
  safeAttachmentHeader(value, "Content-ID");
  if (value.length > MAX_SES_ATTACHMENT_HEADER_LENGTH) {
    throw new Error(
      `Attachment Content-ID exceeds the Amazon SES ${MAX_SES_ATTACHMENT_HEADER_LENGTH}-character limit.`,
    );
  }
  return value;
}

function sesAttachmentFileName(value: string) {
  safeAttachmentHeader(value, "file name");
  if (!value || value.length > MAX_SES_ATTACHMENT_FILE_NAME_LENGTH) {
    throw new Error(
      `Attachment file name must be between 1 and ${MAX_SES_ATTACHMENT_FILE_NAME_LENGTH} characters for Amazon SES.`,
    );
  }
  return value;
}

function sesAttachmentContentType(value: string) {
  safeAttachmentHeader(value, "Content-Type");
  if (!validMimeType(value)) throw new Error("Attachment Content-Type is invalid.");
  if (value.length > MAX_SES_ATTACHMENT_HEADER_LENGTH) {
    throw new Error(
      `Attachment Content-Type exceeds the Amazon SES ${MAX_SES_ATTACHMENT_HEADER_LENGTH}-character limit.`,
    );
  }
  return value;
}

export function boundedInboundMailboxes(values: readonly Address[] | Address | undefined) {
  const addresses: string[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  const add = (candidate: string | undefined) => {
    if (!candidate || addresses.length >= MAX_INBOUND_ADDRESS_COUNT) return;
    const address = candidate.trim();
    if (!address || seen.has(address)) return;
    const addressBytes = Buffer.byteLength(address, "utf8");
    const separatorBytes = addresses.length > 0 ? 1 : 0;
    if (
      addressBytes > MAX_INBOUND_ADDRESS_BYTES ||
      totalBytes + separatorBytes + addressBytes > MAX_INBOUND_ADDRESS_LIST_BYTES
    ) {
      return;
    }
    seen.add(address);
    addresses.push(address);
    totalBytes += separatorBytes + addressBytes;
  };
  const entries = Array.isArray(values) ? values : values ? [values] : [];
  for (const value of entries) {
    if ("group" in value && value.group) {
      for (const entry of value.group) {
        add(entry.address);
        if (addresses.length >= MAX_INBOUND_ADDRESS_COUNT) break;
      }
    } else if ("address" in value && value.address) {
      add(value.address);
    }
    if (addresses.length >= MAX_INBOUND_ADDRESS_COUNT) break;
  }
  return addresses;
}

function safeFileName(value: string | null, index: number) {
  return Array.from(value?.trim() || `attachment-${index + 1}`)
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return character === "/" || character === "\\" || code <= 31 || code === 127
        ? "_"
        : character;
    })
    .join("")
    .slice(0, 255);
}

export function agentEmailInboundThreadKey(
  email: Pick<Email, "inReplyTo" | "messageId" | "references">,
  providerMessageId: string,
) {
  const rootReference =
    typeof email.references === "string"
      ? boundedInboundReferenceCandidates(email.references).next().value
      : undefined;
  const value =
    rootReference || email.inReplyTo?.trim() || email.messageId?.trim() || providerMessageId;
  return Buffer.byteLength(value, "utf8") <= MAX_THREAD_HEADER_BYTES
    ? value
    : `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function boundedInboundThreadHeader(value: string | undefined) {
  const normalized = value?.trim();
  return normalized && Buffer.byteLength(normalized, "utf8") <= MAX_THREAD_HEADER_BYTES
    ? normalized
    : undefined;
}

function* boundedInboundReferenceCandidates(value: string) {
  let start = 0;
  const candidate = (end: number) => {
    if (end <= start || end - start > MAX_THREAD_HEADER_BYTES) return undefined;
    return boundedInboundThreadHeader(value.slice(start, end));
  };
  for (const separator of value.matchAll(/\s+/gu)) {
    const reference = candidate(separator.index);
    if (reference) yield reference;
    start = separator.index + separator[0].length;
  }
  const reference = candidate(value.length);
  if (reference) yield reference;
}

export function boundedInboundReferences(value: string | undefined) {
  if (!value) return [];
  let root: string | undefined;
  const tail: string[] = [];
  let tailBytes = 0;
  for (const reference of boundedInboundReferenceCandidates(value)) {
    if (!root) {
      root = reference;
      continue;
    }
    const referenceBytes = Buffer.byteLength(reference, "utf8");
    tail.push(reference);
    tailBytes += referenceBytes;
    while (
      tail.length + 1 > MAX_INBOUND_REFERENCES ||
      Buffer.byteLength(root, "utf8") + tailBytes + tail.length > MAX_INBOUND_REFERENCES_BYTES
    ) {
      const removed = tail.shift();
      if (!removed) break;
      tailBytes -= Buffer.byteLength(removed, "utf8");
    }
  }
  return root ? [root, ...tail] : [];
}

export async function parseInboundAgentEmail(
  raw: Uint8Array,
  providerMessageId: string,
): Promise<ParsedInboundAgentEmail> {
  const email = await PostalMime.parse(raw);
  const attachments = email.attachments.map((attachment, index) => {
    const content = bytes(attachment.content);
    const contentId = inboundAttachmentContentId(attachment.contentId);
    const contentType = inboundAttachmentContentType(attachment.mimeType);
    return {
      byteSize: content.byteLength,
      content,
      ...(contentId ? { contentId } : {}),
      contentType,
      disposition:
        attachment.disposition === "inline" ? ("inline" as const) : ("attachment" as const),
      fileName: safeFileName(attachment.filename, index),
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  });
  const attachmentBytes = attachments.reduce((total, attachment) => total + attachment.byteSize, 0);
  if (attachments.length > MAX_AGENT_EMAIL_ATTACHMENTS) {
    throw new Error(`Inbound email has more than ${MAX_AGENT_EMAIL_ATTACHMENTS} attachments.`);
  }
  if (attachmentBytes > MAX_INBOUND_ATTACHMENT_BYTES) {
    throw new Error("Inbound email attachments exceed 25 MiB decoded.");
  }
  const htmlBody = email.html?.trim() || undefined;
  const textBody = email.text?.trim() || (htmlBody ? undefined : "");
  if (
    Buffer.byteLength(htmlBody ?? "", "utf8") + Buffer.byteLength(textBody ?? "", "utf8") >
    MAX_INBOUND_BODY_BYTES
  ) {
    throw new Error("Inbound email bodies exceed 1 MiB decoded.");
  }
  const fromAddress = boundedInboundMailboxes(email.from)[0];
  if (!fromAddress) throw new Error("Inbound email has no sender address.");
  const inReplyTo = boundedInboundThreadHeader(email.inReplyTo);
  const internetMessageId = boundedInboundThreadHeader(email.messageId);
  return {
    attachments,
    bccAddresses: boundedInboundMailboxes(email.bcc),
    ccAddresses: boundedInboundMailboxes(email.cc),
    fromAddress,
    ...(htmlBody ? { htmlBody } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(internetMessageId ? { internetMessageId } : {}),
    references: boundedInboundReferences(
      typeof email.references === "string" ? email.references : undefined,
    ),
    replyToAddresses: boundedInboundMailboxes(email.replyTo),
    subject: (email.subject?.trim() ?? "").slice(0, MAX_INBOUND_SUBJECT_LENGTH),
    ...(textBody !== undefined ? { textBody } : {}),
    threadKey: agentEmailInboundThreadKey(email, providerMessageId),
    toAddresses: boundedInboundMailboxes(email.to),
  };
}

export async function externalizeInboundAgentEmailBodies(
  parsed: ParsedInboundAgentEmail,
  args: {
    readonly blobs: AgentEmailBlobStore;
    readonly bucket: string;
    readonly attemptId?: string;
    readonly keyPrefix: string;
    readonly thresholdBytes?: number;
  },
): Promise<{
  readonly bodyReferences: {
    readonly htmlBodyRef?: ExternalizedAgentEmailBodyReference;
    readonly textBodyRef?: ExternalizedAgentEmailBodyReference;
  };
  readonly createdBodyReferences: readonly ExternalizedAgentEmailBodyReference[];
  readonly parsed: ParsedInboundAgentEmail;
}> {
  const thresholdBytes = args.thresholdBytes ?? 256 * 1024;
  const htmlBytes = parsed.htmlBody ? Buffer.from(parsed.htmlBody, "utf8") : undefined;
  const textBytes =
    parsed.textBody !== undefined ? Buffer.from(parsed.textBody, "utf8") : undefined;
  const totalBytes = (htmlBytes?.byteLength ?? 0) + (textBytes?.byteLength ?? 0);
  if (totalBytes <= thresholdBytes) {
    return { bodyReferences: {}, createdBodyReferences: [], parsed };
  }
  const attemptId = args.attemptId ?? randomUUID();
  const attemptKeyPrefix = `${args.keyPrefix}/attempts/${createHash("sha256")
    .update(attemptId)
    .digest("hex")
    .slice(0, 24)}`;

  async function putBody(
    body: Uint8Array | undefined,
    suffix: string,
    contentType: string,
  ): Promise<
    | {
        readonly created: boolean;
        readonly reference: ExternalizedAgentEmailBodyReference;
      }
    | undefined
  > {
    if (!body) return undefined;
    const key = `${attemptKeyPrefix}/${suffix}`;
    const sha256 = createHash("sha256").update(body).digest("hex");
    const stored = await args.blobs.put({
      body,
      contentType,
      ifAbsent: true,
      key,
      metadata: { sha256 },
    });
    return {
      created: stored?.created === true,
      reference: {
        bucket: args.bucket,
        byteSize: body.byteLength,
        contentType,
        ...(stored?.etag ? { etag: stored.etag } : {}),
        key,
        sha256,
        ...(stored?.versionId ? { versionId: stored.versionId } : {}),
      },
    };
  }

  const uploads = [
    {
      body: htmlBytes,
      contentType: "text/html; charset=utf-8",
      kind: "html" as const,
      suffix: "body.html",
    },
    {
      body: textBytes,
      contentType: "text/plain; charset=utf-8",
      kind: "text" as const,
      suffix: "body.txt",
    },
  ].filter((upload) => upload.body !== undefined);
  const settled = await Promise.allSettled(
    uploads.map((upload) => putBody(upload.body, upload.suffix, upload.contentType)),
  );
  const failed = settled.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") {
    const uploadedVersions = settled.flatMap((result) =>
      result.status === "fulfilled" && result.value?.created && result.value.reference.versionId
        ? [result.value.reference]
        : [],
    );
    const cleanup = await Promise.allSettled(
      uploadedVersions.map((reference) =>
        args.blobs.delete(reference.key, reference.bucket, reference.versionId),
      ),
    );
    const cleanupFailures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [failed.reason, ...cleanupFailures],
        "Failed to externalize and clean up inbound agent email bodies.",
        { cause: failed.reason },
      );
    }
    throw failed.reason;
  }
  const references = new Map(
    settled.flatMap((result, index) =>
      result.status === "fulfilled" && result.value
        ? [[uploads[index]!.kind, result.value.reference] as const]
        : [],
    ),
  );
  const htmlBodyRef = references.get("html");
  const textBodyRef = references.get("text");
  const createdBodyReferences = settled.flatMap((result) =>
    result.status === "fulfilled" && result.value?.created && result.value.reference.versionId
      ? [result.value.reference]
      : [],
  );
  const { htmlBody: _htmlBody, textBody: _textBody, ...parsedWithoutBodies } = parsed;
  return {
    bodyReferences: {
      ...(htmlBodyRef ? { htmlBodyRef } : {}),
      ...(textBodyRef ? { textBodyRef } : {}),
    },
    createdBodyReferences,
    parsed: parsedWithoutBodies,
  };
}

export function normalizeSesThreadHeader(value: string | undefined) {
  const normalized = value?.trim();
  if (!normalized || normalized.length > MAX_SES_THREAD_HEADER_LENGTH) return undefined;
  return Array.from(normalized).every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 32 && code <= 126;
  })
    ? normalized
    : undefined;
}

export function normalizeSesReferences(values: readonly string[]) {
  const candidates = values
    .map((value) => normalizeSesThreadHeader(value))
    .filter((value): value is string => Boolean(value));
  const root = candidates[0];
  if (!root) return undefined;
  const tail: string[] = [];
  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const value = candidates[index];
    if (!value) continue;
    const candidate = [root, value, ...tail].join(" ");
    if (candidate.length > MAX_SES_THREAD_HEADER_LENGTH) break;
    tail.unshift(value);
  }
  return [root, ...tail].join(" ");
}

export function agentEmailTenantNameForRegions(
  tenants: readonly AgentEmailProviderTenantRecord[],
  regions: readonly string[],
) {
  const byRegion = new Map(tenants.map((tenant) => [tenant.region, tenant]));
  const names = regions.map((region) => {
    const tenant = byRegion.get(region);
    if (!tenant || !["enabled", "reinstated"].includes(tenant.sendingStatus)) {
      throw new Error(`Amazon SES tenant is not enabled in ${region}.`);
    }
    return tenant.providerName;
  });
  const [name] = names;
  if (!name || names.some((candidate) => candidate !== name)) {
    throw new Error("Amazon SES tenant names differ across the selected route.");
  }
  return name;
}

function encodedMimeBase64Bytes(byteLength: number) {
  const encodedBytes = 4 * Math.ceil(byteLength / 3);
  return encodedBytes + 2 * Math.ceil(encodedBytes / 76);
}

function encodedMimeTextBytes(value: string) {
  const rawBytes = Buffer.byteLength(value, "utf8");
  if (/^[\t\n\r\x20-\x7e]*$/u.test(value)) return rawBytes;
  const quotedPrintableBytes = rawBytes * 3;
  return quotedPrintableBytes + 3 * Math.ceil(quotedPrintableBytes / 73);
}

function assertSesMessageSize(args: {
  readonly attachments: readonly (AgentEmailAttachmentRecord & { readonly content: Uint8Array })[];
  readonly message: AgentEmailMessageRecord;
}) {
  const messageStrings = [
    args.message.subject,
    args.message.fromAddress,
    args.message.htmlBody ?? "",
    args.message.textBody ?? "",
    args.message.inReplyTo ?? "",
    ...args.message.references,
    ...args.message.replyToAddresses,
    ...args.message.toAddresses,
    ...args.message.ccAddresses,
    ...args.message.bccAddresses,
  ];
  let bytes =
    SES_MIME_BASE_OVERHEAD_BYTES +
    messageStrings.reduce((total, value) => total + encodedMimeTextBytes(value), 0);
  for (const attachment of args.attachments) {
    bytes +=
      SES_MIME_ATTACHMENT_OVERHEAD_BYTES +
      encodedMimeBase64Bytes(attachment.content.byteLength) +
      encodedMimeTextBytes(attachment.fileName) +
      encodedMimeTextBytes(attachment.contentType) +
      encodedMimeTextBytes(attachment.contentId ?? "");
    if (bytes > MAX_SES_MESSAGE_BYTES) {
      throw new Error("Outbound email exceeds the Amazon SES 40 MB encoded message limit.");
    }
  }
  if (bytes > MAX_SES_MESSAGE_BYTES) {
    throw new Error("Outbound email exceeds the Amazon SES 40 MB encoded message limit.");
  }
}

export function prepareAgentEmailSend(args: {
  readonly attachments: readonly (AgentEmailAttachmentRecord & { readonly content: Uint8Array })[];
  readonly configurationSetName: string;
  readonly endpointId?: string;
  readonly message: AgentEmailMessageRecord;
  readonly tenantName?: string;
}): SendEmailCommandInput {
  assertSesMessageSize(args);
  const inReplyTo = normalizeSesThreadHeader(args.message.inReplyTo);
  const references = normalizeSesReferences(args.message.references);
  return {
    ConfigurationSetName: args.configurationSetName,
    Content: {
      Simple: {
        ...(args.attachments.length > 0
          ? {
              Attachments: args.attachments.map((attachment) => {
                const contentId = sesAttachmentContentId(attachment.contentId);
                return {
                  ContentDisposition: attachment.disposition === "inline" ? "INLINE" : "ATTACHMENT",
                  ContentTransferEncoding: "BASE64",
                  ...(contentId ? { ContentId: contentId } : {}),
                  ContentType: sesAttachmentContentType(attachment.contentType),
                  FileName: sesAttachmentFileName(attachment.fileName),
                  RawContent: attachment.content,
                };
              }),
            }
          : {}),
        Body: {
          ...(args.message.htmlBody
            ? { Html: { Charset: "UTF-8", Data: args.message.htmlBody } }
            : {}),
          ...(args.message.textBody !== undefined || !args.message.htmlBody
            ? { Text: { Charset: "UTF-8", Data: args.message.textBody ?? "" } }
            : {}),
        },
        ...(inReplyTo || references
          ? {
              Headers: [
                ...(inReplyTo ? [{ Name: "In-Reply-To", Value: inReplyTo }] : []),
                ...(references ? [{ Name: "References", Value: references }] : []),
              ],
            }
          : {}),
        Subject: { Charset: "UTF-8", Data: args.message.subject },
      },
    },
    Destination: {
      ...(args.message.bccAddresses.length > 0
        ? { BccAddresses: [...args.message.bccAddresses] }
        : {}),
      ...(args.message.ccAddresses.length > 0
        ? { CcAddresses: [...args.message.ccAddresses] }
        : {}),
      ToAddresses: [...args.message.toAddresses],
    },
    EmailTags: [
      { Name: "agentEmailMessageId", Value: args.message.id },
      { Name: "agentEmailInboxId", Value: args.message.inboxId },
      { Name: "organizationId", Value: args.message.organizationId },
    ],
    ...(args.endpointId ? { EndpointId: args.endpointId } : {}),
    FromEmailAddress: args.message.fromAddress,
    ReplyToAddresses: [...args.message.replyToAddresses],
    ...(args.tenantName ? { TenantName: args.tenantName } : {}),
  };
}
