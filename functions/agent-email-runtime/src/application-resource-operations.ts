import {
  agentEmailAddress,
  normalizeAgentEmailDomain,
  normalizeAgentEmailLocalPart,
  validateAgentEmailDomainDkimRecords,
  type AgentEmailDomainRecord,
  type AgentEmailInboxBindingRecord,
  type AgentEmailInboxRecord,
  type AgentEmailPlacementRecord,
} from "@deployments-ai/agent-email";
import { deterministicAgentEmailUlid } from "@deployments-ai/agent-email/aws";
import {
  CreateAgentEmailBindingRequest,
  CreateAgentEmailDomainRequest,
  CreateAgentEmailInboxRequest,
  CreateAgentEmailPlacementRequest,
  UpdateAgentEmailInboxRequest,
  UpdateAgentEmailPlacementRequest,
} from "@deployments-ai/api-contract/agent-email";
import { AgentEmailBindingLimitError, type Ulid } from "@deployments-ai/db";
import { type AgentEmailApiInvocation } from "./api-handler.ts";

import type { AgentEmailApplicationContext } from "./application-service-context.ts";
import {
  apiError,
  bindingFrom,
  decodePublicRequest,
  domainFrom,
  event,
  inboxFrom,
  placementFrom,
  requiredBody,
  requiredParameter,
  validated,
  type AgentEmailRunnableDeployment,
  type RecordOf,
} from "./application-service-support.ts";

export function createAgentEmailResourceOperations(context: AgentEmailApplicationContext) {
  const { createId, dependencies, now, requireDomain, requireInbox, scoped } = context;
  async function createInbox(invocation: AgentEmailApiInvocation) {
    const input = decodePublicRequest(CreateAgentEmailInboxRequest, requiredBody(invocation));
    const selected = scoped(invocation);
    const domains = (await selected.repository.listDomains()).map(domainFrom);
    const domainId =
      input.domainId ??
      (await dependencies.defaultDomainId?.(invocation.scope, domains)) ??
      (domains.filter((domain) => domain.status === "verified").length === 1
        ? domains.find((domain) => domain.status === "verified")?.id
        : undefined);
    if (!domainId) {
      apiError(
        409,
        "default_domain_unavailable",
        "domainId is required when the environment does not have exactly one verified domain.",
      );
    }
    const domainRecord = await selected.repository.getDomain(domainId);
    if (!domainRecord) apiError(404, "domain_not_found", `Domain ${domainId} was not found.`);
    const domain = domainFrom(domainRecord as RecordOf<"inbox-domain">);
    if (domain.status !== "verified") {
      apiError(409, "domain_not_verified", "The selected domain is not verified.");
    }
    const createdAt = now();
    const id = await createId();
    const localPart = validated(() =>
      normalizeAgentEmailLocalPart(input.localPart ?? id.toLowerCase()),
    );
    const address = agentEmailAddress(localPart, domain.domain);
    if (
      (await selected.repository.listInboxes()).some(
        (candidate) => candidate.data.address === address,
      )
    ) {
      apiError(409, "inbox_address_conflict", "The requested inbox address is already in use.");
    }
    const inbox: AgentEmailInboxRecord = {
      address,
      ...(input.clientId ? { clientId: input.clientId } : {}),
      createdAt,
      domainId,
      id,
      localPart,
      metadata: input.metadata ?? {},
      ...(input.name ? { name: input.name } : {}),
      organizationId: invocation.scope.organizationId,
      status: "active",
      updatedAt: createdAt,
    };
    const saved = await selected.repository.createInbox(
      inbox,
      event("agent-email.inbox-created", inbox, await createId(), invocation.scope, createdAt),
      domain.placementId as Ulid | undefined,
    );
    return inboxFrom(saved);
  }

  async function updateInbox(invocation: AgentEmailApiInvocation) {
    const input = decodePublicRequest(UpdateAgentEmailInboxRequest, requiredBody(invocation));
    const existing = await requireInbox(invocation);
    if (input.status === "active") {
      const { repository } = scoped(invocation);
      const domainRecord = await repository.getDomain(existing.domainId);
      if (
        !domainRecord ||
        domainFrom(domainRecord as RecordOf<"inbox-domain">).status !== "verified"
      ) {
        apiError(409, "domain_not_verified", "The inbox domain is not verified.");
      }
    }
    const updatedAt = now();
    const { name: _existingName, ...existingWithoutName } = existing;
    const updated: AgentEmailInboxRecord = {
      ...existingWithoutName,
      metadata: input.metadata ?? existing.metadata,
      ...(input.name === undefined
        ? existing.name
          ? { name: existing.name }
          : {}
        : input.name.trim()
          ? { name: input.name.trim() }
          : {}),
      status: input.status ?? existing.status,
      updatedAt,
    };
    const saved = await scoped(invocation).repository.updateInbox(
      updated,
      event("agent-email.inbox-updated", updated, await createId(), invocation.scope, updatedAt),
    );
    if (!saved) apiError(404, "inbox_not_found", `Inbox ${existing.id} was not found.`);
    return inboxFrom(saved);
  }

  async function createDomain(invocation: AgentEmailApiInvocation) {
    const input = decodePublicRequest(CreateAgentEmailDomainRequest, requiredBody(invocation));
    const normalized = validated(() => normalizeAgentEmailDomain(input.domain));
    validated(() => validateAgentEmailDomainDkimRecords(normalized));
    if (
      (await scoped(invocation).repository.listDomains()).some(
        (candidate) => candidate.data.domain === normalized,
      )
    ) {
      apiError(409, "domain_conflict", "The email domain already exists in this environment.");
    }
    if (input.placementId) {
      const placement = await scoped(invocation).record("inbox-placement", input.placementId);
      if (!placement) {
        apiError(404, "placement_not_found", `Placement ${input.placementId} was not found.`);
      }
      if (placement.data.status !== "active") {
        apiError(
          409,
          "placement_not_active",
          "Domains can only be assigned to active email placements.",
        );
      }
    }
    const createdAt = now();
    const id = await createId();
    const domain: AgentEmailDomainRecord = {
      createdAt,
      dnsRecords: [
        {
          name: `_agent-email.${normalized}`,
          type: "TXT",
          value: `agent-email-verification=${id.toLowerCase()}`,
        },
      ],
      domain: normalized,
      id,
      mailFromDomain: `bounce.${normalized}`,
      organizationId: invocation.scope.organizationId,
      ...(input.placementId ? { placementId: input.placementId } : {}),
      providerManaged: false,
      providerMetadata: {},
      status: "pending",
      updatedAt: createdAt,
    };
    const saved = await scoped(invocation).repository.createDomain(
      domain,
      event("agent-email.domain-created", domain, await createId(), invocation.scope, createdAt),
    );
    return domainFrom(saved as RecordOf<"inbox-domain">);
  }

  async function mutateDomain(invocation: AgentEmailApiInvocation, action: "refresh" | "revoke") {
    const existing = await requireDomain(invocation);
    const selected = scoped(invocation);
    const provisioner = dependencies.domainProvisioner;
    if (!provisioner) {
      apiError(
        503,
        "domain_provisioner_unavailable",
        "Domain provider operations are not configured.",
      );
    }
    let target = existing;
    if (action === "refresh" && !existing.providerManaged && !existing.placementId) {
      const defaultPlacements = (await selected.records("inbox-placement")).filter(
        (placement) => placement.data.isDefault && placement.data.status === "active",
      );
      if (defaultPlacements.length !== 1) {
        apiError(
          409,
          "placement_required",
          "An active default placement is required before provisioning an unplaced custom domain.",
        );
      }
      target = { ...existing, placementId: defaultPlacements[0]!.data.id };
    }
    const changed =
      action === "refresh"
        ? target.status === "pending"
          ? await provisioner.provision(target)
          : await provisioner.refresh(target)
        : await provisioner.revoke(target);
    const updatedAt = now();
    const updated = { ...changed, updatedAt };
    const saved = await selected.repository.updateDomain(
      updated,
      event("agent-email.domain-updated", updated, await createId(), invocation.scope, updatedAt),
    );
    if (!saved) apiError(404, "domain_not_found", `Domain ${existing.id} was not found.`);
    return domainFrom(saved as RecordOf<"inbox-domain">);
  }

  async function createBinding(invocation: AgentEmailApiInvocation) {
    const input = decodePublicRequest(CreateAgentEmailBindingRequest, requiredBody(invocation));
    const inbox = await requireInbox(invocation);
    let platformDeployment: AgentEmailRunnableDeployment | undefined;
    if (input.bindingType === "platform_agent") {
      if (!dependencies.validateAgentDeployment) {
        apiError(
          503,
          "agent_deployment_validator_unavailable",
          "Agent deployment validation is not configured.",
        );
      }
      platformDeployment = await dependencies.validateAgentDeployment(
        invocation.scope,
        input.agentDeploymentId,
      );
      if (!platformDeployment) {
        apiError(
          404,
          "agent_deployment_not_found",
          `Agent deployment ${input.agentDeploymentId} was not found or is not runnable.`,
        );
      }
      if (
        input.externalId !== undefined &&
        input.externalId.trim() !== platformDeployment.agentDefinitionId
      ) {
        apiError(
          400,
          "agent_definition_mismatch",
          "Platform agent binding externalId must match the deployment's agent definition.",
        );
      }
    }
    const timestamp = now();
    const externalId =
      input.bindingType === "platform_agent"
        ? platformDeployment!.agentDefinitionId
        : input.externalId.trim();
    const binding: AgentEmailInboxBindingRecord = {
      ...(input.agentDeploymentId ? { agentDeploymentId: input.agentDeploymentId } : {}),
      bindingType: input.bindingType,
      createdAt: timestamp,
      externalId,
      id: await createId(),
      inboxId: inbox.id,
      metadata: input.metadata ?? {},
      organizationId: invocation.scope.organizationId,
      status: "active",
      updatedAt: timestamp,
    };
    const selected = scoped(invocation);
    if (
      (await selected.repository.listInboxBindings()).some(
        (candidate) =>
          candidate.data.status === "active" &&
          candidate.data.bindingType === binding.bindingType &&
          candidate.data.externalId === binding.externalId,
      )
    ) {
      apiError(409, "binding_conflict", "The target already has an active inbox binding.");
    }
    try {
      return bindingFrom(await selected.repository.createBinding(binding));
    } catch (cause) {
      if (cause instanceof AgentEmailBindingLimitError) {
        apiError(
          409,
          "binding_limit_exceeded",
          `An inbox can have at most ${cause.limit} active platform-agent bindings.`,
        );
      }
      throw cause;
    }
  }

  async function deleteBinding(invocation: AgentEmailApiInvocation) {
    const bindingId = requiredParameter(invocation, "bindingId");
    const selected = scoped(invocation);
    const previous = await selected.record("inbox-binding", bindingId);
    if (!previous) apiError(404, "binding_not_found", `Binding ${bindingId} was not found.`);
    if (previous.data.status === "archived") return bindingFrom(previous);
    const archived = await selected.repository.archiveBinding(bindingId, now());
    if (!archived) apiError(404, "binding_not_found", `Binding ${bindingId} was not found.`);
    return bindingFrom(archived);
  }

  async function createPlacement(invocation: AgentEmailApiInvocation) {
    const input = decodePublicRequest(CreateAgentEmailPlacementRequest, requiredBody(invocation));
    if (!dependencies.placementProvisioner) {
      apiError(
        503,
        "placement_provisioner_unavailable",
        "Email placement provisioning is not configured.",
      );
    }
    if (
      input.isDefault &&
      dependencies.hostedDomainRegion &&
      (input.region !== dependencies.hostedDomainRegion || input.secondaryRegion)
    ) {
      apiError(
        400,
        "hosted_domain_region_unsupported",
        `Default placements must use hosted-domain region ${dependencies.hostedDomainRegion} without a secondary region.`,
      );
    }
    if (
      input.isDefault &&
      (await scoped(invocation).records("inbox-placement")).some(
        (candidate) => candidate.data.isDefault,
      )
    ) {
      apiError(
        409,
        "default_placement_conflict",
        "The environment already has a default email placement.",
      );
    }
    const timestamp = now();
    const placementId = invocation.idempotencyKey
      ? deterministicAgentEmailUlid(
          "1970-01-01T00:00:00.000Z",
          "placement-request-v1",
          invocation.scope.organizationId,
          invocation.scope.projectId,
          invocation.scope.environmentId,
          invocation.identity.principalId,
          invocation.idempotencyKey,
        )
      : await createId();
    const selected = scoped(invocation);
    const previousReservationRecord = await selected.context.getEnvironmentRecord(
      "inbox-placement",
      placementId,
    );
    const previousReservation =
      previousReservationRecord?.itemType === "inbox-placement"
        ? previousReservationRecord
        : undefined;
    if (previousReservation?.data.status === "active") {
      return placementFrom(previousReservation);
    }
    const placement = dependencies.placementProvisioner.prepareReservation({
      createdAt: timestamp,
      dedicatedPool: input.dedicatedPool ?? false,
      id: placementId,
      isDefault: input.isDefault ?? false,
      name: input.name,
      organizationId: invocation.scope.organizationId,
      provider: "ses",
      providerMetadata: previousReservation?.data.providerMetadata ?? {},
      region: input.region,
      ...(input.secondaryRegion ? { secondaryRegion: input.secondaryRegion } : {}),
      status: "provisioning",
      updatedAt: timestamp,
    });
    const reserved = previousReservation
      ? await selected.repository.updatePlacement({
          ...placement,
          createdAt: previousReservation.data.createdAt,
        })
      : await selected.repository.createPlacement(placement);
    if (!reserved) {
      apiError(
        500,
        "placement_reservation_lost",
        `Placement ${placement.id} could not be reserved.`,
      );
    }
    let provisioned: AgentEmailPlacementRecord;
    try {
      provisioned = await dependencies.placementProvisioner.provision(placementFrom(reserved));
    } catch (cause) {
      let cleanupError: unknown;
      try {
        await dependencies.placementProvisioner.deprovision(placementFrom(reserved));
      } catch (cleanupCause) {
        cleanupError = cleanupCause;
      }
      await selected.repository.updatePlacement({
        ...placementFrom(reserved),
        isDefault: false,
        reconciliationError: cleanupError
          ? "Email placement provisioning and cleanup failed."
          : "Email placement provisioning failed.",
        status: "failed",
        updatedAt: now(),
      });
      throw cause;
    }
    const saved = await selected.repository.updatePlacement(provisioned);
    if (!saved) {
      apiError(
        500,
        "placement_reservation_lost",
        `Placement ${placement.id} was provisioned but its durable reservation was lost.`,
      );
    }
    return placementFrom(saved);
  }

  async function updatePlacement(invocation: AgentEmailApiInvocation) {
    const placementId = requiredParameter(invocation, "placementId");
    const input = decodePublicRequest(UpdateAgentEmailPlacementRequest, requiredBody(invocation));
    const selected = scoped(invocation);
    const previous = await selected.record("inbox-placement", placementId);
    if (!previous) apiError(404, "placement_not_found", `Placement ${placementId} was not found.`);
    const existing = placementFrom(previous);
    const targetStatus = input.status ?? existing.status;
    const deprovisioning = targetStatus === "disabled" || targetStatus === "deprovisioning";
    const candidate: AgentEmailPlacementRecord = {
      ...existing,
      dedicatedPool: input.dedicatedPool ?? existing.dedicatedPool,
      isDefault: deprovisioning ? false : (input.isDefault ?? existing.isDefault),
      name: input.name ?? existing.name,
      status: deprovisioning ? "deprovisioning" : "reconciling",
      updatedAt: now(),
    };
    if (
      candidate.isDefault &&
      dependencies.hostedDomainRegion &&
      (candidate.region !== dependencies.hostedDomainRegion || candidate.secondaryRegion)
    ) {
      apiError(
        400,
        "hosted_domain_region_unsupported",
        `Default placements must use hosted-domain region ${dependencies.hostedDomainRegion} without a secondary region.`,
      );
    }
    if (
      candidate.isDefault &&
      !existing.isDefault &&
      (await selected.records("inbox-placement")).some(
        (placement) => placement.data.id !== placementId && placement.data.isDefault,
      )
    ) {
      apiError(
        409,
        "default_placement_conflict",
        "The environment already has a default email placement.",
      );
    }
    if (!dependencies.placementProvisioner) {
      apiError(
        503,
        "placement_provisioner_unavailable",
        "Email placement reconciliation is not configured.",
      );
    }
    const preparedCandidate = dependencies.placementProvisioner.prepareReservation(candidate);
    const reserved = await selected.repository.updatePlacement(preparedCandidate);
    if (!reserved) apiError(404, "placement_not_found", `Placement ${placementId} was not found.`);
    const updated = deprovisioning
      ? await dependencies.placementProvisioner.deprovision(placementFrom(reserved))
      : await dependencies.placementProvisioner.reconcile(placementFrom(reserved));
    const saved = await selected.repository.updatePlacement(updated);
    if (!saved) apiError(404, "placement_not_found", `Placement ${placementId} was not found.`);
    return placementFrom(saved);
  }

  return {
    createBinding,
    createDomain,
    createInbox,
    createPlacement,
    deleteBinding,
    mutateDomain,
    updateInbox,
    updatePlacement,
  };
}
