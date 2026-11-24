import { describe, expect, test } from "bun:test";
import { harness } from "@deployments-ai/db/app-domain-testing";
import { fakeEdge } from "./edge.fixture.ts";
import { createDomainReconcilerHandler } from "./handler.ts";
import { makeDomainReconciler } from "./reconcile.ts";

const NOW = new Date("2026-03-01T12:00:00.000Z");

function handlerWorld(
  options: {
    readonly failingCreate?: boolean;
    readonly organizationLimit?: number;
    readonly slowCreate?: boolean;
  } = {},
) {
  let clock = NOW.getTime();
  const now = () => new Date(clock);
  const db = harness();
  const fake = fakeEdge({ now });
  const lines: Readonly<Record<string, unknown>>[] = [];
  const errors: Readonly<Record<string, unknown>>[] = [];
  const handler = createDomainReconcilerHandler({
    emit: (line) => lines.push(line),
    now,
    reconciler: makeDomainReconciler({
      certificateRequestLimits: { organization: options.organizationLimit ?? 5, platform: 12 },
      certificates: fake.certificates,
      domains: db.apps,
      edge: {
        ...fake.edge,
        async create(tenant) {
          if (options.failingCreate) throw new Error("Rate exceeded");
          if (options.slowCreate) clock += 241_000;
          return fake.edge.create(tenant);
        },
      },
      logError: (entry) => errors.push(entry),
      now,
    }),
  });
  return { ...db, errors, fake, handler, lines };
}

describe("app domain reconciler handler", () => {
  test("a scheduled sweep emits quota and status metrics in embedded metric format", async () => {
    const { fake, handler, lines, published } = handlerWorld();
    await published("www.example.com");

    expect(await handler({ kind: "sweep" })).toEqual({ ok: true });
    expect(fake.tenants()).toHaveLength(1);
    expect(lines).toEqual([
      expect.objectContaining({
        AcmCertificates: 1,
        CertificateQuotaUsedPercent: 0.04,
        DomainReconcileFailures: 0,
        DomainTenants: 0,
        PublishedDomains: 1,
        TenantQuotaUsedPercent: 0,
        UntaggedIdleCertificates: 0,
        _aws: expect.objectContaining({ Timestamp: NOW.getTime() }),
      }),
    ]);
    const [line] = lines;
    const metrics = JSON.stringify(line?.["_aws"]);
    expect(metrics).toContain('{"Name":"TenantQuotaUsedPercent","Unit":"Percent"}');
    expect(metrics).toContain('{"Name":"UntaggedIdleCertificates","Unit":"Count"}');
  });

  test("a sweep counts the domains each certificate request budget held back", async () => {
    const { handler, lines, published } = handlerWorld({ organizationLimit: 1 });
    await published("www.example.com");
    await published("signup.example.com");

    expect(await handler({ kind: "sweep" })).toEqual({ ok: true });

    expect(lines).toEqual([
      expect.objectContaining({
        DomainsWithProblem: 1,
        OrganizationCertificateBudgetRefusedDomains: 1,
        PlatformCertificateBudgetRefusedDomains: 0,
      }),
    ]);
    expect(JSON.stringify(lines[0]?.["_aws"])).toContain(
      '{"Name":"PlatformCertificateBudgetRefusedDomains","Unit":"Count"}',
    );
  });

  test("a sweep that runs out of time reports the steps it left in DeferredReconcileSteps", async () => {
    const { handler, lines, published } = handlerWorld({ slowCreate: true });
    await published("alpha.example.com");
    await published("beta.example.com");

    expect(await handler({ kind: "sweep" })).toEqual({ ok: true });

    expect(lines.map((line) => line["DeferredReconcileSteps"])).toEqual([1]);
    expect(JSON.stringify(lines[0]?.["_aws"])).toContain(
      '{"Name":"DeferredReconcileSteps","Unit":"Count"}',
    );
  });

  test("a sweep with failed steps still emits its metrics, then fails the invocation", async () => {
    const { errors, handler, lines, published } = handlerWorld({ failingCreate: true });
    const { verified } = await published("www.example.com");

    const failure = await handler({ kind: "sweep" }).catch((error: unknown) => error);
    expect(failure).toEqual(new Error("1 app domain reconciliation steps failed; see the logs."));
    expect(lines.map((line) => line["DomainReconcileFailures"])).toEqual([1]);
    expect(errors).toEqual([
      {
        domainId: verified.data.id,
        error: "Rate exceeded",
        message: "App domain reconciliation step failed.",
      },
    ]);
  });

  test("a sweep that records a domain problem the edge reported succeeds", async () => {
    const { errors, fake, handler, lines, published } = handlerWorld();
    await published("www.example.com");
    fake.pointDnsElsewhere("www.example.com");

    expect(await handler({ kind: "sweep" })).toEqual({ ok: true });
    expect(
      lines.map((line) => [line["DomainReconcileFailures"], line["DomainsWithProblem"]]),
    ).toEqual([[0, 1]]);
    expect(errors).toEqual([]);
  });

  test("a domain event reconciles only that domain and emits no metrics", async () => {
    const { fake, handler, lines, published } = handlerWorld();
    const { verified } = await published("www.example.com");
    await published("other.example.com");

    await handler({
      appId: verified.data.appId,
      domainId: verified.data.id,
      kind: "domain",
      organizationId: verified.data.organizationId,
      refresh: false,
    });

    expect(fake.tenants().map((tenant) => tenant.hostname)).toEqual(["www.example.com"]);
    expect(lines).toEqual([]);
  });

  test("rejects an event outside the contract", async () => {
    const { handler } = handlerWorld();

    const failure = await handler({ domainId: "not-a-ulid", kind: "domain" }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
  });
});
