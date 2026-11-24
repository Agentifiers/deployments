import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { AppHostname } from "../records/app-domains.ts";
import type { AppRecord } from "../records/apps.ts";
import { UniqueClaimRecord } from "../records/identity.ts";
import { makeUniqueClaimRecord, uniqueOwnerAttributes } from "../unique-claims.ts";
import { harness, hostname, owner, publishing, system } from "./domain-test-support.ts";
import { ORGANIZATION_APP_DOMAIN_LIMIT } from "./domains.ts";
import { AppPersistenceError } from "./errors.ts";
import type { AppPersistence } from "./persistence.ts";
import { ORGANIZATION, OTHER_ORGANIZATION, START, id } from "./test-support.ts";

async function reason(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppPersistenceError) return error.reason;
    throw error;
  }
  throw new Error("Expected a refusal.");
}

function rejectionReason(results: readonly PromiseSettledResult<unknown>[]) {
  const rejected = results.find((result) => result.status === "rejected");
  return rejected?.reason instanceof AppPersistenceError ? rejected.reason.reason : undefined;
}

describe("app domain records and claims", () => {
  test("attach holds the app slot and hostname claims; verify adds the global and organization claims; detach releases all", async () => {
    const { activeApp, apps, claims } = harness();
    const app = await activeApp();

    const attached = await apps.attachDomain({
      actor: owner,
      app,
      hostname: hostname("www.example.com"),
    });
    expect(attached.data.state).toEqual({ kind: "unverified" });
    expect(attached.data.token).toMatch(/^[0-9a-f]{32}$/u);
    expect(attached.sk).toBe(`APP-DOMAIN#${attached.data.id}`);
    expect(claims()).toEqual([
      `app:${app.data.id}:domain-hostname=www.example.com`,
      `app:${app.data.id}:domain-slot=${attached.data.appSlot}`,
    ]);

    const verified = await apps.verifyDomain({
      actor: owner,
      app,
      domain: attached,
      observeTxt: publishing([attached]).observeTxt,
    });
    expect(verified.data.state).toMatchObject({
      kind: "verified",
      problem: null,
      verifiedAt: START,
    });
    const slot = verified.data.state.kind === "verified" ? verified.data.state.slot : -1;
    expect(claims()).toEqual([
      `app-hostname=www.example.com`,
      `app:${app.data.id}:domain-hostname=www.example.com`,
      `app:${app.data.id}:domain-slot=${attached.data.appSlot}`,
      `organization:${ORGANIZATION}:app-domain-slot=${slot}`,
    ]);

    await apps.detachDomain({ actor: owner, app, domain: verified });
    expect(claims()).toEqual([]);
    expect(await apps.listDomains(app)).toEqual([]);
  });

  test("attach, verify, and detach each write one event on the domain aggregate", async () => {
    const { activeApp, apps, domainEvents } = harness();
    const app = await activeApp();
    const attached = await apps.attachDomain({
      actor: owner,
      app,
      hostname: hostname("www.example.com"),
    });
    const verified = await apps.verifyDomain({
      actor: owner,
      app,
      domain: attached,
      observeTxt: publishing([attached]).observeTxt,
    });
    await apps.detachDomain({ actor: owner, app, domain: verified });

    const payload = { appId: app.data.id, domainId: attached.data.id, hostname: "www.example.com" };
    expect(domainEvents().sort((left, right) => left.version - right.version)).toEqual([
      { payload, type: "app.domain.attached", version: 1 },
      { payload, type: "app.domain.verified", version: 2 },
      { payload, type: "app.domain.detached", version: 3 },
    ]);
  });

  test("a domain's claims are owned by its organization, app, and hostname", async () => {
    const { activeApp, apps } = harness();
    const app = await activeApp();
    const attached = await apps.attachDomain({
      actor: owner,
      app,
      hostname: hostname("www.example.com"),
    });

    expect(uniqueOwnerAttributes(attached)).toEqual({
      appId: app.data.id,
      hostname: "www.example.com",
      organizationId: ORGANIZATION,
    });
  });

  test("each attachment gets its own token, so one organization's TXT record cannot verify another's", async () => {
    const { activeApp, apps } = harness();
    const ours = await activeApp(ORGANIZATION);
    const theirs = await activeApp(OTHER_ORGANIZATION);
    const name = hostname("shop.example.com");
    const ourDomain = await apps.attachDomain({ actor: owner, app: ours, hostname: name });
    const theirDomain = await apps.attachDomain({ actor: owner, app: theirs, hostname: name });
    const ourRecord = publishing([ourDomain]);

    expect(
      await reason(
        apps.verifyDomain({ actor: owner, app: theirs, domain: theirDomain, ...ourRecord }),
      ),
    ).toBe("txt-not-found");
    expect(
      (await apps.verifyDomain({ actor: owner, app: ours, domain: ourDomain, ...ourRecord })).data
        .state.kind,
    ).toBe("verified");
  });

  test("attaching a hostname the app already holds returns the existing record", async () => {
    const { activeApp, apps, claims } = harness();
    const app = await activeApp();

    const first = await apps.attachDomain({ actor: owner, app, hostname: hostname("example.com") });
    const again = await apps.attachDomain({ actor: owner, app, hostname: hostname("example.com") });

    expect(again.data.id).toBe(first.data.id);
    expect(claims()).toHaveLength(2);
  });

  test("a pending attachment claims nothing globally, so two organizations may attach one hostname", async () => {
    const { activeApp, apps, claims } = harness();
    const ours = await activeApp(ORGANIZATION);
    const theirs = await activeApp(OTHER_ORGANIZATION);

    await apps.attachDomain({ actor: owner, app: ours, hostname: hostname("shop.example.com") });
    await apps.attachDomain({ actor: owner, app: theirs, hostname: hostname("shop.example.com") });

    expect(claims().filter((claim) => claim.startsWith("app-hostname="))).toEqual([]);
  });

  test("the first organization to verify holds the hostname until it detaches", async () => {
    const { activeApp, apps } = harness();
    const ours = await activeApp(ORGANIZATION);
    const theirs = await activeApp(OTHER_ORGANIZATION);
    const name = hostname("shop.example.com");
    const ourDomain = await apps.attachDomain({ actor: owner, app: ours, hostname: name });
    const theirDomain = await apps.attachDomain({ actor: owner, app: theirs, hostname: name });
    const dns = publishing([ourDomain, theirDomain]);
    const verifiedOurs = await apps.verifyDomain({
      actor: owner,
      app: ours,
      domain: ourDomain,
      ...dns,
    });

    expect(
      await reason(apps.verifyDomain({ actor: owner, app: theirs, domain: theirDomain, ...dns })),
    ).toBe("domain-claimed");

    await apps.detachDomain({ actor: owner, app: ours, domain: verifiedOurs });
    const verifiedTheirs = await apps.verifyDomain({
      actor: owner,
      app: theirs,
      domain: theirDomain,
      ...dns,
    });
    expect(verifiedTheirs.data.state.kind).toBe("verified");
  });

  test("a hostname resolves to the domain that holds its global claim, in whichever app", async () => {
    const { activeApp, apps } = harness();
    const ours = await activeApp(ORGANIZATION);
    const theirs = await activeApp(OTHER_ORGANIZATION);
    const name = hostname("tickets.example.com");
    const ourDomain = await apps.attachDomain({ actor: owner, app: ours, hostname: name });
    const theirDomain = await apps.attachDomain({ actor: owner, app: theirs, hostname: name });
    const dns = publishing([ourDomain, theirDomain]);
    const holder = async () => (await apps.domainForHostname(name))?.data.appId ?? "none";
    const observed = [await holder()];

    const verifiedOurs = await apps.verifyDomain({
      actor: owner,
      app: ours,
      domain: ourDomain,
      ...dns,
    });
    observed.push(await holder());
    await apps.detachDomain({ actor: owner, app: ours, domain: verifiedOurs });
    observed.push(await holder());
    await apps.verifyDomain({ actor: owner, app: theirs, domain: theirDomain, ...dns });
    observed.push(await holder());

    expect(observed).toEqual(["none", ours.data.id, "none", theirs.data.id]);
  });

  test("two organizations verifying one hostname at once leave exactly one verified", async () => {
    const { activeApp, apps, claims } = harness();
    const ours = await activeApp(ORGANIZATION);
    const theirs = await activeApp(OTHER_ORGANIZATION);
    const name = hostname("race.example.com");
    const ourDomain = await apps.attachDomain({ actor: owner, app: ours, hostname: name });
    const theirDomain = await apps.attachDomain({ actor: owner, app: theirs, hostname: name });
    const dns = publishing([ourDomain, theirDomain]);

    const results = await Promise.allSettled([
      apps.verifyDomain({ actor: owner, app: ours, domain: ourDomain, ...dns }),
      apps.verifyDomain({ actor: owner, app: theirs, domain: theirDomain, ...dns }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(rejectionReason(results)).toBe("domain-claimed");
    expect(claims().filter((claim) => claim.startsWith("app-hostname="))).toHaveLength(1);
    expect(claims().filter((claim) => claim.includes(":app-domain-slot="))).toHaveLength(1);
  });

  test("two concurrent attaches at the per-app cap leave ten domains and refuse one", async () => {
    const { activeApp, apps, claims } = harness();
    const app = await activeApp();
    for (let index = 0; index < 9; index += 1) {
      await apps.attachDomain({
        actor: owner,
        app,
        hostname: hostname(`site${index}.example.com`),
      });
    }

    const results = await Promise.allSettled([
      apps.attachDomain({ actor: owner, app, hostname: hostname("left.example.com") }),
      apps.attachDomain({ actor: owner, app, hostname: hostname("right.example.com") }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(rejectionReason(results)).toBe("app-domain-limit");
    expect(await apps.listDomains(app)).toHaveLength(10);
    expect(claims().filter((claim) => claim.includes(":domain-slot="))).toEqual(
      Array.from({ length: 10 }, (_, slot) => `app:${app.data.id}:domain-slot=${slot}`).sort(),
    );
  });

  test("verify refuses when the organization holds its domain limit and writes nothing", async () => {
    const { activeApp, apps, fake, tables } = harness();
    const app = await activeApp();
    for (let slot = 0; slot < ORGANIZATION_APP_DOMAIN_LIMIT; slot += 1) {
      const claim = Schema.decodeUnknownSync(UniqueClaimRecord)(
        makeUniqueClaimRecord(
          {
            namespace: `organization:${ORGANIZATION}:app-domain-slot`,
            ownerId: id(`01ARZ3NDEKTSV4RRFFQ69G5${String(slot).padStart(3, "0")}`),
            ownerItemType: "app-domain",
            ownerPk: "ORG#elsewhere",
            ownerSk: `APP-DOMAIN#${slot}`,
            ownerTable: "control",
            value: String(slot),
          },
          START,
        ),
      );
      fake.put(tables.control, claim);
    }
    const domain = await apps.attachDomain({
      actor: owner,
      app,
      hostname: hostname("full.example.com"),
    });
    const writes = fake.transactions.length;

    expect(
      await reason(apps.verifyDomain({ actor: owner, app, domain, ...publishing([domain]) })),
    ).toBe("organization-domain-limit");
    expect(fake.transactions.length).toBe(writes);
    expect((await apps.getDomain({ app, domainId: domain.data.id }))?.data.state.kind).toBe(
      "unverified",
    );
  });
});

describe("app domain races converge", () => {
  test("two concurrent attaches of one hostname return the same domain", async () => {
    const { activeApp, apps, claims } = harness();
    const app = await activeApp();

    const [left, right] = await Promise.all([
      apps.attachDomain({ actor: owner, app, hostname: hostname("www.example.com") }),
      apps.attachDomain({ actor: owner, app, hostname: hostname("www.example.com") }),
    ]);

    expect(right.data.id).toBe(left.data.id);
    expect(claims()).toEqual([
      `app:${app.data.id}:domain-hostname=www.example.com`,
      `app:${app.data.id}:domain-slot=${left.data.appSlot}`,
    ]);
  });

  test("two concurrent refreshes of one domain both answer it verified", async () => {
    const { activeApp, apps } = harness();
    const app = await activeApp();
    const domain = await apps.attachDomain({
      actor: owner,
      app,
      hostname: hostname("www.example.com"),
    });
    const dns = publishing([domain]);

    const results = await Promise.all([
      apps.verifyDomain({ actor: owner, app, domain, ...dns }),
      apps.verifyDomain({ actor: owner, app, domain, ...dns }),
    ]);

    expect(results.map((result) => [result.data.version, result.data.state.kind])).toEqual([
      [2, "verified"],
      [2, "verified"],
    ]);
  });

  test("two concurrent detaches of one domain both succeed and release every claim", async () => {
    const { activeApp, apps, claims } = harness();
    const app = await activeApp();
    const domain = await apps.attachDomain({
      actor: owner,
      app,
      hostname: hostname("www.example.com"),
    });

    const results = await Promise.allSettled([
      apps.detachDomain({ actor: owner, app, domain }),
      apps.detachDomain({ actor: owner, app, domain }),
    ]);

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(claims()).toEqual([]);
  });
});

describe("app domain refresh", () => {
  test("a missing or wrong TXT record answers txt-not-found and writes nothing", async () => {
    const { activeApp, apps, fake } = harness();
    const app = await activeApp();
    const domain = await apps.attachDomain({
      actor: owner,
      app,
      hostname: hostname("www.example.org"),
    });
    const writes = fake.transactions.length;
    const observed: string[] = [];

    expect(
      await reason(
        apps.verifyDomain({
          actor: owner,
          app,
          domain,
          observeTxt: async (name) => {
            observed.push(name);
            return ["deployments-app=0000"];
          },
        }),
      ),
    ).toBe("txt-not-found");
    expect(observed).toEqual(["_deployments-app.www.example.org"]);
    expect(fake.transactions.length).toBe(writes);
  });

  test("refreshing a verified domain returns it without a DNS lookup", async () => {
    const { activeApp, apps } = harness();
    const app = await activeApp();
    const domain = await apps.attachDomain({
      actor: owner,
      app,
      hostname: hostname("www.example.org"),
    });
    const dns = publishing([domain]);
    const verified = await apps.verifyDomain({ actor: owner, app, domain, ...dns });

    const again = await apps.verifyDomain({ actor: owner, app, domain: verified, ...dns });

    expect(again).toEqual(verified);
    expect(dns.observed).toEqual(["_deployments-app.www.example.org"]);
  });
});

describe("app domain lifecycle checks", () => {
  async function erasing(apps: AppPersistence, app: AppRecord) {
    return apps.transitionApp({ actor: system, app, transition: { to: "erasing" } });
  }

  test("attach refuses an erasing app and detach still works on one", async () => {
    const { activeApp, apps, claims } = harness();
    const app = await activeApp();
    const domain = await apps.attachDomain({
      actor: owner,
      app,
      hostname: hostname("a.example.net"),
    });
    const gone = await erasing(apps, app);

    expect(
      await reason(
        apps.attachDomain({ actor: owner, app: gone, hostname: hostname("b.example.net") }),
      ),
    ).toBe("illegal-state");
    expect(
      await reason(apps.verifyDomain({ actor: owner, app: gone, domain, ...publishing([domain]) })),
    ).toBe("illegal-state");

    await apps.detachDomain({ actor: owner, app: gone, domain });
    expect(claims()).toEqual([]);
  });

  test("a request that read the app before it began erasing cannot attach or verify", async () => {
    const { activeApp, apps } = harness();
    const stale = await activeApp();
    const domain = await apps.attachDomain({
      actor: owner,
      app: stale,
      hostname: hostname("a.example.net"),
    });
    await erasing(apps, stale);

    expect(
      await reason(
        apps.attachDomain({ actor: owner, app: stale, hostname: hostname("b.example.net") }),
      ),
    ).toBe("illegal-state");
    expect(
      await reason(
        apps.verifyDomain({ actor: owner, app: stale, domain, ...publishing([domain]) }),
      ),
    ).toBe("illegal-state");
    expect((await apps.getDomain({ app: stale, domainId: domain.data.id }))?.data.state.kind).toBe(
      "unverified",
    );
  });

  test("eraseApp refuses while a domain remains", async () => {
    const { activeApp, apps } = harness();
    const app = await activeApp();
    const domain = await apps.attachDomain({
      actor: owner,
      app,
      hostname: hostname("a.example.net"),
    });
    const gone = await erasing(apps, app);

    expect(await reason(apps.eraseApp({ actor: system, app: gone }))).toBe("illegal-state");

    await apps.detachDomain({ actor: owner, app: gone, domain });
    await apps.eraseApp({ actor: system, app: gone });
    expect(await apps.getApp(app.data.id)).toBeUndefined();
  });

  test("detach refuses once the app record is gone and keeps the domain's claims", async () => {
    const { activeApp, apps, claims, fake, tables } = harness();
    const app = await activeApp();
    const domain = await apps.attachDomain({
      actor: owner,
      app,
      hostname: hostname("a.example.net"),
    });
    fake.delete(tables.control, app);

    expect(await reason(apps.detachDomain({ actor: owner, app, domain }))).toBe("not-found");
    expect(claims()).toEqual([
      `app:${app.data.id}:domain-hostname=a.example.net`,
      `app:${app.data.id}:domain-slot=${domain.data.appSlot}`,
    ]);
  });
});

describe("app hostnames", () => {
  test("accepts lowercase multi-label ASCII and punycode, refuses everything else", () => {
    const valid = Schema.is(AppHostname);
    const ofLength = (length: number) =>
      `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(length - 196)}.com`;
    const accepted = [
      "example.com",
      "www.example.com",
      "xn--caf-dma.example",
      "a-b.co.uk",
      "x.xn--p1ai",
      ofLength(236),
    ];
    const refused = [
      "localhost",
      "Example.com",
      "192.168.0.1",
      "[::1]",
      "2001:db8::1",
      "-bad.example.com",
      "bad-.example.com",
      "café.example",
      "a..example.com",
      "example.com.",
      "*.example.com",
      `${"a".repeat(64)}.example.com`,
      `${"a.".repeat(126)}com`,
      ofLength(237),
      ofLength(253),
    ];
    expect(accepted.map(valid)).toEqual(accepted.map(() => true));
    expect(refused.map(valid)).toEqual(refused.map(() => false));
  });
});
