import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import * as ControlFields from "./control-fields.ts";
import {
  InboxAddress,
  Metadata,
  NonNegativeSafeInteger,
  StringList,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
  tenantScopeFields,
  workspaceScopeFields,
} from "../record-schema.ts";

const status = ControlFields.status;

export const InboxPlacementRecord = makeRecordSchema("inbox-placement", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  dedicatedPool: Schema.Boolean,
  estimatedMonthlyCostCents: Schema.optional(Schema.Number),
  id: Ulid,
  isDefault: Schema.Boolean,
  lastReconciledAt: Schema.optional(Timestamp),
  name: Schema.String,
  provider: Schema.Literal("ses"),
  providerMetadata: Metadata,
  reconciliationError: Schema.optional(Schema.String),
  region: Schema.String,
  secondaryRegion: Schema.optional(Schema.String),
  status: ControlFields.InboxPlacementStatus,
});

export const InboxProviderTenantRecord = makeRecordSchema("inbox-provider-tenant", {
  ...mutableResourceFields,
  organizationId: Ulid,
  awsManagedStatus: Schema.optional(Schema.Literals(["disabled", "enabled", "reinstated"])),
  customerManagedStatus: Schema.optional(Schema.Literals(["disabled", "enabled", "reinstated"])),
  id: Ulid,
  lastReconciledAt: Schema.optional(Timestamp),
  provider: Schema.Literal("ses"),
  providerArn: Schema.optional(Schema.String),
  providerId: Schema.optional(Schema.String),
  providerName: Schema.String,
  providerMetadata: Metadata,
  reconciliationError: Schema.optional(Schema.String),
  region: Schema.String,
  reputationCause: Schema.optional(Schema.String),
  reputationImpact: Schema.optional(Schema.Literals(["critical", "high", "low"])),
  reputationPolicy: Schema.optional(Schema.String),
  sendingStatus: Schema.Literals(["disabled", "enabled", "failed", "provisioning", "reinstated"]),
  suppressedReasons: Schema.Array(Schema.Literals(["bounce", "complaint"])),
  suppressionScope: Schema.Literals(["account", "tenant"]),
});

export const InboxDomainRecord = makeRecordSchema("inbox-domain", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  domain: Schema.String,
  dnsRecords: Schema.Array(Metadata),
  failureReason: Schema.optional(Schema.String),
  id: Ulid,
  lastCheckedAt: Schema.optional(Timestamp),
  mailFromDomain: Schema.String,
  placementId: Schema.optional(Ulid),
  providerIdentity: Schema.optional(Schema.String),
  providerManaged: Schema.Boolean,
  providerMetadata: Metadata,
  status: ControlFields.InboxDomainStatus,
  verifiedAt: Schema.optional(Timestamp),
});

export const InboxRecord = makeRecordSchema("inbox", {
  ...mutableResourceFields,
  ...workspaceScopeFields,
  activePlatformBindingCount: Schema.optional(NonNegativeSafeInteger),
  address: InboxAddress,
  clientId: Schema.optional(Schema.String),
  domainId: Ulid,
  id: Ulid,
  localPart: Schema.String,
  metadata: Metadata,
  name: Schema.optional(Schema.String),
  placementId: Schema.optional(Ulid),
  status: Schema.Literals(["active", "archived", "paused"]),
});

export const InboxBindingRecord = makeRecordSchema("inbox-binding", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  agentDefinitionId: Schema.optional(Ulid),
  agentDeploymentId: Schema.optional(Ulid),
  bindingType: Schema.Literals(["external", "platform_agent"]),
  externalId: Schema.String,
  id: Ulid,
  inboxId: Ulid,
  metadata: Metadata,
  status,
});

export const InboxPolicyRecord = makeRecordSchema("inbox-policy", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  allowlist: StringList,
  blocklist: StringList,
  bounceMessageCount: Schema.optional(NonNegativeSafeInteger),
  bounceRateThresholdBasisPoints: ControlFields.AgentEmailBasisPoints,
  complaintMessageCount: Schema.optional(NonNegativeSafeInteger),
  complaintRateThresholdBasisPoints: ControlFields.AgentEmailBasisPoints,
  dailyOutboundMessageLimit: NonNegativeSafeInteger,
  id: Ulid,
  inboxId: Schema.optional(Ulid),
  maxAttachmentBytes: ControlFields.AgentEmailAttachmentByteLimit,
  maxRecipientsPerMessage: ControlFields.AgentEmailRecipientLimit,
  outboundOutcomeMessageCount: Schema.optional(NonNegativeSafeInteger),
  rawRetentionDays: ControlFields.AgentEmailRawRetentionDays,
  requireRecipientVerification: Schema.Boolean,
  sendingStatus: Schema.Literals(["active", "paused", "suspended"]),
  sendingStatusReason: Schema.optional(Schema.String),
  warmupStage: Schema.Literals(["production", "ramp_1", "ramp_2", "ramp_3", "sandbox"]),
  warmupStartedAt: Schema.optional(Timestamp),
});

export const InboxSubscriptionRecord = makeRecordSchema("inbox-subscription", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  cancelAtPeriodEnd: Schema.Boolean,
  currentPeriodEnd: Schema.optional(Timestamp),
  currentPeriodStart: Schema.optional(Timestamp),
  id: Ulid,
  planCode: Schema.Literals(["developer", "pro", "sandbox", "scale"]),
  provider: Schema.Literal("stripe"),
  providerCustomerId: Schema.optional(Schema.String),
  providerPriceId: Schema.optional(Schema.String),
  providerSubscriptionId: Schema.optional(Schema.String),
  status: Schema.Literals(["active", "canceled", "incomplete", "past_due", "paused", "trialing"]),
  trialEndsAt: Schema.optional(Timestamp),
});

export const InboxRecipientVerificationRecord = makeRecordSchema("inbox-recipient-verification", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  address: Schema.String,
  emailHash: Schema.String,
  expiresAt: Schema.optional(Timestamp),
  id: Ulid,
  status: Schema.Literals(["expired", "pending", "revoked", "verified"]),
  tokenHash: Schema.String,
  verifiedAt: Schema.optional(Timestamp),
});

export const InboxSuppressionRecord = makeRecordSchema("inbox-suppression", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  address: Schema.String,
  emailHash: Schema.String,
  id: Ulid,
  reason: Schema.Literals(["bounce", "complaint", "manual", "policy"]),
  removedAt: Schema.optional(Timestamp),
  sourceMessageId: Schema.optional(Ulid),
  status: Schema.Literals(["active", "removed"]),
});

export const InboxControlCreatedIndexRecord = makeRecordSchema("inbox-control-created-index", {
  ...tenantScopeFields,
  createdAt: Timestamp,
  id: Ulid,
  resourceType: Schema.Literals([
    "inbox",
    "inbox-binding",
    "inbox-domain",
    "inbox-placement",
    "inbox-suppression",
  ]),
});
