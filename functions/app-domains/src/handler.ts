import { Ulid } from "@deployments-ai/db";
import { Schema } from "effect";
import type { DomainReconciler, SweepReport } from "./reconcile.ts";

/** Default per-account quotas: distribution tenants, and ACM certificates in us-east-1. */
const TENANT_QUOTA = 10_000;
const CERTIFICATE_QUOTA = 2_500;

export const ReconcileEvent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("sweep") }),
  Schema.Struct({
    appId: Ulid,
    domainId: Ulid,
    kind: Schema.Literal("domain"),
    organizationId: Ulid,
    refresh: Schema.Boolean,
  }),
]);

const decodeEvent = Schema.decodeUnknownSync(ReconcileEvent);

export function sweepMetrics(report: SweepReport, timestamp: number) {
  const values = {
    AcmCertificates: report.certificates.account,
    ActiveDomains: report.domains.active,
    CertificateQuotaUsedPercent: (report.certificates.account / CERTIFICATE_QUOTA) * 100,
    CloudFrontManagedCertificates: report.certificates.cloudFrontManaged,
    DeferredReconcileSteps: report.deferred,
    DeletedCertificates: report.certificates.deleted,
    DomainReconcileFailures: report.failures,
    DomainTenants: report.tenants.total,
    DomainTenantsDeployed: report.tenants.deployed,
    DomainTenantsDisabled: report.tenants.disabled,
    DomainTenantsDraining: report.tenants.draining,
    DomainTenantsInProgress: report.tenants.inProgress,
    DomainTenantsUnmanaged: report.tenants.unmanaged,
    DomainsWithProblem: report.domains.withProblem,
    OrganizationCertificateBudgetRefusedDomains:
      report.domains.certificateBudgetRefused.organization,
    PlatformCertificateBudgetRefusedDomains: report.domains.certificateBudgetRefused.platform,
    PublishedDomains: report.domains.published,
    TenantQuotaUsedPercent: (report.tenants.total / TENANT_QUOTA) * 100,
    UntaggedIdleCertificates: report.certificates.untaggedIdle,
  };
  return {
    _aws: {
      CloudWatchMetrics: [
        {
          Dimensions: [[]],
          Metrics: Object.keys(values).map((name) => ({
            Name: name,
            Unit: name.endsWith("Percent") ? "Percent" : "Count",
          })),
          Namespace: "DeploymentsAI/Apps",
        },
      ],
      Timestamp: timestamp,
    },
    ...values,
  };
}

export type DomainReconcilerHandler = (input: unknown) => Promise<{ readonly ok: true }>;

export function createDomainReconcilerHandler(dependencies: {
  readonly emit: (line: Readonly<Record<string, unknown>>) => void;
  readonly now: () => Date;
  readonly reconciler: DomainReconciler;
}): DomainReconcilerHandler {
  const { emit, now, reconciler } = dependencies;
  return async (input: unknown) => {
    const event = decodeEvent(input);
    if (event.kind === "domain") {
      await reconciler.reconcileDomain(event, { refresh: event.refresh });
      return { ok: true };
    }
    const report = await reconciler.sweep();
    emit(sweepMetrics(report, now().getTime()));
    // Domain problems are recorded, not thrown; a failure here is the platform's own.
    if (report.failures > 0) {
      throw new Error(`${report.failures} app domain reconciliation steps failed; see the logs.`);
    }
    return { ok: true };
  };
}
