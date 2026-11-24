import { Schema } from "effect";
import { Cursor, Metadata, PageLimit, PublicId, Timestamp } from "./primitives.ts";

export const MAX_AGENT_EMAIL_ATTACHMENTS = 35;

const trimmedText = (label: string, maximum: number) =>
  Schema.String.pipe(
    Schema.check(
      Schema.isTrimmed({
        message: `${label} must not contain surrounding whitespace.`,
      }),
      Schema.isMinLength(1, { message: `${label} must not be empty.` }),
      Schema.isMaxLength(maximum, {
        message: `${label} must not exceed ${maximum} characters.`,
      }),
    ),
  );

const NonNegativeInteger = Schema.Number.pipe(
  Schema.check(
    Schema.isInt({ message: "Expected an integer." }),
    Schema.isGreaterThanOrEqualTo(0, {
      message: "Expected a non-negative integer.",
    }),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
);

const BasisPoints = NonNegativeInteger.pipe(Schema.check(Schema.isLessThanOrEqualTo(10_000)));

const EmailAddress = Schema.String.pipe(
  Schema.check(
    Schema.isTrimmed({
      message: "Email addresses must not contain surrounding whitespace.",
    }),
    Schema.isMinLength(3),
    Schema.isMaxLength(320),
    Schema.isPattern(/^[^\s@]+@[^\s@]+$/u, {
      message: "Expected an email address.",
    }),
  ),
);

const EmailAddressList = Schema.Array(EmailAddress).pipe(Schema.check(Schema.isMaxLength(50)));
const MessageResponseAddressList = Schema.Array(EmailAddress).pipe(
  Schema.check(Schema.isMaxLength(100)),
);
const ThreadParticipantResponseList = Schema.Array(EmailAddress).pipe(
  Schema.check(Schema.isMaxLength(256)),
);
const NonEmptyEmailAddressList = EmailAddressList.pipe(Schema.check(Schema.isMinLength(1)));
const AgentEmailStatus = Schema.Literals([
  "accepted",
  "bounced",
  "complained",
  "delivered",
  "failed",
  "queued",
  "received",
  "scheduled",
  "sending",
]);

export const AgentEmailListQuery = Schema.Struct({
  cursor: Schema.optional(Cursor),
  limit: Schema.optional(PageLimit),
});

export const AgentEmailInboxListQuery = Schema.Struct({
  clientId: Schema.optional(Schema.String),
  cursor: Schema.optional(Cursor),
  limit: Schema.optional(PageLimit),
  status: Schema.optional(Schema.Literals(["active", "archived", "paused"])),
});

export const AgentEmailMessageListQuery = Schema.Struct({
  cursor: Schema.optional(Cursor),
  direction: Schema.optional(Schema.Literals(["inbound", "outbound"])),
  limit: Schema.optional(PageLimit),
  status: Schema.optional(AgentEmailStatus),
});

export const AgentEmailDraftListQuery = Schema.Struct({
  cursor: Schema.optional(Cursor),
  limit: Schema.optional(PageLimit),
  status: Schema.optional(
    Schema.Literals([
      "approved",
      "cancelled",
      "draft",
      "failed",
      "pending_approval",
      "queued",
      "rejected",
      "scheduled",
      "sent",
    ]),
  ),
});

export const AgentEmailUsageQuery = Schema.Struct({
  from: Schema.optional(Timestamp),
  inboxId: Schema.optional(PublicId),
  to: Schema.optional(Timestamp),
});

export const CreateAgentEmailInboxRequest = Schema.Struct({
  clientId: Schema.optional(Schema.String),
  domainId: Schema.optional(PublicId),
  localPart: Schema.optional(trimmedText("Inbox local parts", 64)),
  metadata: Schema.optional(Metadata),
  name: Schema.optional(trimmedText("Inbox names", 120)),
});

export const UpdateAgentEmailInboxRequest = Schema.Struct({
  metadata: Schema.optional(Metadata),
  name: Schema.optional(Schema.String.pipe(Schema.check(Schema.isMaxLength(120)))),
  status: Schema.optional(Schema.Literals(["active", "archived", "paused"])),
});

export const CreateAgentEmailBindingRequest = Schema.Union([
  Schema.Struct({
    agentDeploymentId: PublicId,
    bindingType: Schema.Literal("platform_agent"),
    externalId: Schema.optional(Schema.String),
    metadata: Schema.optional(Metadata),
  }),
  Schema.Struct({
    agentDeploymentId: Schema.optional(PublicId),
    bindingType: Schema.Literal("external"),
    externalId: trimmedText("External binding IDs", 512),
    metadata: Schema.optional(Metadata),
  }),
]);

export const CreateAgentEmailDomainRequest = Schema.Struct({
  domain: trimmedText("Email domains", 253),
  placementId: Schema.optional(PublicId),
});

const AgentEmailAttachmentContentId = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(78),
    Schema.isPattern(/^[^\r\n]*$/u, {
      message: "Attachment Content-ID must not contain line breaks.",
    }),
  ),
);

const AgentEmailAttachmentContentType = trimmedText("Attachment content types", 78).pipe(
  Schema.check(
    Schema.isPattern(/^[^\s/;]+\/[^\s/;]+(?:\s*;\s*[^\r\n]+)?$/u, {
      message: "Attachment Content-Type must be a valid MIME type.",
    }),
  ),
);

const AgentEmailAttachmentFileName = trimmedText("Attachment file names", 255).pipe(
  Schema.check(
    Schema.isPattern(/^[^\r\n]+$/u, {
      message: "Attachment file names must not contain line breaks.",
    }),
  ),
);

export const AgentEmailAttachmentInput = Schema.Struct({
  contentBase64: Schema.String,
  contentId: Schema.optional(AgentEmailAttachmentContentId),
  contentType: AgentEmailAttachmentContentType,
  disposition: Schema.optional(Schema.Literals(["attachment", "inline"])),
  fileName: AgentEmailAttachmentFileName,
});

const AgentEmailAttachmentInputs = Schema.Array(AgentEmailAttachmentInput).pipe(
  Schema.check(Schema.isMaxLength(MAX_AGENT_EMAIL_ATTACHMENTS)),
);

export const SendAgentEmailMessageRequest = Schema.Struct({
  attachments: Schema.optional(AgentEmailAttachmentInputs),
  bcc: Schema.optional(EmailAddressList),
  cc: Schema.optional(EmailAddressList),
  clientId: Schema.optional(Schema.String),
  html: Schema.optional(Schema.String),
  idempotencyKey: Schema.optional(Schema.String),
  replyToMessageId: Schema.optional(PublicId),
  scheduledAt: Schema.optional(Timestamp),
  subject: Schema.String.pipe(Schema.check(Schema.isMaxLength(998))),
  text: Schema.optional(Schema.String),
  to: NonEmptyEmailAddressList,
});

export const SearchAgentEmailMessagesRequest = Schema.Struct({
  cursor: Schema.optional(Cursor),
  direction: Schema.optional(Schema.Literals(["inbound", "outbound"])),
  from: Schema.optional(EmailAddress),
  hasAttachments: Schema.optional(Schema.Boolean),
  limit: Schema.optional(PageLimit),
  participants: Schema.optional(EmailAddressList),
  query: Schema.optional(Schema.String),
  status: Schema.optional(AgentEmailStatus),
  to: Schema.optional(EmailAddress),
});

export const SearchAgentEmailThreadsRequest = Schema.Struct({
  cursor: Schema.optional(Cursor),
  from: Schema.optional(EmailAddress),
  hasAttachments: Schema.optional(Schema.Boolean),
  limit: Schema.optional(PageLimit),
  participants: Schema.optional(EmailAddressList),
  query: Schema.optional(Schema.String),
  to: Schema.optional(EmailAddress),
});

export const AgentEmailReplyRequest = Schema.Struct({
  attachments: Schema.optional(AgentEmailAttachmentInputs),
  bcc: Schema.optional(EmailAddressList),
  cc: Schema.optional(EmailAddressList),
  html: Schema.optional(Schema.String),
  idempotencyKey: Schema.optional(Schema.String),
  scheduledAt: Schema.optional(Timestamp),
  text: Schema.optional(Schema.String),
});

export const AgentEmailForwardRequest = Schema.Struct({
  attachments: Schema.optional(AgentEmailAttachmentInputs),
  bcc: Schema.optional(EmailAddressList),
  cc: Schema.optional(EmailAddressList),
  html: Schema.optional(Schema.String),
  idempotencyKey: Schema.optional(Schema.String),
  includeOriginal: Schema.optional(Schema.Boolean),
  scheduledAt: Schema.optional(Timestamp),
  text: Schema.optional(Schema.String),
  to: NonEmptyEmailAddressList,
});

export const CreateAgentEmailDraftRequest = Schema.Struct({
  bcc: Schema.optional(EmailAddressList),
  cc: Schema.optional(EmailAddressList),
  clientId: Schema.optional(Schema.String),
  html: Schema.optional(Schema.String),
  metadata: Schema.optional(Metadata),
  replyToMessageId: Schema.optional(PublicId),
  scheduledAt: Schema.optional(Timestamp),
  subject: Schema.String.pipe(Schema.check(Schema.isMaxLength(998))),
  text: Schema.optional(Schema.String),
  to: EmailAddressList,
});

export const UpdateAgentEmailDraftRequest = Schema.Struct({
  bcc: Schema.optional(EmailAddressList),
  cc: Schema.optional(EmailAddressList),
  html: Schema.optional(Schema.String),
  metadata: Schema.optional(Metadata),
  scheduledAt: Schema.optional(Timestamp),
  subject: Schema.optional(Schema.String.pipe(Schema.check(Schema.isMaxLength(998)))),
  text: Schema.optional(Schema.String),
  to: Schema.optional(EmailAddressList),
});

export const RejectAgentEmailDraftRequest = Schema.Struct({
  reason: trimmedText("Draft rejection reasons", 2_000),
});

const AgentEmailRegion = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^(?:[a-z0-9]+-)+[a-z0-9]+-\d+$/u, {
      message: "Expected a normalized AWS region.",
    }),
  ),
);

export const CreateAgentEmailPlacementRequest = Schema.Struct({
  dedicatedPool: Schema.optional(Schema.Boolean),
  isDefault: Schema.optional(Schema.Boolean),
  name: trimmedText("Placement names", 120),
  region: AgentEmailRegion,
  secondaryRegion: Schema.optional(AgentEmailRegion),
}).pipe(
  Schema.check(
    Schema.makeFilter<{
      readonly region: string;
      readonly secondaryRegion?: string | undefined;
    }>((input) =>
      input.secondaryRegion === input.region
        ? "secondaryRegion must differ from region."
        : undefined,
    ),
  ),
);

export const UpdateAgentEmailPlacementRequest = Schema.Struct({
  dedicatedPool: Schema.optional(Schema.Boolean),
  isDefault: Schema.optional(Schema.Boolean),
  name: Schema.optional(trimmedText("Placement names", 120)),
  status: Schema.optional(Schema.Literals(["active", "disabled"])),
});

export const UpdateAgentEmailPolicyRequest = Schema.Struct({
  allowlist: Schema.optional(EmailAddressList),
  blocklist: Schema.optional(EmailAddressList),
  bounceRateThresholdBasisPoints: Schema.optional(BasisPoints),
  complaintRateThresholdBasisPoints: Schema.optional(BasisPoints),
  dailyOutboundMessageLimit: Schema.optional(NonNegativeInteger),
  maxAttachmentBytes: Schema.optional(
    NonNegativeInteger.pipe(Schema.check(Schema.isLessThanOrEqualTo(4 * 1024 * 1024))),
  ),
  maxRecipientsPerMessage: Schema.optional(
    NonNegativeInteger.pipe(
      Schema.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(47)),
    ),
  ),
  rawRetentionDays: Schema.optional(
    NonNegativeInteger.pipe(
      Schema.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(365)),
    ),
  ),
  sendingStatus: Schema.optional(Schema.Literals(["active", "paused"])),
  warmupStage: Schema.optional(
    Schema.Literals(["production", "ramp_1", "ramp_2", "ramp_3", "sandbox"]),
  ),
});

export const CreateAgentEmailSuppressionRequest = Schema.Struct({
  address: EmailAddress,
  reason: Schema.Literals(["manual", "policy"]),
});

export const ExportAgentEmailUsageRequest = Schema.Struct({
  bucket: Schema.optional(Schema.Literals(["day", "hour", "month"])),
  format: Schema.optional(Schema.Literals(["csv", "json"])),
  from: Schema.optional(Timestamp),
  inboxId: Schema.optional(PublicId),
  to: Schema.optional(Timestamp),
});

export const AgentEmailDnsRecordResponse = Schema.Struct({
  name: Schema.String,
  priority: Schema.optional(Schema.Number),
  type: Schema.Literals(["CNAME", "MX", "TXT"]),
  value: Schema.String,
});

export const AgentEmailDomainResponse = Schema.Struct({
  createdAt: Timestamp,
  dnsRecords: Schema.Array(AgentEmailDnsRecordResponse),
  domain: Schema.String,
  failureReason: Schema.optional(Schema.String),
  id: PublicId,
  lastCheckedAt: Schema.optional(Timestamp),
  mailFromDomain: Schema.String,
  organizationId: PublicId,
  placementId: Schema.optional(PublicId),
  providerIdentity: Schema.optional(Schema.String),
  providerManaged: Schema.Boolean,
  providerMetadata: Metadata,
  status: Schema.Literals([
    "failed",
    "pending",
    "pending_dns",
    "provisioning",
    "revoked",
    "verified",
  ]),
  updatedAt: Timestamp,
  verifiedAt: Schema.optional(Timestamp),
});

export const AgentEmailInboxResponse = Schema.Struct({
  address: EmailAddress,
  clientId: Schema.optional(Schema.String),
  createdAt: Timestamp,
  domainId: PublicId,
  id: PublicId,
  localPart: Schema.String,
  metadata: Metadata,
  name: Schema.optional(Schema.String),
  organizationId: PublicId,
  status: Schema.Literals(["active", "archived", "paused"]),
  updatedAt: Timestamp,
});

export const AgentEmailBindingResponse = Schema.Struct({
  agentDeploymentId: Schema.optional(PublicId),
  bindingType: Schema.Literals(["external", "platform_agent"]),
  createdAt: Timestamp,
  externalId: Schema.String,
  id: PublicId,
  inboxId: PublicId,
  metadata: Metadata,
  organizationId: PublicId,
  status: Schema.Literals(["active", "archived", "disabled"]),
  updatedAt: Timestamp,
});

export const AgentEmailAttachmentResponse = Schema.Struct({
  byteSize: NonNegativeInteger,
  contentId: Schema.optional(Schema.String),
  contentType: Schema.String,
  disposition: Schema.Literals(["attachment", "inline"]),
  fileName: Schema.String,
  id: PublicId,
  messageId: PublicId,
  sha256: Schema.String,
});

export const AgentEmailMessageResponse = Schema.Struct({
  acceptedAt: Schema.optional(Timestamp),
  attachments: Schema.Array(AgentEmailAttachmentResponse),
  bccAddresses: MessageResponseAddressList,
  ccAddresses: MessageResponseAddressList,
  clientId: Schema.optional(Schema.String),
  createdAt: Timestamp,
  deliveredAt: Schema.optional(Timestamp),
  direction: Schema.Literals(["inbound", "outbound"]),
  draftId: Schema.optional(PublicId),
  failureCode: Schema.optional(Schema.String),
  failureReason: Schema.optional(Schema.String),
  fromAddress: EmailAddress,
  htmlBody: Schema.optional(Schema.String),
  id: PublicId,
  inboxId: PublicId,
  inReplyTo: Schema.optional(Schema.String),
  internetMessageId: Schema.optional(Schema.String),
  lastReprocessedAt: Schema.optional(Timestamp),
  organizationId: PublicId,
  providerMessageId: Schema.optional(Schema.String),
  rawPurgedAt: Schema.optional(Timestamp),
  rawRetentionExpiresAt: Schema.optional(Timestamp),
  receivedAt: Schema.optional(Timestamp),
  references: Schema.Array(Schema.String),
  replyToAddresses: MessageResponseAddressList,
  reprocessCount: NonNegativeInteger,
  scheduledAt: Schema.optional(Timestamp),
  status: AgentEmailStatus,
  subject: Schema.String,
  textBody: Schema.optional(Schema.String),
  threadId: Schema.optional(PublicId),
  threadKey: Schema.String,
  toAddresses: MessageResponseAddressList,
  updatedAt: Timestamp,
});

export const AgentEmailThreadResponse = Schema.Struct({
  createdAt: Timestamp,
  id: PublicId,
  inboxId: PublicId,
  lastMessageAt: Timestamp,
  messageCount: NonNegativeInteger,
  organizationId: PublicId,
  participants: ThreadParticipantResponseList,
  subject: Schema.String,
  updatedAt: Timestamp,
});

export const AgentEmailDraftResponse = Schema.Struct({
  approvedAt: Schema.optional(Timestamp),
  bccAddresses: EmailAddressList,
  ccAddresses: EmailAddressList,
  clientId: Schema.optional(Schema.String),
  createdAt: Timestamp,
  failureReason: Schema.optional(Schema.String),
  htmlBody: Schema.optional(Schema.String),
  id: PublicId,
  inboxId: PublicId,
  metadata: Metadata,
  organizationId: PublicId,
  rejectedAt: Schema.optional(Timestamp),
  replyToMessageId: Schema.optional(PublicId),
  scheduledAt: Schema.optional(Timestamp),
  sentMessageId: Schema.optional(PublicId),
  status: Schema.Literals([
    "approved",
    "cancelled",
    "draft",
    "failed",
    "pending_approval",
    "queued",
    "rejected",
    "scheduled",
    "sent",
  ]),
  subject: Schema.String,
  textBody: Schema.optional(Schema.String),
  toAddresses: EmailAddressList,
  updatedAt: Timestamp,
});

export const AgentEmailPlacementResponse = Schema.Struct({
  createdAt: Timestamp,
  dedicatedPool: Schema.Boolean,
  estimatedMonthlyCostCents: Schema.optional(NonNegativeInteger),
  id: PublicId,
  isDefault: Schema.Boolean,
  lastReconciledAt: Schema.optional(Timestamp),
  name: Schema.String,
  organizationId: PublicId,
  provider: Schema.String,
  providerMetadata: Metadata,
  reconciliationError: Schema.optional(Schema.String),
  region: Schema.String,
  secondaryRegion: Schema.optional(Schema.String),
  status: Schema.Literals([
    "active",
    "deprovisioning",
    "disabled",
    "failed",
    "provisioning",
    "reconciling",
  ]),
  updatedAt: Timestamp,
});

export const AgentEmailPolicyResponse = Schema.Struct({
  allowlist: Schema.optional(Schema.Array(Schema.String)),
  blocklist: Schema.optional(Schema.Array(Schema.String)),
  bounceRateThresholdBasisPoints: BasisPoints,
  complaintRateThresholdBasisPoints: BasisPoints,
  createdAt: Timestamp,
  dailyOutboundMessageLimit: NonNegativeInteger,
  id: PublicId,
  maxAttachmentBytes: NonNegativeInteger,
  maxRecipientsPerMessage: NonNegativeInteger,
  organizationId: PublicId,
  rawRetentionDays: NonNegativeInteger,
  sendingStatus: Schema.Literals(["active", "paused", "suspended"]),
  sendingStatusReason: Schema.optional(Schema.String),
  updatedAt: Timestamp,
  warmupStage: Schema.Literals(["production", "ramp_1", "ramp_2", "ramp_3", "sandbox"]),
  warmupStartedAt: Schema.optional(Timestamp),
});

export const AgentEmailSuppressionResponse = Schema.Struct({
  address: EmailAddress,
  createdAt: Timestamp,
  id: PublicId,
  organizationId: PublicId,
  reason: Schema.Literals(["bounce", "complaint", "manual", "policy"]),
  sourceMessageId: Schema.optional(PublicId),
});

export const AgentEmailUsageExportRowResponse = Schema.Struct({
  bucketStart: Timestamp,
  clientId: Schema.optional(Schema.String),
  inboxId: Schema.optional(PublicId),
  kind: Schema.Literals([
    "attachment_bytes",
    "inbound_message",
    "outbound_message",
    "stored_bytes",
  ]),
  organizationId: PublicId,
  quantity: NonNegativeInteger,
});

const page = <A extends Schema.Top>(item: A) =>
  Schema.Struct({
    items: Schema.Array(item),
    nextCursor: Schema.optional(Cursor),
  });

export const AgentEmailInboxPageResponse = page(AgentEmailInboxResponse);
export const AgentEmailBindingPageResponse = page(AgentEmailBindingResponse);
export const AgentEmailMessagePageResponse = page(AgentEmailMessageResponse);
export const AgentEmailThreadPageResponse = page(AgentEmailThreadResponse);
export const AgentEmailDomainPageResponse = page(AgentEmailDomainResponse);
export const AgentEmailPlacementPageResponse = page(AgentEmailPlacementResponse);
export const AgentEmailDraftPageResponse = page(AgentEmailDraftResponse);
export const AgentEmailSuppressionPageResponse = page(AgentEmailSuppressionResponse);

export const AgentEmailAccessUrlResponse = Schema.Struct({
  expiresAt: Timestamp,
  rawPurgedAt: Schema.optional(Timestamp),
  rawRetentionExpiresAt: Schema.optional(Timestamp),
  url: Schema.String,
});

export const AgentEmailThreadDetailResponse = Schema.Struct({
  messages: Schema.Array(AgentEmailMessageResponse),
  nextCursor: Schema.optional(Cursor),
  thread: AgentEmailThreadResponse,
});

export const AgentEmailUsageSummaryResponse = Schema.Struct({
  attachmentBytes: NonNegativeInteger,
  from: Timestamp,
  inboundMessages: NonNegativeInteger,
  organizationId: PublicId,
  outboundMessages: NonNegativeInteger,
  storedBytes: NonNegativeInteger,
  to: Timestamp,
});

export const AgentEmailUsageExportResponse = Schema.Struct({
  bucket: Schema.Literals(["day", "hour", "month"]),
  csv: Schema.optional(Schema.String),
  format: Schema.Literals(["csv", "json"]),
  from: Timestamp,
  rows: Schema.Array(AgentEmailUsageExportRowResponse),
  to: Timestamp,
});

export const AGENT_EMAIL_API_SCHEMAS = {
  AgentEmailAccessUrlResponse,
  AgentEmailAttachmentInput,
  AgentEmailAttachmentResponse,
  AgentEmailBindingPageResponse,
  AgentEmailBindingResponse,
  AgentEmailDomainPageResponse,
  AgentEmailDomainResponse,
  AgentEmailDraftListQuery,
  AgentEmailDraftPageResponse,
  AgentEmailDraftResponse,
  AgentEmailForwardRequest,
  AgentEmailInboxListQuery,
  AgentEmailInboxPageResponse,
  AgentEmailInboxResponse,
  AgentEmailListQuery,
  AgentEmailMessageListQuery,
  AgentEmailMessagePageResponse,
  AgentEmailMessageResponse,
  AgentEmailPlacementPageResponse,
  AgentEmailPlacementResponse,
  AgentEmailPolicyResponse,
  AgentEmailReplyRequest,
  AgentEmailSuppressionPageResponse,
  AgentEmailSuppressionResponse,
  AgentEmailThreadDetailResponse,
  AgentEmailThreadPageResponse,
  AgentEmailThreadResponse,
  AgentEmailUsageExportResponse,
  AgentEmailUsageQuery,
  AgentEmailUsageSummaryResponse,
  CreateAgentEmailBindingRequest,
  CreateAgentEmailDomainRequest,
  CreateAgentEmailDraftRequest,
  CreateAgentEmailInboxRequest,
  CreateAgentEmailPlacementRequest,
  CreateAgentEmailSuppressionRequest,
  ExportAgentEmailUsageRequest,
  RejectAgentEmailDraftRequest,
  SearchAgentEmailMessagesRequest,
  SearchAgentEmailThreadsRequest,
  SendAgentEmailMessageRequest,
  UpdateAgentEmailDraftRequest,
  UpdateAgentEmailInboxRequest,
  UpdateAgentEmailPlacementRequest,
  UpdateAgentEmailPolicyRequest,
} as const;

export type AgentEmailApiSchemaName = keyof typeof AGENT_EMAIL_API_SCHEMAS;
