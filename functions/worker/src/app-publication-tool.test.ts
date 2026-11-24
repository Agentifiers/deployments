import { afterEach, describe, expect, test } from "bun:test";
import { AppSlug, type AppPublication, type Ulid } from "@deployments-ai/db";
import { Schema } from "effect";
import { approved, appToolHarness, OTHER_AGENT } from "./app-runtime-tools.fixture.ts";

const SYSTEM = { type: "system" } as const;
const CONVERGED = { converge: async () => {}, layout: 2 };
const DATABASE_UNAVAILABLE = {
  error: { code: "database_unavailable", message: "connect ETIMEDOUT 10.0.1.5:5432" },
  ok: false,
};

let harness = appToolHarness();
afterEach(() => {
  harness.guest.remove();
  harness = appToolHarness();
});

async function stored(appId: Ulid) {
  return (await harness.apps.getApp(appId))!.data;
}

async function publishByHand(appId: Ulid, publication: AppPublication) {
  await harness.apps.setPublication({
    actor: SYSTEM,
    app: (await harness.apps.getApp(appId))!,
    database: CONVERGED,
    publication,
  });
}

describe("app.set_publication", () => {
  test("changes a draft app's serving without approval and returns the app's settings", async () => {
    const appId = await harness.createApp();

    const changed = await harness.call("app.set_publication", { appId, serving: "static-site" });

    expect(changed.decision).toMatchObject({
      action: "allow",
      reason: "app.set_publication runs on app orders without approval.",
    });
    expect(changed.result?.output).toEqual({
      appId,
      liveReleaseId: null,
      name: "Orders",
      publication: { audience: "members", serving: "static-site" },
      slug: "orders",
      state: "active",
      url: "https://orders.apps.example.com",
    });
    expect(changed.result?.outputSummary).toBe(
      "App orders has audience members and serving static-site.",
    );
    expect((await stored(appId)).publication).toEqual({
      audience: "members",
      serving: "static-site",
    });
  });

  test("making an app public waits for approval, then brings an older database up to date", async () => {
    const appId = await harness.firstLayoutApp();

    const requested = await harness.call("app.set_publication", { appId, audience: "public" });
    const continuation = approved(requested.decision);
    const published = await harness.execute(
      requested.request,
      continuation.decision,
      continuation.approvalId,
    );

    expect(requested.decision).toMatchObject({
      action: "require-approval",
      reason:
        "This call needs approval because it opens app orders, which has no live release yet, to anyone on the internet.",
    });
    expect(published.output).toMatchObject({
      publication: { audience: "public", serving: "single-page" },
    });
    const app = await stored(appId);
    expect({
      layout: app.databaseLayout,
      publication: app.publication,
      requests: harness.requests.map(({ op, appId: target }) => `${op} ${target}`),
    }).toEqual({
      layout: 2,
      publication: { audience: "public", serving: "single-page" },
      requests: [`provision ${appId}`],
    });
  });

  test("returns a live public app to members without approval", async () => {
    const { appId } = await harness.liveApp();
    await publishByHand(appId, { audience: "public", serving: "single-page" });

    const narrowed = await harness.call("app.set_publication", { appId, audience: "members" });

    expect(narrowed.decision.action).toBe("allow");
    expect((await stored(appId)).publication).toEqual({
      audience: "members",
      serving: "single-page",
    });
  });

  test("changing how a live app serves pages waits for approval", async () => {
    const { appId } = await harness.liveApp();

    const requested = await harness.call("app.set_publication", {
      appId,
      serving: "static-site",
    });

    expect(requested.decision).toMatchObject({
      action: "require-approval",
      reason: "This call needs approval because it changes how live app orders serves pages.",
    });
    expect((await stored(appId)).publication.serving).toBe("single-page");
  });

  test("changing only the audience keeps the app's serving", async () => {
    const appId = await harness.createApp();
    await harness.call("app.set_publication", { appId, serving: "static-site" });

    const requested = await harness.call("app.set_publication", { appId, audience: "public" });
    const continuation = approved(requested.decision);
    await harness.execute(requested.request, continuation.decision, continuation.approvalId);

    expect((await stored(appId)).publication).toEqual({
      audience: "public",
      serving: "static-site",
    });
  });

  test("changes a provisioning app, as the API does", async () => {
    harness.answers.provision = () => DATABASE_UNAVAILABLE;
    await harness.call("app.create", { name: "Orders", slug: "orders" });
    const appId = (await harness.apps.findAppBySlug(Schema.decodeUnknownSync(AppSlug)("orders")))!
      .data.id;

    const changed = await harness.call("app.set_publication", { appId, serving: "static-site" });

    expect(changed.result?.output).toMatchObject({
      publication: { audience: "members", serving: "static-site" },
      state: "provisioning",
    });
  });

  test("refuses unreadable settings, another agent's app, and an archived app", async () => {
    const appId = await harness.createApp();

    const empty = await harness.call("app.set_publication", { appId });
    const unknown = await harness.call("app.set_publication", { appId, audience: "everyone" });
    const foreign = await harness.call(
      "app.set_publication",
      { appId, serving: "static-site" },
      { agentDefinitionId: OTHER_AGENT },
    );
    await harness.apps.transitionApp({
      actor: SYSTEM,
      app: (await harness.apps.getApp(appId))!,
      transition: { to: "archived" },
    });
    const archived = await harness.call("app.set_publication", { appId, audience: "public" });
    const invalid = {
      code: "invalid_publication",
      message:
        "Provide audience (members or public), serving (single-page or static-site), or both.",
    };

    expect(
      [empty, unknown, foreign, archived].map(({ decision, result }) => ({
        action: decision.action,
        error: result?.output?.error,
      })),
    ).toEqual([
      { action: "allow", error: invalid },
      { action: "allow", error: invalid },
      {
        action: "allow",
        error: {
          code: "app_not_found",
          message: `App ${appId} is not one of this agent's apps in this workspace.`,
        },
      },
      {
        action: "allow",
        error: {
          code: "app_not_ready",
          message: "App orders is archived; app.set_publication needs it provisioning or active.",
        },
      },
    ]);
    expect((await stored(appId)).publication).toEqual({
      audience: "members",
      serving: "single-page",
    });
  });
});

describe("approval re-checked when the call runs", () => {
  test("a promotion authorized while the app was private is refused once it is made public", async () => {
    const appId = await harness.createApp();
    harness.guest.write("dist/index.html", "<!doctype html><title>Orders</title>");
    const released = await harness.call("app.release", { appId, directory: "dist" });
    const request = harness.runRequest("app.promote", {
      appId,
      releaseId: released.result?.output?.releaseId,
    });
    const authorized = await harness.service.authorizeToolCall(request);
    if (authorized.action !== "allow") throw new Error(`Expected allow, got ${authorized.action}.`);
    await publishByHand(appId, { audience: "public", serving: "single-page" });

    const promoted = await harness.execute(request, authorized);

    expect(promoted.output).toEqual({
      error: {
        code: "approval_required",
        message:
          "This call needs approval because app orders, which has no live release yet, has a public audience. The app changed after this call was authorized; call app.promote again to request approval.",
      },
    });
    expect((await stored(appId)).lifecycle).toEqual({ liveReleaseId: null, state: "active" });
  });

  test("a serving change authorized on a draft is refused once the app goes live", async () => {
    const appId = await harness.createApp();
    const request = harness.runRequest("app.set_publication", { appId, serving: "static-site" });
    const authorized = await harness.service.authorizeToolCall(request);
    if (authorized.action !== "allow") throw new Error(`Expected allow, got ${authorized.action}.`);
    harness.guest.write("dist/index.html", "<!doctype html><title>Orders</title>");
    const released = await harness.call("app.release", { appId, directory: "dist" });
    await harness.call("app.promote", { appId, releaseId: released.result?.output?.releaseId });

    const changed = await harness.execute(request, authorized);

    expect(changed.output).toEqual({
      error: {
        code: "approval_required",
        message:
          "This call needs approval because it changes how live app orders serves pages. The app changed after this call was authorized; call app.set_publication again to request approval.",
      },
    });
    expect((await stored(appId)).publication.serving).toBe("single-page");
  });

  test("a retry of the promotion that made the app live runs without approval", async () => {
    const { appId, releaseId } = await harness.liveApp();

    const retried = await harness.call("app.promote", { appId, releaseId });

    expect({ action: retried.decision.action, output: retried.result?.output }).toEqual({
      action: "allow",
      output: {
        appId,
        liveReleaseId: releaseId,
        previousReleaseId: releaseId,
        url: "https://orders.apps.example.com",
      },
    });
  });

  test("an approved serving change is refused once a human returns the app to members", async () => {
    const { appId } = await harness.liveApp();
    await publishByHand(appId, { audience: "public", serving: "single-page" });
    const requested = await harness.call("app.set_publication", {
      appId,
      audience: "public",
      serving: "static-site",
    });
    await publishByHand(appId, { audience: "members", serving: "single-page" });
    const continuation = approved(requested.decision);

    const changed = await harness.execute(
      requested.request,
      continuation.decision,
      continuation.approvalId,
    );

    expect({ reason: requested.decision.reason, output: changed.output }).toEqual({
      output: {
        error: {
          code: "approval_required",
          message:
            "This call needs approval because it opens live app orders to anyone on the internet and changes how live app orders serves pages. The app changed after this call was authorized; call app.set_publication again to request approval.",
        },
      },
      reason: "This call needs approval because it changes how live app orders serves pages.",
    });
    expect((await stored(appId)).publication).toEqual({
      audience: "members",
      serving: "single-page",
    });
  });

  test("opening an app approved before it had a live release is refused once a release goes live", async () => {
    const appId = await harness.createApp();
    const requested = await harness.call("app.set_publication", { appId, audience: "public" });
    harness.guest.write("dist/index.html", "<!doctype html><title>Orders</title>");
    const released = await harness.call("app.release", { appId, directory: "dist" });
    const promoted = await harness.call("app.promote", {
      appId,
      releaseId: released.result?.output?.releaseId,
    });
    const continuation = approved(requested.decision);

    const opened = await harness.execute(
      requested.request,
      continuation.decision,
      continuation.approvalId,
    );

    expect({ promote: promoted.decision.action, output: opened.output }).toEqual({
      output: {
        error: {
          code: "approval_required",
          message:
            "This call needs approval because it opens live app orders to anyone on the internet. The app changed after this call was authorized; call app.set_publication again to request approval.",
        },
      },
      promote: "allow",
    });
    expect((await stored(appId)).publication.audience).toBe("members");
  });

  test("a promotion approved while the app was live is refused once it is made public", async () => {
    const { appId, releaseId } = await harness.liveApp();
    harness.guest.write("dist/index.html", "<!doctype html><title>Orders 2</title>");
    const released = await harness.call("app.release", { appId, directory: "dist" });
    const requested = await harness.call("app.promote", {
      appId,
      releaseId: released.result?.output?.releaseId,
    });
    await publishByHand(appId, { audience: "public", serving: "single-page" });
    const continuation = approved(requested.decision);

    const promoted = await harness.execute(
      requested.request,
      continuation.decision,
      continuation.approvalId,
    );

    expect({ reason: requested.decision.reason, output: promoted.output }).toEqual({
      output: {
        error: {
          code: "approval_required",
          message: `This call needs approval because app orders is live on release ${releaseId} and has a public audience. The app changed after this call was authorized; call app.promote again to request approval.`,
        },
      },
      reason: `This call needs approval because app orders is live on release ${releaseId}.`,
    });
    expect<unknown>((await stored(appId)).lifecycle).toEqual({
      liveReleaseId: releaseId,
      state: "active",
    });
  });

  test("a promotion approved while one release was live is refused once a person makes another live", async () => {
    const { appId, releaseId: first } = await harness.liveApp();
    const second = await harness.release(appId, "Orders 2");
    const third = await harness.release(appId, "Orders 3");
    const requested = await harness.call("app.promote", { appId, releaseId: second });
    await harness.apps.promoteRelease({
      actor: SYSTEM,
      app: (await harness.apps.getApp(appId))!,
      releaseId: third,
    });
    const continuation = approved(requested.decision);

    const promoted = await harness.execute(
      requested.request,
      continuation.decision,
      continuation.approvalId,
    );

    expect({ reason: requested.decision.reason, output: promoted.output }).toEqual({
      output: {
        error: {
          code: "approval_required",
          message: `This call needs approval because app orders is live on release ${third}. The app changed after this call was authorized; call app.promote again to request approval.`,
        },
      },
      reason: `This call needs approval because app orders is live on release ${first}.`,
    });
    expect<unknown>((await stored(appId)).lifecycle).toEqual({
      liveReleaseId: third,
      state: "active",
    });
  });

  test("an approval whose reason the runtime redacted still runs", async () => {
    const appId = await harness.createApp("sk-community-signups");
    const requested = await harness.call("app.set_publication", { appId, audience: "public" });
    const continuation = approved(requested.decision);

    await harness.execute(requested.request, continuation.decision, continuation.approvalId);

    expect({
      approved: continuation.decision.reason,
      audience: (await stored(appId)).publication.audience,
    }).toEqual({
      approved:
        "This call needs approval because it opens app [redacted-provider-token], which has no live release yet, to anyone on the internet.",
      audience: "public",
    });
  });
});

describe("app.describe", () => {
  test("reports the app's publication and the schema of each callable function", async () => {
    const functions = [
      {
        arguments: [],
        name: "list_signups",
        returns: { columns: [], set: true, shape: "row", type: "signups" },
        schema: "api",
        volatility: "stable",
      },
      {
        arguments: [{ hasDefault: false, name: "email", type: "text" }],
        name: "sign_up",
        returns: { columns: [], set: false, shape: "void", type: null },
        schema: "visitor",
        volatility: "volatile",
      },
    ];
    harness.answers.describe = () => ({
      ok: true,
      value: { client: "", functions, migrations: [], relations: [] },
    });
    const appId = await harness.createApp();
    await publishByHand(appId, { audience: "public", serving: "static-site" });

    const described = await harness.call("app.describe", { appId });

    expect({
      app: described.result?.output?.app,
      functions: described.result?.output?.functions,
      summary: described.result?.outputSummary,
    }).toEqual({
      app: {
        appId,
        liveReleaseId: null,
        name: "Orders",
        publication: { audience: "public", serving: "static-site" },
        slug: "orders",
        state: "active",
        url: "https://orders.apps.example.com",
      },
      functions,
      summary:
        "Described app orders: 0 relation(s), 1 api and 1 visitor function(s), 0 release(s).",
    });
  });
});
