import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createAppApiGateway, type AppApiGateway } from "../app-database.ts";
import { appDatabaseNames, type AppId, type AppSlug } from "../names.ts";
import { PROVISION_STEPS, runProvisionSteps } from "../provision.ts";
import {
  asRole,
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
import { provisionLayoutOne } from "./legacy-layout.ts";

const SIGNUPS = `
CREATE TABLE signups (
  id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL,
  ticket serial
);
CREATE FUNCTION public.clean_email(p text) RETURNS text LANGUAGE sql IMMUTABLE RETURN lower(p);
CREATE FUNCTION api.signup_count() RETURNS bigint LANGUAGE sql STABLE
  BEGIN ATOMIC SELECT count(*) FROM signups; END;
`;

const SIGN_UP = `
CREATE FUNCTION visitor.sign_up(p_email text) RETURNS int LANGUAGE sql VOLATILE
  BEGIN ATOMIC INSERT INTO signups (email) VALUES (p_email) RETURNING ticket; END;
`;

const PRIVILEGE_STATE = `SELECT json_build_object(
  'roles', (SELECT json_agg(json_build_object('role', r.rolname, 'connectionLimit', r.rolconnlimit,
      'iam', pg_has_role(r.oid, 'rds_iam', 'MEMBER')) ORDER BY r.rolname)
    FROM pg_roles r WHERE r.rolname LIKE $1),
  'database', (SELECT datacl::text FROM pg_database WHERE datname = current_database()),
  'schemas', (SELECT json_agg(json_build_object('schema', n.nspname,
      'owner', pg_get_userbyid(n.nspowner), 'acl', n.nspacl::text) ORDER BY n.nspname)
    FROM pg_namespace n WHERE n.nspname IN ('public', 'api', 'visitor', 'platform')),
  'defaults', (SELECT json_agg(json_build_object('role', pg_get_userbyid(d.defaclrole),
      'schema', n.nspname, 'kind', d.defaclobjtype, 'acl', d.defaclacl::text)
      ORDER BY n.nspname NULLS FIRST, d.defaclobjtype)
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace),
  'relations', (SELECT json_agg(json_build_object('relation', c.oid::regclass::text,
      'acl', c.relacl::text, 'columns', (SELECT json_agg(json_build_object(a.attname, a.attacl::text)
        ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attacl IS NOT NULL))
      ORDER BY c.oid::regclass::text)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'api', 'visitor', 'platform') AND c.relkind IN ('r', 'S', 'v')),
  'functions', (SELECT json_agg(json_build_object('function', p.oid::regprocedure::text,
      'acl', p.proacl::text) ORDER BY p.oid::regprocedure::text)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'api', 'visitor')
      AND NOT EXISTS (SELECT 1 FROM pg_depend e
        WHERE e.classid = 'pg_proc'::regclass AND e.objid = p.oid AND e.deptype = 'e'))
) AS state`;

let harness: TestControl;
let gateway: AppApiGateway;
const created: Array<{ appId: AppId; slug: AppSlug }> = [];

beforeAll(async () => {
  await prepareCluster();
  harness = createTestControl();
  gateway = createAppApiGateway({ connections: testConnections });
});

afterAll(async () => {
  await gateway.close();
  for (const app of created) await harness.control.erase(eraseInput(app));
  await harness.control.close();
});

function newApp() {
  const app = { appId: newAppId(), slug: newSlug() };
  created.push(app);
  return app;
}

async function privilegeState(appId: AppId) {
  const { database } = appDatabaseNames(appId);
  const prefix = `${database}_`;
  const state = await asSuperuser(database, async (client) => {
    const result = await client.query<{ state: unknown }>(PRIVILEGE_STATE, [`${database}\\_%`]);
    return result.rows[0]?.state;
  });
  return JSON.parse(JSON.stringify(state).replaceAll(prefix, "app_<id>_"));
}

function migrate(appId: AppId, key: string, sql: string) {
  return harness.control.migrate({ appId, description: key, idempotencyKey: key, sql });
}

describe("provision on a layout-1 database", () => {
  test("converges it to the layout a new app gets, and a second pass changes nothing", async () => {
    const legacy = newApp();
    await provisionLayoutOne(legacy.appId);
    await migrate(legacy.appId, "signups", SIGNUPS);
    const beforeConvergence = await gateway.callApiFunction({
      appId: legacy.appId,
      appIsPublic: false,
      args: {},
      functionName: "signup_count",
      principal: { email: null, id: "principal-1" },
      role: "viewer",
    });

    const fresh = newApp();
    await harness.control.provision(fresh);
    await migrate(fresh.appId, "signups", SIGNUPS);

    const converged = await harness.control.provision(legacy);
    const afterFirstPass = await privilegeState(legacy.appId);
    await harness.control.provision(legacy);

    expect({
      beforeConvergence,
      converged: converged.roles.visitor,
      matchesNewApp: afterFirstPass,
      secondPass: await privilegeState(legacy.appId),
    }).toEqual({
      beforeConvergence: { rows: [0] },
      converged: appDatabaseNames(legacy.appId).roles.visitor,
      matchesNewApp: await privilegeState(fresh.appId),
      secondPass: afterFirstPass,
    });
  });

  test("a visitor function inserts into a table created before convergence", async () => {
    const legacy = newApp();
    await provisionLayoutOne(legacy.appId);
    await migrate(legacy.appId, "signups", SIGNUPS);
    await harness.control.provision(legacy);
    await migrate(legacy.appId, "sign-up", SIGN_UP);

    const ticket = await gateway.callApiFunction({
      appId: legacy.appId,
      appIsPublic: true,
      args: { p_email: "guest@example.com" },
      functionName: "sign_up",
      role: "visitor",
    });
    const rows = await harness.control.query({
      appId: legacy.appId,
      maxRows: 10,
      sql: "SELECT id, email, ticket FROM signups",
    });
    expect({ rows: rows.rows, ticket }).toEqual({
      rows: [["1", "guest@example.com", "1"]],
      ticket: { rows: [1] },
    });
  });

  test("erase drops a layout-1 database and its three roles", async () => {
    const appId = newAppId();
    const slug = newSlug();
    await provisionLayoutOne(appId);
    const names = appDatabaseNames(appId);

    const erased = await harness.control.erase(eraseInput({ appId, slug }));
    const left = await asSuperuser("postgres", async (client) => {
      const result = await client.query(
        `SELECT (SELECT count(*)::int FROM pg_database WHERE datname = $1) AS databases,
           (SELECT count(*)::int FROM pg_roles WHERE rolname LIKE $2) AS roles`,
        [names.database, `${names.database}\\_%`],
      );
      return result.rows[0];
    });
    expect({ left, roles: erased.roles }).toEqual({
      left: { databases: 0, roles: 0 },
      roles: [names.roles.owner, names.roles.editor, names.roles.viewer, names.roles.visitor],
    });
  });
});

describe("the visitor role", () => {
  test("holds exactly USAGE on public, visitor and platform, DML on public, and EXECUTE in visitor", async () => {
    const app = newApp();
    await harness.control.provision(app);
    await migrate(app.appId, "signups", SIGNUPS);
    await migrate(app.appId, "sign-up", SIGN_UP);
    const { database, roles } = appDatabaseNames(app.appId);

    const privileges = await asSuperuser(database, async (client) => {
      const result = await client.query(
        `SELECT json_build_object(
          'schemas', (SELECT json_object_agg(n.nspname, json_build_object(
              'usage', has_schema_privilege($1, n.oid, 'USAGE'),
              'create', has_schema_privilege($1, n.oid, 'CREATE')) ORDER BY n.nspname)
            FROM pg_namespace n WHERE n.nspname IN ('public', 'api', 'visitor', 'platform')),
          'signups', (SELECT json_object_agg(p, has_table_privilege($1, 'public.signups', p))
            FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p),
          'ticketSequence', (SELECT json_object_agg(p, has_sequence_privilege($1, 'public.signups_ticket_seq', p))
            FROM unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) p),
          'ledgerColumns', (SELECT json_object_agg(a.attname, has_column_privilege($1, a.attrelid, a.attnum, 'SELECT') ORDER BY a.attnum)
            FROM pg_attribute a WHERE a.attrelid = 'platform.migrations'::regclass AND a.attnum > 0),
          'ledgerInsert', has_table_privilege($1, 'platform.migrations', 'INSERT'),
          'functions', (SELECT json_object_agg(p.oid::regprocedure::text, has_function_privilege($1, p.oid, 'EXECUTE'))
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname IN ('public', 'api', 'visitor')
              AND NOT EXISTS (SELECT 1 FROM pg_depend e
                WHERE e.classid = 'pg_proc'::regclass AND e.objid = p.oid AND e.deptype = 'e'))
        ) AS privileges`,
        [roles.visitor],
      );
      return result.rows[0]?.privileges;
    });
    const attempts = await asRole(database, roles.visitor, async (client) => {
      const outcomes: string[] = [];
      for (const sql of [
        "SELECT api.signup_count()",
        "SELECT public.clean_email('A')",
        "SELECT visitor.sign_up('guest@example.com')",
        "CREATE TABLE public.extra (id int)",
      ]) {
        const failure = await client.query(sql).then(
          () => "ok",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        outcomes.push(`${sql}: ${failure}`);
      }
      return outcomes;
    });

    expect({ attempts, privileges }).toEqual({
      attempts: [
        "SELECT api.signup_count(): permission denied for schema api",
        "SELECT public.clean_email('A'): permission denied for function clean_email",
        "SELECT visitor.sign_up('guest@example.com'): ok",
        "CREATE TABLE public.extra (id int): permission denied for schema public",
      ],
      privileges: {
        functions: {
          "api.signup_count()": false,
          "clean_email(text)": false,
          "visitor.sign_up(text)": true,
        },
        ledgerColumns: {
          applied_at: false,
          description: false,
          id: true,
          idempotency_key: false,
          sql: false,
          transaction_id: false,
        },
        ledgerInsert: false,
        schemas: {
          api: { create: false, usage: false },
          platform: { create: false, usage: true },
          public: { create: false, usage: true },
          visitor: { create: false, usage: true },
        },
        signups: {
          DELETE: true,
          INSERT: true,
          REFERENCES: false,
          SELECT: true,
          TRIGGER: false,
          TRUNCATE: false,
          UPDATE: true,
        },
        ticketSequence: { SELECT: true, UPDATE: false, USAGE: true },
      },
    });
  });

  test("provision refuses a visitor role that can reach api or execute a public function", async () => {
    const app = newApp();
    await harness.control.provision(app);
    await migrate(app.appId, "signups", SIGNUPS);
    const { database, roles } = appDatabaseNames(app.appId);
    await asSuperuser(database, async (client) => {
      await client.query(`GRANT USAGE ON SCHEMA api TO ${roles.visitor}`);
      await client.query(`GRANT EXECUTE ON FUNCTION public.clean_email(text) TO ${roles.visitor}`);
    });
    const failure = await errorOf(harness.control.provision(app));
    expect(`${String(failure.code)}: ${failure.message}`).toBe(
      [
        "provision_incomplete: Function public.clean_email is executable by visitors, but only functions in the visitor schema may be; drop it and create it again.",
        "The visitor role has USAGE on schema api; it may use only public, visitor and platform.",
      ].join("\n"),
    );
  });

  test("verify-catalog reports a visitor role that lacks its grants on public", async () => {
    const app = newApp();
    await harness.control.provision(app);
    await migrate(app.appId, "signups", SIGNUPS);
    const { database, roles } = appDatabaseNames(app.appId);
    await asSuperuser(database, async (client) => {
      await client.query(`REVOKE INSERT, DELETE ON public.signups FROM ${roles.visitor}`);
      await client.query(
        `REVOKE USAGE ON SEQUENCE public.signups_ticket_seq FROM ${roles.visitor}`,
      );
    });
    const verifyCatalog = PROVISION_STEPS.filter((step) => step.name === "verify-catalog");
    const dependencies = { connections: testConnections, slugDirectory: harness.slugs };
    const failure = await errorOf(runProvisionSteps(dependencies, app, verifyCatalog));
    expect(`${String(failure.code)}: ${failure.message}`).toBe(
      [
        "provision_incomplete: The visitor role lacks SELECT, INSERT, UPDATE or DELETE on public.signups.",
        "The visitor role lacks USAGE or SELECT on sequence public.signups_ticket_seq.",
      ].join("\n"),
    );
  });

  test("cannot log in to another app's database", async () => {
    const own = newApp();
    const other = newApp();
    await harness.control.provision(own);
    await harness.control.provision(other);
    const failure = await errorOf(
      asRole(
        appDatabaseNames(other.appId).database,
        appDatabaseNames(own.appId).roles.visitor,
        (client) => client.query("SELECT 1"),
      ),
    );
    expect(`${String(failure.code)} ${failure.message}`).toBe(
      `42501 permission denied for database "${appDatabaseNames(other.appId).database}"`,
    );
  });
});
