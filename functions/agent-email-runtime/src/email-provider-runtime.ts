import type {
  AgentEmailDomainProvisioner,
  AgentEmailDomainRecord,
} from "@deployments-ai/agent-email";
import {
  makeAgentEmailSesDomainProvisioner,
  makeEmailSesSender,
  provisionEmailSesTenant,
  readEmailSesTenant,
  type EmailSesTenant,
} from "@deployments-ai/agent-email/aws";
import type { SendEmailRequest } from "@deployments-ai/api-contract/email";
import type { EmailDomainRecord, EmailTenantRecord } from "@deployments-ai/db";

export interface EmailProviderRuntime {
  readonly provisionTenant: (
    tenant: EmailTenantRecord["data"],
    reconcileCustomerManagedStatus: boolean,
  ) => Promise<EmailSesTenant>;
  readonly readTenant: (tenant: EmailTenantRecord["data"]) => Promise<EmailSesTenant>;
  readonly domainProvisioner: (tenant: EmailTenantRecord["data"]) => AgentEmailDomainProvisioner;
  readonly send: (
    tenant: EmailTenantRecord["data"],
    message: SendEmailRequest,
  ) => Promise<{ readonly providerMessageId: string }>;
}

export function emailProviderDomain(record: EmailDomainRecord): AgentEmailDomainRecord {
  const { failureReason, lastCheckedAt, providerIdentity, verifiedAt, ...data } = record.data;
  return {
    ...data,
    providerManaged: false,
    ...(failureReason === undefined ? {} : { failureReason }),
    ...(lastCheckedAt === undefined ? {} : { lastCheckedAt }),
    ...(providerIdentity === undefined ? {} : { providerIdentity }),
    ...(verifiedAt === undefined ? {} : { verifiedAt }),
  };
}

export function makeEmailProviderRuntime(accountId: string): EmailProviderRuntime {
  const send = makeEmailSesSender();
  return {
    domainProvisioner: (tenant) =>
      makeAgentEmailSesDomainProvisioner({
        accountId,
        defaultConfigurationSetName: tenant.configurationSetName,
        defaultRegion: tenant.region,
        mode: "send-only",
        tenantName: () => tenant.providerName,
      }),
    provisionTenant: (tenant, reconcileCustomerManagedStatus) =>
      provisionEmailSesTenant(tenant, {
        accountId,
        reconcileCustomerManagedStatus,
      }),
    readTenant: (tenant) => readEmailSesTenant(tenant),
    send,
  };
}
