import {
  CreateTenantCommand,
  CreateTenantResourceAssociationCommand,
  DeleteSuppressedDestinationCommand,
  DeleteTenantCommand,
  DeleteTenantResourceAssociationCommand,
  GetReputationEntityCommand,
  GetTenantCommand,
  ListTenantResourcesCommand,
  PutSuppressedDestinationCommand,
  PutTenantSuppressionAttributesCommand,
  UpdateReputationEntityCustomerManagedStatusCommand,
  type CreateTenantRequest,
  type GetReputationEntityResponse,
  type GetTenantResponse,
  type PutSuppressedDestinationRequest,
  type TenantResource,
  type Tag,
} from "@aws-sdk/client-sesv2";
import type { AgentEmailProviderTenantRecord } from "../../core/index.ts";
import { alreadyExists, notFound, sesClient } from "./ses-client.ts";

export { agentEmailSesTenantName } from "./tenancy.ts";

export interface AgentEmailSesTenantOperations {
  readonly associateResource: (tenantName: string, resourceArn: string) => Promise<void>;
  readonly createTenant: (input: CreateTenantRequest) => Promise<void>;
  readonly deleteSuppression: (tenantName: string, address: string) => Promise<void>;
  readonly deleteTenant: (tenantName: string) => Promise<void>;
  readonly dissociateResource: (tenantName: string, resourceArn: string) => Promise<void>;
  readonly getReputation: (tenantArn: string) => Promise<GetReputationEntityResponse>;
  readonly getTenant: (tenantName: string) => Promise<GetTenantResponse>;
  readonly listResources: (tenantName: string) => Promise<readonly TenantResource[]>;
  readonly putSuppression: (
    tenantName: string,
    address: string,
    reason: PutSuppressedDestinationRequest["Reason"],
  ) => Promise<void>;
  readonly putSuppressionAttributes: (tenantName: string) => Promise<void>;
  readonly updateCustomerManagedStatus: (
    tenantArn: string,
    status: "DISABLED" | "ENABLED" | "REINSTATED",
  ) => Promise<void>;
}

function productionOperations(region: string): AgentEmailSesTenantOperations {
  const ses = sesClient(region);
  return {
    associateResource: async (tenantName, resourceArn) => {
      try {
        await ses.send(
          new CreateTenantResourceAssociationCommand({
            ResourceArn: resourceArn,
            TenantName: tenantName,
          }),
        );
      } catch (cause) {
        if (!alreadyExists(cause)) throw cause;
      }
    },
    createTenant: async (input) => {
      try {
        await ses.send(new CreateTenantCommand(input));
      } catch (cause) {
        if (!alreadyExists(cause)) throw cause;
      }
    },
    deleteSuppression: async (tenantName, address) => {
      try {
        await ses.send(
          new DeleteSuppressedDestinationCommand({
            EmailAddress: address,
            TenantName: tenantName,
          }),
        );
      } catch (cause) {
        if (!notFound(cause)) throw cause;
      }
    },
    deleteTenant: async (tenantName) => {
      try {
        await ses.send(new DeleteTenantCommand({ TenantName: tenantName }));
      } catch (cause) {
        if (!notFound(cause)) throw cause;
      }
    },
    dissociateResource: async (tenantName, resourceArn) => {
      try {
        await ses.send(
          new DeleteTenantResourceAssociationCommand({
            ResourceArn: resourceArn,
            TenantName: tenantName,
          }),
        );
      } catch (cause) {
        if (!notFound(cause)) throw cause;
      }
    },
    getReputation: (tenantArn) =>
      ses.send(
        new GetReputationEntityCommand({
          ReputationEntityReference: tenantArn,
          ReputationEntityType: "RESOURCE",
        }),
      ),
    getTenant: (tenantName) => ses.send(new GetTenantCommand({ TenantName: tenantName })),
    listResources: async (tenantName) => {
      const resources: TenantResource[] = [];
      let nextToken: string | undefined;
      do {
        // eslint-disable-next-line no-await-in-loop -- SES pagination is sequential by token.
        const response = await ses.send(
          new ListTenantResourcesCommand({
            ...(nextToken ? { NextToken: nextToken } : {}),
            PageSize: 100,
            TenantName: tenantName,
          }),
        );
        resources.push(...(response.TenantResources ?? []));
        nextToken = response.NextToken;
      } while (nextToken);
      return resources;
    },
    putSuppression: async (tenantName, address, reason) => {
      await ses.send(
        new PutSuppressedDestinationCommand({
          EmailAddress: address,
          Reason: reason,
          TenantName: tenantName,
        }),
      );
    },
    putSuppressionAttributes: async (tenantName) => {
      await ses.send(
        new PutTenantSuppressionAttributesCommand({
          SuppressedReasons: ["BOUNCE", "COMPLAINT"],
          SuppressionScope: "TENANT",
          TenantName: tenantName,
        }),
      );
    },
    updateCustomerManagedStatus: async (tenantArn, status) => {
      await ses.send(
        new UpdateReputationEntityCustomerManagedStatusCommand({
          ReputationEntityReference: tenantArn,
          ReputationEntityType: "RESOURCE",
          SendingStatus: status,
        }),
      );
    },
  };
}

export function agentEmailSesIdentityArn(
  region: string,
  accountId: string,
  identity: string,
  partition = "aws",
) {
  return `arn:${partition}:ses:${region}:${accountId}:identity/${identity}`;
}

export function agentEmailSesConfigurationSetArn(
  region: string,
  accountId: string,
  configurationSetName: string,
  partition = "aws",
) {
  return `arn:${partition}:ses:${region}:${accountId}:configuration-set/${configurationSetName}`;
}

function lowerStatus(value: string | undefined) {
  const normalized = value?.toLowerCase();
  return normalized === "enabled" || normalized === "reinstated" || normalized === "disabled"
    ? normalized
    : undefined;
}

function lowerImpact(value: string | undefined) {
  const normalized = value?.toLowerCase();
  return normalized === "low" || normalized === "high" || normalized === "critical"
    ? normalized
    : undefined;
}

function tenantTagsMatch(
  record: Pick<AgentEmailProviderTenantRecord, "id" | "organizationId">,
  tags: readonly {
    readonly Key?: string | undefined;
    readonly Value?: string | undefined;
  }[],
) {
  const values = new Map(tags.map((tag) => [tag.Key, tag.Value]));
  return (
    values.get("agent-inboxes:organization-id") === record.organizationId &&
    values.get("agent-inboxes:resource-id") === record.id
  );
}

async function getReputation(operations: AgentEmailSesTenantOperations, tenantArn: string) {
  try {
    return await operations.getReputation(tenantArn);
  } catch (cause) {
    if (notFound(cause)) return undefined;
    throw cause;
  }
}

export async function reconcileAgentEmailSesTenant(
  record: AgentEmailProviderTenantRecord,
  input: {
    readonly localSendingStatus: "active" | "paused" | "suspended";
    readonly readOnly?: boolean;
    readonly reconcileCustomerManagedStatus?: boolean;
    readonly ownershipTags?: readonly Tag[];
    readonly removeResourceArns?: readonly string[];
    readonly resourceArns: readonly string[];
  },
  dependencies: {
    readonly now?: () => Date;
    readonly operations?: AgentEmailSesTenantOperations;
  } = {},
): Promise<AgentEmailProviderTenantRecord> {
  const operations = dependencies.operations ?? productionOperations(record.region);
  if (!input.readOnly)
    await operations.createTenant({
      SuppressionAttributes: {
        SuppressedReasons: ["BOUNCE", "COMPLAINT"],
        SuppressionScope: "TENANT",
      },
      Tags: [
        { Key: "agent-inboxes:managed", Value: "true" },
        { Key: "agent-inboxes:organization-id", Value: record.organizationId },
        { Key: "agent-inboxes:resource-id", Value: record.id },
        ...(input.ownershipTags ?? []),
      ],
      TenantName: record.providerName,
    });
  let tenant = (await operations.getTenant(record.providerName)).Tenant;
  if (!tenant?.TenantArn || !tenant.TenantId) {
    throw new Error(`Amazon SES tenant ${record.providerName} is missing its provider identity.`);
  }
  const tags = new Map((tenant.Tags ?? []).map((tag) => [tag.Key, tag.Value]));
  if (
    !tenantTagsMatch(record, tenant.Tags ?? []) ||
    input.ownershipTags?.some((tag) => !tag.Key || tags.get(tag.Key) !== tag.Value)
  ) {
    throw new Error(`Amazon SES tenant ${record.providerName} is owned by another organization.`);
  }
  if (
    !input.readOnly &&
    (tenant.SuppressionAttributes?.SuppressionScope !== "TENANT" ||
      !tenant.SuppressionAttributes.SuppressedReasons?.includes("BOUNCE") ||
      !tenant.SuppressionAttributes.SuppressedReasons.includes("COMPLAINT"))
  ) {
    await operations.putSuppressionAttributes(record.providerName);
  }

  const desiredResources = input.readOnly ? [] : [...new Set(input.resourceArns)].toSorted();
  const removedResources = new Set(input.readOnly ? [] : (input.removeResourceArns ?? []));
  const currentResources = input.readOnly
    ? []
    : await operations.listResources(record.providerName);
  const associatedArns = new Set(
    currentResources
      .map((resource) => resource.ResourceArn)
      .filter((resourceArn): resourceArn is string => Boolean(resourceArn)),
  );
  for (const resourceArn of desiredResources) {
    if (!associatedArns.has(resourceArn)) {
      // eslint-disable-next-line no-await-in-loop -- SES association throttling is tenant-scoped.
      await operations.associateResource(record.providerName, resourceArn);
    }
  }
  const desiredResourceSet = new Set(desiredResources);
  for (const resourceArn of removedResources) {
    if (associatedArns.has(resourceArn) && !desiredResourceSet.has(resourceArn)) {
      // eslint-disable-next-line no-await-in-loop -- SES association throttling is tenant-scoped.
      await operations.dissociateResource(record.providerName, resourceArn);
    }
  }
  const previouslyManagedResources = Array.isArray(record.providerMetadata.managedResourceArns)
    ? record.providerMetadata.managedResourceArns.filter(
        (resourceArn): resourceArn is string => typeof resourceArn === "string",
      )
    : [];
  const managedResources = [
    ...new Set(
      [...previouslyManagedResources, ...desiredResources].filter(
        (resourceArn) => !removedResources.has(resourceArn) || desiredResourceSet.has(resourceArn),
      ),
    ),
  ].toSorted();

  let reputation = await getReputation(operations, tenant.TenantArn);
  const currentCustomerStatus = reputation?.ReputationEntity?.CustomerManagedStatus?.Status;
  const forceCustomerStatusUpdate = record.providerMetadata.customerStatusUpdateRequested === true;
  const desiredCustomerStatus =
    input.localSendingStatus === "active"
      ? forceCustomerStatusUpdate
        ? "REINSTATED"
        : "ENABLED"
      : "DISABLED";
  const currentStatusSatisfiesActiveRequest =
    input.localSendingStatus === "active" && currentCustomerStatus === "REINSTATED";
  if (
    !input.readOnly &&
    input.reconcileCustomerManagedStatus !== false &&
    (forceCustomerStatusUpdate ||
      (!currentStatusSatisfiesActiveRequest && currentCustomerStatus !== desiredCustomerStatus))
  ) {
    await operations.updateCustomerManagedStatus(tenant.TenantArn, desiredCustomerStatus);
    reputation = await getReputation(operations, tenant.TenantArn);
    tenant = (await operations.getTenant(record.providerName)).Tenant;
  }

  const entity = reputation?.ReputationEntity;
  const aggregateStatus = lowerStatus(entity?.SendingStatusAggregate ?? tenant?.SendingStatus);
  const awsManagedStatus = lowerStatus(entity?.AwsSesManagedStatus?.Status);
  const customerManagedStatus = lowerStatus(entity?.CustomerManagedStatus?.Status);
  const reputationImpact = lowerImpact(entity?.ReputationImpact);
  const now = (dependencies.now?.() ?? new Date()).toISOString();
  const cause =
    entity?.AwsSesManagedStatus?.Status === "DISABLED"
      ? entity.AwsSesManagedStatus.Cause
      : entity?.CustomerManagedStatus?.Cause;
  const providerArn = tenant?.TenantArn ?? record.providerArn;
  const providerId = tenant?.TenantId ?? record.providerId;
  const {
    awsManagedStatus: _awsManagedStatus,
    customerManagedStatus: _customerManagedStatus,
    providerArn: _providerArn,
    providerId: _providerId,
    reconciliationError: _reconciliationError,
    reputationCause: _reputationCause,
    reputationImpact: _reputationImpact,
    reputationPolicy: _reputationPolicy,
    ...baseRecord
  } = record;
  const { customerStatusUpdateRequested: _customerStatusUpdateRequested, ...providerMetadata } =
    record.providerMetadata;
  const nextProviderMetadata =
    forceCustomerStatusUpdate && aggregateStatus === "disabled"
      ? record.providerMetadata
      : providerMetadata;
  const sendingStatus =
    input.localSendingStatus !== "active"
      ? "disabled"
      : aggregateStatus === "enabled" || aggregateStatus === "reinstated"
        ? aggregateStatus
        : aggregateStatus === "disabled"
          ? "disabled"
          : "provisioning";
  return {
    ...baseRecord,
    ...(awsManagedStatus ? { awsManagedStatus } : {}),
    ...(customerManagedStatus ? { customerManagedStatus } : {}),
    lastReconciledAt: now,
    ...(providerArn ? { providerArn } : {}),
    ...(providerId ? { providerId } : {}),
    providerMetadata: { ...nextProviderMetadata, managedResourceArns: managedResources },
    ...(cause ? { reputationCause: cause } : {}),
    ...(reputationImpact ? { reputationImpact } : {}),
    ...(entity?.ReputationManagementPolicy
      ? { reputationPolicy: entity.ReputationManagementPolicy }
      : {}),
    sendingStatus,
    suppressedReasons: ["bounce", "complaint"],
    suppressionScope: "tenant",
    updatedAt: now,
  };
}

export async function syncAgentEmailSesSuppression(
  input: {
    readonly address: string;
    readonly providerAddress?: string;
    readonly reason: "bounce" | "complaint" | "manual" | "policy";
    readonly removed: boolean;
    readonly tenantName: string;
  },
  options: {
    readonly operations?: AgentEmailSesTenantOperations;
    readonly region: string;
  },
) {
  const operations = options.operations ?? productionOperations(options.region);
  const providerAddress = input.providerAddress ?? input.address;
  if (input.removed) {
    await operations.deleteSuppression(input.tenantName, providerAddress);
    return;
  }
  await operations.putSuppression(
    input.tenantName,
    providerAddress,
    input.reason === "complaint" ? "COMPLAINT" : "BOUNCE",
  );
}

export async function deleteAgentEmailSesTenant(
  tenant: Pick<AgentEmailProviderTenantRecord, "id" | "organizationId" | "providerName" | "region">,
  dependencies: { readonly operations?: AgentEmailSesTenantOperations } = {},
) {
  const operations = dependencies.operations ?? productionOperations(tenant.region);
  let providerTenant: Awaited<ReturnType<AgentEmailSesTenantOperations["getTenant"]>>["Tenant"];
  try {
    providerTenant = (await operations.getTenant(tenant.providerName)).Tenant;
  } catch (cause) {
    if (notFound(cause)) return;
    throw cause;
  }
  if (!tenantTagsMatch(tenant, providerTenant?.Tags ?? [])) {
    throw new Error(`Amazon SES tenant ${tenant.providerName} is owned by another organization.`);
  }
  await operations.deleteTenant(tenant.providerName);
}
