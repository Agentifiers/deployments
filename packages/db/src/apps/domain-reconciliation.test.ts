import { describe, expect, test } from "bun:test";
import { isPublishedAppDomain, type AppDomainRecord } from "../records/app-domains.ts";
import { harness, hostname, owner, system } from "./domain-test-support.ts";
import { OTHER_ORGANIZATION, START } from "./test-support.ts";

function stateOf(domain: AppDomainRecord | undefined) {
  return domain && { state: domain.data.state, version: domain.data.version };
}

function published(domain: AppDomainRecord | undefined) {
  if (!domain || !isPublishedAppDomain(domain)) throw new Error("Expected a published domain.");
  return domain;
}

describe("app domain reconciliation persistence", () => {
  test("lists verified and active domains of every organization and skips unverified and detached ones", async () => {
    const context = harness();
    await context.published("www.example.com");
    await context.published("signup.example.org", OTHER_ORGANIZATION);
    const detached = await context.published("old.example.net");
    await context.apps.detachDomain({ actor: owner, app: detached.app, domain: detached.verified });
    await context.apps.attachDomain({
      actor: owner,
      app: await context.activeApp(),
      hostname: hostname("pending.example.com"),
    });

    const listed = await context.apps.listPublishedDomains();

    expect(listed.map((domain) => domain.data.hostname).sort()).toEqual([
      hostname("signup.example.org"),
      hostname("www.example.com"),
    ]);
  });

  test("finds a domain by organization, app, and domain id", async () => {
    const { apps, published: publish } = harness();
    const { verified } = await publish("www.example.com");

    const found = await apps.findDomain({
      appId: verified.data.appId,
      domainId: verified.data.id,
      organizationId: verified.data.organizationId,
    });

    expect(found?.data.hostname).toBe(hostname("www.example.com"));
  });

  test("activation moves verified to active, clears the problem, and writes one event", async () => {
    const { apps, domainEvents, published: publish } = harness();
    const { verified } = await publish("www.example.com");
    const troubled = published(
      await apps.recordDomainProblem({
        domain: verified,
        problem: { code: "domain_conflict", message: "Held elsewhere.", observedAt: START },
      }),
    );

    const active = await apps.activateDomain(troubled);

    expect(stateOf(active)).toEqual({
      state: {
        activatedAt: START,
        kind: "active",
        problem: null,
        slot: verified.data.state.slot,
        verifiedAt: START,
      },
      version: 4,
    });
    const payload = {
      appId: verified.data.appId,
      domainId: verified.data.id,
      hostname: "www.example.com",
    };
    expect(domainEvents().filter((event) => event.version >= 3)).toEqual([
      {
        payload: { ...payload, problem: "domain_conflict" },
        type: "app.domain.problem_recorded",
        version: 3,
      },
      { payload, type: "app.domain.activated", version: 4 },
    ]);
  });

  test("a stale activation writes nothing and resolves undefined", async () => {
    const { apps, domainEvents, published: publish } = harness();
    const { verified } = await publish("www.example.com");
    await apps.activateDomain(verified);

    const stale = await apps.activateDomain(verified);

    expect(stale).toBeUndefined();
    expect(domainEvents().map((event) => event.type)).toEqual([
      "app.domain.attached",
      "app.domain.verified",
      "app.domain.activated",
    ]);
  });

  test("activation needs a provisioning or active app", async () => {
    const { apps, published: publish } = harness();
    const { app, verified } = await publish("www.example.com");
    await apps.transitionApp({ actor: system, app, transition: { to: "archived" } });

    const result = await apps.activateDomain(verified);

    expect(result).toBeUndefined();
    expect(
      stateOf(
        await apps.findDomain({
          appId: verified.data.appId,
          domainId: verified.data.id,
          organizationId: verified.data.organizationId,
        }),
      ),
    ).toEqual({ state: verified.data.state, version: 2 });
  });

  test("records a problem once per code and clears it with its own event", async () => {
    const { apps, domainEvents, published: publish } = harness();
    const { verified } = await publish("www.example.com");
    const failed = {
      code: "certificate_failed",
      message: "The certificate failed.",
      observedAt: START,
    } as const;

    const recorded = published(
      await apps.recordDomainProblem({ domain: verified, problem: failed }),
    );
    const repeated = await apps.recordDomainProblem({
      domain: recorded,
      problem: { ...failed, message: "Still failed." },
    });
    const cleared = await apps.recordDomainProblem({ domain: recorded, problem: null });

    expect(recorded.data.state).toMatchObject({ kind: "verified", problem: failed });
    expect(repeated).toBe(recorded);
    expect(stateOf(cleared)).toMatchObject({
      state: { kind: "verified", problem: null },
      version: 4,
    });
    expect(domainEvents().map((event) => [event.type, event.version])).toEqual([
      ["app.domain.attached", 1],
      ["app.domain.verified", 2],
      ["app.domain.problem_recorded", 3],
      ["app.domain.problem_cleared", 4],
    ]);
  });

  test("records each rejected create under the same code, with its count in the event", async () => {
    const { apps, domainEvents, published: publish } = harness();
    const { verified } = await publish("www.example.com");
    const conflict = {
      code: "domain_conflict",
      message: "Held elsewhere.",
      observedAt: START,
    } as const;

    const first = published(
      await apps.recordDomainProblem({
        domain: verified,
        problem: { ...conflict, rejectedCreates: { count: 1, latestAt: START } },
      }),
    );
    const second = published(
      await apps.recordDomainProblem({
        domain: first,
        problem: { ...conflict, rejectedCreates: { count: 2, latestAt: START } },
      }),
    );
    const repeated = await apps.recordDomainProblem({
      domain: second,
      problem: { ...conflict, rejectedCreates: { count: 2, latestAt: START } },
    });

    expect(second.data.state.problem).toEqual({
      ...conflict,
      rejectedCreates: { count: 2, latestAt: START },
    });
    expect(repeated).toBe(second);
    expect(
      domainEvents()
        .filter((event) => event.type === "app.domain.problem_recorded")
        .map((event) => [event.payload["rejectedCreates"], event.version]),
    ).toEqual([
      [1, 3],
      [2, 4],
    ]);
  });

  test("records the same problem again when it is observed later", async () => {
    const { apps, domainEvents, published: publish } = harness();
    const { verified } = await publish("www.example.com");
    const refused = {
      code: "organization_certificate_limit",
      message: "Requests one after 2026-10-09T00:00:00.000Z.",
      observedAt: START,
    } as const;
    const first = published(await apps.recordDomainProblem({ domain: verified, problem: refused }));

    const restated = await apps.recordDomainProblem({
      domain: first,
      problem: {
        ...refused,
        message: "Requests one after 2026-10-10T00:00:00.000Z.",
        observedAt: "2026-10-09T00:00:00.000Z",
      },
    });

    expect(stateOf(restated)).toMatchObject({
      state: {
        problem: {
          message: "Requests one after 2026-10-10T00:00:00.000Z.",
          observedAt: "2026-10-09T00:00:00.000Z",
        },
      },
      version: 4,
    });
    expect(
      domainEvents()
        .filter((event) => event.version >= 3)
        .map((event) => event.type),
    ).toEqual(["app.domain.problem_recorded", "app.domain.problem_recorded"]);
  });

  test("records the rejected creates whose certificate is still sought, keeps them through activation, and clears them", async () => {
    const { apps, domainEvents, published: publish } = harness();
    const { verified } = await publish("www.example.com");
    const search = { endedAt: "2026-10-08T12:00:02.000Z", startedAt: START };

    const searching = published(
      await apps.recordCertificateSearches({ certificateSearches: [search], domain: verified }),
    );
    const active = published(await apps.activateDomain(searching));
    const found = await apps.recordCertificateSearches({ certificateSearches: [], domain: active });

    expect(searching.data.state).toMatchObject({ certificateSearches: [search], kind: "verified" });
    expect(active.data.state).toMatchObject({ certificateSearches: [search], kind: "active" });
    expect(found?.data.state).not.toHaveProperty("certificateSearches");
    expect(
      domainEvents()
        .filter((event) => event.version >= 3)
        .map((event) => [event.type, event.version, event.payload["certificateSearches"]]),
    ).toEqual([
      ["app.domain.certificate_searches_recorded", 3, 1],
      ["app.domain.activated", 4, undefined],
      ["app.domain.certificate_searches_recorded", 5, 0],
    ]);
  });
});
