import type {
  AgentEmailBindingType,
  AgentEmailDomainRecord,
  AgentEmailDraftRecord,
  AgentEmailInboxBindingRecord,
  AgentEmailInboxRecord,
  AgentEmailMessageRecord,
  AgentEmailPlacementRecord,
  AgentEmailPage,
  AgentEmailPolicyRecord,
  AgentEmailSuppressionRecord,
  AgentEmailThreadRecord,
  AgentEmailUsageEventRecord,
  AgentEmailUsageExportRecord,
  AgentEmailUsageBucket,
} from "./models.ts";
import type { AgentEmailDomainEvent } from "./events.ts";
import type {
  AgentEmailAuditRecord,
  AgentEmailEntitlementSnapshot,
  AgentEmailProviderTenantRecord,
  AgentEmailRecipientVerificationRecord,
  AgentEmailSubscriptionRecord,
  AgentEmailSupportGrantRecord,
  AgentEmailUsageReconciliationRecord,
} from "./product.ts";

export interface AgentEmailListOptions {
  readonly cursor?: string;
  readonly limit: number;
}

export interface AgentEmailInboxListOptions extends AgentEmailListOptions {
  readonly bindingAccess?: {
    readonly bindingType: AgentEmailBindingType;
    readonly externalIds: readonly string[];
  };
  readonly clientId?: string;
  readonly excludeBindingTypes?: readonly AgentEmailBindingType[];
  readonly status?: AgentEmailInboxRecord["status"];
}

export interface AgentEmailMessageListOptions extends AgentEmailListOptions {
  readonly clientId?: string;
  readonly direction?: AgentEmailMessageRecord["direction"];
  readonly status?: AgentEmailMessageRecord["status"];
}

export interface AgentEmailMessageSearchOptions extends AgentEmailMessageListOptions {
  readonly from?: string;
  readonly hasAttachments?: boolean;
  readonly participants?: readonly string[];
  readonly query?: string;
  readonly to?: string;
}

export interface AgentEmailThreadListOptions extends AgentEmailListOptions {
  readonly clientId?: string;
}

export interface AgentEmailThreadSearchOptions extends AgentEmailThreadListOptions {
  readonly from?: string;
  readonly hasAttachments?: boolean;
  readonly participants?: readonly string[];
  readonly query?: string;
  readonly to?: string;
}

export interface AgentEmailDraftListOptions extends AgentEmailListOptions {
  readonly status?: AgentEmailDraftRecord["status"];
}

export interface AgentEmailInboxStore {
  readonly create: (record: AgentEmailInboxRecord) => Promise<AgentEmailInboxRecord>;
  readonly findByAddress: (
    organizationId: string,
    address: string,
  ) => Promise<AgentEmailInboxRecord | undefined>;
  readonly get: (
    organizationId: string,
    inboxId: string,
  ) => Promise<AgentEmailInboxRecord | undefined>;
  readonly list: (
    organizationId: string,
    options: AgentEmailInboxListOptions,
  ) => Promise<AgentEmailPage<AgentEmailInboxRecord>>;
  readonly update: (record: AgentEmailInboxRecord) => Promise<AgentEmailInboxRecord>;
}

export interface AgentEmailBindingStore {
  readonly create: (record: AgentEmailInboxBindingRecord) => Promise<AgentEmailInboxBindingRecord>;
  readonly findByExternalId: (
    organizationId: string,
    bindingType: string,
    externalId: string,
  ) => Promise<AgentEmailInboxBindingRecord | undefined>;
  readonly listForInbox: (
    organizationId: string,
    inboxId: string,
  ) => Promise<readonly AgentEmailInboxBindingRecord[]>;
}

export interface AgentEmailDomainStore {
  readonly create: (record: AgentEmailDomainRecord) => Promise<AgentEmailDomainRecord>;
  readonly get: (
    organizationId: string,
    domainId: string,
  ) => Promise<AgentEmailDomainRecord | undefined>;
  readonly list: (
    organizationId: string,
    options: AgentEmailListOptions,
  ) => Promise<AgentEmailPage<AgentEmailDomainRecord>>;
  readonly update: (record: AgentEmailDomainRecord) => Promise<AgentEmailDomainRecord>;
  readonly withLock: <T>(
    organizationId: string,
    domainId: string,
    operation: (domain: AgentEmailDomainRecord, inboxes: AgentEmailInboxStore) => Promise<T>,
  ) => Promise<T | undefined>;
}

export interface AgentEmailMessageStore {
  readonly getThread: (
    organizationId: string,
    inboxId: string,
    threadId: string,
    options?: { readonly clientId?: string },
  ) => Promise<AgentEmailThreadRecord | undefined>;
  readonly get: (
    organizationId: string,
    messageId: string,
  ) => Promise<AgentEmailMessageRecord | undefined>;
  readonly listForInbox: (
    organizationId: string,
    inboxId: string,
    options: AgentEmailMessageListOptions,
  ) => Promise<AgentEmailPage<AgentEmailMessageRecord>>;
  readonly searchForInbox: (
    organizationId: string,
    inboxId: string,
    options: AgentEmailMessageSearchOptions,
  ) => Promise<AgentEmailPage<AgentEmailMessageRecord>>;
  readonly listThreads: (
    organizationId: string,
    inboxId: string,
    options: AgentEmailThreadListOptions,
  ) => Promise<AgentEmailPage<AgentEmailThreadRecord>>;
  readonly searchThreads: (
    organizationId: string,
    inboxId: string,
    options: AgentEmailThreadSearchOptions,
  ) => Promise<AgentEmailPage<AgentEmailThreadRecord>>;
  readonly listThreadMessages: (
    organizationId: string,
    inboxId: string,
    threadId: string,
    options: AgentEmailMessageListOptions,
  ) => Promise<AgentEmailPage<AgentEmailMessageRecord>>;
}

export interface AgentEmailDraftStore {
  readonly create: (record: AgentEmailDraftRecord) => Promise<AgentEmailDraftRecord>;
  readonly get: (
    organizationId: string,
    draftId: string,
  ) => Promise<AgentEmailDraftRecord | undefined>;
  readonly listForInbox: (
    organizationId: string,
    inboxId: string,
    options: AgentEmailDraftListOptions,
  ) => Promise<AgentEmailPage<AgentEmailDraftRecord>>;
  readonly updateIfStatus: (
    record: AgentEmailDraftRecord,
    expectedStatuses: readonly AgentEmailDraftRecord["status"][],
  ) => Promise<AgentEmailDraftRecord | undefined>;
  readonly update: (record: AgentEmailDraftRecord) => Promise<AgentEmailDraftRecord>;
}

export interface AgentEmailUsageStore {
  readonly export: (args: {
    readonly bucket: AgentEmailUsageBucket;
    readonly clientId?: string;
    readonly from: string;
    readonly inboxId?: string;
    readonly organizationId: string;
    readonly to: string;
  }) => Promise<readonly AgentEmailUsageExportRecord[]>;
  readonly record: (event: AgentEmailUsageEventRecord) => Promise<void>;
  readonly total: (args: {
    readonly clientId?: string;
    readonly from: string;
    readonly inboxId?: string;
    readonly kind: AgentEmailUsageEventRecord["kind"];
    readonly organizationId: string;
    readonly to: string;
  }) => Promise<number>;
}

export interface AgentEmailPlacementStore {
  readonly create: (record: AgentEmailPlacementRecord) => Promise<AgentEmailPlacementRecord>;
  readonly get: (
    organizationId: string,
    placementId: string,
  ) => Promise<AgentEmailPlacementRecord | undefined>;
  readonly list: (
    organizationId: string,
    options: AgentEmailListOptions,
  ) => Promise<AgentEmailPage<AgentEmailPlacementRecord>>;
  readonly update: (record: AgentEmailPlacementRecord) => Promise<AgentEmailPlacementRecord>;
}

export interface AgentEmailPlacementProvisioner {
  readonly deprovision: (
    placement: AgentEmailPlacementRecord,
  ) => Promise<AgentEmailPlacementRecord>;
  readonly prepareReservation: (placement: AgentEmailPlacementRecord) => AgentEmailPlacementRecord;
  readonly provision: (placement: AgentEmailPlacementRecord) => Promise<AgentEmailPlacementRecord>;
  readonly reconcile: (placement: AgentEmailPlacementRecord) => Promise<AgentEmailPlacementRecord>;
}

export interface AgentEmailPolicyStore {
  readonly get: (organizationId: string) => Promise<AgentEmailPolicyRecord | undefined>;
  readonly upsert: (record: AgentEmailPolicyRecord) => Promise<AgentEmailPolicyRecord>;
}

export interface AgentEmailSuppressionStore {
  readonly create: (record: AgentEmailSuppressionRecord) => Promise<AgentEmailSuppressionRecord>;
  readonly find: (
    organizationId: string,
    address: string,
  ) => Promise<AgentEmailSuppressionRecord | undefined>;
  readonly get: (
    organizationId: string,
    suppressionId: string,
  ) => Promise<AgentEmailSuppressionRecord | undefined>;
  readonly list: (
    organizationId: string,
    options: AgentEmailListOptions,
  ) => Promise<AgentEmailPage<AgentEmailSuppressionRecord>>;
  readonly remove: (organizationId: string, suppressionId: string) => Promise<boolean>;
}

export interface AgentEmailBlobStore {
  readonly delete: (key: string, bucket?: string, versionId?: string) => Promise<void>;
  readonly get: (key: string, versionId?: string, bucket?: string) => Promise<Uint8Array>;
  readonly put: (args: {
    readonly body: Uint8Array;
    readonly contentType: string;
    readonly ifAbsent?: boolean;
    readonly key: string;
    readonly metadata?: Readonly<Record<string, string>>;
  }) => Promise<void | {
    readonly created: boolean;
    readonly etag?: string;
    readonly versionId?: string;
  }>;
  readonly signedGetUrl: (
    key: string,
    expiresInSeconds: number,
    versionId?: string,
    bucket?: string,
  ) => Promise<string>;
}

export interface AgentEmailOutboundTransport {
  readonly send: (message: AgentEmailMessageRecord) => Promise<{
    readonly internetMessageId?: string;
    readonly providerMessageId: string;
  }>;
}

export interface AgentEmailDomainProvisioner {
  readonly provision: (domain: AgentEmailDomainRecord) => Promise<AgentEmailDomainRecord>;
  readonly refresh: (domain: AgentEmailDomainRecord) => Promise<AgentEmailDomainRecord>;
  readonly revoke: (domain: AgentEmailDomainRecord) => Promise<AgentEmailDomainRecord>;
}

export interface AgentEmailEventSink {
  readonly publish: (event: AgentEmailDomainEvent) => Promise<void>;
}

export interface AgentEmailSubscriptionStore {
  readonly get: (organizationId: string) => Promise<AgentEmailSubscriptionRecord | undefined>;
  readonly upsert: (record: AgentEmailSubscriptionRecord) => Promise<AgentEmailSubscriptionRecord>;
}

export interface AgentEmailProviderTenantStore {
  readonly create: (
    record: AgentEmailProviderTenantRecord,
  ) => Promise<AgentEmailProviderTenantRecord>;
  readonly get: (
    organizationId: string,
    region: string,
  ) => Promise<AgentEmailProviderTenantRecord | undefined>;
  readonly listForOrganization: (
    organizationId: string,
  ) => Promise<readonly AgentEmailProviderTenantRecord[]>;
  readonly update: (
    record: AgentEmailProviderTenantRecord,
  ) => Promise<AgentEmailProviderTenantRecord>;
}

export interface AgentEmailEntitlementResolver {
  readonly resolve: (organizationId: string) => Promise<AgentEmailEntitlementSnapshot>;
}

export interface AgentEmailRecipientVerificationStore {
  readonly find: (
    organizationId: string,
    address: string,
  ) => Promise<AgentEmailRecipientVerificationRecord | undefined>;
  readonly getByTokenHash: (
    tokenHash: string,
  ) => Promise<AgentEmailRecipientVerificationRecord | undefined>;
  readonly list: (
    organizationId: string,
    options: AgentEmailListOptions,
  ) => Promise<AgentEmailPage<AgentEmailRecipientVerificationRecord>>;
  readonly upsert: (
    record: AgentEmailRecipientVerificationRecord,
  ) => Promise<AgentEmailRecipientVerificationRecord>;
}

export interface AgentEmailUsageReconciliationStore {
  readonly getByPeriod: (
    organizationId: string,
    periodStart: string,
    periodEnd: string,
  ) => Promise<AgentEmailUsageReconciliationRecord | undefined>;
  readonly getByProviderEventId: (
    providerEventId: string,
  ) => Promise<AgentEmailUsageReconciliationRecord | undefined>;
  readonly upsert: (
    record: AgentEmailUsageReconciliationRecord,
  ) => Promise<AgentEmailUsageReconciliationRecord>;
}

export interface AgentEmailAuditStore {
  readonly list: (
    organizationId: string,
    options: AgentEmailListOptions & {
      readonly action?: string;
      readonly resourceId?: string;
      readonly resourceType?: string;
    },
  ) => Promise<AgentEmailPage<AgentEmailAuditRecord>>;
  readonly record: (record: AgentEmailAuditRecord) => Promise<void>;
}

export interface AgentEmailSupportGrantStore {
  readonly create: (record: AgentEmailSupportGrantRecord) => Promise<AgentEmailSupportGrantRecord>;
  readonly getActive: (
    organizationId: string,
    supportPrincipalId: string,
    at: string,
  ) => Promise<AgentEmailSupportGrantRecord | undefined>;
  readonly update: (record: AgentEmailSupportGrantRecord) => Promise<AgentEmailSupportGrantRecord>;
}
