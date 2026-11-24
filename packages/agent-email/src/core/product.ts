import { Schema } from "effect";

export const AGENT_EMAIL_PLAN_CODES = ["sandbox", "developer", "pro", "scale"] as const;
export type AgentEmailPlanCode = (typeof AGENT_EMAIL_PLAN_CODES)[number];

export const AGENT_EMAIL_SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "paused",
  "canceled",
  "incomplete",
] as const;
export type AgentEmailSubscriptionStatus = (typeof AGENT_EMAIL_SUBSCRIPTION_STATUSES)[number];

export const AGENT_EMAIL_WARMUP_STAGES = [
  "sandbox",
  "ramp_1",
  "ramp_2",
  "ramp_3",
  "production",
] as const;
export type AgentEmailWarmupStage = (typeof AGENT_EMAIL_WARMUP_STAGES)[number];

export const AGENT_EMAIL_RECIPIENT_VERIFICATION_STATUSES = [
  "pending",
  "verified",
  "expired",
  "revoked",
] as const;
export type AgentEmailRecipientVerificationStatus =
  (typeof AGENT_EMAIL_RECIPIENT_VERIFICATION_STATUSES)[number];

export const AGENT_EMAIL_RECONCILIATION_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
] as const;
export type AgentEmailReconciliationStatus = (typeof AGENT_EMAIL_RECONCILIATION_STATUSES)[number];

export const AGENT_EMAIL_SUPPORT_GRANT_STATUSES = ["active", "expired", "revoked"] as const;
export type AgentEmailSupportGrantStatus = (typeof AGENT_EMAIL_SUPPORT_GRANT_STATUSES)[number];

export const AGENT_EMAIL_PROVIDER_TENANT_STATUSES = [
  "provisioning",
  "enabled",
  "reinstated",
  "disabled",
  "failed",
] as const;
export type AgentEmailProviderTenantStatus = (typeof AGENT_EMAIL_PROVIDER_TENANT_STATUSES)[number];

export const AGENT_EMAIL_PROVIDER_REPUTATION_IMPACTS = ["low", "high", "critical"] as const;
export type AgentEmailProviderReputationImpact =
  (typeof AGENT_EMAIL_PROVIDER_REPUTATION_IMPACTS)[number];

export const AGENT_EMAIL_QUOTA_DIMENSIONS = [
  "api_keys",
  "custom_domains",
  "inbound_messages",
  "inboxes",
  "outbound_messages",
  "webhook_endpoints",
] as const;
export type AgentEmailQuotaDimension = (typeof AGENT_EMAIL_QUOTA_DIMENSIONS)[number];

export interface AgentEmailPlanEntitlements {
  readonly apiKeyLimit: number;
  readonly customDomainLimit: number;
  readonly dedicatedPlacementAllowed: boolean;
  readonly inboxLimit: number;
  readonly maxRecipientsPerMessage: number;
  readonly monthlyInboundMessageLimit: number;
  readonly monthlyOutboundMessageLimit: number;
  readonly rawRetentionDays: number;
  readonly supportAccessAllowed: boolean;
  readonly webhookEndpointLimit: number;
}

export interface AgentEmailPlanDefinition {
  readonly code: AgentEmailPlanCode;
  readonly entitlements: AgentEmailPlanEntitlements;
  readonly name: string;
  readonly trialDays: number;
}

export const AGENT_EMAIL_PLAN_CATALOG = Object.freeze({
  sandbox: {
    code: "sandbox",
    entitlements: {
      apiKeyLimit: 2,
      customDomainLimit: 0,
      dedicatedPlacementAllowed: false,
      inboxLimit: 3,
      maxRecipientsPerMessage: 1,
      monthlyInboundMessageLimit: 1_000,
      monthlyOutboundMessageLimit: 100,
      rawRetentionDays: 7,
      supportAccessAllowed: false,
      webhookEndpointLimit: 1,
    },
    name: "Sandbox",
    trialDays: 14,
  },
  developer: {
    code: "developer",
    entitlements: {
      apiKeyLimit: 10,
      customDomainLimit: 2,
      dedicatedPlacementAllowed: false,
      inboxLimit: 25,
      maxRecipientsPerMessage: 10,
      monthlyInboundMessageLimit: 25_000,
      monthlyOutboundMessageLimit: 10_000,
      rawRetentionDays: 30,
      supportAccessAllowed: false,
      webhookEndpointLimit: 5,
    },
    name: "Developer",
    trialDays: 0,
  },
  pro: {
    code: "pro",
    entitlements: {
      apiKeyLimit: 50,
      customDomainLimit: 20,
      dedicatedPlacementAllowed: false,
      inboxLimit: 250,
      maxRecipientsPerMessage: 47,
      monthlyInboundMessageLimit: 250_000,
      monthlyOutboundMessageLimit: 100_000,
      rawRetentionDays: 90,
      supportAccessAllowed: true,
      webhookEndpointLimit: 25,
    },
    name: "Pro",
    trialDays: 0,
  },
  scale: {
    code: "scale",
    entitlements: {
      apiKeyLimit: 200,
      customDomainLimit: 200,
      dedicatedPlacementAllowed: true,
      inboxLimit: 5_000,
      maxRecipientsPerMessage: 47,
      monthlyInboundMessageLimit: 2_000_000,
      monthlyOutboundMessageLimit: 1_000_000,
      rawRetentionDays: 365,
      supportAccessAllowed: true,
      webhookEndpointLimit: 100,
    },
    name: "Scale",
    trialDays: 0,
  },
} satisfies Record<AgentEmailPlanCode, AgentEmailPlanDefinition>);

export interface AgentEmailSubscriptionRecord {
  readonly cancelAtPeriodEnd: boolean;
  readonly createdAt: string;
  readonly currentPeriodEnd?: string;
  readonly currentPeriodStart?: string;
  readonly id: string;
  readonly organizationId: string;
  readonly planCode: AgentEmailPlanCode;
  readonly provider: "stripe";
  readonly providerCustomerId?: string;
  readonly providerPriceId?: string;
  readonly providerSubscriptionId?: string;
  readonly status: AgentEmailSubscriptionStatus;
  readonly trialEndsAt?: string;
  readonly updatedAt: string;
}

export interface AgentEmailRecipientVerificationRecord {
  readonly address: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly id: string;
  readonly organizationId: string;
  readonly status: AgentEmailRecipientVerificationStatus;
  readonly tokenHash: string;
  readonly updatedAt: string;
  readonly verifiedAt?: string;
}

export interface AgentEmailUsageReconciliationRecord {
  readonly completedAt?: string;
  readonly createdAt: string;
  readonly error?: string;
  readonly id: string;
  readonly organizationId: string;
  readonly periodEnd: string;
  readonly periodStart: string;
  readonly providerEventId?: string;
  readonly status: AgentEmailReconciliationStatus;
  readonly totals: Readonly<Record<string, number>>;
  readonly updatedAt: string;
}

export interface AgentEmailAuditRecord {
  readonly action: string;
  readonly actorId: string;
  readonly actorType: "api_key" | "principal" | "support" | "system";
  readonly createdAt: string;
  readonly id: string;
  readonly ipHash?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly organizationId: string;
  readonly resourceId?: string;
  readonly resourceType?: string;
}

export interface AgentEmailSupportGrantRecord {
  readonly approvedByPrincipalId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly id: string;
  readonly organizationId: string;
  readonly reason: string;
  readonly status: AgentEmailSupportGrantStatus;
  readonly supportPrincipalId: string;
  readonly updatedAt: string;
}

export interface AgentEmailProviderTenantRecord {
  readonly awsManagedStatus?: "disabled" | "enabled" | "reinstated";
  readonly createdAt: string;
  readonly customerManagedStatus?: "disabled" | "enabled" | "reinstated";
  readonly id: string;
  readonly lastReconciledAt?: string;
  readonly organizationId: string;
  readonly provider: "ses";
  readonly providerArn?: string;
  readonly providerId?: string;
  readonly providerMetadata: Readonly<Record<string, unknown>>;
  readonly providerName: string;
  readonly reconciliationError?: string;
  readonly region: string;
  readonly reputationCause?: string;
  readonly reputationImpact?: AgentEmailProviderReputationImpact;
  readonly reputationPolicy?: string;
  readonly sendingStatus: AgentEmailProviderTenantStatus;
  readonly suppressedReasons: readonly ("bounce" | "complaint")[];
  readonly suppressionScope: "account" | "tenant";
  readonly updatedAt: string;
}

export interface AgentEmailEntitlementSnapshot {
  readonly entitlements: AgentEmailPlanEntitlements;
  readonly organizationId: string;
  readonly planCode: AgentEmailPlanCode;
  readonly subscriptionStatus: AgentEmailSubscriptionStatus;
}

export class AgentEmailEntitlementError extends Schema.TaggedErrorClass<AgentEmailEntitlementError>()(
  "AgentEmailEntitlementError",
  {
    dimension: Schema.Literals(AGENT_EMAIL_QUOTA_DIMENSIONS),
    limit: Schema.Number,
    message: Schema.String,
    usage: Schema.Number,
  },
) {}

export function agentEmailPlan(code: AgentEmailPlanCode): AgentEmailPlanDefinition {
  return AGENT_EMAIL_PLAN_CATALOG[code];
}

export function agentEmailSubscriptionCanSend(status: AgentEmailSubscriptionStatus) {
  return status === "active" || status === "trialing";
}

export function agentEmailWarmupDailyLimit(stage: AgentEmailWarmupStage) {
  switch (stage) {
    case "sandbox":
      return 20;
    case "ramp_1":
      return 50;
    case "ramp_2":
      return 250;
    case "ramp_3":
      return 1_000;
    case "production":
      return undefined;
  }
}

export function agentEmailWarmupRequiresVerifiedRecipients(stage: AgentEmailWarmupStage) {
  return stage === "sandbox" || stage === "ramp_1";
}

export function assertAgentEmailQuota(args: {
  readonly dimension: AgentEmailQuotaDimension;
  readonly limit: number;
  readonly requested?: number;
  readonly usage: number;
}) {
  const requested = args.requested ?? 1;
  if (args.usage + requested <= args.limit) return;
  throw new AgentEmailEntitlementError({
    dimension: args.dimension,
    limit: args.limit,
    message: `${args.dimension} quota exceeded.`,
    usage: args.usage,
  });
}

export function agentEmailEffectiveDailyLimit(args: {
  readonly policyLimit: number;
  readonly warmupStage: AgentEmailWarmupStage;
}) {
  const warmupLimit = agentEmailWarmupDailyLimit(args.warmupStage);
  return warmupLimit === undefined ? args.policyLimit : Math.min(args.policyLimit, warmupLimit);
}
