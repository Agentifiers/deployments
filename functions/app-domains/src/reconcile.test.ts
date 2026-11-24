import { describe, expect, test } from "bun:test";
import type {
  AppDomainReconciliation,
  AppRecord,
  CertificateRequestLimits,
  PublishedAppDomain,
} from "@deployments-ai/db";
import { harness, OTHER_ORGANIZATION, owner } from "@deployments-ai/db/app-domain-testing";
import { tenantName, type EdgeTenants, type Tenant } from "./edge.ts";
import { fakeEdge } from "./edge.fixture.ts";
import { makeDomainReconciler } from "./reconcile.ts";

const NOW = Date.parse("2026-03-01T12:00:00.000Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Nine rejected creates put the next one a day after the latest, which was a day ago. */
async function rejectedADayAgo(domains: AppDomainReconciliation, domain: PublishedAppDomain) {
  await domains.recordDomainProblem({
    domain,
    problem: {
      code: "edge_rejected",
      message: "Rejected.",
      observedAt: new Date(NOW - DAY).toISOString(),
      rejectedCreates: { count: 9, latestAt: new Date(NOW - DAY).toISOString() },
    },
  });
}

function world(
  overrides: {
    readonly domains?: (domains: AppDomainReconciliation) => Partial<AppDomainReconciliation>;
    readonly edge?: (edge: EdgeTenants) => Partial<EdgeTenants>;
    readonly limits?: CertificateRequestLimits;
  } = {},
) {
  let clock = NOW;
  const now = () => new Date(clock);
  const db = harness({ now });
  const fake = fakeEdge({ now });
  const errors: Readonly<Record<string, unknown>>[] = [];
  const reconciler = makeDomainReconciler({
    certificateRequestLimits: overrides.limits ?? { organization: 100, platform: 100 },
    certificates: fake.certificates,
    domains: { ...db.apps, ...overrides.domains?.(db.apps) },
    edge: { ...fake.edge, ...overrides.edge?.(fake.edge) },
    logError: (entry) => errors.push(entry),
    now,
  });
  async function find(domain: PublishedAppDomain) {
    return db.apps.findDomain({
      appId: domain.data.appId,
      domainId: domain.data.id,
      organizationId: domain.data.organizationId,
    });
  }
  async function state(domain: PublishedAppDomain) {
    const record = await find(domain);
    if (!record) return "detached";
    const { state: current } = record.data;
    return current.kind === "unverified"
      ? current.kind
      : `${current.kind}${current.problem ? `:${current.problem.code}` : ""}`;
  }
  async function detach(app: AppRecord, domain: PublishedAppDomain) {
    const latest = await db.apps.getDomain({ app, domainId: domain.data.id });
    if (latest) await db.apps.detachDomain({ actor: owner, app, domain: latest });
  }
  return {
    ...db,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    detach,
    errors,
    fake,
    find,
    reconciler,
    state,
  };
}

const reference = (domain: PublishedAppDomain) => ({
  appId: domain.data.appId,
  domainId: domain.data.id,
  organizationId: domain.data.organizationId,
});

describe("app domain reconciler", () => {
  test("creates the tenant, attaches the issued certificate, and activates the domain once it serves", async () => {
    const { domainEvents, errors, fake, published, reconciler, state } = world();
    const { verified } = await published("www.example.com");
    const name = tenantName(verified.data.id);

    await reconciler.sweep();
    expect(fake.tenants()).toEqual([
      {
        certificate: "none",
        domainActive: false,
        enabled: true,
        hostname: "www.example.com",
        name,
      },
    ]);
    expect(await state(verified)).toBe("verified");

    fake.settleCertificate("www.example.com", "issued");
    await reconciler.sweep();
    expect(fake.tenants()).toEqual([
      {
        certificate: "attached",
        domainActive: true,
        enabled: true,
        hostname: "www.example.com",
        name,
      },
    ]);
    expect(await state(verified)).toBe("verified");

    fake.propagate();
    const report = await reconciler.sweep();
    expect(await state(verified)).toBe("active");
    expect(report).toEqual({
      certificates: { account: 2, cloudFrontManaged: 1, deleted: 0, untaggedIdle: 0 },
      domains: {
        active: 1,
        certificateBudgetRefused: { organization: 0, platform: 0 },
        published: 1,
        withProblem: 0,
      },
      deferred: 0,
      failures: 0,
      tenants: { deployed: 1, disabled: 0, draining: 0, inProgress: 0, total: 1, unmanaged: 0 },
    });
    expect(fake.managedCertificates()).toEqual([
      { hostname: "www.example.com", inUse: true, status: "issued", tagged: true },
    ]);
    expect(domainEvents().map((event) => [event.type, event.version])).toEqual([
      ["app.domain.attached", 1],
      ["app.domain.verified", 2],
      ["app.domain.activated", 3],
    ]);

    await reconciler.sweep();
    expect(fake.writes()).toEqual([`create ${name}`, `attach-certificate ${name}`]);
    expect(errors).toEqual([]);
  });

  test("a tenant created for a domain detached mid-run is disabled, then deleted with its certificate", async () => {
    let detachDuringListing: (() => Promise<void>) | undefined;
    const context = world({
      domains: (domains) => ({
        async listPublishedDomains() {
          const listed = await domains.listPublishedDomains();
          const detach = detachDuringListing;
          detachDuringListing = undefined;
          await detach?.();
          return listed;
        },
      }),
    });
    const { apps, fake, published, reconciler, state } = context;
    const { app, verified } = await published("www.example.com");
    detachDuringListing = () => apps.detachDomain({ actor: owner, app, domain: verified });
    const name = tenantName(verified.data.id);

    await reconciler.sweep();
    expect(await state(verified)).toBe("detached");
    expect(fake.tenants().map((tenant) => [tenant.name, tenant.enabled])).toEqual([[name, true]]);

    await reconciler.sweep();
    expect(fake.tenants().map((tenant) => [tenant.name, tenant.enabled])).toEqual([[name, false]]);

    fake.propagate();
    await reconciler.sweep();
    expect(fake.tenants()).toEqual([]);
    expect(fake.managedCertificates()).toEqual([]);
    expect(fake.writes()).toEqual([
      `create ${name}`,
      `disable ${name}`,
      `delete ${name}`,
      "delete-certificate www.example.com",
    ]);
  });

  test("detach disables the tenant at once through the scoped run", async () => {
    const { apps, fake, published, reconciler } = world();
    const { app, verified } = await published("www.example.com");
    await reconciler.sweep();

    await apps.detachDomain({ actor: owner, app, domain: verified });
    await reconciler.reconcileDomain(reference(verified), { refresh: false });

    expect(fake.tenants().map((tenant) => tenant.enabled)).toEqual([false]);
  });

  test("a disabled tenant is never re-enabled; the domain waits for its deletion and gets a new tenant", async () => {
    const { errors, fake, published, reconciler, state } = world();
    const { verified } = await published("www.example.com");
    const name = tenantName(verified.data.id);
    await reconciler.sweep();
    const [created] = await fake.edge.list();
    if (!created) throw new Error("Expected the created tenant.");
    await fake.edge.disable(created);

    await reconciler.sweep();
    expect(fake.tenants().map((tenant) => tenant.enabled)).toEqual([false]);
    expect(await state(verified)).toBe("verified:previous_tenant_draining");

    fake.propagate();
    await reconciler.sweep();
    expect(fake.tenants()).toEqual([]);

    await reconciler.sweep();
    expect(fake.tenants().map((tenant) => tenant.enabled)).toEqual([true]);
    expect(await state(verified)).toBe("verified");
    expect(fake.writes()).toEqual([
      `create ${name}`,
      `disable ${name}`,
      `delete ${name}`,
      "delete-certificate www.example.com",
      `create ${name}`,
    ]);
    expect(errors).toEqual([]);
  });

  test("a hostname reattached while its old tenant drains records previous_tenant_draining until deletion", async () => {
    const { apps, errors, fake, published, reconciler, state } = world();
    const first = await published("www.example.com");
    await reconciler.sweep();
    await apps.detachDomain({ actor: owner, app: first.app, domain: first.verified });
    const second = await published("www.example.com");

    await reconciler.reconcileDomain(reference(second.verified), { refresh: true });
    expect(await state(second.verified)).toBe("verified:domain_conflict");
    await reconciler.sweep();
    expect(await state(second.verified)).toBe("verified:previous_tenant_draining");
    fake.propagate();
    await reconciler.sweep();
    await reconciler.sweep();

    expect(fake.tenants().map((tenant) => [tenant.name, tenant.enabled])).toEqual([
      [tenantName(second.verified.data.id), true],
    ]);
    expect(await state(second.verified)).toBe("verified");
    expect(fake.managedCertificates()).toEqual([
      { hostname: "www.example.com", inUse: false, status: "pending-validation", tagged: false },
    ]);
    expect(errors).toEqual([]);
  });

  test("keeps an attached certificate until its tenant is gone, then deletes it", async () => {
    const { advance, detach, fake, published, reconciler } = world();
    const untaggedIdle: number[] = [];
    const sweep = async () => {
      const report = await reconciler.sweep();
      untaggedIdle.push(report.certificates.untaggedIdle);
      return report;
    };
    const { app, verified } = await published("www.example.com");
    await sweep();
    fake.settleCertificate("www.example.com", "issued");
    await sweep();
    fake.propagate();
    await sweep();
    advance(3 * 60 * MINUTE);
    await detach(app, verified);

    await sweep();
    fake.propagate();
    await sweep();
    expect(fake.tenants()).toEqual([]);
    expect(fake.managedCertificates()).toEqual([
      { hostname: "www.example.com", inUse: false, status: "issued", tagged: true },
    ]);

    const report = await sweep();
    expect(report.certificates).toEqual({
      account: 2,
      cloudFrontManaged: 1,
      deleted: 1,
      untaggedIdle: 0,
    });
    expect(fake.managedCertificates()).toEqual([]);
    expect(untaggedIdle).toEqual([0, 0, 0, 0, 0, 0]);
  });

  test("records domain_conflict when another CloudFront resource holds the hostname, and deletes the certificate its rejected create left", async () => {
    const { domainEvents, errors, fake, published, reconciler, state } = world();
    fake.holdElsewhere("www.example.com");
    fake.addLeftoverCertificate("www.example.com", new Date("2026-02-01T00:00:00.000Z"));
    fake.addOtherDistributionTenant("brochure", "shop.example.com");
    const elsewhere = await published("www.example.com");
    const otherDistribution = await published("shop.example.com");

    await reconciler.sweep();
    await reconciler.sweep();
    await reconciler.sweep();

    expect(await state(elsewhere.verified)).toBe("verified:domain_conflict");
    expect(await state(otherDistribution.verified)).toBe("verified:domain_conflict");
    expect(fake.tenants()).toEqual([]);
    expect(fake.writes()).toEqual(["delete-certificate www.example.com"]);
    expect(fake.managedCertificates()).toEqual([
      { hostname: "www.example.com", inUse: false, status: "failed", tagged: false },
      { hostname: "shop.example.com", inUse: true, status: "issued", tagged: false },
    ]);
    expect(errors).toEqual([]);
    expect(
      domainEvents()
        .filter((event) => event.type === "app.domain.problem_recorded")
        .map((event) => [event.payload["hostname"], event.payload["problem"], event.version])
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    ).toEqual([
      ["shop.example.com", "domain_conflict", 3],
      ["www.example.com", "domain_conflict", 3],
    ]);
  });

  test("backs off creates the edge rejected from 10 minutes to one a day, for sweeps and refreshes alike, until one succeeds", async () => {
    const { advance, fake, find, published, reconciler, state } = world();
    fake.holdElsewhere("www.example.com");
    const { verified } = await published("www.example.com");

    await reconciler.sweep();
    expect((await find(verified))?.data.state).toMatchObject({
      problem: {
        code: "domain_conflict",
        message:
          "www.example.com is already served by another CloudFront resource. Remove it there; the platform tries again after 2026-03-01T12:10:00.000Z.",
        observedAt: "2026-03-01T12:00:00.000Z",
        rejectedCreates: { count: 1, latestAt: "2026-03-01T12:00:00.000Z" },
      },
    });

    const attemptMinutes = [0];
    let minute = 0;
    for (const due of [10, 30, 70, 150, 310, 630, 1270, 2550, 3990, 5430]) {
      for (const at of [due - 10, due]) {
        advance((at - minute) * MINUTE);
        minute = at;
        const before = fake.createAttempts().length;
        await reconciler.reconcileDomain(reference(verified), {
          refresh: true,
        });
        await reconciler.sweep();
        if (fake.createAttempts().length > before) attemptMinutes.push(minute);
      }
    }

    expect(attemptMinutes).toEqual([0, 10, 30, 70, 150, 310, 630, 1270, 2550, 3990, 5430]);
    expect(fake.managedCertificates()).toEqual([]);

    fake.release("www.example.com");
    advance(24 * 60 * MINUTE);
    await reconciler.sweep();
    expect(await state(verified)).toBe("verified");
    expect((await find(verified))?.data.state).toMatchObject({ problem: null });
    expect(fake.tenants().map((tenant) => tenant.hostname)).toEqual(["www.example.com"]);
  });

  test("starts no step after 240 seconds and leaves the rest to the next sweep", async () => {
    const context = world({
      edge: (edge) => ({
        async create(tenant) {
          context.advance(241_000);
          return edge.create(tenant);
        },
      }),
    });
    const { fake, published, reconciler, state } = context;
    await published("alpha.example.com");
    const late = await published("beta.example.com");

    const report = await reconciler.sweep();
    expect(fake.createAttempts()).toEqual(["alpha.example.com"]);
    expect([report.deferred, report.failures]).toEqual([1, 0]);

    await reconciler.sweep();
    expect(fake.createAttempts()).toEqual(["alpha.example.com", "beta.example.com"]);
    expect(await state(late.verified)).toBe("verified");
  });

  test("keeps the create backoff when the problem changes to a holder that comes and goes", async () => {
    let foreign: Tenant | undefined;
    const { advance, fake, find, published, reconciler } = world({
      edge: (edge) => ({
        list: async () => [...(await edge.list()), ...(foreign ? [foreign] : [])],
      }),
    });
    fake.pointDnsElsewhere("www.example.com");
    const { verified } = await published("www.example.com");
    await reconciler.sweep();
    advance(10 * MINUTE);
    await reconciler.sweep();

    foreign = {
      arn: "arn:aws:cloudfront::123456789012:distribution-tenant/dt_foreign",
      certificateArn: undefined,
      deployed: true,
      domainActive: true,
      enabled: true,
      etag: "E1",
      hostname: "www.example.com",
      id: "dt_foreign",
      name: "someone-else",
      onDistribution: false,
    };
    advance(5 * MINUTE);
    await reconciler.sweep();
    expect((await find(verified))?.data.state).toMatchObject({
      problem: { code: "domain_conflict", rejectedCreates: { count: 2 } },
    });

    foreign = undefined;
    advance(5 * MINUTE);
    await reconciler.sweep();
    expect(fake.createAttempts()).toEqual(["www.example.com", "www.example.com"]);
  });

  test("a create the edge rejects records edge_rejected under the same backoff, and no domain's failure holds back certificate cleanup", async () => {
    const { advance, errors, fake, published, reconciler, state } = world({
      edge: (edge) => ({
        async create(tenant) {
          if (tenant.hostname === "broken.example.org") throw new Error("Rate exceeded");
          return edge.create(tenant);
        },
      }),
    });
    fake.pointDnsElsewhere("www.example.com");
    const { verified } = await published("www.example.com");
    const broken = await published("broken.example.org");
    const orphan = fake.addLeftoverCertificate("old.example.net", new Date(NOW - 60 * MINUTE));
    await fake.certificates.markManaged(orphan);

    const report = await reconciler.sweep();

    expect(await state(verified)).toBe("verified:edge_rejected");
    expect(report.failures).toBe(1);
    expect(errors).toEqual([
      {
        domainId: broken.verified.data.id,
        error: "Rate exceeded",
        message: "App domain reconciliation step failed.",
      },
    ]);
    expect(fake.writes()).toEqual(["delete-certificate old.example.net"]);
    expect(fake.managedCertificates()).toEqual([]);

    fake.pointDnsHere("www.example.com");
    await reconciler.sweep();
    expect(await state(verified)).toBe("verified:edge_rejected");
    advance(10 * MINUTE);
    await reconciler.sweep();
    expect(await state(verified)).toBe("verified");
    expect(fake.createAttempts().filter((hostname) => hostname === "www.example.com")).toEqual([
      "www.example.com",
      "www.example.com",
    ]);
  });

  test("tags only certificates requested during its rejected create, and never deletes one a listed tenant references", async () => {
    const context = world({
      edge: (edge) => ({
        async create(tenant) {
          const outcome = await edge.create(tenant);
          context.fake.addPendingOtherDistributionTenant(
            "operator-site",
            tenant.hostname,
            new Date(NOW + 1_000),
          );
          return outcome;
        },
      }),
    });
    const { errors, fake, published, reconciler, state } = context;
    fake.addLeftoverCertificate("www.example.com", new Date(NOW - 6_000));
    fake.addLeftoverCertificate("www.example.com", new Date(NOW + 6_000));
    fake.holdElsewhere("www.example.com");
    const { verified } = await published("www.example.com");

    await reconciler.sweep();
    expect(fake.managedCertificates()).toEqual([
      {
        hostname: "www.example.com",
        inUse: false,
        status: "failed",
        tagged: false,
      },
      {
        hostname: "www.example.com",
        inUse: false,
        status: "failed",
        tagged: false,
      },
      {
        hostname: "www.example.com",
        inUse: false,
        status: "pending-validation",
        tagged: true,
      },
      {
        hostname: "www.example.com",
        inUse: false,
        status: "pending-validation",
        tagged: true,
      },
    ]);

    await reconciler.sweep();
    await reconciler.sweep();
    expect(fake.managedCertificates()).toEqual([
      {
        hostname: "www.example.com",
        inUse: false,
        status: "failed",
        tagged: false,
      },
      {
        hostname: "www.example.com",
        inUse: false,
        status: "failed",
        tagged: false,
      },
      {
        hostname: "www.example.com",
        inUse: false,
        status: "pending-validation",
        tagged: true,
      },
    ]);
    expect(fake.writes()).toEqual(["delete-certificate www.example.com"]);
    expect(await state(verified)).toBe("verified:domain_conflict");
    expect(errors).toEqual([]);
  });

  test("a later sweep tags and deletes the certificate of a rejected create that ACM listed late", async () => {
    const { advance, errors, fake, find, published, reconciler, state } = world();
    fake.lagListingOfNewCertificates(2_000);
    fake.holdElsewhere("www.example.com");
    const { verified } = await published("www.example.com");

    await reconciler.reconcileDomain(reference(verified), { refresh: true });
    expect(fake.managedCertificates()).toEqual([
      { hostname: "www.example.com", inUse: false, status: "pending-validation", tagged: false },
    ]);

    advance(5 * MINUTE);
    const report = await reconciler.sweep();

    expect(report.certificates.deleted).toBe(1);
    expect(fake.managedCertificates()).toEqual([]);
    expect(fake.writes()).toEqual(["delete-certificate www.example.com"]);
    expect(await state(verified)).toBe("verified:domain_conflict");
    expect((await find(verified))?.data.state).not.toHaveProperty("certificateSearches");
    expect(errors).toEqual([]);
  });

  test("looks for a rejected create's certificate for an hour, then stops", async () => {
    const { advance, errors, fake, published, reconciler } = world();
    fake.pointDnsElsewhere("late.example.com");
    fake.pointDnsElsewhere("never.example.com");
    await published("late.example.com");
    await published("never.example.com");
    await reconciler.sweep();
    fake.lagListingOfNewCertificates(50 * MINUTE);
    fake.addLeftoverCertificate("late.example.com", new Date(NOW + 1_000));
    fake.lagListingOfNewCertificates(70 * MINUTE);
    fake.addLeftoverCertificate("never.example.com", new Date(NOW + 1_000));

    for (let minute = 5; minute <= 75; minute += 5) {
      advance(5 * MINUTE);
      await reconciler.sweep();
    }

    expect(fake.writes()).toEqual(["delete-certificate late.example.com"]);
    expect(fake.managedCertificates()).toEqual([
      { hostname: "never.example.com", inUse: false, status: "failed", tagged: false },
    ]);
    expect(errors).toEqual([]);
  });

  test("counts an untagged certificate that nothing uses or references once it is two hours old", async () => {
    const { advance, detach, fake, published, reconciler } = world();
    fake.lagListingOfNewCertificates(2_000);
    fake.holdElsewhere("www.example.com");
    fake.addPendingOtherDistributionTenant(
      "operator-site",
      "shop.example.com",
      new Date(NOW - DAY),
    );
    const { app, verified } = await published("www.example.com");
    await reconciler.reconcileDomain(reference(verified), { refresh: true });
    await detach(app, verified);

    const counted: [number, number][] = [];
    for (const minute of [5, 60, 120, 125]) {
      advance((minute - (counted.at(-1)?.[0] ?? 0)) * MINUTE);
      counted.push([minute, (await reconciler.sweep()).certificates.untaggedIdle]);
    }

    expect(counted).toEqual([
      [5, 0],
      [60, 0],
      [120, 0],
      [125, 1],
    ]);
    expect(fake.managedCertificates()).toEqual([
      { hostname: "shop.example.com", inUse: false, status: "pending-validation", tagged: false },
      { hostname: "www.example.com", inUse: false, status: "pending-validation", tagged: false },
    ]);
    expect(fake.writes()).toEqual([]);
  });

  test("keeps the tagged pending certificate of its own tenant when the tenant listing misses that tenant", async () => {
    let hidden: string | undefined;
    const { errors, fake, published, reconciler } = world({
      edge: (edge) => ({
        list: async () => (await edge.list()).filter((tenant) => tenant.name !== hidden),
      }),
    });
    const { verified } = await published("www.example.com");
    const name = tenantName(verified.data.id);
    await reconciler.reconcileDomain(reference(verified), { refresh: false });
    await reconciler.reconcileDomain(reference(verified), { refresh: false });

    hidden = name;
    await reconciler.sweep();
    hidden = undefined;
    await reconciler.sweep();
    fake.settleCertificate("www.example.com", "issued");
    await reconciler.sweep();

    expect(fake.tenants().map((tenant) => [tenant.name, tenant.certificate])).toEqual([
      [name, "attached"],
    ]);
    expect(fake.writes()).toEqual([
      `create ${name}`,
      "delete-certificate www.example.com",
      `attach-certificate ${name}`,
    ]);
    expect(errors).toEqual([]);
  });

  test.each([
    ["failed", "verified:certificate_failed"],
    ["validation-timed-out", "verified:certificate_timed_out"],
  ] as const)(
    "a %s certificate is a problem until refresh requests a new one",
    async (status, problem) => {
      const { domainEvents, fake, published, reconciler, state } = world();
      const { verified } = await published("www.example.com");
      await reconciler.sweep();
      fake.settleCertificate("www.example.com", status);

      await reconciler.sweep();
      await reconciler.sweep();
      expect(await state(verified)).toBe(problem);
      expect(fake.managedCertificates().map((certificate) => certificate.status)).toEqual([status]);

      await reconciler.reconcileDomain(reference(verified), { refresh: true });
      expect(await state(verified)).toBe("verified");
      expect(fake.managedCertificates().map((certificate) => certificate.status)).toEqual([
        status,
        "pending-validation",
      ]);

      await reconciler.sweep();
      expect(fake.managedCertificates().map((certificate) => certificate.status)).toEqual([
        "pending-validation",
      ]);
      expect(domainEvents().map((event) => event.type)).toEqual([
        "app.domain.attached",
        "app.domain.verified",
        "app.domain.problem_recorded",
        "app.domain.problem_cleared",
      ]);
    },
  );

  test("leaves untagged tenants alone, including ones that squat a domain's tenant name", async () => {
    const { errors, fake, published, reconciler, state } = world();
    fake.addUntaggedTenant("legacy-site", "www.legacy.example");
    const bare = await published("www.example.com");
    fake.addUntaggedTenant(tenantName(bare.verified.data.id), "www.example.com");
    const serving = await published("shop.example.com");
    fake.addServingUntaggedTenant(tenantName(serving.verified.data.id), "shop.example.com");

    const report = await reconciler.sweep();
    await reconciler.sweep();

    expect(
      fake.tenants().map((tenant) => [tenant.hostname, tenant.enabled, tenant.certificate]),
    ).toEqual([
      ["www.example.com", true, "none"],
      ["shop.example.com", true, "attached"],
      ["www.legacy.example", true, "none"],
    ]);
    expect(await state(bare.verified)).toBe("verified:domain_conflict");
    expect(await state(serving.verified)).toBe("verified:domain_conflict");
    expect(report.tenants.unmanaged).toBe(1);
    expect(fake.writes()).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe("app domain certificate request budgets", () => {
  const UNTIL_MIDNIGHT = 12 * 60 * MINUTE;

  test("a spent organization budget holds creates back until the next UTC day", async () => {
    const { advance, fake, find, published, reconciler, state } = world({
      limits: { organization: 2, platform: 12 },
    });
    await published("alpha.example.com");
    await published("beta.example.com");
    const { verified } = await published("gamma.example.com");

    const report = await reconciler.sweep();
    await reconciler.sweep();

    expect(fake.createAttempts()).toEqual(["alpha.example.com", "beta.example.com"]);
    expect(report.domains.certificateBudgetRefused).toEqual({ organization: 1, platform: 0 });
    expect((await find(verified))?.data.state).toMatchObject({
      problem: {
        code: "organization_certificate_limit",
        message:
          "gamma.example.com needs a TLS certificate, and your organization has used every certificate request it may make today. The platform requests one after 2026-03-02T00:00:00.000Z.",
        observedAt: "2026-03-01T12:00:00.000Z",
      },
    });

    advance(UNTIL_MIDNIGHT - MINUTE);
    await reconciler.sweep();
    expect(fake.createAttempts()).toHaveLength(2);

    advance(MINUTE);
    const nextDay = await reconciler.sweep();
    expect(fake.createAttempts()).toEqual([
      "alpha.example.com",
      "beta.example.com",
      "gamma.example.com",
    ]);
    expect(await state(verified)).toBe("verified");
    expect(nextDay.domains.certificateBudgetRefused).toEqual({ organization: 0, platform: 0 });
  });

  test("a refusal on a later UTC day restates the next request time, whatever the local time zone", async () => {
    const zone = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const { advance, find, published, reconciler } = world({
        limits: { organization: 1, platform: 12 },
      });
      await published("alpha.example.com");
      await published("beta.example.com");
      const { verified } = await published("gamma.example.com");
      await reconciler.sweep();

      advance(UNTIL_MIDNIGHT);
      await reconciler.sweep();

      expect((await find(verified))?.data.state).toMatchObject({
        problem: {
          code: "organization_certificate_limit",
          message:
            "gamma.example.com needs a TLS certificate, and your organization has used every certificate request it may make today. The platform requests one after 2026-03-03T00:00:00.000Z.",
          observedAt: "2026-03-02T00:00:00.000Z",
        },
      });
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  test("a refused request for a tenant without a managed certificate sends nothing until the budget refills", async () => {
    const { advance, fake, published, reconciler, state } = world({
      limits: { organization: 1, platform: 12 },
    });
    const { verified } = await published("www.example.com");
    const name = tenantName(verified.data.id);
    await reconciler.sweep();
    fake.forgetManagedCertificate("www.example.com");

    await reconciler.sweep();
    expect(await state(verified)).toBe("verified:organization_certificate_limit");
    expect(fake.writes()).toEqual([`create ${name}`]);

    advance(UNTIL_MIDNIGHT);
    await reconciler.sweep();
    expect(await state(verified)).toBe("verified");
    expect(fake.writes()).toEqual([`create ${name}`, `request-certificate ${name}`]);
  });

  test("every organization draws on the one platform budget", async () => {
    const { fake, find, published, reconciler } = world({
      limits: { organization: 5, platform: 2 },
    });
    await published("alpha.example.com");
    await published("beta.example.com", OTHER_ORGANIZATION);
    const { verified } = await published("gamma.example.com", OTHER_ORGANIZATION);

    const report = await reconciler.sweep();

    expect(fake.createAttempts()).toEqual(["alpha.example.com", "beta.example.com"]);
    expect(report.domains.certificateBudgetRefused).toEqual({ organization: 0, platform: 1 });
    expect((await find(verified))?.data.state).toMatchObject({
      problem: {
        code: "platform_certificate_limit",
        message:
          "gamma.example.com needs a TLS certificate, and the platform has used every certificate request it may make today. It requests one after 2026-03-02T00:00:00.000Z.",
      },
    });
  });

  test("detaching and attaching a hostname again does not refill the organization's budget", async () => {
    const { advance, detach, fake, published, reconciler, state } = world({
      limits: { organization: 1, platform: 12 },
    });
    const first = await published("www.example.com");
    await reconciler.sweep();
    await detach(first.app, first.verified);
    await reconciler.sweep();
    fake.propagate();
    await reconciler.sweep();
    expect(fake.tenants()).toEqual([]);

    const again = await published("www.example.com");
    await reconciler.reconcileDomain(reference(again.verified), { refresh: true });
    await reconciler.sweep();

    expect(await state(again.verified)).toBe("verified:organization_certificate_limit");
    expect(fake.createAttempts()).toEqual(["www.example.com"]);

    advance(UNTIL_MIDNIGHT);
    await reconciler.sweep();
    expect(fake.createAttempts()).toEqual(["www.example.com", "www.example.com"]);
    expect(await state(again.verified)).toBe("verified");
  });

  test("a refused certificate renewal runs on its own once the budget refills", async () => {
    const { advance, fake, published, reconciler, state } = world({
      limits: { organization: 1, platform: 12 },
    });
    const { verified } = await published("www.example.com");
    await reconciler.sweep();
    fake.settleCertificate("www.example.com", "failed");
    await reconciler.sweep();

    await reconciler.reconcileDomain(reference(verified), { refresh: true });
    await reconciler.sweep();
    expect(await state(verified)).toBe("verified:organization_certificate_limit");
    expect(fake.managedCertificates().map((certificate) => certificate.status)).toEqual(["failed"]);

    advance(UNTIL_MIDNIGHT);
    await reconciler.sweep();
    expect(await state(verified)).toBe("verified");
    expect(fake.managedCertificates().map((certificate) => certificate.status)).toEqual([
      "pending-validation",
    ]);
  });

  test("a refusal writes nothing more while the time it promises still holds", async () => {
    const { advance, domainEvents, published, reconciler } = world({
      limits: { organization: 1, platform: 12 },
    });
    await published("alpha.example.com");
    await published("gamma.example.com");

    await reconciler.sweep();
    advance(5 * MINUTE);
    await reconciler.sweep();
    advance(UNTIL_MIDNIGHT - 10 * MINUTE);
    await reconciler.sweep();

    expect(
      domainEvents()
        .filter((event) => event.type === "app.domain.problem_recorded")
        .map((event) => [event.payload["hostname"], event.payload["problem"], event.version]),
    ).toEqual([["gamma.example.com", "organization_certificate_limit", 3]]);
  });

  test("a problem no budget caused is not recorded again on a later day", async () => {
    const { advance, domainEvents, fake, find, published, reconciler } = world();
    fake.addOtherDistributionTenant("brochure", "shop.example.com");
    const { verified } = await published("shop.example.com");

    await reconciler.sweep();
    advance(UNTIL_MIDNIGHT);
    await reconciler.sweep();
    advance(DAY);
    await reconciler.sweep();

    expect(
      domainEvents()
        .filter((event) => event.type === "app.domain.problem_recorded")
        .map((event) => [event.payload["problem"], event.version]),
    ).toEqual([["domain_conflict", 3]]);
    expect((await find(verified))?.data.state).toMatchObject({
      problem: { code: "domain_conflict", observedAt: "2026-03-01T12:00:00.000Z" },
    });
  });

  test("a refusal restated on a later day keeps the rejected creates and gives the next UTC day", async () => {
    const limits = { organization: 1, platform: 12 };
    const { advance, apps, fake, find, published, reconciler } = world({ limits });
    const { verified } = await published("www.example.com");
    await rejectedADayAgo(apps, verified);
    const spend = () =>
      apps.takeCertificateRequest({ limits, organizationId: verified.data.organizationId });
    expect(await spend()).toBe("granted");

    await reconciler.sweep();
    advance(UNTIL_MIDNIGHT);
    expect(await spend()).toBe("granted");
    await reconciler.sweep();

    expect(fake.createAttempts()).toEqual([]);
    expect((await find(verified))?.data.state).toMatchObject({
      problem: {
        code: "organization_certificate_limit",
        message:
          "www.example.com needs a TLS certificate, and your organization has used every certificate request it may make today. The platform requests one after 2026-03-03T00:00:00.000Z.",
        observedAt: "2026-03-02T00:00:00.000Z",
        rejectedCreates: { count: 9, latestAt: "2026-02-28T12:00:00.000Z" },
      },
    });
  });

  test("a day-long create backoff still gets its create when the organization spends its budget earlier each day", async () => {
    const limits = { organization: 1, platform: 12 };
    const { advance, apps, fake, published, reconciler } = world({ limits });
    const { verified } = await published("www.example.com");
    await rejectedADayAgo(apps, verified);
    const spend = () =>
      apps.takeCertificateRequest({ limits, organizationId: verified.data.organizationId });
    expect(await spend()).toBe("granted");

    const creates: string[] = [];
    for (let hour = 0; hour < 48; hour += 1) {
      const at = new Date(NOW + hour * 60 * MINUTE);
      if (at.getUTCHours() === 6) await spend();
      const before = fake.createAttempts().length;
      await reconciler.sweep();
      if (fake.createAttempts().length > before) creates.push(at.toISOString());
      advance(60 * MINUTE);
    }

    expect(creates).toEqual(["2026-03-02T00:00:00.000Z"]);
  });
});
