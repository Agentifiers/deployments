import { describe, expect, test } from "bun:test";
import { OWNER, SERVICE_ACCOUNT, START, appsApiHarness } from "./apps-api.fixture.ts";

describe("apps API publication", () => {
  test("the publication route admits owners, admins, and keys that name apps:publish", async () => {
    const { payroll, payrollBody, send } = await appsApiHarness();
    const publication = `/v1/apps/${payroll.data.id}/publication`;
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
      const response = await send(caller, "PATCH", publication, {
        body: { serving: caller === "publish key" ? "static-site" : "single-page" },
      });
      outcomes[caller] = [response.status, response.body.code ?? response.body.publication];
    }

    expect(outcomes).toEqual({
      admin: [200, { audience: "members", serving: "single-page" }],
      member: [403, "insufficient_role"],
      owner: [200, { audience: "members", serving: "single-page" }],
      "platform key": [403, "insufficient_scope"],
      "publish key": [200, { audience: "members", serving: "static-site" }],
      reader: [403, "insufficient_scope"],
      viewer: [403, "insufficient_role"],
      "wildcard key": [403, "insufficient_scope"],
    });
    expect((await send("wildcard key", "PATCH", publication, { body: {} })).body.detail).toBe(
      "The API key does not name the apps:publish scope; wildcards do not grant it.",
    );
    expect(await send("publish key", "GET", `/v1/apps/${payroll.data.id}`)).toEqual({
      body: {
        ...payrollBody,
        publication: { audience: "members", serving: "static-site" },
        updatedAt: START,
      },
      status: 200,
    });
  });

  test("the publication route needs at least one setting and keeps the other", async () => {
    const { payroll, send } = await appsApiHarness();
    const publication = `/v1/apps/${payroll.data.id}/publication`;

    expect(await send("owner", "PATCH", publication, { body: {} })).toMatchObject({
      body: { code: "validation_failed" },
      status: 422,
    });
    expect(
      await send("owner", "PATCH", publication, { body: { audience: "everyone" } }),
    ).toMatchObject({ body: { code: "validation_failed" }, status: 422 });
    await send("owner", "PATCH", publication, { body: { serving: "static-site" } });
    expect(
      (await send("owner", "PATCH", publication, { body: { audience: "public" } })).body
        .publication,
    ).toEqual({ audience: "public", serving: "static-site" });
  });

  test("going public provisions a database of an older layout once", async () => {
    const { appsDatabase, payroll, send } = await appsApiHarness();
    const publication = `/v1/apps/${payroll.data.id}/publication`;
    const steps = [];

    for (const body of [
      { serving: "static-site" },
      { audience: "public" },
      { serving: "single-page" },
      { audience: "members" },
      { audience: "public" },
    ]) {
      const response = await send("owner", "PATCH", publication, { body });
      steps.push([response.status, appsDatabase.invocations.length]);
    }

    expect({ invocations: appsDatabase.invocations, steps }).toEqual({
      invocations: [{ appId: payroll.data.id, op: "provision", slug: "payroll" }],
      steps: [
        [200, 0],
        [200, 1],
        [200, 1],
        [200, 1],
        [200, 1],
      ],
    });
  });

  test("a failed database step leaves publication and layout unchanged, and a retry converges", async () => {
    const { apps, appsDatabase, payroll, send } = await appsApiHarness();
    const app = `/v1/apps/${payroll.data.id}`;
    const body = { audience: "public", serving: "static-site" };
    appsDatabase.nextOutcome = "crashes";

    const failed = await send("owner", "PATCH", `${app}/publication`, { body });
    const afterFailure = {
      layout: (await apps.getApp(payroll.data.id))?.data.databaseLayout,
      publication: (await send("owner", "GET", app)).body.publication,
    };
    const retried = await send("owner", "PATCH", `${app}/publication`, { body });

    expect({
      afterFailure,
      failed: [failed.status, failed.body.code],
      layoutAfterRetry: (await apps.getApp(payroll.data.id))?.data.databaseLayout,
      operations: appsDatabase.invocations.map(({ op }) => op),
      retried: [retried.status, retried.body.publication],
    }).toEqual({
      afterFailure: { layout: 1, publication: { audience: "members", serving: "single-page" } },
      failed: [500, "internal_error"],
      layoutAfterRetry: 2,
      operations: ["provision", "provision"],
      retried: [200, { audience: "public", serving: "static-site" }],
    });
  });

  test("records the service account or the member who changed the publication", async () => {
    const { eventsOf, payroll, send } = await appsApiHarness();
    const publication = `/v1/apps/${payroll.data.id}/publication`;

    await send("publish key", "PATCH", publication, { body: { serving: "static-site" } });
    await send("owner", "PATCH", publication, { body: { serving: "single-page" } });

    expect(eventsOf("app.publication.changed").map(({ actor }) => actor)).toEqual([
      { id: SERVICE_ACCOUNT, type: "service-account" },
      { id: OWNER, type: "principal" },
    ]);
  });
});
