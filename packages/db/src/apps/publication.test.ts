import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { AppRecord, type AppAudience } from "../records/apps.ts";
import { appIsPublic, type AppDatabaseConvergence } from "./publication.ts";
import { ADMIN, appHarness, BUNDLE_SHA256, id, RUN, slug, START } from "./test-support.ts";

const system = { type: "system" } as const;
const owner = { id: ADMIN, type: "principal" } as const;

function fakeDatabase(layout = 2) {
  const converged: string[] = [];
  const database: AppDatabaseConvergence = {
    converge: async (app) => {
      converged.push(`${app.data.id}@${app.data.version}`);
    },
    layout,
  };
  return { converged, database };
}

async function activeHarness() {
  const harness = appHarness();
  const created = await harness.apps.createApp(harness.appInput());
  const app = await harness.apps.transitionApp({
    actor: system,
    app: created,
    transition: { to: "active" },
  });
  return { ...harness, app };
}

function eventsOf(memory: ReturnType<typeof appHarness>["memory"], eventType: string) {
  return memory
    .all()
    .flatMap((record) =>
      record.itemType === "semantic-event" && record.data.eventType === eventType
        ? [{ actor: record.data.actor, payload: record.data.payload }]
        : [],
    );
}

describe("app publication records", () => {
  test("a stored app without publication or layout decodes as members, single-page, layout 1", async () => {
    const { app } = await activeHarness();
    const {
      databaseLayout: _layout,
      publication: _publication,
      ...legacy
    } = Schema.encodeSync(AppRecord)(app).data;

    const decoded = Schema.decodeUnknownSync(AppRecord)({ ...app, data: legacy });

    expect(decoded.data.publication).toEqual({ audience: "members", serving: "single-page" });
    expect(decoded.data.databaseLayout).toBe(1);
  });

  test("a new app stores its publication and the layout it was created with", async () => {
    const { appInput, apps, memory } = appHarness();

    await apps.createApp(appInput({ databaseLayout: 2 }));

    expect(memory.all().find((record) => record.itemType === "app")?.data).toMatchObject({
      databaseLayout: 2,
      publication: { audience: "members", serving: "single-page" },
    });
  });
});

describe("setPublication", () => {
  test("publishing a layout-1 app stamps the record, converges its database, then writes publication and layout", async () => {
    const { app, apps, eventTypes, memory } = await activeHarness();
    const { converged, database } = fakeDatabase();

    const published = await apps.setPublication({
      actor: owner,
      app,
      database,
      publication: { audience: "public", serving: "static-site" },
    });

    expect(converged).toEqual([`${app.data.id}@${app.data.version + 1}`]);
    expect(published.data).toMatchObject({
      databaseConvergenceStartedAt: START,
      databaseLayout: 2,
      publication: { audience: "public", serving: "static-site" },
      version: app.data.version + 2,
    });
    expect(await apps.getApp(app.data.id)).toEqual(published);
    expect(eventTypes(app)).toEqual([
      "app.created",
      "app.activated",
      "app.database-convergence.started",
      "app.publication.changed",
    ]);
    expect(eventsOf(memory, "app.database-convergence.started")).toEqual([
      { actor: owner, payload: { appId: app.data.id, next: 2, previous: 1 } },
    ]);
    expect(eventsOf(memory, "app.publication.changed")).toEqual([
      {
        actor: owner,
        payload: {
          appId: app.data.id,
          next: { audience: "public", serving: "static-site" },
          previous: { audience: "members", serving: "single-page" },
        },
      },
    ]);
  });

  test("converges only when the next audience is public and the recorded layout is lower", async () => {
    const { appInput, apps } = appHarness();
    const current = await apps.createApp(appInput({ databaseLayout: 2 }));
    const legacy = await apps.createApp(appInput({ slug: slug("ledger") }));
    const { converged, database } = fakeDatabase();

    const publicCurrent = await apps.setPublication({
      actor: owner,
      app: current,
      database,
      publication: { audience: "public", serving: "single-page" },
    });
    const servingOnly = await apps.setPublication({
      actor: owner,
      app: legacy,
      database,
      publication: { audience: "members", serving: "static-site" },
    });

    expect(converged).toEqual([]);
    expect([publicCurrent.data.databaseLayout, servingOnly.data.databaseLayout]).toEqual([2, 1]);
  });

  test("writing the current settings changes nothing and converges nothing", async () => {
    const { app, apps, eventTypes } = await activeHarness();
    const { converged, database } = fakeDatabase();

    const unchanged = await apps.setPublication({
      actor: owner,
      app,
      database,
      publication: { audience: "members", serving: "single-page" },
    });

    expect(unchanged).toBe(app);
    expect(converged).toEqual([]);
    expect(eventTypes(app)).toEqual(["app.created", "app.activated"]);
  });

  test("a stale record loses the version race", async () => {
    const { app, apps } = await activeHarness();
    const { database } = fakeDatabase();
    await apps.setPublication({
      actor: owner,
      app,
      database,
      publication: { audience: "members", serving: "static-site" },
    });

    expect(
      apps.setPublication({
        actor: owner,
        app,
        database,
        publication: { audience: "public", serving: "single-page" },
      }),
    ).rejects.toMatchObject({ _tag: "AppPersistenceError", reason: "conflict" });
    expect((await apps.getApp(app.data.id))?.data.publication).toEqual({
      audience: "members",
      serving: "static-site",
    });
  });

  test("is refused once the app is archived, before any convergence", async () => {
    const { app, apps } = await activeHarness();
    const { converged, database } = fakeDatabase();
    const archived = await apps.transitionApp({
      actor: system,
      app,
      transition: { to: "archived" },
    });

    expect(
      apps.setPublication({
        actor: owner,
        app: archived,
        database,
        publication: { audience: "public", serving: "single-page" },
      }),
    ).rejects.toMatchObject({ reason: "illegal-state" });
    expect(converged).toEqual([]);
  });
});

describe("convergeDatabase", () => {
  test("converges and records a lower layout once, then does nothing", async () => {
    const { app, apps, memory } = await activeHarness();
    const { converged, database } = fakeDatabase();

    const raised = await apps.convergeDatabase({ actor: system, app, database });
    const again = await apps.convergeDatabase({ actor: system, app: raised, database });

    expect(converged).toEqual([`${app.data.id}@${app.data.version + 1}`]);
    expect(raised.data).toMatchObject({ databaseLayout: 2, version: app.data.version + 2 });
    expect(again).toBe(raised);
    expect(eventsOf(memory, "app.database-layout.changed")).toEqual([
      { actor: system, payload: { appId: app.data.id, next: 2, previous: 1 } },
    ]);
  });
});

describe("erasing after a database convergence started", () => {
  test("waits until the provision can no longer be running, whether or not it answered", async () => {
    const { advance, appInput, apps } = appHarness();
    const activeApp = async (name: string) =>
      apps.transitionApp({
        actor: system,
        app: await apps.createApp(appInput({ name, slug: slug(name.toLowerCase()) })),
        transition: { to: "active" },
      });
    const abandoning: AppDatabaseConvergence = {
      converge: async () => {
        throw new Error("Request aborted");
      },
      layout: 2,
    };
    const timedOut = await activeApp("Payroll");
    const migrated = await activeApp("Ledger");
    const untouched = await activeApp("Roster");
    const publishing = await apps
      .setPublication({
        actor: owner,
        app: timedOut,
        database: abandoning,
        publication: { audience: "public", serving: "single-page" },
      })
      .catch((error: unknown) => (error instanceof Error ? error.message : error));
    await apps.convergeDatabase({
      actor: system,
      app: migrated,
      database: fakeDatabase().database,
    });
    const erase = (app: AppRecord) =>
      apps.getApp(app.data.id).then((current) =>
        apps.transitionApp({ actor: system, app: current!, transition: { to: "erasing" } }).then(
          (erasing) => erasing.data.lifecycle.state,
          (error: unknown) => (error instanceof Error ? error.message : error),
        ),
      );

    const early = {
      migrated: await erase(migrated),
      timedOut: await erase(timedOut),
      untouched: await erase(untouched),
    };
    advance(11 * 60_000);
    const settled = { migrated: await erase(migrated), timedOut: await erase(timedOut) };

    expect({
      early,
      publishing,
      settled,
      timedOut: (await apps.getApp(timedOut.data.id))?.data,
    }).toMatchObject({
      early: {
        migrated: `App ${migrated.data.id} may still be provisioning; erasure becomes possible after 2026-10-08T12:10:00.000Z.`,
        timedOut: `App ${timedOut.data.id} may still be provisioning; erasure becomes possible after 2026-10-08T12:10:00.000Z.`,
        untouched: "erasing",
      },
      publishing: "Request aborted",
      settled: { migrated: "erasing", timedOut: "erasing" },
      timedOut: {
        databaseLayout: 1,
        lifecycle: { state: "erasing" },
        publication: { audience: "members", serving: "single-page" },
      },
    });
  });
});

describe("appIsPublic", () => {
  test("needs the public audience, an active lifecycle, and a live release", async () => {
    const { app, apps } = await activeHarness();
    const { database } = fakeDatabase();
    const withAudience = (published: AppRecord, audience: AppAudience) =>
      apps.setPublication({
        actor: owner,
        app: published,
        database,
        publication: { audience, serving: "single-page" },
      });
    const releaseId = id("01ARZ3NDEKTSV4RRFFQ69G5FC1");
    const publicNoRelease = await withAudience(app, "public");
    const released = await apps.createRelease({
      actor: system,
      app: publicNoRelease,
      bundleSha256: BUNDLE_SHA256,
      bytes: 1,
      documents: ["index.html"],
      files: 1,
      releaseId,
      runId: RUN,
    });
    const publicLive = await apps.promoteRelease({ actor: system, app: released.app, releaseId });
    const membersLive = await withAudience(publicLive, "members");
    const publicArchived = await apps.transitionApp({
      actor: system,
      app: await withAudience(membersLive, "public"),
      transition: { to: "archived" },
    });

    expect(
      [app, publicNoRelease, publicLive, membersLive, publicArchived].map((record) =>
        appIsPublic(record.data),
      ),
    ).toEqual([false, false, true, false, false]);
  });
});
