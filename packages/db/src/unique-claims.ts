import {
  type UniqueClaimDelete,
  type UniqueClaimPut,
  type UniqueClaimRecord,
} from "./client-types.ts";
import { createHash } from "node:crypto";
import { UNIQUE_CLAIM_CONDITION } from "./keys.ts";
import type { PlatformRecord, TableName } from "./records/index.ts";
import { withCanonicalRecordKeys } from "./records/index.ts";
import { expiredUniqueClaimAcquisitionCondition } from "./transaction-conditions.ts";
import { appClaimOwnerAttributes, appClaimRequirements } from "./apps/claims.ts";
import { brainSourceRevisionClaimNamespace } from "./brains/claim-identities.ts";
import { capacityClaimRequirements } from "./capacity/requirements.ts";
import {
  directoryClaimOwnerAttributes,
  directoryClaimRequirements,
} from "./directory/record-rules.ts";
import {
  federationClaimOwnerAttributes,
  federationClaimRequirements,
} from "./identity-federation/claims.ts";
import {
  claimOwnerAttributes as ownerAttributes,
  claimRequirement as requirement,
  claimValue as value,
} from "./unique-claim-requirement.ts";
export interface UniqueClaimRequirement {
  readonly expiresAt?: string;
  readonly namespace: string;
  readonly ownerId: string;
  readonly ownerItemType: PlatformRecord["itemType"];
  readonly ownerPk: string;
  readonly ownerSk: string;
  readonly ownerTable: TableName;
  readonly ttl?: number;
  readonly value: string;
}

export function makeUniqueClaimRecord(requirement: UniqueClaimRequirement, createdAt: string) {
  return withCanonicalRecordKeys({
    data: {
      createdAt,
      ...(requirement.expiresAt ? { expiresAt: requirement.expiresAt } : {}),
      namespace: requirement.namespace,
      ownerId: requirement.ownerId,
      ownerItemType: requirement.ownerItemType,
      ownerPk: requirement.ownerPk,
      ownerSk: requirement.ownerSk,
      ownerTable: requirement.ownerTable,
      value: requirement.value,
    },
    itemType: "unique-claim" as const,
    ...(requirement.ttl === undefined ? {} : { ttl: requirement.ttl }),
  });
}

export function acquireUniqueClaim(record: UniqueClaimRecord): UniqueClaimPut {
  return {
    conditionExpression: UNIQUE_CLAIM_CONDITION,
    kind: "put",
    record,
  };
}

export function acquireExpiringUniqueClaim(
  record: UniqueClaimRecord,
  observedAt: string,
): UniqueClaimPut {
  if (record.data.expiresAt === undefined || record.ttl === undefined) {
    throw new TypeError("Expiring unique-claim acquisition requires a logical expiration and TTL.");
  }
  return {
    ...expiredUniqueClaimAcquisitionCondition(observedAt),
    kind: "put",
    record,
    replaceExpired: true,
  };
}

export function releaseUniqueClaim(record: UniqueClaimRecord): UniqueClaimDelete {
  return { kind: "delete", record };
}

export function memorySpaceGrantClaimNamespace(environmentId: string) {
  return `environment:${environmentId}:memory-space-grant`;
}

export function memorySpaceGrantClaimValue(agentDefinitionId: string, memorySpaceId: string) {
  return `${agentDefinitionId}:${memorySpaceId}`;
}

export function managedSkillInstallationClaimNamespace(environmentId: string) {
  return `environment:${environmentId}:managed-skill-installation`;
}

export function managedSkillInstallationClaimValue(
  agentDefinitionId: string | undefined,
  managedSkillId: string,
) {
  return `${agentDefinitionId ? `agent:${agentDefinitionId}` : "environment"}:${managedSkillId}`;
}

/** Values are workspace IDs: each workspace has at most one default memory space. */
export function defaultWorkspaceMemorySpaceClaimNamespace(environmentId: string) {
  return `environment:${environmentId}:default-workspace-memory-space`;
}

export function memoryPolicyClaimNamespace(environmentId: string) {
  return `environment:${environmentId}:memory-policy`;
}

export function memoryPolicyClaimValue(scope: string, workspaceId?: string) {
  return scope === "workspace" ? `workspace:${workspaceId}` : scope;
}

export function promotedAgentReleaseClaimNamespace(
  environmentId: string,
  agentDefinitionId: string,
) {
  return `environment:${environmentId}:agent-definition:${agentDefinitionId}:promoted-release-content-hash`;
}

export function agentDefinitionSlugClaimNamespace(environmentId: string) {
  return `environment:${environmentId}:agent-definition-slug`;
}

/** At most one model policy per environment is active; archived policies release the claim. */
export function modelPolicyClaimNamespace(environmentId: string) {
  return `environment:${environmentId}:model-policy`;
}

export const MODEL_POLICY_ACTIVE_CLAIM_VALUE = "active";

export function uniqueOwnerAttributes(record: PlatformRecord): Readonly<Record<string, unknown>> {
  const data = record.data as Readonly<Record<string, unknown>>;
  const domainOwned =
    federationClaimOwnerAttributes(record) ??
    appClaimOwnerAttributes(record) ??
    directoryClaimOwnerAttributes(record);
  if (domainOwned) return domainOwned;

  switch (record.itemType) {
    case "agent-definition":
      return ownerAttributes(data, ["environmentId", "workspaceId", "slug"]);
    case "agent-release":
      return ownerAttributes(data, [
        "environmentId",
        "agentDefinitionId",
        "contentHash",
        "promotedFromReleaseId",
      ]);
    case "api-credential":
      return ownerAttributes(data, ["credentialHash"]);
    case "approval-action-token":
      return ownerAttributes(data, ["tokenHash"]);
    case "brain":
      return ownerAttributes(data, ["organizationId", "slug"]);
    case "brain-deployment-mount":
      return ownerAttributes(data, ["organizationId", "agentDeploymentId", "brainId", "status"]);
    case "brain-document":
      return ownerAttributes(data, [
        "organizationId",
        "brainId",
        "sourceId",
        "externalItemIdentity",
      ]);
    case "brain-entity":
      return {
        ...ownerAttributes(data, ["organizationId", "brainId"]),
        normalizedAliases: data.normalizedAliases,
      };
    case "brain-grant":
      return ownerAttributes(data, [
        "organizationId",
        "brainId",
        "targetType",
        "principalId",
        "organizationRole",
        "serviceAccountId",
        "agentDefinitionId",
        "targetProjectId",
        "targetEnvironmentId",
        "status",
      ]);
    case "brain-source":
      return {
        ...ownerAttributes(data, ["organizationId", "brainId", "kind", "connectionId"]),
        configuration: data.configuration,
      };
    case "brain-source-order-claim":
      return ownerAttributes(data, [
        "organizationId",
        "sourceId",
        "documentId",
        "sourceOrder",
        "stableVersion",
      ]);
    case "brain-source-item-claim":
      return ownerAttributes(data, ["organizationId", "sourceId", "externalItemIdentity"]);
    case "brain-source-revision-claim":
      return ownerAttributes(data, ["organizationId", "sourceId", "revisionKey"]);
    case "environment":
      return ownerAttributes(data, ["projectId", "slug"]);
    case "inbox":
      return ownerAttributes(data, ["environmentId", "address"]);
    case "dataset-case":
      return ownerAttributes(data, ["datasetId", "contentSha256"]);
    case "regression-dataset":
    case "score-definition":
      return ownerAttributes(data, ["environmentId", "name", "status"]);
    case "email-domain":
      return ownerAttributes(data, [
        "organizationId",
        "projectId",
        "environmentId",
        "tenantId",
        "domain",
        "verifiedAt",
        "revocationCompletedAt",
      ]);
    case "inbox-domain":
      return {
        ...ownerAttributes(data, [
          "organizationId",
          "projectId",
          "environmentId",
          "domain",
          "status",
          "verifiedAt",
        ]),
        providerManaged:
          typeof data.providerManaged === "boolean" ? data.providerManaged : undefined,
      };
    case "inbox-binding":
      return ownerAttributes(data, ["organizationId", "bindingType", "externalId"]);
    case "inbox-suppression":
      return ownerAttributes(data, ["organizationId", "emailHash"]);
    case "inbox-provider-tenant":
      return ownerAttributes(data, ["organizationId", "provider", "region"]);
    case "managed-skill-source":
      return ownerAttributes(data, ["key"]);
    case "managed-skill-release":
      return ownerAttributes(data, ["sourceId", "releaseVersion"]);
    case "managed-skill-installation":
      return ownerAttributes(data, [
        "environmentId",
        "agentDefinitionId",
        "managedSkillId",
        "status",
      ]);
    case "memory-space-grant":
      return ownerAttributes(data, ["agentDefinitionId", "memorySpaceId", "revokedAt"]);
    case "memory-policy":
      return ownerAttributes(data, ["scope", "workspaceId"]);
    case "model-policy":
      return ownerAttributes(data, ["environmentId"]);
    case "organization":
      return ownerAttributes(data, ["slug"]);
    case "organization-invitation":
      return ownerAttributes(data, ["organizationId", "email", "status"]);
    case "oauth-authorization-attempt":
      return ownerAttributes(data, ["stateHash"]);
    case "project":
      return ownerAttributes(data, ["organizationId", "slug"]);
    case "provider-application":
      return {
        ...ownerAttributes(data, ["environmentId", "providerKey", "clientId", "status"]),
        registration: data.registration,
      };
    case "provider-connection":
      return ownerAttributes(data, ["environmentId", "providerKey", "externalAccountId", "status"]);
    case "tool-adapter":
      return ownerAttributes(data, ["environmentId", "name", "status"]);
    case "run":
      return ownerAttributes(data, ["environmentId", "id"]);
    case "sandbox-lease":
      return ownerAttributes(data, ["provider", "providerRouteKey", "externalSandboxId"]);
    case "workspace":
      return ownerAttributes(data, ["environmentId", "slug"]);
    case "webhook-endpoint":
      // Disabled endpoints keep their quota slot, so status changes never touch the claim.
      return ownerAttributes(data, ["environmentId"]);
    default:
      return {};
  }
}

export function uniqueClaimRequirements(record: PlatformRecord): readonly UniqueClaimRequirement[] {
  return [
    ...resourceClaimRequirements(record),
    ...capacityClaimRequirements(record),
    ...appClaimRequirements(record),
    ...federationClaimRequirements(record),
    ...directoryClaimRequirements(record),
  ];
}

function resourceClaimRequirements(record: PlatformRecord): readonly UniqueClaimRequirement[] {
  const data = record.data as Readonly<Record<string, unknown>>;

  switch (record.itemType) {
    case "principal": {
      const primaryEmail = value(data, "primaryEmail");
      return data.kind === "human" && primaryEmail
        ? requirement(
            record,
            "principal-email",
            createHash("sha256").update(primaryEmail.trim().toLowerCase()).digest("hex"),
          )
        : [];
    }
    case "oauth-device-grant":
      return requirement(record, "oauth-device-user-code", value(data, "userCodeHash"));
    case "agent-definition": {
      const workspaceId = value(data, "workspaceId");
      return requirement(
        record,
        workspaceId
          ? `workspace:${workspaceId}:agent-definition-slug`
          : agentDefinitionSlugClaimNamespace(value(data, "environmentId") ?? ""),
        value(data, "slug")?.toLowerCase(),
      );
    }
    case "agent-release":
      // Only promoted releases claim their content: promotion is idempotent per target
      // definition, while ordinary publishing may snapshot an identical draft again.
      return value(data, "promotedFromReleaseId")
        ? requirement(
            record,
            promotedAgentReleaseClaimNamespace(
              value(data, "environmentId") ?? "",
              value(data, "agentDefinitionId") ?? "",
            ),
            value(data, "contentHash"),
          )
        : [];
    case "api-credential":
      return requirement(record, "api-credential-hash", value(data, "credentialHash"));
    case "approval-action-token":
      return requirement(record, "approval-action-token-hash", value(data, "tokenHash"));
    case "brain":
      return requirement(
        record,
        `organization:${value(data, "organizationId")}:brain-slug`,
        value(data, "slug")?.toLowerCase(),
      );
    case "brain-deployment-mount":
      return data.status === "active"
        ? requirement(
            record,
            `organization:${value(data, "organizationId")}:agent-deployment:${value(data, "agentDeploymentId")}:brain-mount`,
            value(data, "brainId"),
          )
        : [];
    case "brain-document":
      return requirement(
        record,
        `organization:${value(data, "organizationId")}:brain-source:${value(data, "sourceId")}:document`,
        value(data, "externalItemIdentity"),
      );
    case "brain-entity": {
      const aliases = Array.isArray(data.normalizedAliases)
        ? data.normalizedAliases.filter(
            (alias): alias is string => typeof alias === "string" && alias.trim().length > 0,
          )
        : [];
      return aliases.flatMap((alias) =>
        requirement(
          record,
          `organization:${value(data, "organizationId")}:brain:${value(data, "brainId")}:entity-alias`,
          alias,
        ),
      );
    }
    case "brain-grant": {
      if (data.status !== "active") return [];
      const target =
        value(data, "principalId") ??
        value(data, "organizationRole") ??
        value(data, "serviceAccountId") ??
        value(data, "agentDefinitionId");
      return requirement(
        record,
        `organization:${value(data, "organizationId")}:brain:${value(data, "brainId")}:grant`,
        target ? `${value(data, "targetType")}:${target}` : undefined,
      );
    }
    case "brain-source": {
      if (data.kind !== "github") return [];
      const configuration =
        data.configuration &&
        typeof data.configuration === "object" &&
        !Array.isArray(data.configuration)
          ? (data.configuration as Readonly<Record<string, unknown>>)
          : {};
      const owner = value(configuration, "owner")?.toLowerCase();
      const repository = value(configuration, "repository")?.toLowerCase();
      const ref = value(configuration, "ref") ?? "HEAD";
      return requirement(
        record,
        `organization:${value(data, "organizationId")}:brain:${value(data, "brainId")}:managed-source`,
        owner && repository ? `github:${owner}/${repository}@${ref}` : undefined,
      );
    }
    case "brain-source-order-claim": {
      const sourceOrder = data.sourceOrder;
      return [
        ...requirement(
          record,
          `organization:${value(data, "organizationId")}:brain-source:${value(data, "sourceId")}:document:${value(data, "documentId")}:source-order`,
          Number.isSafeInteger(sourceOrder) ? String(sourceOrder) : undefined,
        ),
        ...requirement(
          record,
          `organization:${value(data, "organizationId")}:brain-source:${value(data, "sourceId")}:document:${value(data, "documentId")}:stable-version`,
          value(data, "stableVersion"),
        ),
      ];
    }
    case "brain-source-item-claim":
      return requirement(
        record,
        `organization:${value(data, "organizationId")}:brain-source:${value(data, "sourceId")}:item`,
        value(data, "externalItemIdentity"),
      );
    case "brain-source-revision-claim":
      return requirement(
        record,
        brainSourceRevisionClaimNamespace(
          value(data, "organizationId")!,
          value(data, "sourceId")!,
          value(data, "externalItemIdentity")!,
        ),
        value(data, "revisionKey"),
      );
    case "environment":
      return [
        ...requirement(record, "environment-id", value(data, "id")),
        ...requirement(
          record,
          `project:${value(data, "projectId")}:environment-slug`,
          value(data, "slug")?.toLowerCase(),
        ),
      ];
    case "inbox":
      return requirement(record, "inbox-address", value(data, "address")?.toLowerCase());
    case "dataset-case":
      return requirement(
        record,
        `regression-dataset:${value(data, "datasetId")}:case-content`,
        value(data, "contentSha256"),
      );
    case "regression-dataset":
      return data.status === "active"
        ? requirement(
            record,
            `environment:${value(data, "environmentId")}:regression-dataset-name`,
            value(data, "name"),
          )
        : [];
    case "score-definition":
      return data.status === "active"
        ? requirement(
            record,
            `environment:${value(data, "environmentId")}:score-definition-name`,
            value(data, "name"),
          )
        : [];
    case "email-domain":
      // Pending challenges cannot reserve somebody else's domain. Hold proven ownership
      // through cleanup failures, then release only after provider cleanup has completed.
      return value(data, "verifiedAt") !== undefined &&
        value(data, "revocationCompletedAt") === undefined
        ? requirement(record, "inbox-domain", value(data, "domain")?.toLowerCase())
        : [];
    case "inbox-domain": {
      if (data.providerManaged !== false) return [];
      const domain = value(data, "domain")?.toLowerCase();
      const registration = requirement(
        record,
        `organization:${value(data, "organizationId")}:project:${value(data, "projectId")}:environment:${value(data, "environmentId")}:inbox-domain`,
        domain,
      );
      const ownsDomain = value(data, "verifiedAt") !== undefined && data.status !== "revoked";
      return [...registration, ...(ownsDomain ? requirement(record, "inbox-domain", domain) : [])];
    }
    case "inbox-binding":
      return data.status === "active"
        ? requirement(
            record,
            `organization:${value(data, "organizationId")}:project:${value(data, "projectId")}:environment:${value(data, "environmentId")}:inbox-binding:${value(data, "bindingType")}`,
            value(data, "externalId"),
          )
        : [];
    case "inbox-suppression":
      return data.status === "active"
        ? [
            ...requirement(
              record,
              `organization:${value(data, "organizationId")}:project:${value(data, "projectId")}:environment:${value(data, "environmentId")}:inbox-suppression`,
              value(data, "emailHash"),
            ),
            ...requirement(
              record,
              `organization:${value(data, "organizationId")}:inbox-suppression-address:${value(data, "emailHash")}`,
              `${value(data, "environmentId")}:${value(data, "id")}`,
            ),
          ]
        : [];
    case "inbox-provider-tenant":
      return requirement(
        record,
        `organization:${value(data, "organizationId")}:inbox-provider-tenant`,
        `${value(data, "provider")}:${value(data, "region")}`,
      );
    case "managed-skill-source":
      return requirement(record, "managed-skill-source-key", value(data, "key")?.toLowerCase());
    case "managed-skill-release":
      return requirement(
        record,
        `managed-skill-source:${value(data, "sourceId")}:release-version`,
        value(data, "releaseVersion"),
      );
    case "managed-skill-installation": {
      const environmentId = value(data, "environmentId");
      const managedSkillId = value(data, "managedSkillId");
      if (data.status !== "active" || !environmentId || !managedSkillId) return [];
      const agentDefinitionId = value(data, "agentDefinitionId");
      return requirement(
        record,
        managedSkillInstallationClaimNamespace(environmentId),
        managedSkillInstallationClaimValue(agentDefinitionId, managedSkillId),
      );
    }
    case "inbox-placement":
      return data.isDefault === true
        ? requirement(
            record,
            `organization:${value(data, "organizationId")}:project:${value(data, "projectId")}:environment:${value(data, "environmentId")}:default-inbox-placement`,
            "default",
          )
        : [];
    case "memory-space": {
      const environmentId = value(data, "environmentId");
      const workspaceId = value(data, "workspaceId");
      return data.isDefault === true && environmentId && workspaceId
        ? requirement(record, defaultWorkspaceMemorySpaceClaimNamespace(environmentId), workspaceId)
        : [];
    }
    case "memory-space-grant": {
      const environmentId = value(data, "environmentId");
      const agentDefinitionId = value(data, "agentDefinitionId");
      const memorySpaceId = value(data, "memorySpaceId");
      return data.revokedAt === undefined && environmentId && agentDefinitionId && memorySpaceId
        ? requirement(
            record,
            memorySpaceGrantClaimNamespace(environmentId),
            memorySpaceGrantClaimValue(agentDefinitionId, memorySpaceId),
          )
        : [];
    }
    case "memory-policy": {
      const environmentId = value(data, "environmentId");
      const scope = value(data, "scope");
      const workspaceId = value(data, "workspaceId");
      return environmentId && scope
        ? requirement(
            record,
            memoryPolicyClaimNamespace(environmentId),
            memoryPolicyClaimValue(scope, workspaceId),
          )
        : [];
    }
    case "model-policy": {
      const environmentId = value(data, "environmentId");
      return environmentId && data.status === "active"
        ? requirement(
            record,
            modelPolicyClaimNamespace(environmentId),
            MODEL_POLICY_ACTIVE_CLAIM_VALUE,
          )
        : [];
    }
    case "organization":
      return requirement(record, "organization-slug", value(data, "slug")?.toLowerCase());
    case "organization-invitation":
      return [
        ...requirement(record, "organization-invitation-id", value(data, "id")),
        ...(data.status === "pending"
          ? requirement(
              record,
              `organization:${value(data, "organizationId")}:pending-invitation-email`,
              value(data, "email")?.toLowerCase(),
            )
          : []),
      ];
    case "oauth-authorization-attempt":
      return requirement(
        record,
        `environment:${value(data, "environmentId")}:oauth-state-hash`,
        value(data, "stateHash"),
      );
    case "project":
      return [
        ...requirement(record, "project-id", value(data, "id")),
        ...requirement(
          record,
          `organization:${value(data, "organizationId")}:project-slug`,
          value(data, "slug")?.toLowerCase(),
        ),
      ];
    case "provider-application": {
      // The clientId claim survives archival; an issuer-bound dynamic registration releases its
      // slot once the application stops being active so a replacement can be registered.
      const registration = record.data.registration;
      return [
        ...requirement(
          record,
          `environment:${value(data, "environmentId")}:provider-application:${value(data, "providerKey")}`,
          value(data, "clientId"),
        ),
        ...(record.data.status === "active" &&
        registration?.method === "dynamic_client_registration"
          ? requirement(
              record,
              `environment:${value(data, "environmentId")}:provider-application-registration:${value(data, "providerKey")}`,
              registration.issuer,
            )
          : []),
      ];
    }
    case "provider-connection":
      return value(data, "status") === "disconnected"
        ? []
        : requirement(
            record,
            `environment:${value(data, "environmentId")}:provider-connection:${value(data, "providerKey")}`,
            value(data, "externalAccountId"),
          );
    case "tool-adapter":
      return data.status === "active"
        ? requirement(
            record,
            `environment:${value(data, "environmentId")}:tool-adapter-name`,
            value(data, "name"),
          )
        : [];
    case "sandbox-lease":
      return requirement(
        record,
        `sandbox-provider:${value(data, "provider")}:route:${value(data, "providerRouteKey") ?? "legacy"}`,
        value(data, "externalSandboxId"),
      );
    case "workspace":
      return requirement(
        record,
        `environment:${value(data, "environmentId")}:workspace-slug`,
        value(data, "slug")?.toLowerCase(),
      );
    case "webhook-endpoint": {
      const environmentId = value(data, "environmentId");
      const quotaSlot = data.quotaSlot;
      return (data.status === "active" || data.status === "disabled") &&
        environmentId &&
        typeof quotaSlot === "number" &&
        Number.isSafeInteger(quotaSlot) &&
        quotaSlot >= 0 &&
        quotaSlot < 100
        ? requirement(
            record,
            `environment:${environmentId}:webhook-subscription-slot`,
            String(quotaSlot),
          )
        : [];
    }
    default:
      return [];
  }
}
