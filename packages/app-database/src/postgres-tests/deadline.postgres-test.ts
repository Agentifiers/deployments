import { afterAll, beforeAll, expect, test } from "bun:test";
import { createAppApiGateway, type AppApiGateway } from "../app-database.ts";
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

const LIMITS = { apiDeadlineMs: 300, graceMs: 300, queryDeadlineMs: 300 };

let harness: TestControl;
let gateway: AppApiGateway;
let appId: AppId;
let slug: AppSlug;

beforeAll(async () => {
  await prepareCluster();
  harness = createTestControl(LIMITS);
  gateway = createAppApiGateway({ connections: testConnections, limits: LIMITS });
  appId = newAppId();
  slug = newSlug();
  await harness.control.provision({ appId, slug });
  await harness.control.migrate({
    appId,
    description: "stubborn",
    idempotencyKey: "stubborn",
    sql: `
CREATE FUNCTION public.stubborn() RETURNS int LANGUAGE plpgsql AS $$
BEGIN
  LOOP
    BEGIN
      PERFORM pg_sleep(0.05);
    EXCEPTION WHEN query_canceled THEN
      NULL;
    END;
  END LOOP;
END $$;
CREATE FUNCTION api.spin() RETURNS int LANGUAGE sql STABLE BEGIN ATOMIC SELECT public.stubborn(); END;`,
  });
});

afterAll(async () => {
  await gateway.close();
  await harness.control.erase(eraseInput({ appId, slug }));
  await harness.control.close();
});

async function stubbornBackends() {
  const { database } = appDatabaseNames(appId);
  return asSuperuser(
    "postgres",
    async (client) =>
      (
        await client.query(
          "SELECT count(*)::int AS running FROM pg_stat_activity WHERE datname = $1 AND query LIKE '%stubborn%' AND pid <> pg_backend_pid()",
          [database],
        )
      ).rows,
  );
}

test("a plpgsql loop that traps query_canceled ends at the caller's deadline", async () => {
  const started = performance.now();
  const viaQuery = await errorOf(
    harness.control.query({ appId, maxRows: 1, sql: "SELECT public.stubborn()" }),
  );
  const viaApi = await errorOf(
    gateway.callApiFunction({
      appId,
      appIsPublic: false,
      args: {},
      functionName: "spin",
      principal: { email: null, id: "principal-1" },
      role: "viewer",
    }),
  );
  const elapsedMs = performance.now() - started;

  expect([viaQuery, viaApi]).toEqual([
    {
      code: "deadline_exceeded",
      message: "The statement exceeded its 300 ms deadline.",
      name: "AppDatabaseError",
      statement: "SELECT public.stubborn()",
    },
    {
      code: "deadline_exceeded",
      message: "The statement exceeded its 300 ms deadline.",
      name: "AppDatabaseError",
      statement: "api.spin",
    },
  ]);
  expect(elapsedMs).toBeLessThan(3_000);
  expect(await stubbornBackends()).toEqual([{ running: 0 }]);

  const after = await harness.control.query({ appId, maxRows: 1, sql: "SELECT 1 AS alive" });
  expect(after.rows).toEqual([["1"]]);
});
