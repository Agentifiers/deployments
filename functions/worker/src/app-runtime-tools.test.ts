import { afterEach, describe, expect, test } from "bun:test";
import { approved, appToolHarness, id, OTHER_AGENT, RUN } from "./app-runtime-tools.fixture.ts";
import { boundRunToolAuthorization } from "./execution-tool-policy.ts";

const ELEVEN_MINUTES = 11 * 60_000;
const SYSTEM = { type: "system" } as const;
const ORDERS = { name: "Orders", slug: "orders" };
const DATABASE_UNAVAILABLE = {
  error: { code: "database_unavailable", message: "connect ETIMEDOUT 10.0.1.5:5432" },
  ok: false,
};

let harness = appToolHarness();
afterEach(() => {
  harness.guest.remove();
  harness = appToolHarness();
});

describe("app tool resolution", () => {
  test("a run of another agent definition cannot see or reach the app", async () => {
    const appId = await harness.createApp();

    const listed = await harness.call("app.list", {}, { agentDefinitionId: OTHER_AGENT });
    const described = await harness.call(
      "app.describe",
      { appId },
      { agentDefinitionId: OTHER_AGENT },
    );
    const ownList = await harness.call("app.list", {});

    expect(listed.result?.output).toEqual({ apps: [] });
    expect(described.result?.output).toEqual({
      error: {
        code: "app_not_found",
        message: `App ${appId} is not one of this agent's apps in this workspace.`,
      },
    });
    expect(ownList.result?.output).toEqual({
      apps: [
        {
          appId,
          liveReleaseId: null,
          name: "Orders",
          publication: { audience: "members", serving: "single-page" },
          slug: "orders",
          state: "active",
          url: "https://orders.apps.example.com",
        },
      ],
    });
  });

  test("a run without a workspace is refused before anything is written", async () => {
    const created = await harness.call(
      "app.create",
      { name: "Orders", slug: "orders" },
      { workspaceId: undefined },
    );

    expect(created.result).toEqual({
      output: {
        error: {
          code: "workspace_required",
          message: "App tools work only in runs that belong to a workspace.",
        },
      },
      outputSummary: "app.create failed: App tools work only in runs that belong to a workspace.",
      status: "completed",
    });
    expect(harness.requests).toEqual([]);
    expect(await harness.apps.findAppBySlug("orders" as never)).toBeUndefined();
  });

  test.each([
    ["app.create", { name: "Orders", slug: "orders" }],
    ["app.set_publication", { appId: id("50"), audience: "public" }],
  ] as const)("a preview run is refused %s", async (toolName, input) => {
    const authorize = boundRunToolAuthorization(harness.service.authorizeToolCall, "interactive");
    const request = harness.runRequest(toolName, input, {
      agentDeploymentId: undefined,
      executionBindingId: id("12"),
      executionPurpose: "preview",
    });
    const decision = await authorize(request);
    if (decision.action !== "allow") throw new Error(`Expected allow, got ${decision.action}.`);

    const result = await harness.service.executeToolCall({
      ...request,
      decision,
      policyAction: "allow",
    });

    expect(result).toEqual({
      output: {
        denied: true,
        reason:
          "Agent-built apps requires a deployed agent and is unavailable to preview and evaluation runs.",
      },
      outputSummary: `Tool ${toolName} failed: Agent-built apps requires a deployed agent and is unavailable to preview and evaluation runs.`,
      status: "completed",
    });
    expect(harness.requests).toEqual([]);
  });
});

describe("app.create", () => {
  test("provisions the database and returns the app's URL", async () => {
    const created = await harness.call("app.create", { name: "Orders", slug: "orders" });
    const appId = created.result?.output?.appId;

    expect(harness.requests as unknown[]).toEqual([{ appId, op: "provision", slug: "orders" }]);
    expect(created.result?.output).toMatchObject({
      liveReleaseId: null,
      name: "Orders",
      slug: "orders",
      state: "active",
      url: "https://orders.apps.example.com",
    });
    expect(created.result?.outputSummary).toBe(
      "Created app orders at https://orders.apps.example.com.",
    );
  });

  test("records the database layout that provision creates", async () => {
    const appId = await harness.createApp();

    expect((await harness.apps.getApp(appId))?.data.databaseLayout).toBe(2);
  });

  test("a repeated call with the same idempotency key returns the same app", async () => {
    const request = harness.runRequest("app.create", { name: "Orders", slug: "orders" });
    const first = await harness.service.authorizeToolCall(request);
    const second = await harness.service.authorizeToolCall(request);
    if (first.action !== "allow" || second.action !== "allow") throw new Error("Expected allow.");

    const original = await harness.execute(request, first);
    const repeated = await harness.execute(request, second);

    expect(repeated.output).toEqual(original.output);
    expect(harness.requests.map((entry) => entry.op)).toEqual(["provision"]);
    expect((await harness.call("app.list", {})).result?.output?.apps).toHaveLength(1);
  });

  test("a retry after the Lambda could not answer converges on the app it began", async () => {
    let failures = 1;
    harness.answers.provision = (request) => {
      if (failures-- > 0) throw new Error("Rate exceeded");
      return { ok: true, value: { appId: request.appId } };
    };
    const request = harness.runRequest("app.create", { name: "Orders", slug: "orders" });
    const first = await harness.service.authorizeToolCall(request);
    if (first.action !== "allow") throw new Error("Expected allow.");

    const interrupted = await harness.execute(request, first).catch((cause: unknown) => cause);
    const between = await harness.apps.findAppBySlug("orders" as never);
    const retried = await harness.execute(request, first);

    expect(interrupted).toMatchObject({ name: "RuntimeToolPreparationRetryableError" });
    expect(between?.data.lifecycle.state).toBe("provisioning");
    expect(retried.output).toMatchObject({ slug: "orders", state: "active" });
    expect((await harness.call("app.list", {})).result?.output?.apps).toMatchObject([
      { appId: retried.output?.appId, state: "active" },
    ]);
  });

  test("a database that did not answer leaves the app provisioning for any run of the agent to resume", async () => {
    let failures = 1;
    harness.answers.provision = (request) =>
      failures-- > 0 ? DATABASE_UNAVAILABLE : { ok: true, value: { appId: request.appId } };

    const interrupted = await harness.call("app.create", ORDERS);
    const pending = await harness.apps.findAppBySlug("orders" as never);
    const resumed = await harness.call("app.create", ORDERS, { runId: id("20") });

    expect(interrupted.result?.output?.error).toEqual({
      code: "database_unavailable",
      message: `Provisioning app orders (${pending?.data.id}) did not finish, so the app is still provisioning. Call app.create again with slug "orders" and name "Orders" to resume it. Cause: connect ETIMEDOUT 10.0.1.5:5432`,
    });
    expect(pending?.data.lifecycle.state).toBe("provisioning");
    expect(resumed.result?.output).toMatchObject({ appId: pending?.data.id, state: "active" });
    expect(harness.requests.map((entry) => entry.op)).toEqual(["provision", "provision"]);
  });

  test("an erase that read the app before a resume loses, and one during the provision is refused", async () => {
    harness.answers.provision = () => DATABASE_UNAVAILABLE;
    await harness.call("app.create", ORDERS);
    const stale = (await harness.apps.findAppBySlug("orders" as never))!;
    harness.advance(ELEVEN_MINUTES);
    const erases: Record<string, unknown> = {};
    const erase = (app: typeof stale) =>
      harness.apps.transitionApp({ actor: SYSTEM, app, transition: { to: "erasing" } }).then(
        () => "erasing",
        (cause: { readonly reason?: string }) => cause.reason,
      );
    harness.answers.provision = async (request) => {
      erases.stale = await erase(stale);
      erases.current = await erase((await harness.apps.getApp(stale.data.id))!);
      return { ok: true, value: { appId: request.appId } };
    };

    const resumed = await harness.call("app.create", ORDERS, { runId: id("20") });

    expect({ erases, state: resumed.result?.output?.state }).toEqual({
      erases: { current: "still-provisioning", stale: "conflict" },
      state: "active",
    });
  });

  test("a resume that an erase overtook stops before it provisions", async () => {
    harness.answers.provision = () => DATABASE_UNAVAILABLE;
    await harness.call("app.create", ORDERS);
    harness.advance(ELEVEN_MINUTES);
    harness.afterNextSlugLookup(async (found) => {
      await harness.apps.transitionApp({
        actor: SYSTEM,
        app: found!,
        transition: { to: "erasing" },
      });
    });

    const overtaken = await harness
      .call("app.create", ORDERS, { runId: id("20") })
      .catch((cause: unknown) => cause);
    const retried = await harness.call("app.create", ORDERS, { runId: id("20") });

    expect({
      overtaken: (overtaken as Error).name,
      provisions: harness.requests.length,
      retried: retried.result?.output?.error,
      state: (await harness.apps.findAppBySlug("orders" as never))?.data.lifecycle.state,
    }).toEqual({
      overtaken: "RuntimeToolPreparationRetryableError",
      provisions: 1,
      retried: {
        code: "slug_taken",
        message:
          "The slug orders is taken and slugs are never reused. Choose another slug, or call app.list to find apps you already own.",
      },
      state: "erasing",
    });
  });

  test("a provision that cannot succeed unchanged marks the app failed", async () => {
    harness.answers.provision = () => ({
      error: { code: "provision_incomplete", message: "app_x_viewer can still CONNECT" },
      ok: false,
    });

    const created = await harness.call("app.create", ORDERS);
    const listed = await harness.call("app.list", {});

    expect(created.result?.output?.error).toMatchObject({ code: "provision_incomplete" });
    expect(listed.result?.output?.apps).toMatchObject([
      {
        failure: "provision_incomplete: app_x_viewer can still CONNECT",
        slug: "orders",
        state: "failed",
      },
    ]);
  });

  test("a later run of the same agent gets the app that already holds the slug", async () => {
    const appId = await harness.createApp();

    const again = await harness.call(
      "app.create",
      { name: "Order desk", slug: "orders" },
      { runId: id("20") },
    );

    expect({
      nextSteps: "nextSteps" in (again.result?.output ?? {}),
      output: again.result?.output,
      provisions: harness.requests.length,
      summary: again.result?.outputSummary,
    }).toMatchObject({
      nextSteps: true,
      output: {
        appId,
        liveReleaseId: null,
        name: "Orders",
        slug: "orders",
        state: "active",
        url: "https://orders.apps.example.com",
      },
      provisions: 1,
      summary:
        "App orders at https://orders.apps.example.com already belongs to this agent and is active, so app.create returned it.",
    });
  });

  test("a later run of the same agent gets its failed app back without provisioning again", async () => {
    harness.answers.provision = () => ({
      error: { code: "provision_incomplete", message: "app_x_viewer can still CONNECT" },
      ok: false,
    });
    await harness.call("app.create", ORDERS);

    const again = await harness.call("app.create", ORDERS, { runId: id("20") });

    expect({
      nextSteps: "nextSteps" in (again.result?.output ?? {}),
      output: again.result?.output,
      provisions: harness.requests.length,
    }).toMatchObject({
      nextSteps: false,
      output: {
        failure: "provision_incomplete: app_x_viewer can still CONNECT",
        slug: "orders",
        state: "failed",
      },
      provisions: 1,
    });
  });

  test("a reserved slug, or one another agent's app holds, is refused", async () => {
    await harness.createApp();

    const reserved = await harness.call("app.create", { name: "Admin", slug: "admin" });
    const taken = await harness.call(
      "app.create",
      { name: "Orders", slug: "orders" },
      { agentDefinitionId: OTHER_AGENT, runId: id("20") },
    );

    expect(reserved.result?.output?.error).toMatchObject({ code: "invalid_slug" });
    expect(taken.result?.output?.error).toEqual({
      code: "slug_taken",
      message:
        "The slug orders is taken and slugs are never reused. Choose another slug, or call app.list to find apps you already own.",
    });
  });
});

describe("app.migrate", () => {
  test("provisions an app of an older database layout once, before its first migration", async () => {
    const appId = await harness.firstLayoutApp();

    for (const sql of [
      "CREATE TABLE orders (id bigint PRIMARY KEY);",
      "ALTER TABLE orders ADD COLUMN status text;",
    ]) {
      await harness.call("app.migrate", { appId, description: "Shape orders", sql });
    }

    expect({
      layout: (await harness.apps.getApp(appId))?.data.databaseLayout,
      requests: harness.requests.map(({ op, appId: target }) => `${op} ${target}`),
    }).toEqual({
      layout: 2,
      requests: [`provision ${appId}`, `migrate ${appId}`, `migrate ${appId}`],
    });
  });

  test("a failed provision refuses the migration and records no new layout", async () => {
    const appId = await harness.firstLayoutApp();
    harness.answers.provision = () => ({
      error: { code: "provision_incomplete", message: "app_x_viewer can still CONNECT" },
      ok: false,
    });

    const refused = await harness.call("app.migrate", {
      appId,
      description: "Shape orders",
      sql: "CREATE TABLE orders (id bigint PRIMARY KEY);",
    });

    expect({
      error: refused.result?.output?.error,
      layout: (await harness.apps.getApp(appId))?.data.databaseLayout,
      requests: harness.requests.map(({ op }) => op),
    }).toEqual({
      error: { code: "provision_incomplete", message: "app_x_viewer can still CONNECT" },
      layout: 1,
      requests: ["provision"],
    });
  });
});

describe("approval once an app is live", () => {
  test("app.migrate runs freely on a draft and pauses for approval once live", async () => {
    let migrations = 0;
    harness.answers.migrate = () => ({
      ok: true,
      value: { appliedAt: "2026-10-09T12:00:00.000Z", migrationId: ++migrations, replayed: false },
    });
    const appId = await harness.createApp();
    const draft = await harness.call("app.migrate", {
      appId,
      description: "Create orders",
      sql: "CREATE TABLE orders (id bigint PRIMARY KEY);",
    });
    harness.guest.write("dist/index.html", "<!doctype html><title>Orders</title>");
    const released = await harness.call("app.release", { appId, directory: "dist" });
    const promoted = await harness.call("app.promote", {
      appId,
      releaseId: released.result?.output?.releaseId,
    });

    const live = await harness.call("app.migrate", {
      appId,
      description: "Add status",
      sql: "ALTER TABLE orders ADD COLUMN status text;",
    });
    const continuation = approved(live.decision);
    const executed = await harness.execute(
      live.request,
      continuation.decision,
      continuation.approvalId,
    );

    expect([draft.decision.action, promoted.decision.action]).toEqual(["allow", "allow"]);
    expect(draft.result?.output).toEqual({
      appId,
      appliedAt: "2026-10-09T12:00:00.000Z",
      migrationId: 1,
      replayed: false,
    });
    expect(live.decision).toMatchObject({
      action: "require-approval",
      reason: "This call needs approval because app orders is live.",
    });
    expect(executed.output).toEqual({
      appId,
      appliedAt: "2026-10-09T12:00:00.000Z",
      migrationId: 2,
      replayed: false,
    });
    expect(harness.requests.filter((entry) => entry.op === "migrate") as unknown[]).toEqual([
      {
        appId,
        description: "Create orders",
        idempotencyKey: `${RUN}:model-tool:1:0`,
        op: "migrate",
        sql: "CREATE TABLE orders (id bigint PRIMARY KEY);",
      },
      {
        appId,
        description: "Add status",
        idempotencyKey: live.request.idempotencyKey,
        op: "migrate",
        sql: "ALTER TABLE orders ADD COLUMN status text;",
      },
    ]);
  });

  test("a live app refuses an unapproved change that was authorized while it was a draft", async () => {
    const { appId } = await harness.liveApp();
    const request = harness.runRequest("app.migrate", {
      appId,
      description: "Add status",
      sql: "ALTER TABLE orders ADD COLUMN status text;",
    });

    const authorized = await harness.service.authorizeToolCall(request);

    const result = await harness.execute(request, approved(authorized).decision);

    expect(result.output).toEqual({
      error: {
        code: "approval_required",
        message:
          "This call needs approval because app orders is live. The app changed after this call was authorized; call app.migrate again to request approval.",
      },
    });
    expect(harness.requests.filter((entry) => entry.op === "migrate")).toEqual([]);
  });

  test("the first promotion runs without approval and later ones pause", async () => {
    const { appId, releaseId } = await harness.liveApp();
    harness.guest.write("dist/index.html", "<!doctype html><title>Orders v2</title>");
    const second = await harness.call("app.release", { appId, directory: "dist" });

    const rollback = await harness.call("app.promote", {
      appId,
      releaseId: second.result?.output?.releaseId,
    });

    expect((await harness.call("app.list", {})).result?.output?.apps).toMatchObject([
      { liveReleaseId: releaseId },
    ]);
    expect(rollback.decision).toMatchObject({
      action: "require-approval",
      reason: `This call needs approval because app orders is live on release ${releaseId}.`,
    });
  });
});

describe("app.promote", () => {
  test("refuses a release of another app", async () => {
    const mine = await harness.createApp("orders");
    const theirs = await harness.createApp("invoices");
    harness.guest.write("dist/index.html", "<!doctype html><title>Invoices</title>");
    const released = await harness.call("app.release", { appId: theirs, directory: "dist" });
    const releaseId = String(released.result?.output?.releaseId);

    const promoted = await harness.call("app.promote", { appId: mine, releaseId });

    expect(promoted.result?.output).toEqual({
      error: {
        code: "release_not_found",
        message: `Release ${releaseId} is not a release of app ${mine}.`,
      },
    });
    expect((await harness.call("app.list", {})).result?.output?.apps).toMatchObject([
      { liveReleaseId: null, slug: "orders" },
      { liveReleaseId: null, slug: "invoices" },
    ]);
  });
});
