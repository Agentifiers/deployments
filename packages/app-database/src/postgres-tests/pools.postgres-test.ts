import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createAppApiGateway, type AppApiGateway } from "../app-database.ts";
import type { AppDatabaseLimits } from "../limits.ts";
import { appDatabaseNames, type AppId, type AppSlug } from "../names.ts";
import {
  asSuperuser,
  createTestControl,
  eraseInput,
  errorOf,
  newAppId,
  newSlug,
  prepareCluster,
  testConnections,
  type TestControl,
} from "./harness.ts";

const SCHEMA = `
CREATE FUNCTION api.ping() RETURNS int LANGUAGE sql STABLE BEGIN ATOMIC SELECT 1; END;
CREATE FUNCTION api.hold(p_seconds float8) RETURNS int
  LANGUAGE sql STABLE
  BEGIN ATOMIC SELECT 1 FROM pg_sleep(p_seconds); END;
CREATE FUNCTION api.leave_state() RETURNS int LANGUAGE sql VOLATILE
  BEGIN ATOMIC SELECT pg_backend_pid() FROM set_config('app.leftover', 'stale', false); END;
CREATE FUNCTION api.read_state() RETURNS text LANGUAGE sql VOLATILE
  BEGIN ATOMIC SELECT pg_backend_pid() || ':' || coalesce(current_setting('app.leftover', true), 'unset'); END;
CREATE FUNCTION visitor.linger(p_seconds float8) RETURNS int
  LANGUAGE sql STABLE
  BEGIN ATOMIC SELECT 1 FROM pg_sleep(p_seconds); END;
`;
const MEMBER = { email: null, id: "principal-1" } as const;

let harness: TestControl;
const apps: { readonly appId: AppId; readonly slug: AppSlug }[] = [];
const gateways: AppApiGateway[] = [];

function gateway(limits: Partial<AppDatabaseLimits>) {
  const created = createAppApiGateway({ connections: testConnections, limits });
  gateways.push(created);
  return created;
}

function call(target: AppApiGateway, appId: AppId, functionName: string, seconds?: number) {
  return target.callApiFunction({
    appId,
    appIsPublic: false,
    args: seconds === undefined ? {} : { p_seconds: seconds },
    functionName,
    principal: MEMBER,
    role: "viewer",
  });
}

async function openConnections() {
  const names = apps.map(({ appId }) => appDatabaseNames(appId));
  let counts: Record<string, number> = {};
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const rows = await asSuperuser("postgres", async (client) => {
      const result = await client.query<{ datname: string; open: number }>(
        "SELECT datname, count(*)::int AS open FROM pg_stat_activity WHERE usename = ANY($1) GROUP BY datname",
        [names.map((name) => name.roles.viewer)],
      );
      return result.rows;
    });
    counts = Object.fromEntries(rows.map((row) => [row.datname, row.open]));
    if (Object.values(counts).reduce((sum, open) => sum + open, 0) <= 2) return counts;
    await Bun.sleep(50);
  }
  return counts;
}

beforeAll(async () => {
  await prepareCluster();
  harness = createTestControl();
  for (let index = 0; index < 3; index += 1) {
    const app = { appId: newAppId(), slug: newSlug() };
    await harness.control.provision(app);
    await harness.control.migrate({
      appId: app.appId,
      description: "pool probes",
      idempotencyKey: "pool-probes",
      sql: SCHEMA,
    });
    apps.push(app);
  }
});

afterAll(async () => {
  await Promise.all(gateways.map((created) => created.close()));
  for (const app of apps) await harness.control.erase(eraseInput(app));
  await harness.control.close();
});

describe("the total connection cap", () => {
  test("at the cap, a new app's call ends the least recently used idle pool", async () => {
    const capped = gateway({ connectionWaitMs: 500, maxConnectionsTotal: 2 });
    const [first, second, third] = apps.map(({ appId }) => appId) as [AppId, AppId, AppId];

    for (const appId of [first, second, first, third]) {
      expect(await call(capped, appId, "ping")).toEqual({ rows: [1] });
    }

    expect(await openConnections()).toEqual({
      [appDatabaseNames(first).database]: 1,
      [appDatabaseNames(third).database]: 1,
    });
    await capped.close();
  });

  test("a call at the cap waits for a busy connection and fails after the wait", async () => {
    const [first, second] = apps.map(({ appId }) => appId) as [AppId, AppId];
    const impatient = gateway({ connectionWaitMs: 200, maxConnectionsTotal: 1 });
    const holding = call(impatient, first, "hold", 1);
    await Bun.sleep(100);
    const exhausted = await errorOf(call(impatient, second, "ping"));
    await holding;

    const patient = gateway({ connectionWaitMs: 5_000, maxConnectionsTotal: 1 });
    const finished: string[] = [];
    const held = call(patient, first, "hold", 0.3).then(() => finished.push("hold"));
    await Bun.sleep(50);
    const pinged = call(patient, second, "ping").then(() => finished.push("ping"));
    await Promise.all([held, pinged]);

    expect({ exhausted, finished }).toEqual({
      exhausted: {
        code: "connections_exhausted",
        message: "All 1 app database connections stayed busy for 200 ms.",
        name: "AppDatabaseError",
        statement: undefined,
      },
      finished: ["hold", "ping"],
    });
  });
});

describe("a pooled connection", () => {
  test("does not show the next borrower session state that app SQL left behind", async () => {
    const [first] = apps.map(({ appId }) => appId) as [AppId];
    const single = gateway({
      maxConnectionsPerPool: { editor: 1, owner: 1, viewer: 1, visitor: 1 },
    });
    const asEditor = (functionName: string) =>
      single.callApiFunction({
        appId: first,
        appIsPublic: false,
        args: {},
        functionName,
        principal: MEMBER,
        role: "editor",
      });

    const left = await asEditor("leave_state");
    const read = await asEditor("read_state");

    expect(read.rows).toEqual([`${Number(left.rows[0])}:`]);
  });

  test("comes from a pool sized for its role", async () => {
    const [, , third] = apps.map(({ appId }) => appId) as [AppId, AppId, AppId];
    const { roles } = appDatabaseNames(third);
    const sized = gateway({
      maxConnectionsPerPool: { editor: 3, owner: 1, viewer: 3, visitor: 1 },
    });
    const base = { appId: third, appIsPublic: true, args: { p_seconds: 0.3 } };
    const calls = Promise.all([
      ...[1, 2, 3].map(() =>
        sized.callApiFunction({ ...base, functionName: "hold", principal: MEMBER, role: "viewer" }),
      ),
      ...[1, 2, 3].map(() =>
        sized.callApiFunction({ ...base, functionName: "linger", role: "visitor" }),
      ),
    ]);
    let settled = false;
    const finished = calls.finally(() => {
      settled = true;
    });
    const peak = { viewer: 0, visitor: 0 };
    while (!settled) {
      const open = await asSuperuser("postgres", async (client) => {
        const result = await client.query<{ viewer: number; visitor: number }>(
          "SELECT count(*) FILTER (WHERE usename = $1)::int AS viewer, count(*) FILTER (WHERE usename = $2)::int AS visitor FROM pg_stat_activity",
          [roles.viewer, roles.visitor],
        );
        return result.rows[0] ?? { viewer: 0, visitor: 0 };
      });
      peak.viewer = Math.max(peak.viewer, open.viewer);
      peak.visitor = Math.max(peak.visitor, open.visitor);
      await Bun.sleep(25);
    }
    expect({ peak, rows: (await finished).map((result) => result.rows) }).toEqual({
      peak: { viewer: 3, visitor: 1 },
      rows: [[1], [1], [1], [1], [1], [1]],
    });
  });
});
