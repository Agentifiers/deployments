import {
  isPublishedAppDomain,
  type AppDomainCertificateSearch,
  type AppDomainProblem,
  type AppDomainReconciliation,
  type CertificateRequestGrant,
  type CertificateRequestLimits,
  type PublishedAppDomain,
  type Ulid,
} from "@deployments-ai/db";
import {
  tenantName,
  type AccountCertificate,
  type Certificates,
  type CreateOutcome,
  type DomainHolder,
  type EdgeTenants,
  type ManagedCertificateStatus,
  type Tenant,
} from "./edge.ts";

type ProblemCode = AppDomainProblem["code"];

type ObservedProblem = Omit<AppDomainProblem, "message">;

const LIMIT_PROBLEMS = {
  "organization-spent": "organization_certificate_limit",
  "platform-spent": "platform_certificate_limit",
} as const satisfies Record<Exclude<CertificateRequestGrant, "granted">, ProblemCode>;

/** True for the problems that mean a daily certificate request budget refused the latest request. */
const BUDGET_REFUSED: Record<ProblemCode, boolean> = {
  certificate_failed: false,
  certificate_timed_out: false,
  domain_conflict: false,
  edge_rejected: false,
  organization_certificate_limit: true,
  platform_certificate_limit: true,
  previous_tenant_draining: false,
};

type CertificateStep =
  | { readonly kind: "attach" }
  | { readonly kind: "wait" }
  | { readonly kind: "renew"; readonly problem: ProblemCode };

const CERTIFICATE_STEPS: Record<ManagedCertificateStatus, CertificateStep> = {
  expired: { kind: "renew", problem: "certificate_failed" },
  failed: { kind: "renew", problem: "certificate_failed" },
  inactive: { kind: "wait" },
  issued: { kind: "attach" },
  "pending-validation": { kind: "wait" },
  revoked: { kind: "renew", problem: "certificate_failed" },
  "validation-timed-out": { kind: "renew", problem: "certificate_timed_out" },
};

const FIRST_CREATE_RETRY_MS = 10 * 60 * 1_000;
const LAST_CREATE_RETRY_MS = 24 * 60 * 60 * 1_000;

/** ACM stamps a certificate with its own clock, which may run ahead of or behind Lambda's. */
const CLOCK_SKEW_MS = 5_000;

/**
 * ACM listed a new certificate up to 1.6 s after the rejected create that requested it returned
 * (measured), so the listing right after that create can miss it. Sweeps keep looking for an hour,
 * which outlasts that lag and a few deferred or failed sweeps.
 */
const CERTIFICATE_SEARCH_MS = 60 * 60 * 1_000;

/**
 * Sweeps stop searching an hour after a create, so an untagged certificate an hour older than that
 * which nothing uses or references is one the reconciler will never tag or delete.
 */
const UNTAGGED_IDLE_MS = 2 * 60 * 60 * 1_000;

/** Lambda stops a run at 300 s; a sweep starts no step after 240 s, so the step in flight ends. */
const SWEEP_WORK_MS = 240_000;

/**
 * The backoff doubles from 10 minutes to one create a day. It counts from the latest rejected
 * create, so recording a problem again, or a different one, never moves it.
 */
function nextCreateAt({ rejectedCreates }: ObservedProblem) {
  if (!rejectedCreates) return undefined;
  const delay = Math.min(
    FIRST_CREATE_RETRY_MS * 2 ** (rejectedCreates.count - 1),
    LAST_CREATE_RETRY_MS,
  );
  return new Date(Date.parse(rejectedCreates.latestAt) + delay);
}

/**
 * Budgets refill at 00:00 UTC. A create takes from a budget only once its backoff has ended, so a
 * refusal never waits on the backoff as well.
 */
function nextRequestAt({ observedAt }: ObservedProblem) {
  const tomorrow = new Date(observedAt);
  tomorrow.setUTCHours(24, 0, 0, 0);
  return tomorrow;
}

function retryWithin(problem: ObservedProblem, fallback: string) {
  const next = nextCreateAt(problem);
  return next ? `after ${next.toISOString()}` : fallback;
}

const PROBLEM_MESSAGES: Record<
  ProblemCode,
  (hostname: string, problem: ObservedProblem) => string
> = {
  certificate_failed: (hostname) =>
    `The TLS certificate for ${hostname} could not be issued. Check that ${hostname} points at the routing endpoint, then refresh the domain to request a new one.`,
  certificate_timed_out: (hostname) =>
    `TLS certificate validation for ${hostname} timed out. Check that ${hostname} points at the routing endpoint, then refresh the domain to request a new one.`,
  domain_conflict: (hostname, problem) =>
    `${hostname} is already served by another CloudFront resource. Remove it there; the platform tries again ${retryWithin(problem, "within 5 minutes of its removal")}.`,
  edge_rejected: (hostname, problem) =>
    `CloudFront rejected ${hostname}, usually because its CNAME record does not point at the routing endpoint yet. Fix the record; the platform tries again ${retryWithin(problem, "within 5 minutes")}.`,
  organization_certificate_limit: (hostname, problem) =>
    `${hostname} needs a TLS certificate, and your organization has used every certificate request it may make today. The platform requests one after ${nextRequestAt(problem).toISOString()}.`,
  platform_certificate_limit: (hostname, problem) =>
    `${hostname} needs a TLS certificate, and the platform has used every certificate request it may make today. It requests one after ${nextRequestAt(problem).toISOString()}.`,
  previous_tenant_draining: (hostname) =>
    `An earlier attachment of ${hostname} is still being removed from the edge. Setup continues once it is gone, usually within minutes.`,
};

export interface DomainReference {
  readonly appId: Ulid;
  readonly domainId: Ulid;
  readonly organizationId: Ulid;
}

export interface SweepReport {
  readonly certificates: {
    readonly account: number;
    readonly cloudFrontManaged: number;
    readonly deleted: number;
    /**
     * CloudFront-managed certificates over two hours old that carry no tag, that are not in use, and
     * that no listed tenant has attached or requested. The reconciler never deletes them.
     */
    readonly untaggedIdle: number;
  };
  readonly domains: {
    readonly active: number;
    /** Domains whose latest certificate request a daily budget refused, by budget. */
    readonly certificateBudgetRefused: { readonly organization: number; readonly platform: number };
    readonly published: number;
    readonly withProblem: number;
  };
  /** Steps left for the next sweep because this one ran out of time. */
  readonly deferred: number;
  readonly failures: number;
  readonly tenants: {
    readonly deployed: number;
    readonly disabled: number;
    readonly draining: number;
    readonly inProgress: number;
    readonly total: number;
    readonly unmanaged: number;
  };
}

export interface DomainReconcilerDependencies {
  readonly certificateRequestLimits: CertificateRequestLimits;
  readonly certificates: Certificates;
  readonly domains: AppDomainReconciliation;
  readonly edge: EdgeTenants;
  readonly logError: (entry: Readonly<Record<string, unknown>>) => void;
  readonly now: () => Date;
}

/**
 * Runs must not overlap: the function's reserved concurrency of 1 makes it the only writer. A
 * disabled tenant is never re-enabled: it drains even while its domain is still wanted. Every
 * call that makes CloudFront request a certificate first spends one daily request of the domain's
 * organization and of the platform, which keeps the account under its ACM quota.
 */
export interface DomainReconciler {
  /** `refresh` re-requests a failed or timed-out certificate. */
  readonly reconcileDomain: (
    reference: DomainReference,
    options: { readonly refresh: boolean },
  ) => Promise<void>;
  readonly sweep: () => Promise<SweepReport>;
}

export function makeDomainReconciler(dependencies: DomainReconcilerDependencies): DomainReconciler {
  const { certificateRequestLimits, certificates, domains, edge, logError, now } = dependencies;

  async function recordProblem(domain: PublishedAppDomain, problem: ObservedProblem | null) {
    const next = await domains.recordDomainProblem({
      domain,
      problem: problem && {
        ...problem,
        message: PROBLEM_MESSAGES[problem.code](domain.data.hostname, problem),
      },
    });
    return next && isPublishedAppDomain(next) ? next : domain;
  }

  /** Resolves the problem to record when a budget refuses the request. */
  async function spendCertificateRequest(domain: PublishedAppDomain) {
    const grant = await domains.takeCertificateRequest({
      limits: certificateRequestLimits,
      organizationId: domain.data.organizationId,
    });
    return grant === "granted" ? undefined : LIMIT_PROBLEMS[grant];
  }

  /**
   * The create backoff survives every problem but one: a draining tenant of our own explains the
   * rejections, so the create may run as soon as it is gone.
   */
  async function setProblem(domain: PublishedAppDomain, code: ProblemCode | null) {
    const current = domain.data.state.problem;
    const promiseLapsed =
      current !== null && BUDGET_REFUSED[current.code] && nextRequestAt(current) <= now();
    if ((current?.code ?? null) === code && !promiseLapsed) return domain;
    const rejectedCreates =
      code === "previous_tenant_draining" ? undefined : current?.rejectedCreates;
    return recordProblem(
      domain,
      code && {
        code,
        observedAt: now().toISOString(),
        ...(rejectedCreates ? { rejectedCreates } : {}),
      },
    );
  }

  async function recordSearches(
    domain: PublishedAppDomain,
    certificateSearches: readonly AppDomainCertificateSearch[],
  ) {
    const next = await domains.recordCertificateSearches({ certificateSearches, domain });
    return next && isPublishedAppDomain(next) ? next : domain;
  }

  async function adoptCertificatesRequestedDuring(
    domain: PublishedAppDomain,
    search: AppDomainCertificateSearch,
    listed: readonly AccountCertificate[],
  ) {
    const from = Date.parse(search.startedAt) - CLOCK_SKEW_MS;
    const to = Date.parse(search.endedAt) + CLOCK_SKEW_MS;
    let found = false;
    for (const certificate of listed) {
      if (
        certificate.managedByCloudFront &&
        certificate.hostname === domain.data.hostname &&
        certificate.requestedAt.getTime() >= from &&
        certificate.requestedAt.getTime() <= to
      ) {
        await certificates.markManaged(certificate.arn);
        found = true;
      }
    }
    return found;
  }

  async function adoptLateCertificates(
    domain: PublishedAppDomain,
    listed: readonly AccountCertificate[],
  ) {
    const searches = domain.data.state.certificateSearches ?? [];
    const pending: AppDomainCertificateSearch[] = [];
    for (const search of searches) {
      const found = await adoptCertificatesRequestedDuring(domain, search, listed);
      const searching = now().getTime() - Date.parse(search.endedAt) <= CERTIFICATE_SEARCH_MS;
      if (!found && searching) pending.push(search);
    }
    return pending.length === searches.length ? domain : recordSearches(domain, pending);
  }

  async function create(domain: PublishedAppDomain) {
    const { appId, hostname, id } = domain.data;
    const { problem } = domain.data.state;
    const retryAt = problem && nextCreateAt(problem);
    if (retryAt && now() < retryAt) return domain;
    const refused = await spendCertificateRequest(domain);
    if (refused) return setProblem(domain, refused);
    const startedAt = now().toISOString();
    let outcome: CreateOutcome | undefined;
    let searched = domain;
    try {
      outcome = await edge.create({ appId, hostname, name: tenantName(id) });
    } finally {
      // A create that did not create the tenant may leave behind the certificate it requested.
      if (outcome !== "created") {
        const search = { endedAt: now().toISOString(), startedAt };
        if (!(await adoptCertificatesRequestedDuring(domain, search, await certificates.list()))) {
          searched = await recordSearches(domain, [
            ...(domain.data.state.certificateSearches ?? []),
            search,
          ]);
        }
      }
    }
    if (outcome === "created" || outcome === "exists") return setProblem(searched, null);
    const rejectedAt = now().toISOString();
    return recordProblem(searched, {
      code: outcome === "domain-taken" ? "domain_conflict" : "edge_rejected",
      observedAt: rejectedAt,
      rejectedCreates: { count: (problem?.rejectedCreates?.count ?? 0) + 1, latestAt: rejectedAt },
    });
  }

  async function serve(
    domain: PublishedAppDomain,
    tenant: Tenant | undefined,
    options: {
      readonly findHolder: (hostname: string) => Promise<DomainHolder | undefined>;
      readonly refresh: boolean;
    },
  ): Promise<PublishedAppDomain> {
    if (!tenant) {
      const holder = await options.findHolder(domain.data.hostname);
      if (!holder) return create(domain);
      const draining = holder.onDistribution && (await edge.isManaged(holder));
      return setProblem(domain, draining ? "previous_tenant_draining" : "domain_conflict");
    }
    if (!tenant.enabled) {
      const managed = await edge.isManaged(tenant);
      return setProblem(domain, managed ? "previous_tenant_draining" : "domain_conflict");
    }
    const checkedAtActivation =
      domain.data.state.kind === "active" && tenant.certificateArn !== undefined;
    if (!checkedAtActivation && !(await edge.isManaged(tenant))) {
      return setProblem(domain, "domain_conflict");
    }
    if (tenant.certificateArn) {
      if (tenant.domainActive && tenant.deployed && domain.data.state.kind === "verified") {
        const active = await domains.activateDomain(domain);
        return active && isPublishedAppDomain(active) ? active : domain;
      }
      return setProblem(domain, null);
    }
    const certificate = await edge.managedCertificate(tenant);
    if (!certificate) {
      const refused = await spendCertificateRequest(domain);
      if (refused) return setProblem(domain, refused);
      await edge.requestCertificate(tenant);
      return setProblem(domain, null);
    }
    await certificates.markManaged(certificate.arn);
    const step = CERTIFICATE_STEPS[certificate.status];
    switch (step.kind) {
      case "attach":
        await edge.attachCertificate(tenant, certificate.arn);
        return setProblem(domain, null);
      case "wait":
        return setProblem(domain, null);
      case "renew": {
        const problem = domain.data.state.problem;
        const requested = options.refresh || (problem !== null && BUDGET_REFUSED[problem.code]);
        if (!requested) return setProblem(domain, step.problem);
        const refused = await spendCertificateRequest(domain);
        if (refused) return setProblem(domain, refused);
        const renewed = (await edge.requestCertificate(tenant)) === "applied";
        return setProblem(domain, renewed ? null : step.problem);
      }
      default: {
        const exhaustive: never = step;
        return exhaustive;
      }
    }
  }

  async function drain(tenant: Tenant): Promise<"draining" | "unmanaged"> {
    if (!(await edge.isManaged(tenant))) return "unmanaged";
    if (tenant.enabled) {
      await edge.disable(tenant);
      return "draining";
    }
    if (!tenant.deployed) return "draining";
    const certificate = await edge.managedCertificate(tenant);
    if (certificate) await certificates.markManaged(certificate.arn);
    await edge.delete(tenant);
    return "draining";
  }

  return {
    async reconcileDomain(reference, options) {
      const record = await domains.findDomain(reference);
      const domain = record && isPublishedAppDomain(record) ? record : undefined;
      const tenant = await edge.get(tenantName(reference.domainId));
      if (domain) {
        await serve(domain, tenant, {
          findHolder: edge.holderOf,
          refresh: options.refresh,
        });
      }
      if (tenant && (!domain || !tenant.enabled)) await drain(tenant);
    },

    async sweep(): Promise<SweepReport> {
      const deadline = now().getTime() + SWEEP_WORK_MS;
      // Certificates before tenants before records: a tenant that references a listed certificate
      // is in the snapshot, and a tenant in the snapshot was created after its record was published.
      const accountCertificates = await certificates.list();
      const tenants = await edge.list();
      const published = await domains.listPublishedDomains();
      const ours = tenants.filter((tenant) => tenant.onDistribution);
      const tenantsByName = new Map(ours.map((tenant) => [tenant.name, tenant]));
      const tenantsByHostname = Map.groupBy(tenants, (tenant) => tenant.hostname);
      const attached = new Set(tenants.map((tenant) => tenant.certificateArn));
      const publishedNames = new Set(published.map((domain) => tenantName(domain.data.id)));
      const publishedByHostname = Map.groupBy(published, (domain): string => domain.data.hostname);
      let deferred = 0;
      let failures = 0;

      async function isolated<Result>(
        subject: Readonly<Record<string, string>>,
        work: () => Promise<Result>,
      ) {
        if (now().getTime() >= deadline) {
          deferred += 1;
          return undefined;
        }
        try {
          return await work();
        } catch (cause) {
          failures += 1;
          logError({
            ...subject,
            error: cause instanceof Error ? cause.message : String(cause),
            message: "App domain reconciliation step failed.",
          });
          return undefined;
        }
      }

      const settled: PublishedAppDomain[] = [];
      for (const domain of published) {
        const tenant = tenantsByName.get(tenantName(domain.data.id));
        settled.push(
          (await isolated({ domainId: domain.data.id }, async () =>
            serve(await adoptLateCertificates(domain, accountCertificates), tenant, {
              findHolder: async (hostname) => tenantsByHostname.get(hostname)?.[0],
              refresh: false,
            }),
          )) ?? domain,
        );
      }

      let draining = 0;
      let unmanaged = 0;
      for (const tenant of ours) {
        if (publishedNames.has(tenant.name) && tenant.enabled) continue;
        const outcome = await isolated({ tenantId: tenant.id }, () => drain(tenant));
        if (outcome === "draining") draining += 1;
        if (outcome === "unmanaged") unmanaged += 1;
      }

      async function referencedBy(holders: readonly (Tenant | undefined)[], arn: string) {
        for (const holder of holders) {
          if (holder && (await edge.managedCertificate(holder))?.arn === arn) return true;
        }
        return false;
      }

      let deleted = 0;
      let untaggedIdle = 0;
      for (const certificate of accountCertificates) {
        if (
          !certificate.managedByCloudFront ||
          certificate.inUse ||
          attached.has(certificate.arn)
        ) {
          continue;
        }
        await isolated({ certificateArn: certificate.arn }, async () => {
          const listedHolders = tenantsByHostname.get(certificate.hostname) ?? [];
          if (!(await certificates.isManaged(certificate.arn))) {
            const age = now().getTime() - certificate.requestedAt.getTime();
            if (age > UNTAGGED_IDLE_MS && !(await referencedBy(listedHolders, certificate.arn))) {
              untaggedIdle += 1;
            }
            return;
          }
          // ACM does not count a pending certificate as in use until its tenant attaches it. Our own
          // tenants are also read by name, so one the listing misses still keeps its certificate.
          const ownHolders = await Promise.all(
            (publishedByHostname.get(certificate.hostname) ?? []).map((domain) =>
              edge.get(tenantName(domain.data.id)),
            ),
          );
          if (await referencedBy([...listedHolders, ...ownHolders], certificate.arn)) return;
          if ((await certificates.delete(certificate.arn)) === "deleted") deleted += 1;
        });
      }

      return {
        certificates: {
          account: accountCertificates.length,
          cloudFrontManaged: accountCertificates.filter(
            (certificate) => certificate.managedByCloudFront,
          ).length,
          deleted,
          untaggedIdle,
        },
        domains: {
          active: settled.filter((domain) => domain.data.state.kind === "active").length,
          certificateBudgetRefused: {
            organization: settled.filter(
              ({ data: { state } }) => state.problem?.code === "organization_certificate_limit",
            ).length,
            platform: settled.filter(
              ({ data: { state } }) => state.problem?.code === "platform_certificate_limit",
            ).length,
          },
          published: settled.length,
          withProblem: settled.filter((domain) => domain.data.state.problem !== null).length,
        },
        deferred,
        failures,
        tenants: {
          deployed: ours.filter((tenant) => tenant.deployed).length,
          disabled: ours.filter((tenant) => !tenant.enabled).length,
          draining,
          inProgress: ours.filter((tenant) => !tenant.deployed).length,
          total: ours.length,
          unmanaged,
        },
      };
    },
  };
}
