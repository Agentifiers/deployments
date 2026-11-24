import type { Ulid } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import {
  ADMIN,
  FIRST_RELEASE,
  MEMBER,
  MISSING_AGENT,
  NEXT_AGENT,
  OUTSIDER,
  RUN,
  SECOND_RELEASE,
  STAGING_RELEASE,
  START,
  appsApiHarness,
} from "./apps-api.fixture.ts";

const EXPECTED_WRITE_REFUSALS: Readonly<Record<string, readonly [number, string]>> = {
  key: [403, "human_principal_required"],
  member: [403, "insufficient_role"],
  "platform key": [403, "human_principal_required"],
  "publish key": [403, "insufficient_scope"],
  reader: [403, "insufficient_scope"],
  viewer: [403, "insufficient_role"],
  "wildcard key": [403, "human_principal_required"],
};

describe("apps API", () => {
  test("lists and reads apps only in the caller's environment", async () => {
    const { payroll, payrollBody, roster, send, staging } = await appsApiHarness();

    expect(await send("member", "GET", "/v1/apps")).toEqual({
      body: { items: [payrollBody], nextCursor: null },
      status: 200,
    });
    expect(await send("member", "GET", `/v1/apps/${payroll.data.id}`)).toEqual({
      body: payrollBody,
      status: 200,
    });
    expect(await send("member", "GET", `/v1/apps/${roster.data.id}`)).toEqual({
      body: {
        code: "app_not_found",
        detail: "The app was not found.",
        requestId: "req-test",
        status: 404,
        title: "Request failed",
      },
      status: 404,
    });
    const stagingList = await send("member", "GET", "/v1/apps", { environmentId: staging });
    expect(stagingList.status).toBe(200);
    expect((stagingList.body.items as { slug: string }[]).map((app) => app.slug)).toEqual([
      "roster",
    ]);
    expect((await send("key", "GET", "/v1/apps", { environmentId: staging })).body.code).toBe(
      "environment_scope_violation",
    );
  });

  test("finds an app by its slug only in the caller's environment", async () => {
    const { payrollBody, send, staging } = await appsApiHarness();
    const none = { body: { items: [], nextCursor: null }, status: 200 };

    expect(await send("member", "GET", "/v1/apps?slug=payroll")).toEqual({
      body: { items: [payrollBody], nextCursor: null },
      status: 200,
    });
    // roster lives in staging, so production has no app with that slug.
    expect(await send("member", "GET", "/v1/apps?slug=roster")).toEqual(none);
    expect(await send("member", "GET", "/v1/apps?slug=missing")).toEqual(none);
    expect(await send("member", "GET", "/v1/apps?slug=Not%20A%20Slug")).toEqual(none);
    const inStaging = await send("member", "GET", "/v1/apps?slug=roster", {
      environmentId: staging,
    });
    expect((inStaging.body.items as { slug: string }[]).map((app) => app.slug)).toEqual(["roster"]);
  });

  test("refuses every change from a member without the write role or from any API key", async () => {
    const { payroll, send } = await appsApiHarness();
    const app = `/v1/apps/${payroll.data.id}`;
    const changes = [
      ["PATCH", app, { name: "Renamed" }],
      ["POST", `${app}/archive`, undefined],
      ["PUT", `${app}/grants/${MEMBER}`, { role: "viewer" }],
      ["DELETE", `${app}/grants/${MEMBER}`, undefined],
      ["POST", `${app}/releases/${FIRST_RELEASE}/promote`, undefined],
      ["DELETE", app, undefined],
    ] as const;
    const outcomes: Record<string, unknown> = {};
    for (const caller of Object.keys(EXPECTED_WRITE_REFUSALS)) {
      for (const [method, path, body] of changes) {
        const response = await send(caller, method, path, body === undefined ? {} : { body });
        outcomes[`${caller} ${method} ${path.replace(app, "app")}`] = [
          response.status,
          response.body.code,
        ];
      }
    }

    const refused = (status: number, code: string) =>
      Object.fromEntries(
        changes.map(([method, path]) => [`${method} ${path.replace(app, "app")}`, [status, code]]),
      );
    expect(outcomes).toEqual(
      Object.fromEntries(
        Object.entries(EXPECTED_WRITE_REFUSALS).flatMap(([caller, [status, code]]) =>
          Object.entries(refused(status, code)).map(([route, outcome]) => [
            `${caller} ${route}`,
            outcome,
          ]),
        ),
      ),
    );
    expect((await send("member", "GET", app)).body.name).toBe("Payroll");
  });

  test("grants only reach active organization members", async () => {
    const { payroll, send } = await appsApiHarness();
    const grants = `/v1/apps/${payroll.data.id}/grants`;

    expect(
      await send("admin", "PUT", `${grants}/${OUTSIDER}`, { body: { role: "viewer" } }),
    ).toEqual({
      body: {
        code: "not_an_organization_member",
        detail: "App grants apply only to active members of the app's organization.",
        requestId: "req-test",
        status: 422,
        title: "Request failed",
      },
      status: 422,
    });
    const memberGrant = {
      appId: payroll.data.id,
      createdAt: START,
      grantedBy: ADMIN,
      principalId: MEMBER,
      role: "editor",
      updatedAt: START,
    };
    expect(await send("admin", "PUT", `${grants}/${MEMBER}`, { body: { role: "editor" } })).toEqual(
      { body: memberGrant, status: 200 },
    );
    expect(await send("member", "GET", grants)).toEqual({
      body: { items: [memberGrant], nextCursor: null },
      status: 200,
    });
    expect(await send("owner", "DELETE", `${grants}/${MEMBER}`)).toEqual({
      body: memberGrant,
      status: 200,
    });
    expect(await send("owner", "DELETE", `${grants}/${MEMBER}`)).toMatchObject({
      body: { code: "grant_not_found" },
      status: 404,
    });
    expect((await send("member", "GET", grants)).body).toEqual({ items: [], nextCursor: null });
  });

  test("grants only the viewer and editor roles", async () => {
    const { payroll, send } = await appsApiHarness();
    const grant = `/v1/apps/${payroll.data.id}/grants/${MEMBER}`;

    const refused = await send("admin", "PUT", grant, { body: { role: "admin" } });
    expect({ code: refused.body.code, status: refused.status }).toEqual({
      code: "validation_failed",
      status: 422,
    });
    expect((await send("member", "GET", `/v1/apps/${payroll.data.id}/grants`)).body).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  test("promotes only the app's own releases and lists them with the live one marked", async () => {
    const { payroll, send } = await appsApiHarness();
    const app = `/v1/apps/${payroll.data.id}`;

    expect(await send("owner", "POST", `${app}/releases/${STAGING_RELEASE}/promote`)).toEqual({
      body: {
        code: "resource_not_found",
        detail: `Release ${STAGING_RELEASE} is not a release of app ${payroll.data.id}.`,
        requestId: "req-test",
        status: 404,
        title: "Request failed",
      },
      status: 404,
    });
    const promoted = await send("owner", "POST", `${app}/releases/${FIRST_RELEASE}/promote`);
    expect([promoted.status, promoted.body.lifecycle]).toEqual([
      200,
      { liveReleaseId: FIRST_RELEASE, state: "active" },
    ]);
    const release = (id: Ulid, live: boolean) => ({
      appId: payroll.data.id,
      bundleSha256: "a".repeat(64),
      bytes: 2_048,
      createdAt: START,
      files: 3,
      id,
      live,
      runId: RUN,
    });
    expect(await send("member", "GET", `${app}/releases`)).toEqual({
      body: {
        items: [release(SECOND_RELEASE, false), release(FIRST_RELEASE, true)],
        nextCursor: null,
      },
      status: 200,
    });
    const page = await send("member", "GET", `${app}/releases?limit=1`);
    expect((page.body.items as { id: string }[]).map((item) => item.id)).toEqual([SECOND_RELEASE]);
    const next = await send(
      "member",
      "GET",
      `${app}/releases?limit=1&cursor=${String(page.body.nextCursor)}`,
    );
    expect((next.body.items as { id: string }[]).map((item) => item.id)).toEqual([FIRST_RELEASE]);
  });

  test("archive moves the app to archived, converges on repeat, and freezes releases", async () => {
    const { payroll, payrollBody, send } = await appsApiHarness();
    const app = `/v1/apps/${payroll.data.id}`;
    const archived = {
      ...payrollBody,
      lifecycle: { archivedAt: START, liveReleaseId: null, state: "archived" },
    };

    expect(await send("admin", "POST", `${app}/archive`)).toEqual({ body: archived, status: 200 });
    expect(await send("member", "GET", app)).toEqual({ body: archived, status: 200 });
    expect(await send("owner", "POST", `${app}/archive`)).toEqual({ body: archived, status: 200 });
    expect(await send("owner", "POST", `${app}/releases/${FIRST_RELEASE}/promote`)).toMatchObject({
      body: { code: "app_state_conflict" },
      status: 409,
    });
  });

  test("updates name, member access, and agent definition in one request", async () => {
    const { payroll, payrollBody, send } = await appsApiHarness();
    const app = `/v1/apps/${payroll.data.id}`;

    expect(
      await send("admin", "PATCH", app, {
        body: {
          access: { organizationMembers: "viewer" },
          agentDefinitionId: NEXT_AGENT,
          name: "Payroll desk",
        },
      }),
    ).toEqual({
      body: {
        ...payrollBody,
        access: { organizationMembers: "viewer" },
        agentDefinitionId: NEXT_AGENT,
        name: "Payroll desk",
      },
      status: 200,
    });
    expect(
      await send("admin", "PATCH", app, { body: { agentDefinitionId: MISSING_AGENT } }),
    ).toMatchObject({ body: { code: "agent_definition_unavailable" }, status: 422 });
    expect(await send("admin", "PATCH", app, { body: {} })).toMatchObject({
      body: { code: "validation_failed" },
      status: 422,
    });
    expect((await send("member", "GET", app)).body.agentDefinitionId).toBe(NEXT_AGENT);
  });
});
