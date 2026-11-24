import { describe, expect, test } from "bun:test";
import { InvalidTenancyCursorError } from "../tenancy-contracts.ts";
import { ADMIN, appHarness, BUNDLE_SHA256, id, RUN } from "./test-support.ts";

const system = { type: "system" } as const;

describe("app rename", () => {
  test("renames once with an event, repeats as a no-op, and refuses an archived app", async () => {
    const { appInput, apps, eventTypes } = appHarness();
    const created = await apps.createApp(appInput());
    const app = await apps.transitionApp({
      actor: system,
      app: created,
      transition: { to: "active" },
    });

    const renamed = await apps.renameApp({ app, changedBy: ADMIN, name: "Payroll desk" });
    const repeated = await apps.renameApp({ app: renamed, changedBy: ADMIN, name: "Payroll desk" });
    const archived = await apps.transitionApp({
      actor: system,
      app: repeated,
      transition: { to: "archived" },
    });

    expect([renamed.data.name, renamed.data.version, repeated.data.version]).toEqual([
      "Payroll desk",
      3,
      3,
    ]);
    expect(
      apps.renameApp({ app: archived, changedBy: ADMIN, name: "Payroll archive" }),
    ).rejects.toMatchObject({ reason: "illegal-state" });
    expect(eventTypes(app)).toEqual([
      "app.created",
      "app.activated",
      "app.renamed",
      "app.archived",
    ]);
  });
});

describe("app reads", () => {
  test("pages releases newest first and rejects a cursor from another listing", async () => {
    const { appInput, apps } = appHarness();
    const created = await apps.createApp(appInput());
    let app = await apps.transitionApp({
      actor: system,
      app: created,
      transition: { to: "active" },
    });
    for (const releaseId of ["01ARZ3NDEKTSV4RRFFQ69G5FC1", "01ARZ3NDEKTSV4RRFFQ69G5FC2"]) {
      ({ app } = await apps.createRelease({
        actor: system,
        app,
        bundleSha256: BUNDLE_SHA256,
        bytes: 1,
        documents: ["index.html"],
        files: 1,
        releaseId: id(releaseId),
        runId: RUN,
      }));
    }

    const first = await apps.pageReleases({ app, limit: 1 });
    const second = await apps.pageReleases({ app, cursor: first.nextCursor ?? "", limit: 1 });

    expect([...first.items, ...second.items].map((release): string => release.data.id)).toEqual([
      "01ARZ3NDEKTSV4RRFFQ69G5FC2",
      "01ARZ3NDEKTSV4RRFFQ69G5FC1",
    ]);
    expect(second.nextCursor).toBeNull();
    expect(apps.pageGrants({ app, cursor: first.nextCursor ?? "" })).rejects.toBeInstanceOf(
      InvalidTenancyCursorError,
    );
  });
});
