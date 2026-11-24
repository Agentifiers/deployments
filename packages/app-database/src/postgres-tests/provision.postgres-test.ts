import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createAppDatabaseControl } from "../app-database.ts";
import { appDatabaseNames, type AppId } from "../names.ts";
import { PROVISION_STEPS, runProvisionSteps } from "../provision.ts";
import {
  asRole,
  asSuperuser,
  createTestControl,
  eraseInput,
  newAppId,
  newSlug,
  prepareCluster,
  testConnections,
  type TestControl,
} from "./harness.ts";

let harness: TestControl;

beforeAll(async () => {
  await prepareCluster();
  harness = createTestControl();
});

afterAll(async () => {
  await harness.control.close();
});

async function catalogState(appId: AppId) {
  const names = appDatabaseNames(appId);
  return asSuperuser("postgres", async (client) => {
    const database = await client.query<{ datacl: string; datallowconn: boolean }>(
      "SELECT datacl::text, datallowconn FROM pg_database WHERE datname = $1",
      [names.database],
    );
    const roles = await client.query<{ rolname: string; iam: boolean; connectionLimit: number }>(
      `SELECT r.rolname, pg_has_role(r.oid, 'rds_iam', 'MEMBER') AS iam, r.rolconnlimit AS "connectionLimit"
       FROM pg_roles r WHERE r.rolname LIKE $1 ORDER BY r.rolname`,
      [`${names.database}\\_%`],
    );
    return { database: database.rows, roles: roles.rows };
  });
}

describe("bootstrap", () => {
  test("seals the template and is idempotent", async () => {
    await prepareCluster();
    const template = await asSuperuser("postgres", async (client) => {
      const result = await client.query(
        `SELECT datistemplate, datallowconn,
           (SELECT rolcreatedb AND rolcreaterole AND rolcanlogin FROM pg_roles WHERE rolname = 'platform_provisioner') AS provisioner,
           (SELECT array_agg(setting) FROM pg_db_role_setting s, unnest(s.setconfig) setting
             WHERE s.setrole = 'platform_provisioner'::regrole) AS settings
         FROM pg_database WHERE datname = 'app_template'`,
      );
      return result.rows;
    });
    expect(template).toEqual([
      {
        datallowconn: false,
        datistemplate: true,
        provisioner: true,
        settings: ["createrole_self_grant=set"],
      },
    ]);
  });
});

describe("provision", () => {
  test("creates an isolated database whose ACL admits only the app roles", async () => {
    const appId = newAppId();
    const slug = newSlug();
    const names = appDatabaseNames(appId);
    const id = appId.toLowerCase();

    const result = await harness.control.provision({ appId, slug });

    expect(result).toEqual({
      appId,
      database: names.database,
      roles: names.roles,
      slug,
    });
    expect(await catalogState(appId)).toEqual({
      database: [
        {
          datacl: `{platform_provisioner=CTc/platform_provisioner,app_${id}_owner=c/platform_provisioner,app_${id}_editor=c/platform_provisioner,app_${id}_viewer=c/platform_provisioner,app_${id}_visitor=c/platform_provisioner}`,
          datallowconn: true,
        },
      ],
      roles: [
        { connectionLimit: 32, iam: true, rolname: `app_${id}_editor` },
        { connectionLimit: 8, iam: true, rolname: `app_${id}_owner` },
        { connectionLimit: 40, iam: true, rolname: `app_${id}_viewer` },
        { connectionLimit: 16, iam: true, rolname: `app_${id}_visitor` },
      ],
    });
    expect(harness.slugs.entries.get(slug)).toBe(appId);

    const layout = await asRole(names.database, names.roles.owner, async (client) => {
      const schemas = await client.query(
        `SELECT n.nspname AS schema, pg_get_userbyid(n.nspowner) AS owner, n.nspacl::text AS acl
         FROM pg_namespace n WHERE n.nspname IN ('public', 'api', 'visitor', 'platform') ORDER BY n.nspname`,
      );
      const extensions = await client.query(
        "SELECT array_agg(extname::text ORDER BY extname) AS names FROM pg_extension",
      );
      const ledger = await client.query(
        `SELECT target, acl FROM (
           SELECT 0 AS position, 'table' AS target, relacl::text AS acl
           FROM pg_class WHERE oid = 'platform.migrations'::regclass
           UNION ALL
           SELECT attnum, attname::text, attacl::text
           FROM pg_attribute WHERE attrelid = 'platform.migrations'::regclass AND attacl IS NOT NULL
         ) AS grants ORDER BY position`,
      );
      return { extensions: extensions.rows[0], ledger: ledger.rows, schemas: schemas.rows };
    });
    expect(layout).toEqual({
      extensions: { names: ["citext", "pg_trgm", "pgcrypto", "plpgsql"] },
      ledger: [
        {
          acl: `{platform_provisioner=arwdDxtm/platform_provisioner,app_${id}_owner=r/platform_provisioner}`,
          target: "table",
        },
        {
          acl: `{app_${id}_editor=r/platform_provisioner,app_${id}_viewer=r/platform_provisioner,app_${id}_visitor=r/platform_provisioner}`,
          target: "id",
        },
        { acl: `{app_${id}_owner=a/platform_provisioner}`, target: "idempotency_key" },
        { acl: `{app_${id}_owner=a/platform_provisioner}`, target: "description" },
        { acl: `{app_${id}_owner=a/platform_provisioner}`, target: "sql" },
      ],
      schemas: [
        {
          acl: `{app_${id}_owner=UC/app_${id}_owner,app_${id}_editor=U/app_${id}_owner,app_${id}_viewer=U/app_${id}_owner}`,
          owner: `app_${id}_owner`,
          schema: "api",
        },
        {
          acl: `{platform_provisioner=UC/platform_provisioner,app_${id}_owner=U/platform_provisioner,app_${id}_editor=U/platform_provisioner,app_${id}_viewer=U/platform_provisioner,app_${id}_visitor=U/platform_provisioner}`,
          owner: "platform_provisioner",
          schema: "platform",
        },
        {
          acl: `{app_${id}_owner=UC/app_${id}_owner,app_${id}_editor=U/app_${id}_owner,app_${id}_viewer=U/app_${id}_owner,app_${id}_visitor=U/app_${id}_owner}`,
          owner: `app_${id}_owner`,
          schema: "public",
        },
        {
          acl: `{app_${id}_owner=UC/app_${id}_owner,app_${id}_editor=U/app_${id}_owner,app_${id}_viewer=U/app_${id}_owner,app_${id}_visitor=U/app_${id}_owner}`,
          owner: `app_${id}_owner`,
          schema: "visitor",
        },
      ],
    });

    await harness.control.erase(eraseInput({ appId, slug }));
  });

  test("converges after a crash following each step", async () => {
    const outcomes: Array<{ crashedAfter: string; slugPublished: boolean }> = [];
    for (let completed = 0; completed < PROVISION_STEPS.length; completed += 1) {
      const appId = newAppId();
      const slug = newSlug();
      const dependencies = { connections: testConnections, slugDirectory: harness.slugs };
      await runProvisionSteps(dependencies, { appId, slug }, PROVISION_STEPS.slice(0, completed));
      await harness.control.provision({ appId, slug });
      const names = appDatabaseNames(appId);
      const ledger = await asRole(
        names.database,
        names.roles.owner,
        async (client) =>
          (await client.query("SELECT count(*)::int AS rows FROM platform.migrations")).rows,
      );
      expect(ledger).toEqual([{ rows: 0 }]);
      outcomes.push({
        crashedAfter: PROVISION_STEPS[completed - 1]?.name ?? "nothing",
        slugPublished: harness.slugs.entries.get(slug) === appId,
      });
      await harness.control.erase(eraseInput({ appId, slug }));
    }
    expect(outcomes).toEqual([
      { crashedAfter: "nothing", slugPublished: true },
      { crashedAfter: "create-roles", slugPublished: true },
      { crashedAfter: "grant-iam-login", slugPublished: true },
      { crashedAfter: "create-database", slugPublished: true },
      { crashedAfter: "restrict-database-acl", slugPublished: true },
      { crashedAfter: "allow-connections", slugPublished: true },
      { crashedAfter: "configure-schemas", slugPublished: true },
      { crashedAfter: "verify-catalog", slugPublished: true },
    ]);
  });

  test("a second pass over a provisioned app changes nothing and restores connection limits", async () => {
    const appId = newAppId();
    const slug = newSlug();
    const names = appDatabaseNames(appId);
    await harness.control.provision({ appId, slug });
    const before = await catalogState(appId);
    await asSuperuser("postgres", (client) =>
      client.query(`ALTER ROLE ${names.roles.viewer} WITH CONNECTION LIMIT -1`),
    );
    await harness.control.provision({ appId, slug });
    expect(await catalogState(appId)).toEqual(before);
    await harness.control.erase(eraseInput({ appId, slug }));
  });
});

describe("erase", () => {
  test("leaves no database, role, slug, or app object, and repeats cleanly", async () => {
    const appId = newAppId();
    const otherAppId = newAppId();
    const slug = newSlug();
    await harness.control.provision({ appId, slug });
    await harness.control.migrate({
      appId,
      description: "orders",
      idempotencyKey: "orders-1",
      sql: "CREATE TABLE orders (id int PRIMARY KEY)",
    });
    for (const key of [
      `apps/${appId}/releases/r1/index.html`,
      `apps/${appId}/releases/r1/assets/app.js`,
      `apps/${appId}/releases/r2/index.html`,
      `apps/${appId}/exports/e1/orders.csv`,
      `apps/${appId}/exports/e2/orders.csv`,
      `apps/${otherAppId}/releases/r1/index.html`,
    ]) {
      harness.objects.entries.set(`apps-bucket/${key}`, "seeded");
    }

    const input = { appId, bucket: "apps-bucket", slug };
    const first = await harness.control.erase(input);
    const second = await harness.control.erase(input);

    const names = appDatabaseNames(appId);
    const erased = {
      appId,
      database: names.database,
      roles: [names.roles.owner, names.roles.editor, names.roles.viewer, names.roles.visitor],
    };
    expect({ first, second }).toEqual({
      first: { ...erased, objectsDeleted: 5 },
      second: { ...erased, objectsDeleted: 0 },
    });
    expect(await catalogState(appId)).toEqual({ database: [], roles: [] });
    expect(harness.slugs.entries.has(slug)).toBe(false);
    expect([...harness.objects.entries.keys()]).toEqual([
      `apps-bucket/apps/${otherAppId}/releases/r1/index.html`,
    ]);
  });

  test("removes the slug route while the app database still exists", async () => {
    const appId = newAppId();
    const slug = newSlug();
    await harness.control.provision({ appId, slug });
    const atRemove: Array<{ databases: number; slug: string }> = [];
    const control = createAppDatabaseControl({
      connections: testConnections,
      objectStore: harness.objects,
      slugDirectory: {
        put: harness.slugs.put,
        remove: async (removed) => {
          atRemove.push({ databases: (await catalogState(appId)).database.length, slug: removed });
          await harness.slugs.remove(removed);
        },
      },
    });
    await control.erase(eraseInput({ appId, slug }));
    await control.close();

    expect({ after: await catalogState(appId), atRemove }).toEqual({
      after: { database: [], roles: [] },
      atRemove: [{ databases: 1, slug }],
    });
  });
});
