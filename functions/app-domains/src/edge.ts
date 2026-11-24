export const MANAGED_TAG = { key: "deployments:managed-by", value: "apps" } as const;

const TENANT_NAME_PREFIX = "app-domain-";

export function tenantName(domainId: string) {
  return `${TENANT_NAME_PREFIX}${domainId}`;
}

/** A distribution tenant as the reconciler observes it; `etag` is the version every write must match. */
export interface Tenant {
  readonly arn: string;
  readonly certificateArn: string | undefined;
  readonly deployed: boolean;
  readonly domainActive: boolean;
  readonly enabled: boolean;
  readonly etag: string;
  readonly hostname: string | undefined;
  readonly id: string;
  readonly name: string;
  /** False for a tenant of another distribution in the account. */
  readonly onDistribution: boolean;
}

export interface DomainHolder {
  readonly arn: string;
  readonly onDistribution: boolean;
}

export type ManagedCertificateStatus =
  | "expired"
  | "failed"
  | "inactive"
  | "issued"
  | "pending-validation"
  | "revoked"
  | "validation-timed-out";

export interface ManagedCertificate {
  readonly arn: string;
  readonly status: ManagedCertificateStatus;
}

/** `stale` means the tenant changed or vanished since it was observed; the next run decides again. */
export type TenantWrite = "applied" | "stale";

/**
 * `domain-taken`: another CloudFront resource holds the hostname. `rejected`: CloudFront refused
 * the hostname itself, as it does when the hostname's DNS does not point at CloudFront.
 */
export type CreateOutcome = "created" | "exists" | "domain-taken" | "rejected";

export interface EdgeTenants {
  /** Every tenant in the account, on any distribution. */
  readonly list: () => Promise<readonly Tenant[]>;
  readonly get: (name: string) => Promise<Tenant | undefined>;
  /** CloudFront finds a tenant by domain only once that domain is active. */
  readonly holderOf: (hostname: string) => Promise<DomainHolder | undefined>;
  readonly isManaged: (tenant: Pick<Tenant, "arn">) => Promise<boolean>;
  /**
   * CloudFront requests the managed certificate before it checks the hostname, so a create that
   * answers `exists` or `domain-taken` leaves an untagged certificate behind.
   */
  readonly create: (tenant: {
    readonly appId: string;
    readonly hostname: string;
    readonly name: string;
  }) => Promise<CreateOutcome>;
  readonly managedCertificate: (tenant: Tenant) => Promise<ManagedCertificate | undefined>;
  readonly attachCertificate: (tenant: Tenant, certificateArn: string) => Promise<TenantWrite>;
  readonly requestCertificate: (tenant: Tenant) => Promise<TenantWrite>;
  readonly disable: (tenant: Tenant) => Promise<TenantWrite>;
  readonly delete: (tenant: Tenant) => Promise<TenantWrite>;
}

export type AccountCertificate = { readonly arn: string; readonly inUse: boolean } & (
  | { readonly managedByCloudFront: false }
  | { readonly managedByCloudFront: true; readonly hostname: string; readonly requestedAt: Date }
);

export interface Certificates {
  readonly list: () => Promise<readonly AccountCertificate[]>;
  readonly isManaged: (arn: string) => Promise<boolean>;
  readonly markManaged: (arn: string) => Promise<void>;
  readonly delete: (arn: string) => Promise<"deleted" | "in-use" | "gone" | "busy">;
}
