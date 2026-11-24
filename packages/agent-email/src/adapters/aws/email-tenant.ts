import {
  CreateConfigurationSetCommand,
  ListTagsForResourceCommand,
  PutConfigurationSetSuppressionOptionsCommand,
  SESv2Client,
  type CreateConfigurationSetRequest,
  type Tag,
} from "@aws-sdk/client-sesv2";
import type { AgentEmailProviderTenantRecord } from "../../core/index.ts";
import {
  agentEmailSesConfigurationSetArn,
  reconcileAgentEmailSesTenant,
  type AgentEmailSesTenantOperations,
} from "./tenant-provisioner.ts";

export interface EmailSesTenant {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly region: string;
  readonly providerName: string;
  readonly configurationSetName: string;
  readonly status: "active" | "paused";
  readonly sendingStatus: "provisioning" | "enabled" | "reinstated" | "disabled";
  readonly providerId?: string | undefined;
  readonly providerArn?: string | undefined;
}

export interface EmailSesConfigurationSetOperations {
  readonly create: (input: CreateConfigurationSetRequest) => Promise<void>;
  readonly listTags: (arn: string) => Promise<readonly Tag[]>;
  readonly putSuppression: (name: string) => Promise<void>;
}

export interface EmailSesTenantDependencies {
  readonly now?: () => Date;
  readonly operations?: AgentEmailSesTenantOperations;
}

const clients = new Map<string, SESv2Client>();

function configurationSetOperations(region: string): EmailSesConfigurationSetOperations {
  let ses = clients.get(region);
  if (!ses) {
    ses = new SESv2Client({ region });
    clients.set(region, ses);
  }
  const client = ses;
  return {
    create: async (input) => {
      try {
        await client.send(new CreateConfigurationSetCommand(input));
      } catch (cause) {
        if (!(cause instanceof Error && cause.name === "AlreadyExistsException")) throw cause;
      }
    },
    listTags: async (arn) =>
      (await client.send(new ListTagsForResourceCommand({ ResourceArn: arn }))).Tags ?? [],
    putSuppression: async (name) => {
      await client.send(
        new PutConfigurationSetSuppressionOptionsCommand({
          ConfigurationSetName: name,
          SuppressedReasons: ["BOUNCE", "COMPLAINT"],
        }),
      );
    },
  };
}

export function emailSesTenantNames(tenantId: string) {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(tenantId)) {
    throw new Error("An opaque email tenant ULID is required.");
  }
  const name = `email-${tenantId.toLowerCase()}`;
  return { providerName: name, configurationSetName: name };
}

function ownershipTags(tenant: EmailSesTenant): Tag[] {
  return [
    { Key: "platform-email:managed", Value: "true" },
    { Key: "platform-email:organization-id", Value: tenant.organizationId },
    { Key: "platform-email:project-id", Value: tenant.projectId },
    { Key: "platform-email:environment-id", Value: tenant.environmentId },
    { Key: "platform-email:tenant-id", Value: tenant.id },
  ];
}

function providerRecord(tenant: EmailSesTenant, now: Date): AgentEmailProviderTenantRecord {
  return {
    id: tenant.id,
    organizationId: tenant.organizationId,
    provider: "ses",
    providerName: tenant.providerName,
    ...(tenant.providerId ? { providerId: tenant.providerId } : {}),
    ...(tenant.providerArn ? { providerArn: tenant.providerArn } : {}),
    providerMetadata: {},
    region: tenant.region,
    sendingStatus: tenant.sendingStatus,
    suppressionScope: "tenant",
    suppressedReasons: ["bounce", "complaint"],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function nativeResult(
  tenant: EmailSesTenant,
  native: AgentEmailProviderTenantRecord,
): EmailSesTenant {
  return {
    ...tenant,
    ...(native.providerId ? { providerId: native.providerId } : {}),
    ...(native.providerArn ? { providerArn: native.providerArn } : {}),
    // Failed provisioning must remain non-sendable in the public tenant status model.
    sendingStatus:
      native.sendingStatus === "failed" ||
      native.awsManagedStatus === "disabled" ||
      native.customerManagedStatus === "disabled"
        ? "disabled"
        : native.sendingStatus,
  };
}

/** Reads native pause/reputation restrictions without reconciling any provider resources. */
export async function readEmailSesTenant(
  tenant: EmailSesTenant,
  dependencies: EmailSesTenantDependencies & { readonly requireExisting?: boolean } = {},
): Promise<EmailSesTenant> {
  try {
    const native = await reconcileAgentEmailSesTenant(
      providerRecord(tenant, dependencies.now?.() ?? new Date()),
      {
        localSendingStatus: tenant.status,
        ownershipTags: ownershipTags(tenant),
        readOnly: true,
        reconcileCustomerManagedStatus: false,
        resourceArns: [],
      },
      dependencies,
    );
    return nativeResult(tenant, native);
  } catch (cause) {
    if (
      dependencies.requireExisting ||
      !(cause instanceof Error && cause.name === "NotFoundException")
    )
      throw cause;
    return {
      ...tenant,
      sendingStatus: tenant.providerId ? "disabled" : "provisioning",
    };
  }
}

/** Only an explicit admin status mutation may reconcile customer-managed sending status. */
export async function provisionEmailSesTenant(
  tenant: EmailSesTenant,
  options: EmailSesTenantDependencies & {
    readonly accountId: string;
    readonly partition?: string;
    readonly reconcileCustomerManagedStatus?: boolean;
    readonly configurationSetOperations?: EmailSesConfigurationSetOperations;
  },
): Promise<EmailSesTenant> {
  if (!/^\d{12}$/u.test(options.accountId))
    throw new Error("A 12-digit AWS account ID is required.");
  const names = emailSesTenantNames(tenant.id);
  if (
    tenant.providerName !== names.providerName ||
    tenant.configurationSetName !== names.configurationSetName
  ) {
    throw new Error("Email tenant provider names must belong to the opaque tenant ID.");
  }
  const operations =
    options.configurationSetOperations ?? configurationSetOperations(tenant.region);
  const tags = ownershipTags(tenant);
  const arn = agentEmailSesConfigurationSetArn(
    tenant.region,
    options.accountId,
    tenant.configurationSetName,
    options.partition,
  );
  await operations.create({
    ConfigurationSetName: tenant.configurationSetName,
    SuppressionOptions: { SuppressedReasons: ["BOUNCE", "COMPLAINT"] },
    Tags: tags,
  });
  const actualTags = new Map((await operations.listTags(arn)).map((tag) => [tag.Key, tag.Value]));
  if (tags.some((tag) => actualTags.get(tag.Key) !== tag.Value)) {
    throw new Error("Amazon SES configuration set is not owned by this email tenant.");
  }
  await operations.putSuppression(tenant.configurationSetName);
  const record = providerRecord(tenant, options.now?.() ?? new Date());
  const native = await reconcileAgentEmailSesTenant(
    {
      ...record,
      providerMetadata: options.reconcileCustomerManagedStatus
        ? { customerStatusUpdateRequested: true }
        : {},
    },
    {
      localSendingStatus: tenant.status,
      ownershipTags: tags,
      reconcileCustomerManagedStatus: options.reconcileCustomerManagedStatus === true,
      resourceArns: [arn],
    },
    options,
  );
  return nativeResult(tenant, native);
}
