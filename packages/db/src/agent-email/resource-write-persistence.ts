import type {
  AgentEmailDomainEvent,
  AgentEmailDomainRecord,
  AgentEmailInboxBindingRecord,
  AgentEmailInboxRecord,
  AgentEmailPlacementRecord,
  AgentEmailProviderTenantRecord,
  AgentEmailSuppressionRecord,
} from "@deployments-ai/agent-email";
import { createHash } from "node:crypto";
import type {
  AgentEmailInboxPlacementUpdate,
  AgentEmailRepositoryContext,
} from "./persistence-context.ts";
import {
  AgentEmailBindingLimitError,
  inboxBindingRecord,
  inboxControlCreatedIndexRecord,
  inboxDomainRecord,
  inboxPlacementRecord,
  inboxProviderTenantRecord,
  inboxRecord,
  inboxSuppressionRecord,
  MAX_ACTIVE_AGENT_EMAIL_PLATFORM_BINDINGS_PER_INBOX,
} from "./record-mapping.ts";
import type { Ulid } from "../ids.ts";
import { Keys } from "../keys.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import { makeUniqueClaimRecord, uniqueClaimRequirements } from "../unique-claims.ts";

function defaultPlacementClaimNamespace(
  placement: Extract<PlatformRecord, { readonly itemType: "inbox-placement" }>,
) {
  return `organization:${placement.data.organizationId}:project:${placement.data.projectId}:environment:${placement.data.environmentId}:default-inbox-placement`;
}

function organizationSuppressionClaim(
  suppression: Extract<PlatformRecord, { readonly itemType: "inbox-suppression" }>,
) {
  return makeUniqueClaimRecord(
    {
      namespace: `organization:${suppression.data.organizationId}:inbox-suppression-address:${suppression.data.emailHash}`,
      ownerId: suppression.data.id,
      ownerItemType: suppression.itemType,
      ownerPk: suppression.pk,
      ownerSk: suppression.sk,
      ownerTable: "control",
      value: `${suppression.data.environmentId}:${suppression.data.id}`,
    },
    suppression.data.createdAt,
  ) as Extract<PlatformRecord, { readonly itemType: "unique-claim" }>;
}

export function makeAgentEmailResourceWriteRepository(context: AgentEmailRepositoryContext) {
  const {
    createWithEvent,
    database,
    failure,
    getDomain,
    getEnvironmentRecord,
    getInbox,
    getOrganizationRecord,
    run,
    scope,
    updateVersion,
    updateWithEvent,
  } = context;

  return {
    getDomain,
    getInbox,
    async archiveBinding(id: string, archivedAt = new Date().toISOString()) {
      const existing = await getEnvironmentRecord("inbox-binding", id, "control", true);
      if (!existing) return undefined;
      const previous = existing as Extract<PlatformRecord, { readonly itemType: "inbox-binding" }>;
      if (previous.data.status === "archived") return previous;
      const [claimRequirement] = uniqueClaimRequirements(previous);
      if (previous.data.status === "active" && !claimRequirement) {
        throw failure("archive-binding", new Error("Active binding claim is missing."));
      }
      const claim = claimRequirement
        ? (makeUniqueClaimRecord(claimRequirement, previous.data.createdAt) as Extract<
            PlatformRecord,
            { readonly itemType: "unique-claim" }
          >)
        : undefined;
      const next = withCanonicalRecordKeys({
        data: {
          ...previous.data,
          status: "archived" as const,
          updatedAt: archivedAt,
          version: previous.data.version + 1,
        },
        itemType: "inbox-binding" as const,
      }) as Extract<PlatformRecord, { readonly itemType: "inbox-binding" }>;
      const decrementsInbox =
        previous.data.status === "active" && previous.data.bindingType === "platform_agent";
      const inbox = decrementsInbox ? await getInbox(previous.data.inboxId, true) : undefined;
      const bindingCount = inbox?.data.activePlatformBindingCount ?? 0;
      if (decrementsInbox && (!inbox || bindingCount === undefined || bindingCount < 1)) {
        throw failure(
          "archive-binding",
          new Error("Active platform-agent binding count is inconsistent."),
        );
      }
      const updatedInbox = inbox
        ? withCanonicalRecordKeys({
            data: {
              ...inbox.data,
              activePlatformBindingCount: bindingCount! - 1,
              version: inbox.data.version + 1,
            },
            itemType: "inbox" as const,
          })
        : undefined;
      await run(
        "archive-binding",
        database.transactWrite([
          { kind: "put", previousRecord: previous, record: next },
          ...(inbox && updatedInbox
            ? [{ kind: "put" as const, previousRecord: inbox, record: updatedInbox }]
            : []),
          ...(claim ? [{ kind: "delete" as const, record: claim }] : []),
        ]),
      );
      return next;
    },

    async createBinding(binding: AgentEmailInboxBindingRecord) {
      const created = inboxBindingRecord(scope, binding);
      const createdIndex = inboxControlCreatedIndexRecord(scope, "inbox-binding", created);
      const [claimRequirement] = uniqueClaimRequirements(created);
      if (!claimRequirement) {
        throw failure("create-binding", new Error("Inbox binding uniqueness is not registered."));
      }
      const claim = makeUniqueClaimRecord(claimRequirement, created.data.createdAt) as Extract<
        PlatformRecord,
        { readonly itemType: "unique-claim" }
      >;
      const incrementsInbox =
        created.data.status === "active" && created.data.bindingType === "platform_agent";
      const inbox = incrementsInbox ? await getInbox(created.data.inboxId, true) : undefined;
      if (
        incrementsInbox &&
        (!inbox ||
          inbox.data.organizationId !== scope.organizationId ||
          inbox.data.projectId !== scope.projectId ||
          inbox.data.environmentId !== scope.environmentId)
      ) {
        throw failure(
          "create-binding",
          new Error("Inbox binding owner is missing or out of scope."),
        );
      }
      const bindingCount = inbox?.data.activePlatformBindingCount ?? 0;
      if (
        bindingCount !== undefined &&
        bindingCount >= MAX_ACTIVE_AGENT_EMAIL_PLATFORM_BINDINGS_PER_INBOX
      ) {
        throw new AgentEmailBindingLimitError(created.data.inboxId);
      }
      const updatedInbox = inbox
        ? withCanonicalRecordKeys({
            data: {
              ...inbox.data,
              activePlatformBindingCount: bindingCount! + 1,
              version: inbox.data.version + 1,
            },
            itemType: "inbox" as const,
          })
        : undefined;
      await run(
        "create-binding",
        database.transactWrite(
          [
            { kind: "put", record: created },
            ...(inbox && updatedInbox
              ? [{ kind: "put" as const, previousRecord: inbox, record: updatedInbox }]
              : []),
            {
              conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              kind: "put",
              record: createdIndex,
            },
            {
              conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              kind: "put",
              record: claim,
            },
          ],
          binding.id,
        ),
      );
      return created;
    },

    async createDomain(domain: AgentEmailDomainRecord, event: AgentEmailDomainEvent) {
      const created = inboxDomainRecord(scope, domain);
      const createdIndex = inboxControlCreatedIndexRecord(scope, "inbox-domain", created);
      const [registrationRequirement] = uniqueClaimRequirements(created);
      if (!created.data.providerManaged && !registrationRequirement) {
        throw failure("create-domain", new Error("Inbox domain registration is not reserved."));
      }
      const registrationClaim = registrationRequirement
        ? (makeUniqueClaimRecord(registrationRequirement, created.data.createdAt) as Extract<
            PlatformRecord,
            { readonly itemType: "unique-claim" }
          >)
        : undefined;
      return createWithEvent(created, event, [
        {
          conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          kind: "put",
          record: createdIndex,
        },
        ...(registrationClaim
          ? [
              {
                conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                kind: "put" as const,
                record: registrationClaim,
              },
            ]
          : []),
      ]);
    },

    async createInbox(
      inbox: AgentEmailInboxRecord,
      event: AgentEmailDomainEvent,
      placementId?: Ulid,
    ) {
      const created = inboxRecord(scope, inbox, placementId);
      const createdIndex = inboxControlCreatedIndexRecord(scope, "inbox", created);
      const claimRequirement = {
        namespace: "inbox-address",
        ownerId: created.data.id as Ulid,
        ownerItemType: created.itemType,
        ownerPk: created.pk,
        ownerSk: created.sk,
        ownerTable: "control" as const,
        value: created.data.address,
      };
      const claim = makeUniqueClaimRecord(claimRequirement, created.data.createdAt) as Extract<
        PlatformRecord,
        { readonly itemType: "unique-claim" }
      >;
      return createWithEvent(created, event, [
        {
          conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          kind: "put",
          record: createdIndex,
        },
        {
          conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          kind: "put",
          record: claim,
        },
      ]);
    },

    async createPlacement(placement: AgentEmailPlacementRecord) {
      const created = inboxPlacementRecord(scope, placement);
      const createdIndex = inboxControlCreatedIndexRecord(scope, "inbox-placement", created);
      if (!created.data.isDefault) {
        await run(
          "create-placement",
          database.transactWrite([
            { kind: "put", record: created },
            {
              conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              kind: "put",
              record: createdIndex,
            },
          ]),
        );
        return created;
      }
      const claim = makeUniqueClaimRecord(
        {
          namespace: defaultPlacementClaimNamespace(created),
          ownerId: created.data.id as Ulid,
          ownerItemType: created.itemType,
          ownerPk: created.pk,
          ownerSk: created.sk,
          ownerTable: "control",
          value: "default",
        },
        created.data.createdAt,
      ) as Extract<PlatformRecord, { readonly itemType: "unique-claim" }>;
      await run(
        "create-placement",
        database.transactWrite([
          { kind: "put", record: created },
          {
            conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
            kind: "put",
            record: createdIndex,
          },
          {
            conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
            kind: "put",
            record: claim,
          },
        ]),
      );
      return created;
    },

    async createProviderTenant(tenant: AgentEmailProviderTenantRecord) {
      const created = inboxProviderTenantRecord(scope, tenant);
      const claimRequirement = {
        namespace: `organization:${created.data.organizationId}:inbox-provider-tenant`,
        ownerId: created.data.id as Ulid,
        ownerItemType: created.itemType,
        ownerPk: created.pk,
        ownerSk: created.sk,
        ownerTable: "control" as const,
        value: `${created.data.provider}:${created.data.region}`,
      };
      const claim = makeUniqueClaimRecord(claimRequirement, created.data.createdAt) as Extract<
        PlatformRecord,
        { readonly itemType: "unique-claim" }
      >;
      await run(
        "create-provider-tenant",
        database.transactWrite([
          { kind: "put", record: created },
          {
            conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
            kind: "put",
            record: claim,
          },
        ]),
      );
      return created;
    },

    async createSuppression(suppression: AgentEmailSuppressionRecord) {
      const hash = createHash("sha256")
        .update(suppression.address.trim().toLowerCase())
        .digest("hex");
      const created = inboxSuppressionRecord(scope, suppression, hash);
      const createdIndex = inboxControlCreatedIndexRecord(scope, "inbox-suppression", created);
      const [claimRequirement] = uniqueClaimRequirements(created);
      if (!claimRequirement) {
        throw failure("create-suppression", new Error("Suppression uniqueness is not registered."));
      }
      const claim = makeUniqueClaimRecord(claimRequirement, created.data.createdAt) as Extract<
        PlatformRecord,
        { readonly itemType: "unique-claim" }
      >;
      const organizationClaim = organizationSuppressionClaim(created);
      await run(
        "create-suppression",
        database.transactWrite(
          [
            { kind: "put", record: created },
            {
              conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              kind: "put",
              record: createdIndex,
            },
            {
              conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              kind: "put",
              record: claim,
            },
            {
              conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              kind: "put",
              record: organizationClaim,
            },
          ],
          suppression.id,
        ),
      );
      return created;
    },

    async removeSuppression(id: string, removedAt = new Date().toISOString()) {
      const existing = await getEnvironmentRecord("inbox-suppression", id);
      if (!existing) return false;
      const previous = existing as Extract<
        PlatformRecord,
        { readonly itemType: "inbox-suppression" }
      >;
      if (previous.data.status === "removed") return true;
      const [claimRequirement] = uniqueClaimRequirements(previous);
      if (!claimRequirement) {
        throw failure("remove-suppression", new Error("Active suppression claim is missing."));
      }
      const claim = makeUniqueClaimRecord(claimRequirement, previous.data.createdAt) as Extract<
        PlatformRecord,
        { readonly itemType: "unique-claim" }
      >;
      const organizationClaim = organizationSuppressionClaim(previous);
      const next = withCanonicalRecordKeys({
        data: {
          ...previous.data,
          removedAt,
          status: "removed" as const,
          updatedAt: removedAt,
          version: previous.data.version + 1,
        },
        itemType: "inbox-suppression" as const,
      }) as Extract<PlatformRecord, { readonly itemType: "inbox-suppression" }>;
      await run(
        "remove-suppression",
        database.transactWrite([
          { kind: "put", previousRecord: previous, record: next },
          { kind: "delete", record: claim },
          { kind: "delete", record: organizationClaim },
        ]),
      );
      return true;
    },

    async updateDomain(domain: AgentEmailDomainRecord, event: AgentEmailDomainEvent) {
      const previous = await getEnvironmentRecord("inbox-domain", domain.id);
      if (!previous) return undefined;
      const previousDomain = previous as Extract<
        PlatformRecord,
        { readonly itemType: "inbox-domain" }
      >;
      const next = updateVersion(inboxDomainRecord(scope, domain), previousDomain);
      const previousOwnership = uniqueClaimRequirements(previousDomain).find(
        (requirement) => requirement.namespace === "inbox-domain",
      );
      const nextOwnership = uniqueClaimRequirements(next).find(
        (requirement) => requirement.namespace === "inbox-domain",
      );
      const ownershipRequirement = nextOwnership ?? previousOwnership;
      const ownershipClaim = ownershipRequirement
        ? (makeUniqueClaimRecord(ownershipRequirement, next.data.createdAt) as Extract<
            PlatformRecord,
            { readonly itemType: "unique-claim" }
          >)
        : undefined;
      const firstOwnershipVerification = !previousOwnership && Boolean(nextOwnership);
      const releaseOwnership = Boolean(previousOwnership) && !nextOwnership;
      return updateWithEvent(previousDomain, next, event, [
        ...(firstOwnershipVerification && ownershipClaim
          ? [
              {
                conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                kind: "put" as const,
                record: ownershipClaim,
              },
            ]
          : []),
        ...(releaseOwnership && ownershipClaim
          ? [{ kind: "delete" as const, record: ownershipClaim }]
          : []),
      ]);
    },

    async updateInbox(
      inbox: AgentEmailInboxRecord,
      event: AgentEmailDomainEvent,
      placementId?: AgentEmailInboxPlacementUpdate,
    ) {
      const previous = await getInbox(inbox.id, true);
      if (!previous) return undefined;
      const bindingCount = previous.data.activePlatformBindingCount ?? 0;
      const next = updateVersion(
        inboxRecord(
          scope,
          inbox,
          placementId === null ? undefined : (placementId ?? previous.data.placementId),
          bindingCount,
        ),
        previous,
      );
      const claimKey = Keys.control.uniqueClaim("inbox-address", previous.data.address);
      return updateWithEvent(previous, next, event, [
        {
          conditionExpression: "attribute_exists(pk)",
          key: claimKey,
          kind: "condition-check",
          table: "control",
        },
      ]);
    },

    async updatePlacement(placement: AgentEmailPlacementRecord) {
      const previous = await getEnvironmentRecord("inbox-placement", placement.id);
      if (!previous) return undefined;
      const previousPlacement = previous as Extract<
        PlatformRecord,
        { readonly itemType: "inbox-placement" }
      >;
      const next = updateVersion(inboxPlacementRecord(scope, placement), previousPlacement);
      const claim = makeUniqueClaimRecord(
        {
          namespace: defaultPlacementClaimNamespace(next),
          ownerId: next.data.id as Ulid,
          ownerItemType: next.itemType,
          ownerPk: next.pk,
          ownerSk: next.sk,
          ownerTable: "control",
          value: "default",
        },
        next.data.createdAt,
      ) as Extract<PlatformRecord, { readonly itemType: "unique-claim" }>;
      await run(
        "update-placement",
        database.transactWrite([
          { kind: "put", previousRecord: previousPlacement, record: next },
          ...(!previousPlacement.data.isDefault && next.data.isDefault
            ? [
                {
                  conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                  kind: "put" as const,
                  record: claim,
                },
              ]
            : []),
          ...(previousPlacement.data.isDefault && !next.data.isDefault
            ? [{ kind: "delete" as const, record: claim }]
            : []),
        ]),
      );
      return next;
    },

    async updateProviderTenant(tenant: AgentEmailProviderTenantRecord) {
      const previous = await getOrganizationRecord("inbox-provider-tenant", tenant.id);
      if (!previous) return undefined;
      const previousTenant = previous as Extract<
        PlatformRecord,
        { readonly itemType: "inbox-provider-tenant" }
      >;
      const next = updateVersion(inboxProviderTenantRecord(scope, tenant), previousTenant);
      await run(
        "update-provider-tenant",
        database.transactWrite(
          previousTenant.pk === next.pk && previousTenant.sk === next.sk
            ? [{ kind: "put", previousRecord: previousTenant, record: next }]
            : [
                { kind: "delete", record: previousTenant },
                { kind: "put", record: next },
              ],
        ),
      );
      return next;
    },
  };
}
