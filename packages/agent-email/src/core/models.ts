import { Schema } from "effect";

export const AGENT_EMAIL_DOMAIN_STATUSES = [
  "pending",
  "provisioning",
  "pending_dns",
  "verified",
  "failed",
  "revoked",
] as const;
export type AgentEmailDomainStatus = (typeof AGENT_EMAIL_DOMAIN_STATUSES)[number];

export const AGENT_EMAIL_INBOX_STATUSES = ["active", "paused", "archived"] as const;
export type AgentEmailInboxStatus = (typeof AGENT_EMAIL_INBOX_STATUSES)[number];

export const AGENT_EMAIL_BINDING_TYPES = ["platform_agent", "external"] as const;
export type AgentEmailBindingType = (typeof AGENT_EMAIL_BINDING_TYPES)[number];

export const AGENT_EMAIL_INBOX_BINDING_STATUSES = ["active", "archived", "disabled"] as const;
export type AgentEmailInboxBindingStatus = (typeof AGENT_EMAIL_INBOX_BINDING_STATUSES)[number];

export const AGENT_EMAIL_DIRECTIONS = ["inbound", "outbound"] as const;
export type AgentEmailDirection = (typeof AGENT_EMAIL_DIRECTIONS)[number];

export const AGENT_EMAIL_MESSAGE_STATUSES = [
  "received",
  "scheduled",
  "queued",
  "sending",
  "accepted",
  "delivered",
  "bounced",
  "complained",
  "failed",
] as const;
export type AgentEmailMessageStatus = (typeof AGENT_EMAIL_MESSAGE_STATUSES)[number];

export const AGENT_EMAIL_DRAFT_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "rejected",
  "scheduled",
  "queued",
  "sent",
  "cancelled",
  "failed",
] as const;
export type AgentEmailDraftStatus = (typeof AGENT_EMAIL_DRAFT_STATUSES)[number];

export const AGENT_EMAIL_ATTACHMENT_DISPOSITIONS = ["attachment", "inline"] as const;
export type AgentEmailAttachmentDisposition = (typeof AGENT_EMAIL_ATTACHMENT_DISPOSITIONS)[number];

export const AGENT_EMAIL_SUPPRESSION_REASONS = ["bounce", "complaint", "manual", "policy"] as const;
export type AgentEmailSuppressionReason = (typeof AGENT_EMAIL_SUPPRESSION_REASONS)[number];

export const AGENT_EMAIL_USAGE_KINDS = [
  "inbound_message",
  "outbound_message",
  "attachment_bytes",
  "stored_bytes",
] as const;
export type AgentEmailUsageKind = (typeof AGENT_EMAIL_USAGE_KINDS)[number];

export const AGENT_EMAIL_SENDING_STATUSES = ["active", "paused", "suspended"] as const;
export type AgentEmailSendingStatus = (typeof AGENT_EMAIL_SENDING_STATUSES)[number];

export const AGENT_EMAIL_PLACEMENT_STATUSES = [
  "provisioning",
  "active",
  "reconciling",
  "deprovisioning",
  "failed",
  "disabled",
] as const;
export type AgentEmailPlacementStatus = (typeof AGENT_EMAIL_PLACEMENT_STATUSES)[number];

export const AGENT_EMAIL_USAGE_BUCKETS = ["hour", "day", "month"] as const;
export type AgentEmailUsageBucket = (typeof AGENT_EMAIL_USAGE_BUCKETS)[number];

export const AGENT_EMAIL_USAGE_DIMENSIONS = ["organization", "client", "inbox", "kind"] as const;
export type AgentEmailUsageDimension = (typeof AGENT_EMAIL_USAGE_DIMENSIONS)[number];

export const AgentEmailDnsRecordSchema = Schema.Struct({
  name: Schema.String,
  priority: Schema.optional(Schema.Number),
  type: Schema.Literals(["CNAME", "MX", "TXT"]),
  value: Schema.String,
});
export type AgentEmailDnsRecord = typeof AgentEmailDnsRecordSchema.Type;

export interface AgentEmailDomainRecord {
  readonly createdAt: string;
  readonly dnsRecords: readonly AgentEmailDnsRecord[];
  readonly domain: string;
  readonly failureReason?: string;
  readonly id: string;
  readonly lastCheckedAt?: string;
  readonly mailFromDomain: string;
  readonly organizationId: string;
  readonly placementId?: string;
  readonly providerManaged: boolean;
  readonly providerIdentity?: string;
  readonly providerMetadata: Readonly<Record<string, unknown>>;
  readonly status: AgentEmailDomainStatus;
  readonly updatedAt: string;
  readonly verifiedAt?: string;
}

export interface AgentEmailInboxRecord {
  readonly address: string;
  readonly clientId?: string;
  readonly createdAt: string;
  readonly domainId: string;
  readonly id: string;
  readonly localPart: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly name?: string;
  readonly organizationId: string;
  readonly status: AgentEmailInboxStatus;
  readonly updatedAt: string;
}

export interface AgentEmailInboxBindingRecord {
  readonly agentDeploymentId?: string;
  readonly bindingType: AgentEmailBindingType;
  readonly createdAt: string;
  readonly externalId: string;
  readonly id: string;
  readonly inboxId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly organizationId: string;
  readonly status: AgentEmailInboxBindingStatus;
  readonly updatedAt: string;
}

export interface AgentEmailAttachmentRecord {
  readonly byteSize: number;
  readonly contentId?: string;
  readonly contentType: string;
  readonly disposition: AgentEmailAttachmentDisposition;
  readonly fileName: string;
  readonly id: string;
  readonly messageId: string;
  readonly sha256: string;
}

export interface AgentEmailMessageRecord {
  readonly acceptedAt?: string;
  readonly attachments: readonly AgentEmailAttachmentRecord[];
  readonly bccAddresses: readonly string[];
  readonly ccAddresses: readonly string[];
  readonly clientId?: string;
  readonly createdAt: string;
  readonly deliveredAt?: string;
  readonly direction: AgentEmailDirection;
  readonly draftId?: string;
  readonly failureCode?: string;
  readonly failureReason?: string;
  readonly fromAddress: string;
  readonly htmlBody?: string;
  readonly id: string;
  readonly inReplyTo?: string;
  readonly inboxId: string;
  readonly internetMessageId?: string;
  readonly organizationId: string;
  readonly providerMessageId?: string;
  readonly receivedAt?: string;
  readonly rawPurgedAt?: string;
  readonly rawRetentionExpiresAt?: string;
  readonly reprocessCount: number;
  readonly lastReprocessedAt?: string;
  readonly references: readonly string[];
  readonly replyToAddresses: readonly string[];
  readonly scheduledAt?: string;
  readonly status: AgentEmailMessageStatus;
  readonly subject: string;
  readonly textBody?: string;
  readonly threadKey: string;
  readonly threadId?: string;
  readonly toAddresses: readonly string[];
  readonly updatedAt: string;
}

export interface AgentEmailThreadRecord {
  readonly createdAt: string;
  readonly id: string;
  readonly inboxId: string;
  readonly lastMessageAt: string;
  readonly messageCount: number;
  readonly organizationId: string;
  readonly participants: readonly string[];
  readonly subject: string;
  readonly updatedAt: string;
}

export interface AgentEmailDraftRecord {
  readonly approvedAt?: string;
  readonly bccAddresses: readonly string[];
  readonly ccAddresses: readonly string[];
  readonly clientId?: string;
  readonly createdAt: string;
  readonly failureReason?: string;
  readonly htmlBody?: string;
  readonly id: string;
  readonly inboxId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly organizationId: string;
  readonly rejectedAt?: string;
  readonly replyToMessageId?: string;
  readonly scheduledAt?: string;
  readonly sentMessageId?: string;
  readonly status: AgentEmailDraftStatus;
  readonly subject: string;
  readonly textBody?: string;
  readonly toAddresses: readonly string[];
  readonly updatedAt: string;
}

export interface AgentEmailUsageEventRecord {
  readonly clientId?: string;
  readonly createdAt: string;
  readonly id: string;
  readonly inboxId?: string;
  readonly kind: AgentEmailUsageKind;
  readonly messageId?: string;
  readonly organizationId: string;
  readonly quantity: number;
}

export interface AgentEmailUsageExportRecord {
  readonly bucketStart: string;
  readonly clientId?: string;
  readonly inboxId?: string;
  readonly kind: AgentEmailUsageKind;
  readonly organizationId: string;
  readonly quantity: number;
}

export interface AgentEmailPlacementRecord {
  readonly createdAt: string;
  readonly dedicatedPool: boolean;
  readonly estimatedMonthlyCostCents?: number;
  readonly id: string;
  readonly isDefault: boolean;
  readonly lastReconciledAt?: string;
  readonly name: string;
  readonly organizationId: string;
  readonly provider: string;
  readonly providerMetadata: Readonly<Record<string, unknown>>;
  readonly reconciliationError?: string;
  readonly region: string;
  readonly secondaryRegion?: string;
  readonly status: AgentEmailPlacementStatus;
  readonly updatedAt: string;
}

export interface AgentEmailSuppressionRecord {
  readonly address: string;
  readonly createdAt: string;
  readonly id: string;
  readonly organizationId: string;
  readonly reason: AgentEmailSuppressionReason;
  readonly sourceMessageId?: string;
}

export interface AgentEmailPolicyRecord {
  readonly allowlist?: readonly string[];
  readonly blocklist?: readonly string[];
  readonly bounceRateThresholdBasisPoints: number;
  readonly complaintRateThresholdBasisPoints: number;
  readonly createdAt: string;
  readonly dailyOutboundMessageLimit: number;
  readonly id: string;
  readonly maxAttachmentBytes: number;
  readonly maxRecipientsPerMessage: number;
  readonly organizationId: string;
  readonly rawRetentionDays: number;
  readonly sendingStatusReason?: string;
  readonly sendingStatus: AgentEmailSendingStatus;
  readonly warmupStage: import("./product.ts").AgentEmailWarmupStage;
  readonly warmupStartedAt?: string;
  readonly updatedAt: string;
}

export interface AgentEmailPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}
