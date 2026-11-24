import type { AgentEmailMessageRecord } from "@deployments-ai/agent-email";
import { syncAgentEmailSesSuppression } from "@deployments-ai/agent-email/aws";
import type { makeAgentEmailDynamoRepository } from "@deployments-ai/db";

type AgentEmailDynamoRepository = ReturnType<typeof makeAgentEmailDynamoRepository>;

export interface AgentEmailSesSuppressionTarget {
  readonly region: string;
  readonly tenantName: string;
}

export async function agentEmailSesSuppressionTargets(
  repository: AgentEmailDynamoRepository,
  message: AgentEmailMessageRecord,
  removal?: {
    readonly address: string;
    readonly suppressionId: string;
  },
): Promise<readonly AgentEmailSesSuppressionTarget[]> {
  const [inbox, domains, placements, tenants] = await Promise.all([
    repository.getInbox(message.inboxId),
    repository.listDomains(),
    repository.listPlacements(),
    repository.listProviderTenants(),
  ]);
  if (
    !inbox ||
    inbox.data.organizationId !== message.organizationId ||
    inbox.data.id !== message.inboxId
  ) {
    throw new Error("Provider suppression source message does not resolve to its inbox.");
  }
  const domain = domains.find(
    (candidate) =>
      candidate.data.id === inbox.data.domainId &&
      candidate.data.organizationId === message.organizationId,
  );
  if (!domain) {
    throw new Error("Provider suppression source message does not resolve to its domain.");
  }
  // The hosted identity is shared across organizations and cannot safely use
  // the account-level SES suppression list. Its suppressions remain local.
  if (domain.data.providerManaged) return [];
  if (removal) {
    const retainedBySiblingEnvironment = await repository.hasOtherActiveOrganizationSuppression(
      removal.address,
      removal.suppressionId,
    );
    if (retainedBySiblingEnvironment) return [];
    const targets = tenants
      .filter(
        (tenant) =>
          tenant.data.organizationId === message.organizationId && tenant.data.provider === "ses",
      )
      .map((tenant) => ({
        region: tenant.data.region,
        tenantName: tenant.data.providerName,
      }));
    if (targets.length === 0) {
      throw new Error("Provider suppression source message has no organization SES tenants.");
    }
    return targets;
  }
  const selectedPlacements = inbox.data.placementId
    ? placements.filter((placement) => placement.data.id === inbox.data.placementId)
    : placements.filter((placement) => placement.data.isDefault);
  if (selectedPlacements.length !== 1 || selectedPlacements[0]!.data.provider !== "ses") {
    throw new Error("Provider suppression source message does not resolve to one SES placement.");
  }
  const placement = selectedPlacements[0]!;
  const regions = [
    placement.data.region,
    ...(placement.data.secondaryRegion ? [placement.data.secondaryRegion] : []),
  ];
  return regions.map((region) => {
    const tenant = tenants.find(
      (candidate) =>
        candidate.data.organizationId === message.organizationId &&
        candidate.data.provider === "ses" &&
        candidate.data.region === region,
    );
    if (!tenant) {
      throw new Error(`Provider suppression source message has no SES tenant in ${region}.`);
    }
    return { region, tenantName: tenant.data.providerName };
  });
}

export async function syncAgentEmailMessageSuppression(
  repository: AgentEmailDynamoRepository,
  input: {
    readonly address: string;
    readonly message: AgentEmailMessageRecord;
    readonly reason: "bounce" | "complaint";
    readonly removed: boolean;
    readonly suppressionId?: string;
  },
) {
  if (input.removed && !input.suppressionId) {
    throw new Error("Provider suppression removal requires its suppression id.");
  }
  const targets = await agentEmailSesSuppressionTargets(
    repository,
    input.message,
    input.removed
      ? {
          address: input.address,
          suppressionId: input.suppressionId!,
        }
      : undefined,
  );
  await Promise.all(
    targets.map((target) =>
      syncAgentEmailSesSuppression(
        {
          address: input.address,
          reason: input.reason,
          removed: input.removed,
          tenantName: target.tenantName,
        },
        { region: target.region },
      ),
    ),
  );
}
