import { describe, expect, test } from "bun:test";
import type { AppLifecycleState } from "../records/apps.ts";
import { PROVISION_SETTLE_MILLISECONDS, type AppLifecycleTarget } from "./lifecycle.ts";
import { appHarness, id, START } from "./test-support.ts";

const LEGAL_TARGETS: Record<AppLifecycleState, readonly AppLifecycleTarget[]> = {
  provisioning: ["provisioning", "active", "failed", "erasing"],
  failed: ["erasing"],
  active: ["archived", "erasing"],
  archived: ["erasing"],
  erasing: ["erased"],
};

const TARGETS: readonly AppLifecycleTarget[] = [
  "provisioning",
  "active",
  "failed",
  "archived",
  "erasing",
  "erased",
];

const EVENT_BY_TARGET: Record<AppLifecycleTarget, string> = {
  active: "app.activated",
  archived: "app.archived",
  erased: "app.erased",
  erasing: "app.erasing",
  failed: "app.failed",
  provisioning: "app.provisioning.resumed",
};

const SETTLED = PROVISION_SETTLE_MILLISECONDS + 60_000;

async function appIn(state: AppLifecycleState) {
  const harness = appHarness();
  const actor = { type: "system" } as const;
  const created = await harness.apps.createApp(harness.appInput());
  const move = (app: typeof created, to: "active" | "archived" | "erasing") =>
    harness.apps.transitionApp({ actor, app, transition: { to } });
  const reached = {
    provisioning: async () => created,
    failed: () =>
      harness.apps.transitionApp({
        actor,
        app: created,
        transition: { reason: "Provisioning failed.", to: "failed" },
      }),
    active: () => move(created, "active"),
    archived: async () => move(await move(created, "active"), "archived"),
    erasing: async () => move(await move(created, "active"), "erasing"),
  } satisfies Record<AppLifecycleState, () => Promise<typeof created>>;
  return { ...harness, actor, app: await reached[state]() };
}

const STATES: readonly AppLifecycleState[] = [
  "provisioning",
  "failed",
  "active",
  "archived",
  "erasing",
];

const cases = STATES.flatMap((from) =>
  TARGETS.map((to) => ({ from, legal: LEGAL_TARGETS[from].includes(to), to })),
);

describe("app lifecycle transitions", () => {
  test.each(cases.filter((entry) => entry.legal))("$from -> $to succeeds", async ({ from, to }) => {
    const { actor, advance, app, apps, eventTypes } = await appIn(from);
    advance(SETTLED);

    if (to === "erased") {
      await apps.eraseApp({ actor, app });
      expect(await apps.getApp(app.data.id)).toBeUndefined();
    } else {
      const next = await apps.transitionApp({
        actor,
        app,
        transition: to === "failed" ? { reason: "Provisioning failed.", to } : { to },
      });
      const stored = await apps.getApp(app.data.id);
      expect(stored?.data.lifecycle.state).toBe(to);
      expect(stored?.data.status).toBe(to);
      expect(stored?.data.version).toBe(app.data.version + 1);
      expect(next).toEqual(stored!);
    }
    expect(eventTypes(app).at(-1)).toBe(EVENT_BY_TARGET[to]);
    expect(eventTypes(app)).toHaveLength(app.data.version + 1);
  });

  test.each(cases.filter((entry) => !entry.legal))(
    "$from -> $to is rejected",
    async ({ from, to }) => {
      const { actor, app, apps, eventTypes } = await appIn(from);
      const eventsBefore = eventTypes(app);

      const attempt =
        to === "erased"
          ? apps.eraseApp({ actor, app })
          : apps.transitionApp({
              actor,
              app,
              transition: to === "failed" ? { reason: "Provisioning failed.", to } : { to },
            });

      expect(attempt).rejects.toMatchObject({
        _tag: "AppPersistenceError",
        reason: "illegal-state",
      });
      expect(await apps.getApp(app.data.id)).toEqual(app);
      expect(eventTypes(app)).toEqual(eventsBefore);
    },
  );

  test("records each lifecycle step with its timestamp and keeps the live release on archive", async () => {
    const { actor, advance, app, apps, eventTypes } = await appIn("active");
    const { app: withRelease, release } = await apps.createRelease({
      actor,
      app,
      bundleSha256: "b".repeat(64),
      bytes: 2_048,
      documents: ["index.html"],
      files: 3,
      releaseId: id("01ARZ3NDEKTSV4RRFFQ69G5FC1"),
      runId: app.data.createdBy.runId,
    });
    const live = await apps.promoteRelease({ actor, app: withRelease, releaseId: release.data.id });
    advance(60_000);

    const archived = await apps.transitionApp({ actor, app: live, transition: { to: "archived" } });

    expect(archived.data.lifecycle).toEqual({
      archivedAt: "2026-10-08T12:01:00.000Z",
      liveReleaseId: release.data.id,
      state: "archived",
    });
    expect(eventTypes(app)).toEqual([
      "app.created",
      "app.activated",
      "app.release.created",
      "app.release.promoted",
      "app.archived",
    ]);
  });

  test("a failed app keeps its failure reason", async () => {
    const { app } = await appIn("failed");

    expect(app.data.lifecycle).toEqual({
      failedAt: START,
      reason: "Provisioning failed.",
      state: "failed",
    });
  });
});

describe("erasing a provisioning app", () => {
  const MINUTE = 60_000;

  test("waits until ten minutes after the app's last write", async () => {
    const { actor, advance, app, apps } = await appIn("provisioning");

    advance(9 * MINUTE);
    const early = await apps
      .transitionApp({ actor, app, transition: { to: "erasing" } })
      .catch((error: unknown) => error);
    const afterRefusal = await apps.getApp(app.data.id);
    advance(2 * MINUTE);
    await apps.transitionApp({ actor, app, transition: { to: "erasing" } });

    expect(early).toMatchObject({
      message: `App ${app.data.id} may still be provisioning; erasure becomes possible after 2026-10-08T12:10:00.000Z.`,
      reason: "still-provisioning",
    });
    expect(afterRefusal).toEqual(app);
    expect((await apps.getApp(app.data.id))?.data.lifecycle).toEqual({
      requestedAt: "2026-10-08T12:11:00.000Z",
      state: "erasing",
    });
  });

  test("a resumed provision refreshes the app, so an erase that read it earlier loses", async () => {
    const { actor, advance, app: stale, apps, eventTypes } = await appIn("provisioning");
    advance(11 * MINUTE);

    const resumed = await apps.transitionApp({
      actor,
      app: stale,
      transition: { to: "provisioning" },
    });
    const staleErase = await apps
      .transitionApp({ actor, app: stale, transition: { to: "erasing" } })
      .catch((error: unknown) => error);
    const freshErase = await apps
      .transitionApp({ actor, app: resumed, transition: { to: "erasing" } })
      .catch((error: unknown) => error);

    expect(resumed.data).toMatchObject({
      lifecycle: { requestedAt: "2026-10-08T12:11:00.000Z", state: "provisioning" },
      updatedAt: "2026-10-08T12:11:00.000Z",
      version: 2,
    });
    expect(staleErase).toMatchObject({ reason: "conflict" });
    expect(freshErase).toMatchObject({ reason: "still-provisioning" });
    expect(await apps.getApp(stale.data.id)).toEqual(resumed);
    expect(eventTypes(stale)).toEqual(["app.created", "app.provisioning.resumed"]);
  });
});
