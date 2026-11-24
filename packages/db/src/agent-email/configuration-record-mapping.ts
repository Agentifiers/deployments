import {
  agentEmailWarmupRequiresVerifiedRecipients,
  type AgentEmailDomainRecord,
  type AgentEmailInboxBindingRecord,
  type AgentEmailInboxRecord,
  type AgentEmailPlacementRecord,
  type AgentEmailPolicyRecord,
  type AgentEmailProviderTenantRecord,
  type AgentEmailSuppressionRecord,
} from "@deployments-ai/agent-email";
import {
  base,
  metadata,
  record,
  type AgentEmailControlResourceType,
  type AgentEmailPlatformScope,
  type AgentEmailPolicyReputationState,
  type RecordOf,
} from "./record-mapping-support.ts";
import type { Ulid } from "../ids.ts";

export function inboxDomainRecord(
  scope: AgentEmailPlatformScope,
  domain: AgentEmailDomainRecord,
): RecordOf<"inbox-domain"> {
  return record({
    data: {
      ...base(scope),
      createdAt: domain.createdAt,
      dnsRecords: domain.dnsRecords.map((entry) =>
        metadata({
          name: entry.name,
          ...(entry.priority === undefined ? {} : { priority: entry.priority }),
          type: entry.type,
          value: entry.value,
        }),
      ),
      domain: domain.domain,
      ...(domain.failureReason ? { failureReason: domain.failureReason } : {}),
      id: domain.id as Ulid,
      ...(domain.lastCheckedAt ? { lastCheckedAt: domain.lastCheckedAt } : {}),
      mailFromDomain: domain.mailFromDomain,
      ...(domain.placementId ? { placementId: domain.placementId as Ulid } : {}),
      ...(domain.providerIdentity ? { providerIdentity: domain.providerIdentity } : {}),
      providerManaged: domain.providerManaged,
      providerMetadata: metadata(domain.providerMetadata),
      status: domain.status,
      updatedAt: domain.updatedAt,
      ...(domain.verifiedAt ? { verifiedAt: domain.verifiedAt } : {}),
      version: 0,
    },
    itemType: "inbox-domain",
  });
}

export function inboxRecord(
  scope: AgentEmailPlatformScope,
  inbox: AgentEmailInboxRecord,
  placementId?: Ulid,
  activePlatformBindingCount = 0,
): RecordOf<"inbox"> {
  return record({
    data: {
      ...base(scope),
      ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
      activePlatformBindingCount,
      address: inbox.address,
      ...(inbox.clientId ? { clientId: inbox.clientId } : {}),
      createdAt: inbox.createdAt,
      domainId: inbox.domainId as Ulid,
      id: inbox.id as Ulid,
      localPart: inbox.localPart,
      metadata: metadata(inbox.metadata),
      ...(inbox.name ? { name: inbox.name } : {}),
      ...(placementId ? { placementId } : {}),
      status: inbox.status,
      updatedAt: inbox.updatedAt,
      version: 0,
    },
    itemType: "inbox",
  });
}

export function inboxControlCreatedIndexRecord(
  scope: AgentEmailPlatformScope,
  resourceType: AgentEmailControlResourceType,
  resource: Pick<RecordOf<AgentEmailControlResourceType>, "data">,
): RecordOf<"inbox-control-created-index"> {
  return record({
    data: {
      ...base(scope),
      createdAt: resource.data.createdAt,
      id: resource.data.id,
      resourceType,
    },
    itemType: "inbox-control-created-index",
  });
}

export function inboxBindingRecord(
  scope: AgentEmailPlatformScope,
  binding: AgentEmailInboxBindingRecord,
): RecordOf<"inbox-binding"> {
  return record({
    data: {
      ...base(scope),
      ...(binding.bindingType === "platform_agent"
        ? { agentDefinitionId: binding.externalId as Ulid }
        : {}),
      ...(binding.agentDeploymentId
        ? { agentDeploymentId: binding.agentDeploymentId as Ulid }
        : {}),
      bindingType: binding.bindingType,
      createdAt: binding.createdAt,
      externalId: binding.externalId,
      id: binding.id as Ulid,
      inboxId: binding.inboxId as Ulid,
      metadata: metadata(binding.metadata),
      status: binding.status,
      updatedAt: binding.updatedAt,
      version: 0,
    },
    itemType: "inbox-binding",
  });
}

export function inboxPlacementRecord(
  scope: AgentEmailPlatformScope,
  placement: AgentEmailPlacementRecord,
): RecordOf<"inbox-placement"> {
  return record({
    data: {
      ...base(scope),
      createdAt: placement.createdAt,
      dedicatedPool: placement.dedicatedPool,
      ...(placement.estimatedMonthlyCostCents === undefined
        ? {}
        : { estimatedMonthlyCostCents: placement.estimatedMonthlyCostCents }),
      id: placement.id as Ulid,
      isDefault: placement.isDefault,
      ...(placement.lastReconciledAt ? { lastReconciledAt: placement.lastReconciledAt } : {}),
      name: placement.name,
      provider: "ses",
      providerMetadata: metadata(placement.providerMetadata),
      ...(placement.reconciliationError
        ? { reconciliationError: placement.reconciliationError }
        : {}),
      region: placement.region,
      ...(placement.secondaryRegion ? { secondaryRegion: placement.secondaryRegion } : {}),
      status: placement.status,
      updatedAt: placement.updatedAt,
      version: 0,
    },
    itemType: "inbox-placement",
  });
}

export function inboxProviderTenantRecord(
  scope: AgentEmailPlatformScope,
  tenant: AgentEmailProviderTenantRecord,
): RecordOf<"inbox-provider-tenant"> {
  return record({
    data: {
      organizationId: scope.organizationId,
      ...(tenant.awsManagedStatus ? { awsManagedStatus: tenant.awsManagedStatus } : {}),
      createdAt: tenant.createdAt,
      ...(tenant.customerManagedStatus
        ? { customerManagedStatus: tenant.customerManagedStatus }
        : {}),
      id: tenant.id as Ulid,
      ...(tenant.lastReconciledAt ? { lastReconciledAt: tenant.lastReconciledAt } : {}),
      provider: "ses",
      ...(tenant.providerArn ? { providerArn: tenant.providerArn } : {}),
      ...(tenant.providerId ? { providerId: tenant.providerId } : {}),
      providerMetadata: metadata(tenant.providerMetadata),
      providerName: tenant.providerName,
      ...(tenant.reconciliationError ? { reconciliationError: tenant.reconciliationError } : {}),
      region: tenant.region,
      ...(tenant.reputationCause ? { reputationCause: tenant.reputationCause } : {}),
      ...(tenant.reputationImpact ? { reputationImpact: tenant.reputationImpact } : {}),
      ...(tenant.reputationPolicy ? { reputationPolicy: tenant.reputationPolicy } : {}),
      sendingStatus: tenant.sendingStatus,
      suppressedReasons: [...tenant.suppressedReasons],
      suppressionScope: tenant.suppressionScope,
      updatedAt: tenant.updatedAt,
      version: 0,
    },
    itemType: "inbox-provider-tenant",
  });
}

export function inboxPolicyRecord(
  scope: AgentEmailPlatformScope,
  policy: AgentEmailPolicyRecord,
  inboxId?: Ulid,
  reputation: AgentEmailPolicyReputationState = {},
): RecordOf<"inbox-policy"> {
  return record({
    data: {
      ...base(scope),
      allowlist: [...(policy.allowlist ?? [])],
      blocklist: [...(policy.blocklist ?? [])],
      ...(reputation.bounceMessageCount !== undefined
        ? { bounceMessageCount: reputation.bounceMessageCount }
        : {}),
      bounceRateThresholdBasisPoints: policy.bounceRateThresholdBasisPoints,
      ...(reputation.complaintMessageCount !== undefined
        ? { complaintMessageCount: reputation.complaintMessageCount }
        : {}),
      complaintRateThresholdBasisPoints: policy.complaintRateThresholdBasisPoints,
      createdAt: policy.createdAt,
      dailyOutboundMessageLimit: policy.dailyOutboundMessageLimit,
      id: policy.id as Ulid,
      ...(inboxId ? { inboxId } : {}),
      maxAttachmentBytes: policy.maxAttachmentBytes,
      maxRecipientsPerMessage: policy.maxRecipientsPerMessage,
      ...(reputation.outboundOutcomeMessageCount !== undefined
        ? {
            outboundOutcomeMessageCount: reputation.outboundOutcomeMessageCount,
          }
        : {}),
      rawRetentionDays: policy.rawRetentionDays,
      requireRecipientVerification: agentEmailWarmupRequiresVerifiedRecipients(policy.warmupStage),
      sendingStatus: policy.sendingStatus,
      ...(policy.sendingStatusReason ? { sendingStatusReason: policy.sendingStatusReason } : {}),
      updatedAt: policy.updatedAt,
      version: 0,
      warmupStage: policy.warmupStage,
      ...(policy.warmupStartedAt ? { warmupStartedAt: policy.warmupStartedAt } : {}),
    },
    itemType: "inbox-policy",
  });
}

export function inboxSuppressionRecord(
  scope: AgentEmailPlatformScope,
  suppression: AgentEmailSuppressionRecord,
  emailHash: string,
): RecordOf<"inbox-suppression"> {
  return record({
    data: {
      ...base(scope),
      address: suppression.address,
      createdAt: suppression.createdAt,
      emailHash,
      id: suppression.id as Ulid,
      reason: suppression.reason,
      ...(suppression.sourceMessageId
        ? { sourceMessageId: suppression.sourceMessageId as Ulid }
        : {}),
      status: "active",
      updatedAt: suppression.createdAt,
      version: 0,
    },
    itemType: "inbox-suppression",
  });
}
