import { AppPersistenceError } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { START, appsApiHarness } from "./apps-api.fixture.ts";

describe("apps API erasure", () => {
  test("erases an active app, keeps its slug reserved, and answers a repeat with 404", async () => {
    const { appsDatabase, payroll, payrollBody, provisioningApp, send, staging } =
      await appsApiHarness();
    const app = `/v1/apps/${payroll.data.id}`;

    const erased = await send("owner", "DELETE", app);
    const afterwards = {
      get: await send("owner", "GET", app),
      repeat: await send("owner", "DELETE", app),
    };
    const slugReuse = await provisioningApp(staging, "payroll", "Payroll again").catch(
      (error: unknown) => error,
    );

    expect(erased).toEqual({
      body: { ...payrollBody, lifecycle: { requestedAt: START, state: "erasing" } },
      status: 202,
    });
    expect({
      erasures: appsDatabase.invocations,
      get: afterwards.get.body.code,
      repeat: [afterwards.repeat.status, afterwards.repeat.body.code],
      slugReuse: slugReuse instanceof AppPersistenceError ? slugReuse.reason : slugReuse,
    }).toEqual({
      erasures: [{ appId: payroll.data.id, op: "erase", slug: "payroll" }],
      get: "app_not_found",
      repeat: [404, "app_not_found"],
      slugReuse: "slug-taken",
    });
  });

  test("erases an app still provisioning once no provision can still be running", async () => {
    const { advance, appsDatabase, production, provisioningApp, send } = await appsApiHarness();
    const stuck = await provisioningApp(production, "stuck-app", "Stuck");

    const early = await send("admin", "DELETE", `/v1/apps/${stuck.data.id}`);
    const erasuresWhileEarly = appsDatabase.invocations.length;
    advance(11 * 60_000);
    const erased = await send("admin", "DELETE", `/v1/apps/${stuck.data.id}`);

    expect([early.status, early.body.code, early.body.detail, erasuresWhileEarly]).toEqual([
      409,
      "app_state_conflict",
      `App ${stuck.data.id} may still be provisioning; erasure becomes possible after 2026-10-08T12:10:00.000Z.`,
      0,
    ]);
    expect([erased.status, erased.body.lifecycle]).toEqual([
      202,
      { requestedAt: "2026-10-08T12:11:00.000Z", state: "erasing" },
    ]);
    expect((await send("admin", "GET", `/v1/apps/${stuck.data.id}`)).status).toBe(404);
  });

  test("erases an app that went public, active or archived, once the provision going public started can no longer be running", async () => {
    const { advance, appsDatabase, payroll, send } = await appsApiHarness();
    const app = `/v1/apps/${payroll.data.id}`;
    appsDatabase.nextOutcome = "outlives its deadline";

    const published = await send("owner", "PATCH", `${app}/publication`, {
      body: { audience: "public" },
    });
    const earlyActive = await send("owner", "DELETE", app);
    const archived = await send("owner", "POST", `${app}/archive`);
    const earlyArchived = await send("owner", "DELETE", app);
    const operationsWhileEarly = appsDatabase.invocations.map(({ op }) => op);
    advance(11 * 60_000);
    const erased = await send("owner", "DELETE", app);

    const refusal = [
      409,
      "app_state_conflict",
      `App ${payroll.data.id} may still be provisioning; erasure becomes possible after 2026-10-08T12:10:00.000Z.`,
    ];
    expect({
      archived: [archived.status, archived.body.lifecycle],
      earlyActive: [earlyActive.status, earlyActive.body.code, earlyActive.body.detail],
      earlyArchived: [earlyArchived.status, earlyArchived.body.code, earlyArchived.body.detail],
      erased: [erased.status, erased.body.lifecycle],
      operations: appsDatabase.invocations.map(({ op }) => op),
      operationsWhileEarly,
      published: [published.status, published.body.code],
    }).toEqual({
      archived: [200, { archivedAt: START, liveReleaseId: null, state: "archived" }],
      earlyActive: refusal,
      earlyArchived: refusal,
      erased: [202, { requestedAt: "2026-10-08T12:11:00.000Z", state: "erasing" }],
      operations: ["provision", "erase"],
      operationsWhileEarly: ["provision"],
      published: [503, "database_unavailable"],
    });
  });

  test("a failed database erase leaves the app erasing and a retry finishes it", async () => {
    const { appsDatabase, payroll, send } = await appsApiHarness();
    const app = `/v1/apps/${payroll.data.id}`;
    appsDatabase.nextOutcome = "crashes";

    const failed = await send("owner", "DELETE", app);
    const stranded = await send("owner", "GET", app);
    const retried = await send("owner", "DELETE", app);

    expect({
      failed: [failed.status, failed.body.code],
      retried: [retried.status, retried.body.lifecycle],
      stranded: stranded.body.lifecycle,
      tries: appsDatabase.invocations.length,
    }).toEqual({
      failed: [500, "internal_error"],
      retried: [202, { requestedAt: START, state: "erasing" }],
      stranded: { requestedAt: START, state: "erasing" },
      tries: 2,
    });
    expect((await send("owner", "GET", app)).status).toBe(404);
  });

  test("an erase that outlives its deadline answers a retryable 503 and a retry finishes it", async () => {
    const { appsDatabase, payroll, send } = await appsApiHarness();
    const app = `/v1/apps/${payroll.data.id}`;
    appsDatabase.nextOutcome = "outlives its deadline";

    const timedOut = await send("owner", "DELETE", app);
    const stranded = await send("owner", "GET", app);
    const retried = await send("owner", "DELETE", app);

    expect({
      retried: [retried.status, retried.body.lifecycle],
      stranded: stranded.body.lifecycle,
      timedOut,
      tries: appsDatabase.invocations.length,
    }).toEqual({
      retried: [202, { requestedAt: START, state: "erasing" }],
      stranded: { requestedAt: START, state: "erasing" },
      timedOut: {
        body: {
          code: "database_unavailable",
          detail: "The app's database is starting; retry in a few seconds.",
          requestId: "req-test",
          status: 503,
          title: "Request failed",
        },
        retryAfter: "5",
        status: 503,
      },
      tries: 2,
    });
    expect((await send("owner", "GET", app)).status).toBe(404);
  });
});
