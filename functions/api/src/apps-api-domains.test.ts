import { AppDomainResponse, ListAppDomainsResponse } from "@deployments-ai/api-contract";
import { describe, expect, test } from "bun:test";
import { Ulid, isPublishedAppDomain } from "@deployments-ai/db";
import { Schema } from "effect";
import {
  ROUTING_ENDPOINT,
  SERVICE_ACCOUNT,
  START,
  appsApiHarness,
  type AppsApiSend,
} from "./apps-api.fixture.ts";

const domainOf = Schema.decodeUnknownSync(AppDomainResponse);
const listOf = Schema.decodeUnknownSync(ListAppDomainsResponse);

async function attach(send: AppsApiSend, appId: string, hostname: string, caller = "owner") {
  return send(caller, "POST", `/v1/apps/${appId}/domains`, { body: { hostname } });
}

function txtOf(body: Record<string, unknown>) {
  const [txt] = domainOf(body).dnsRecords;
  if (!txt) throw new Error("The domain lists no TXT record.");
  return txt;
}

describe("app domains API", () => {
  test("attach answers the TXT and CNAME records to publish and claims nothing yet", async () => {
    const { payroll, send } = await appsApiHarness();

    const attached = await attach(send, payroll.data.id, "  Events.Example.COM ");

    expect(attached.status).toBe(200);
    const token = txtOf(attached.body).value.replace("deployments-app=", "");
    expect(token).toMatch(/^[0-9a-f]{32}$/u);
    expect(attached.body).toEqual({
      appId: payroll.data.id,
      attachedBy: { id: expect.any(String), principal: "human" },
      createdAt: START,
      dnsRecords: [
        {
          name: "_deployments-app.events.example.com",
          type: "TXT",
          value: `deployments-app=${token}`,
        },
        {
          name: "events.example.com",
          note: "A zone apex cannot hold a CNAME; publish an ALIAS or ANAME record, or use CNAME flattening.",
          type: "CNAME",
          value: ROUTING_ENDPOINT,
        },
      ],
      hostname: "events.example.com",
      id: expect.any(String),
      state: { kind: "unverified" },
      updatedAt: START,
    });
    expect((await send("member", "GET", `/v1/apps/${payroll.data.id}/domains`)).body).toEqual({
      items: [attached.body],
      nextCursor: null,
    });
  });

  test("publish routes admit owners, admins, and keys that name apps:publish; reads admit readers", async () => {
    const { payroll, send } = await appsApiHarness();
    const outcomes: Record<string, unknown> = {};
    for (const caller of [
      "member",
      "viewer",
      "reader",
      "wildcard key",
      "platform key",
      "owner",
      "admin",
      "publish key",
    ]) {
      const response = await attach(
        send,
        payroll.data.id,
        `${caller.replace(" ", "-")}.example.com`,
        caller,
      );
      outcomes[caller] = [
        response.status,
        response.status === 200 ? domainOf(response.body).attachedBy.principal : response.body.code,
      ];
    }

    expect(outcomes).toEqual({
      admin: [200, "human"],
      member: [403, "insufficient_role"],
      owner: [200, "human"],
      "platform key": [403, "insufficient_scope"],
      "publish key": [200, "service-account"],
      reader: [403, "insufficient_scope"],
      viewer: [403, "insufficient_role"],
      "wildcard key": [403, "insufficient_scope"],
    });
    const { items } = listOf(
      (await send("key", "GET", `/v1/apps/${payroll.data.id}/domains`)).body,
    );
    expect(items.map(({ attachedBy }) => `${attachedBy.principal}:${attachedBy.id}`)).toContain(
      `service-account:${SERVICE_ACCOUNT}`,
    );
    const [first] = items;
    const domainPath = `/v1/apps/${payroll.data.id}/domains/${first?.id}`;
    for (const [method, path] of [
      ["POST", `${domainPath}/refresh`],
      ["DELETE", domainPath],
    ] as const) {
      expect((await send("wildcard key", method, path)).body.code).toBe("insufficient_scope");
      expect((await send("member", method, path)).body.code).toBe("insufficient_role");
    }
    expect((await send("publish key", "DELETE", domainPath)).status).toBe(200);
  });

  test("refresh verifies only once the TXT record is published and is never replayed", async () => {
    const { dns, payroll, replayed, send } = await appsApiHarness();
    const attached = await attach(send, payroll.data.id, "www.example.org");
    const refresh = `/v1/apps/${payroll.data.id}/domains/${domainOf(attached.body).id}/refresh`;
    const txt = txtOf(attached.body);
    const replays = replayed.length;

    expect(await send("owner", "POST", refresh)).toMatchObject({
      body: { code: "txt_not_found" },
      status: 422,
    });

    dns.failing = true;
    expect(await send("owner", "POST", refresh)).toMatchObject({
      body: { code: "dns_lookup_failed" },
      retryAfter: "5",
      status: 503,
    });

    dns.failing = false;
    dns.txt.set(txt.name, [
      ["v=spf1 -all"],
      ["deployments-app=", txt.value.slice("deployments-app=".length)],
    ]);
    const verified = await send("publish key", "POST", refresh);
    expect(verified).toMatchObject({
      body: { state: { kind: "verified", problem: null, verifiedAt: START } },
      status: 200,
    });
    const lookups = dns.lookups.length;
    expect(await send("owner", "POST", refresh)).toEqual(verified);
    expect(dns.lookups.length).toBe(lookups);
    expect(replayed.length).toBe(replays);
  });

  test("a hostname another app verified first answers domain_claimed until it detaches", async () => {
    const { dns, payroll, roster, send, staging } = await appsApiHarness();
    const ours = await attach(send, payroll.data.id, "shop.example.net");
    const theirs = await send("owner", "POST", `/v1/apps/${roster.data.id}/domains`, {
      body: { hostname: "shop.example.net" },
      environmentId: staging,
    });
    for (const attached of [ours, theirs]) {
      const txt = txtOf(attached.body);
      dns.txt.set(txt.name, [...(dns.txt.get(txt.name) ?? []), [txt.value]]);
    }
    const theirRefresh = `/v1/apps/${roster.data.id}/domains/${domainOf(theirs.body).id}/refresh`;

    const ourPath = `/v1/apps/${payroll.data.id}/domains/${domainOf(ours.body).id}`;
    await send("owner", "POST", `${ourPath}/refresh`);
    expect(await send("owner", "POST", theirRefresh, { environmentId: staging })).toMatchObject({
      body: { code: "domain_claimed" },
      status: 409,
    });

    await send("owner", "DELETE", ourPath);
    expect(
      (await send("owner", "POST", theirRefresh, { environmentId: staging })).body.state,
    ).toEqual({ kind: "verified", problem: null, verifiedAt: START });
  });

  test("refuses invalid hostnames and the installation's own hostnames", async () => {
    const { payroll, send } = await appsApiHarness();
    const outcomes: Record<string, unknown> = {};
    for (const hostname of [
      "",
      "localhost",
      "10.0.0.1",
      "café.example",
      "apps.example.test",
      "payroll.apps.example.test",
      "API.example.test",
      "console.example.test",
      "notapps.example.test",
    ]) {
      const response = await attach(send, payroll.data.id, hostname);
      outcomes[hostname] = response.body.code ?? response.status;
    }

    expect(outcomes).toEqual({
      "": "invalid_hostname",
      "10.0.0.1": "invalid_hostname",
      "API.example.test": "hostname_reserved",
      "apps.example.test": "hostname_reserved",
      "café.example": "invalid_hostname",
      "console.example.test": "hostname_reserved",
      localhost: "invalid_hostname",
      "notapps.example.test": 200,
      "payroll.apps.example.test": "hostname_reserved",
    });
  });

  test("refuses a hostname whose TXT name would pass the 253 characters DNS allows", async () => {
    const { payroll, send } = await appsApiHarness();
    const outcomes: Record<number, unknown> = {};
    for (const length of [236, 237, 253, 254]) {
      const hostname = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(length - 196)}.com`;
      const response = await attach(send, payroll.data.id, hostname);
      outcomes[length] =
        response.status === 200 ? txtOf(response.body).name.length : response.body.code;
    }

    expect(outcomes).toEqual({
      236: 253,
      237: "invalid_hostname",
      253: "invalid_hostname",
      254: "invalid_hostname",
    });
  });

  test("detach answers the detached domain, then domain_not_found", async () => {
    const { payroll, send } = await appsApiHarness();
    const attached = await attach(send, payroll.data.id, "www.example.net");
    const path = `/v1/apps/${payroll.data.id}/domains/${domainOf(attached.body).id}`;

    expect(await send("owner", "DELETE", path)).toEqual({ body: attached.body, status: 200 });
    expect(await send("owner", "DELETE", path)).toMatchObject({
      body: { code: "domain_not_found" },
      status: 404,
    });
    expect((await send("owner", "GET", `/v1/apps/${payroll.data.id}/domains`)).body.items).toEqual(
      [],
    );
  });

  test("refresh queues the reconciler and answers the domain as it stands", async () => {
    const { apps, dns, domainReconciler, payroll, send } = await appsApiHarness();
    const attached = await attach(send, payroll.data.id, "www.example.com");
    const { id } = domainOf(attached.body);
    const txt = txtOf(attached.body);
    dns.txt.set(txt.name, [[txt.value]]);
    const refresh = `/v1/apps/${payroll.data.id}/domains/${id}/refresh`;
    await send("owner", "POST", refresh);
    const verified = await apps.getDomain({
      app: payroll,
      domainId: Schema.decodeUnknownSync(Ulid)(id),
    });
    if (!verified || !isPublishedAppDomain(verified))
      throw new Error("Expected a verified domain.");
    await apps.recordDomainProblem({
      domain: verified,
      problem: {
        code: "domain_conflict",
        message: "Held elsewhere.",
        observedAt: START,
        rejectedCreates: { count: 2, latestAt: START },
      },
    });

    const refreshed = await send("owner", "POST", refresh);

    expect(refreshed.status).toBe(200);
    expect(domainOf(refreshed.body).state).toEqual({
      kind: "verified",
      problem: {
        code: "domain_conflict",
        message: "Held elsewhere.",
        observedAt: START,
      },
      verifiedAt: START,
    });
    const queued = {
      invocationType: "Event",
      payload: {
        appId: payroll.data.id,
        domainId: id,
        kind: "domain",
        organizationId: payroll.data.organizationId,
        refresh: true,
      },
    };
    expect(domainReconciler.invocations).toEqual([queued, queued]);
  });

  test("refresh answers the verified domain when the reconciler cannot be queued", async () => {
    const { dns, domainReconciler, payroll, send } = await appsApiHarness();
    const attached = await attach(send, payroll.data.id, "www.example.com");
    const txt = txtOf(attached.body);
    dns.txt.set(txt.name, [[txt.value]]);
    domainReconciler.nextOutcome = "fails";

    const refreshed = await send(
      "owner",
      "POST",
      `/v1/apps/${payroll.data.id}/domains/${domainOf(attached.body).id}/refresh`,
    );

    expect(refreshed.status).toBe(200);
    expect(domainOf(refreshed.body).state).toEqual({
      kind: "verified",
      problem: null,
      verifiedAt: START,
    });
  });

  test("detaching a verified domain queues a reconcile; detaching an unverified one does not", async () => {
    const { dns, domainReconciler, payroll, send } = await appsApiHarness();
    const pending = await attach(send, payroll.data.id, "pending.example.com");
    const attached = await attach(send, payroll.data.id, "www.example.com");
    const { id } = domainOf(attached.body);
    const txt = txtOf(attached.body);
    dns.txt.set(txt.name, [[txt.value]]);
    await send("owner", "POST", `/v1/apps/${payroll.data.id}/domains/${id}/refresh`);
    domainReconciler.invocations.length = 0;

    await send(
      "owner",
      "DELETE",
      `/v1/apps/${payroll.data.id}/domains/${domainOf(pending.body).id}`,
    );
    await send("owner", "DELETE", `/v1/apps/${payroll.data.id}/domains/${id}`);

    expect(domainReconciler.invocations).toEqual([
      {
        invocationType: "Event",
        payload: {
          appId: payroll.data.id,
          domainId: id,
          kind: "domain",
          organizationId: payroll.data.organizationId,
          refresh: false,
        },
      },
    ]);
  });

  test("erasing an app detaches its domains before the database erase runs", async () => {
    const { appsDatabase, dns, payroll, send } = await appsApiHarness();
    const attached = await attach(send, payroll.data.id, "www.example.com");
    const txt = txtOf(attached.body);
    dns.txt.set(txt.name, [[txt.value]]);
    await send(
      "owner",
      "POST",
      `/v1/apps/${payroll.data.id}/domains/${domainOf(attached.body).id}/refresh`,
    );
    appsDatabase.nextOutcome = "crashes";

    expect((await send("owner", "DELETE", `/v1/apps/${payroll.data.id}`)).status).toBe(500);
    expect(appsDatabase.invocations).toEqual([
      { appId: payroll.data.id, op: "erase", slug: "payroll" },
    ]);
    expect((await send("owner", "GET", `/v1/apps/${payroll.data.id}/domains`)).body.items).toEqual(
      [],
    );
    expect(await attach(send, payroll.data.id, "www.example.com")).toMatchObject({
      body: { code: "app_state_conflict" },
      status: 409,
    });

    expect((await send("owner", "DELETE", `/v1/apps/${payroll.data.id}`)).status).toBe(202);
  });
});

describe("apps API composed from the environment", () => {
  const environment = {
    APPS_BUCKET: "apps-bucket",
    APPS_CUSTOM_DOMAIN_TARGET: ROUTING_ENDPOINT,
    APPS_DATABASE_FUNCTION_NAME: "apps-database",
    APPS_DOMAIN_RECONCILER_FUNCTION_NAME: "apps-domains",
    APPS_DOMAIN: "apps.example.test",
    APPS_RESERVED_HOSTNAMES: " API.example.test,, console.example.test ",
  };

  test("refuses to start without a routing endpoint, the reconciler, or a reserved hostname", async () => {
    const { fromEnvironment } = await appsApiHarness();
    const refusals: Record<string, unknown> = {};
    for (const [name, override] of [
      ["no target", { APPS_CUSTOM_DOMAIN_TARGET: undefined }],
      ["blank target", { APPS_CUSTOM_DOMAIN_TARGET: "  " }],
      ["no reconciler", { APPS_DOMAIN_RECONCILER_FUNCTION_NAME: undefined }],
      ["no reserved hostnames", { APPS_RESERVED_HOSTNAMES: undefined }],
      ["empty reserved hostnames", { APPS_RESERVED_HOSTNAMES: "" }],
      ["blank reserved hostnames", { APPS_RESERVED_HOSTNAMES: " , " }],
    ] as const) {
      try {
        fromEnvironment({ ...environment, ...override });
        refusals[name] = "started";
      } catch (error) {
        refusals[name] = error instanceof Error ? error.message : error;
      }
    }

    const refusal =
      "APPS_BUCKET, APPS_DATABASE_FUNCTION_NAME, APPS_CUSTOM_DOMAIN_TARGET, APPS_DOMAIN_RECONCILER_FUNCTION_NAME and APPS_RESERVED_HOSTNAMES must be set with APPS_DOMAIN.";
    expect(refusals).toEqual({
      "blank reserved hostnames": refusal,
      "blank target": refusal,
      "empty reserved hostnames": refusal,
      "no reconciler": refusal,
      "no reserved hostnames": refusal,
      "no target": refusal,
    });
    expect(fromEnvironment({ ...environment, APPS_DOMAIN: undefined })).toBeUndefined();
  });

  test("reserves the apps domain and every listed hostname, trimmed and lowercased", async () => {
    const { fromEnvironment, payroll } = await appsApiHarness();
    const send = fromEnvironment(environment);
    if (!send) throw new Error("The apps API did not start.");
    const outcomes: Record<string, unknown> = {};
    for (const hostname of [
      "apps.example.test",
      "payroll.apps.example.test",
      "api.example.test",
      "v1.api.example.test",
      "console.example.test",
      "www.example.test",
    ]) {
      const response = await attach(send, payroll.data.id, hostname);
      outcomes[hostname] = response.body.code ?? response.status;
    }

    expect(outcomes).toEqual({
      "api.example.test": "hostname_reserved",
      "apps.example.test": "hostname_reserved",
      "console.example.test": "hostname_reserved",
      "payroll.apps.example.test": "hostname_reserved",
      "v1.api.example.test": "hostname_reserved",
      "www.example.test": 200,
    });
  });
});
