import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import { makeIdGenerator, type Ulid } from "../ids.ts";
import { AppReleaseRecord, AppSlug, type AppRecord } from "../records/apps.ts";
import { makeAppPersistence, type AppErasureOwner, type AppPersistence } from "./persistence.ts";
import {
  ADMIN,
  AGENT,
  appHarness,
  BUNDLE_SHA256,
  ENVIRONMENT,
  id,
  MEMBER,
  ORGANIZATION,
  OTHER_ORGANIZATION,
  RUN,
  slug,
  START,
  WORKSPACE,
} from "./test-support.ts";

const system = { type: "system" } as const;

async function activeApp(apps: AppPersistence, app: AppRecord) {
  return apps.transitionApp({ actor: system, app, transition: { to: "active" } });
}

function release(apps: AppPersistence, app: AppRecord, releaseId: Ulid) {
  return apps.createRelease({
    actor: system,
    app,
    bundleSha256: BUNDLE_SHA256,
    bytes: 4_096,
    documents: ["index.html"],
    files: 2,
    releaseId,
    runId: RUN,
  });
}

function outcome<Value>(results: readonly PromiseSettledResult<Value>[]) {
  return {
    errors: results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    values: results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
  };
}

function fencedBy(database: DynamoDatabaseService, owner: AppErasureOwner): DynamoDatabaseService {
  return {
    ...database,
    transactWrite: async (operations, token, signal) => {
      const fenced = operations.some(
        (operation) =>
          operation.kind !== "condition-check" &&
          "organizationId" in operation.record.data &&
          operation.record.data.organizationId === owner.organizationId,
      );
      if (fenced) throw new Error("The organization is being erased.");
      return database.transactWrite(operations, token, signal);
    },
    transactWriteForErasure: async (operations, writer, token, signal) => {
      if (writer.operationId !== owner.operationId) {
        throw new Error("Another erasure holds the organization fence.");
      }
      return database.transactWrite(operations, token, signal);
    },
  };
}

describe("app slugs", () => {
  test("accepts only well-formed, unreserved slugs", () => {
    const valid = (input: string) => Schema.is(AppSlug)(input);

    expect(["payroll", "q3-budget-tracker", "abc"].map(valid)).toEqual([true, true, true]);
    expect(
      ["ab", "Payroll", "9lives", "ends-", "double--hyphen", "xn-abc", "admin", "www"].map(valid),
    ).toEqual([false, false, false, false, false, false, false, false]);
  });

  test("two concurrent creates with one slug leave exactly one app", async () => {
    const { appInput, apps } = appHarness();

    const results = await Promise.allSettled([
      apps.createApp(appInput()),
      apps.createApp(appInput({ organizationId: OTHER_ORGANIZATION })),
    ]);

    const { errors, values } = outcome(results);
    expect(errors).toMatchObject([{ _tag: "AppPersistenceError", reason: "slug-taken" }]);
    expect(await apps.findAppBySlug(slug("payroll"))).toEqual(values[0]!);
    expect(values[0]?.data.slug).toBe(slug("payroll"));
  });

  test("the slug stays reserved after the organization's app records are erased", async () => {
    const { appInput, apps, eraseOrganization, memory } = appHarness();
    const app = await apps.createApp(appInput());

    eraseOrganization(ORGANIZATION);

    expect(memory.all().filter((record) => record.pk.startsWith(`ORG#${ORGANIZATION}`))).toEqual(
      [],
    );
    expect(await apps.getApp(app.data.id)).toBeUndefined();
    expect(await apps.findAppBySlug(slug("payroll"))).toBeUndefined();
    expect(
      memory
        .all()
        .flatMap((record) => (record.itemType === "app-slug-reservation" ? [record.data] : [])),
    ).toEqual([{ appId: app.data.id, reservedAt: START, slug: slug("payroll") }]);
    expect(apps.createApp(appInput({ organizationId: OTHER_ORGANIZATION }))).rejects.toMatchObject({
      reason: "slug-taken",
    });
  });
});

describe("app records", () => {
  test("a new app starts provisioning with no member access and is found by id and slug", async () => {
    const { appInput, apps } = appHarness();

    const app = await apps.createApp(appInput());

    expect(app.data).toMatchObject({
      access: { organizationMembers: "none" },
      agentDefinitionId: AGENT,
      createdBy: { principalId: null, runId: RUN },
      lifecycle: { requestedAt: START, state: "provisioning" },
      slug: "payroll",
      status: "provisioning",
      version: 1,
      workspaceId: WORKSPACE,
    });
    expect(app.pk).toBe(`ORG#${ORGANIZATION}#ENV#${ENVIRONMENT}`);
    expect(await apps.getApp(app.data.id)).toEqual(app);
    expect(await apps.findAppBySlug(slug("payroll"))).toEqual(app);
  });

  test("lists apps for exactly one agent definition in one workspace", async () => {
    const { appInput, apps } = appHarness();
    const otherAgent = id("01ARZ3NDEKTSV4RRFFQ69G5FB0");
    const otherWorkspace = id("01ARZ3NDEKTSV4RRFFQ69G5FB1");
    const mine = await apps.createApp(appInput());
    await apps.createApp(appInput({ agentDefinitionId: otherAgent, slug: slug("other-agent") }));
    await apps.createApp(appInput({ slug: slug("other-workspace"), workspaceId: otherWorkspace }));

    const listed = await apps.listAppsForAgent({
      agentDefinitionId: AGENT,
      environmentId: ENVIRONMENT,
      organizationId: ORGANIZATION,
      workspaceId: WORKSPACE,
    });

    expect(listed.map((app) => app.data.slug)).toEqual([mine.data.slug]);
  });

  test("a stale record loses the version race and changes nothing", async () => {
    const { appInput, apps, eventTypes } = appHarness();
    const app = await apps.createApp(appInput());

    const results = await Promise.allSettled([
      apps.transitionApp({ actor: system, app, transition: { to: "active" } }),
      apps.transitionApp({
        actor: system,
        app,
        transition: { reason: "No capacity.", to: "failed" },
      }),
    ]);

    const { errors, values } = outcome(results);
    expect(errors).toMatchObject([{ _tag: "AppPersistenceError", reason: "conflict" }]);
    const winner = values[0]!;
    expect(await apps.getApp(app.data.id)).toEqual(winner);
    expect(winner.data.version).toBe(2);
    expect(
      apps.setAccess({ app, changedBy: ADMIN, organizationMembers: "viewer" }),
    ).rejects.toMatchObject({ reason: "conflict" });
    expect(eventTypes(app)).toEqual([
      "app.created",
      winner.data.lifecycle.state === "active" ? "app.activated" : "app.failed",
    ]);
  });

  test("a grant and a release written against one app version leave exactly one of them", async () => {
    const { appInput, apps, eventTypes } = appHarness();
    const app = await activeApp(apps, await apps.createApp(appInput()));

    const { errors } = outcome<unknown>(
      await Promise.allSettled([
        apps.putGrant({ app, changedBy: ADMIN, principalId: MEMBER, role: "viewer" }),
        release(apps, app, id("01ARZ3NDEKTSV4RRFFQ69G5FC1")),
      ]),
    );

    const children = [...(await apps.listGrants(app)), ...(await apps.listReleases(app))];
    expect(errors).toMatchObject([{ _tag: "AppPersistenceError", reason: "conflict" }]);
    expect(children).toHaveLength(1);
    expect((await apps.getApp(app.data.id))?.data.version).toBe(3);
    expect(eventTypes(app)).toEqual([
      "app.created",
      "app.activated",
      children[0]?.itemType === "app-grant" ? "app.grant.changed" : "app.release.created",
    ]);
  });
});

describe("app releases", () => {
  test("promotion moves the live release, including a rollback", async () => {
    const { appInput, apps, eventTypes } = appHarness();
    const app = await activeApp(apps, await apps.createApp(appInput()));
    const first = await release(apps, app, id("01ARZ3NDEKTSV4RRFFQ69G5FC1"));
    const second = await release(apps, first.app, id("01ARZ3NDEKTSV4RRFFQ69G5FC2"));

    const promoted = await apps.promoteRelease({
      actor: system,
      app: second.app,
      releaseId: second.release.data.id,
    });
    const rolledBack = await apps.promoteRelease({
      actor: system,
      app: promoted,
      releaseId: first.release.data.id,
    });

    expect(promoted.data.lifecycle).toEqual({
      liveReleaseId: second.release.data.id,
      state: "active",
    });
    expect((await apps.getApp(app.data.id))?.data.lifecycle).toEqual({
      liveReleaseId: first.release.data.id,
      state: "active",
    });
    expect(rolledBack.data.version).toBe(6);
    expect((await apps.listReleases(rolledBack)).map((entry) => entry.data.id)).toEqual([
      second.release.data.id,
      first.release.data.id,
    ]);
    expect(eventTypes(app)).toEqual([
      "app.created",
      "app.activated",
      "app.release.created",
      "app.release.created",
      "app.release.promoted",
      "app.release.promoted",
    ]);
  });

  test("promotion refuses a release of another app and an unknown release", async () => {
    const { appInput, apps } = appHarness();
    const mine = await release(
      apps,
      await activeApp(apps, await apps.createApp(appInput())),
      id("01ARZ3NDEKTSV4RRFFQ69G5FC1"),
    );
    const theirs = await release(
      apps,
      await activeApp(apps, await apps.createApp(appInput({ slug: slug("theirs") }))),
      id("01ARZ3NDEKTSV4RRFFQ69G5FC2"),
    );

    expect(
      apps.promoteRelease({ actor: system, app: mine.app, releaseId: theirs.release.data.id }),
    ).rejects.toMatchObject({ reason: "not-found" });
    expect(
      apps.promoteRelease({
        actor: system,
        app: mine.app,
        releaseId: id("01ARZ3NDEKTSV4RRFFQ69G5FB2"),
      }),
    ).rejects.toMatchObject({ reason: "not-found" });
    expect((await apps.getApp(mine.app.data.id))?.data.lifecycle).toEqual({
      liveReleaseId: null,
      state: "active",
    });
  });

  test("releases need an active app", async () => {
    const { appInput, apps } = appHarness();
    const provisioning = await apps.createApp(appInput());

    expect(release(apps, provisioning, id("01ARZ3NDEKTSV4RRFFQ69G5FC1"))).rejects.toMatchObject({
      reason: "illegal-state",
    });
  });

  test("a release keeps the id its caller uploaded under, once", async () => {
    const { appInput, apps } = appHarness();
    const app = await activeApp(apps, await apps.createApp(appInput()));
    const releaseId = id("01ARZ3NDEKTSV4RRFFQ69G5FC1");
    const created = await release(apps, app, releaseId);

    expect(created.release.data.id).toBe(releaseId);
    expect(release(apps, created.app, releaseId)).rejects.toMatchObject({ reason: "conflict" });
    expect((await apps.listReleases(created.app)).map((entry) => entry.data.id)).toEqual([
      releaseId,
    ]);
  });

  test("a release keeps its sorted HTML documents, and an older record decodes them as unknown", async () => {
    const { appInput, apps } = appHarness();
    const app = await activeApp(apps, await apps.createApp(appInput()));
    const releaseId = id("01ARZ3NDEKTSV4RRFFQ69G5FC1");
    const created = await apps.createRelease({
      actor: system,
      app,
      bundleSha256: BUNDLE_SHA256,
      bytes: 4_096,
      documents: ["about/index.html", "café.html", "index.html"],
      files: 4,
      releaseId,
      runId: RUN,
    });
    const { documents: _documents, ...olderData } = created.release.data;

    expect<unknown>({
      older: Schema.decodeUnknownSync(AppReleaseRecord)({ ...created.release, data: olderData })
        .data.documents,
      stored: (await apps.getRelease({ app: created.app, releaseId }))?.data.documents,
    }).toEqual({ older: null, stored: ["about/index.html", "café.html", "index.html"] });
  });

  test("a release refuses document lists that are unsorted, unsafe, not HTML, or over the limits", async () => {
    const { appInput, apps } = appHarness();
    const app = await activeApp(apps, await apps.createApp(appInput()));
    const lists: Readonly<Record<string, readonly string[]>> = {
      "401 long paths": Array.from(
        { length: 401 },
        (_, index) => `${String(index).padStart(3, "0")}${"x".repeat(160)}.html`,
      ),
      "501 documents": Array.from(
        { length: 501 },
        (_, index) => `${String(index).padStart(3, "0")}.html`,
      ),
      "500 documents": Array.from(
        { length: 500 },
        (_, index) => `${String(index).padStart(3, "0")}.html`,
      ),
      absolute: ["/index.html"],
      "c1 control": ["caf\u0085.html"],
      "replacement character": ["caf\ufffd.html"],
      backslash: ["a\\b.html"],
      "dot segment": ["a/./b.html"],
      duplicate: ["a.html", "a.html"],
      "not html": ["styles.css"],
      parent: ["../index.html"],
      "upper-case extension": ["INDEX.HTM"],
      unsorted: ["b.html", "a.html"],
    };
    const outcomes: Record<string, string> = {};
    let next = 0;
    for (const [name, documents] of Object.entries(lists)) {
      next += 1;
      outcomes[name] = await apps
        .createRelease({
          actor: system,
          app: (await apps.getApp(app.data.id))!,
          bundleSha256: BUNDLE_SHA256,
          bytes: 1,
          documents,
          files: documents.length,
          releaseId: id(`01ARZ3NDEKTSV4RRFFQ69G5F${String(next).padStart(2, "0")}`),
          runId: RUN,
        })
        .then(
          () => "accepted",
          (error: unknown) => (error instanceof Error ? "refused" : "thrown"),
        );
    }

    expect(outcomes).toEqual({
      "401 long paths": "refused",
      "500 documents": "accepted",
      "501 documents": "refused",
      absolute: "refused",
      "c1 control": "refused",
      "replacement character": "refused",
      backslash: "refused",
      "dot segment": "refused",
      duplicate: "refused",
      "not html": "refused",
      parent: "refused",
      unsorted: "refused",
      "upper-case extension": "accepted",
    });
  });
});

describe("app access", () => {
  test("grants are upserted per principal and removed", async () => {
    const { appInput, apps, eventTypes } = appHarness();
    const app = await apps.createApp(appInput());

    const viewer = await apps.putGrant({
      app,
      changedBy: ADMIN,
      principalId: MEMBER,
      role: "viewer",
    });
    const editor = await apps.putGrant({
      app: viewer.app,
      changedBy: ADMIN,
      principalId: MEMBER,
      role: "editor",
    });
    const unchanged = await apps.putGrant({
      app: editor.app,
      changedBy: ADMIN,
      principalId: MEMBER,
      role: "editor",
    });

    expect(unchanged.app).toEqual(editor.app);
    expect((await apps.listGrants(editor.app)).map((grant) => grant.data)).toEqual([
      {
        appId: app.data.id,
        createdAt: START,
        environmentId: ENVIRONMENT,
        grantedBy: ADMIN,
        id: viewer.grant.data.id,
        organizationId: ORGANIZATION,
        principalId: MEMBER,
        projectId: app.data.projectId,
        role: "editor",
        updatedAt: START,
        version: 2,
      },
    ]);

    const removed = await apps.removeGrant({
      app: editor.app,
      changedBy: ADMIN,
      principalId: MEMBER,
    });

    expect(await apps.getGrant({ app: removed, principalId: MEMBER })).toBeUndefined();
    expect(await apps.removeGrant({ app: removed, changedBy: ADMIN, principalId: MEMBER })).toEqual(
      removed,
    );
    expect(eventTypes(app)).toEqual([
      "app.created",
      "app.grant.changed",
      "app.grant.changed",
      "app.grant.changed",
    ]);
  });

  test("member access and the agent definition change by a human, and not once archived", async () => {
    const { appInput, apps, eventTypes } = appHarness();
    const nextAgent = id("01ARZ3NDEKTSV4RRFFQ69G5FB3");
    const app = await activeApp(apps, await apps.createApp(appInput()));

    const shared = await apps.setAccess({ app, changedBy: ADMIN, organizationMembers: "viewer" });
    const moved = await apps.setAgentDefinition({
      agentDefinitionId: nextAgent,
      app: shared,
      changedBy: ADMIN,
    });
    const archived = await apps.transitionApp({
      actor: system,
      app: moved,
      transition: { to: "archived" },
    });

    expect(moved.data).toMatchObject({
      access: { organizationMembers: "viewer" },
      agentDefinitionId: nextAgent,
      version: 4,
    });
    expect(
      apps.setAccess({ app: archived, changedBy: ADMIN, organizationMembers: "editor" }),
    ).rejects.toMatchObject({ reason: "illegal-state" });
    expect(eventTypes(app)).toEqual([
      "app.created",
      "app.activated",
      "app.access.changed",
      "app.agent-definition.changed",
      "app.archived",
    ]);
  });
});

describe("app erasure", () => {
  test("erasing deletes the app, its releases, and its grants but keeps the slug", async () => {
    const { appInput, apps, eventTypes, memory } = appHarness();
    const active = await activeApp(apps, await apps.createApp(appInput()));
    const granted = await apps.putGrant({
      app: active,
      changedBy: ADMIN,
      principalId: MEMBER,
      role: "editor",
    });
    const released = await release(apps, granted.app, id("01ARZ3NDEKTSV4RRFFQ69G5FC1"));
    const erasing = await apps.transitionApp({
      actor: system,
      app: released.app,
      transition: { to: "erasing" },
    });

    await apps.eraseApp({ actor: system, app: erasing });

    expect(
      memory
        .all()
        .filter((record) =>
          ["app", "app-grant", "app-release", "app-slug-reservation", "unique-claim"].includes(
            record.itemType,
          ),
        )
        .map((record) => record.itemType),
    ).toEqual(["app-slug-reservation"]);
    expect(eventTypes(active).at(-1)).toBe("app.erased");
    expect(apps.createApp(appInput({ organizationId: OTHER_ORGANIZATION }))).rejects.toMatchObject({
      reason: "slug-taken",
    });
  });

  test("an organization erasure erases a fenced app only as the fence's owner", async () => {
    const { appInput, apps: unfenced, memory } = appHarness();
    const active = await activeApp(unfenced, await unfenced.createApp(appInput()));
    const owner = { operationId: id("01ARZ3NDEKTSV4RRFFQ69G5FD0"), organizationId: ORGANIZATION };
    const apps = makeAppPersistence({
      database: fencedBy(memory.database, owner),
      generateId: makeIdGenerator().generate,
      now: () => new Date(START),
    });

    const refused = await apps
      .transitionApp({ actor: system, app: active, transition: { to: "erasing" } })
      .catch((error: unknown) => error);
    const erasing = await apps.transitionApp({
      actor: system,
      app: active,
      erasureOwner: owner,
      transition: { to: "erasing" },
    });
    await apps.eraseApp({ actor: system, app: erasing, erasureOwner: owner });

    expect({
      erasingFrom: erasing.data.lifecycle,
      refused: refused instanceof Error ? refused.message : refused,
      remaining: memory
        .all()
        .filter((record) =>
          ["app", "app-grant", "app-release", "app-slug-reservation", "unique-claim"].includes(
            record.itemType,
          ),
        )
        .map((record) => record.itemType),
    }).toEqual({
      erasingFrom: { requestedAt: START, state: "erasing" },
      refused: "App transition failed.",
      remaining: ["app-slug-reservation"],
    });
  });
});
