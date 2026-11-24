import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appDatabaseNames, type AppId, type AppSlug } from "../names.ts";
import {
  createTestControl,
  eraseInput,
  errorOf,
  newAppId,
  newSlug,
  prepareCluster,
  type TestControl,
} from "./harness.ts";

let harness: TestControl;
let appId: AppId;
let slug: AppSlug;

const ORDERS = `
CREATE TABLE orders (id int PRIMARY KEY, status text NOT NULL);
CREATE FUNCTION api.list_orders(p_status text) RETURNS SETOF orders
  LANGUAGE sql STABLE
  BEGIN ATOMIC SELECT * FROM orders WHERE status = p_status ORDER BY id; END;
`;

beforeAll(async () => {
  await prepareCluster();
  harness = createTestControl();
  appId = newAppId();
  slug = newSlug();
  await harness.control.provision({ appId, slug });
  await harness.control.migrate({
    appId,
    description: "orders",
    idempotencyKey: "orders-1",
    sql: ORDERS,
  });
});

afterAll(async () => {
  await harness.control.erase(eraseInput({ appId, slug }));
  await harness.control.close();
});

async function rows(sql: string) {
  return (await harness.control.query({ appId, maxRows: 100, sql })).rows;
}

async function ledgerKeys() {
  return (await harness.control.describe(appId)).migrations.map(
    (migration) => `${migration.id}:${migration.idempotencyKey}`,
  );
}

describe("migrate", () => {
  test("a repeated key replays the recorded outcome and different SQL is refused", async () => {
    const replay = await harness.control.migrate({
      appId,
      description: "orders",
      idempotencyKey: "orders-1",
      sql: ORDERS,
    });
    expect({ migrationId: replay.migrationId, replayed: replay.replayed }).toEqual({
      migrationId: 1,
      replayed: true,
    });
    expect(
      await errorOf(
        harness.control.migrate({
          appId,
          description: "orders",
          idempotencyKey: "orders-1",
          sql: "CREATE TABLE other (id int)",
        }),
      ),
    ).toEqual({
      code: "idempotency_conflict",
      message:
        "Idempotency key orders-1 already applied different SQL; use a new key for a new migration.",
      name: "AppDatabaseError",
      statement: undefined,
    });
    expect(await ledgerKeys()).toEqual(["1:orders-1"]);
  });

  test("a failing migration rolls back as a unit, ledger row included", async () => {
    const failure = await errorOf(
      harness.control.migrate({
        appId,
        description: "audit",
        idempotencyKey: "audit-1",
        sql: "CREATE TABLE audit (id int);\nINSERT INTO missing VALUES (1);",
      }),
    );
    expect(failure).toEqual({
      code: "postgres_error",
      message: 'relation "missing" does not exist',
      name: "AppDatabaseError",
      statement: "INSERT INTO missing VALUES (1)",
    });
    expect(await rows("SELECT to_regclass('public.audit')::text")).toEqual([[null]]);
    expect(await ledgerKeys()).toEqual(["1:orders-1"]);
  });

  test("dropping a column an api function reads is rejected", async () => {
    const failure = await errorOf(
      harness.control.migrate({
        appId,
        description: "drop status",
        idempotencyKey: "drop-status",
        sql: "ALTER TABLE orders DROP COLUMN status",
      }),
    );
    expect(failure).toEqual({
      code: "postgres_error",
      message: [
        "cannot drop column status of table orders because other objects depend on it",
        "DETAIL: function api.list_orders(text) depends on column status of table orders",
        "HINT: Use DROP ... CASCADE to drop the dependent objects too.",
      ].join("\n"),
      name: "AppDatabaseError",
      statement: "ALTER TABLE orders DROP COLUMN status",
    });
    expect(
      await rows(
        "SELECT attname::text FROM pg_attribute WHERE attrelid = 'orders'::regclass AND attnum > 0 ORDER BY attnum",
      ),
    ).toEqual([["id"], ["status"]]);
  });

  test("two concurrent migrations with different keys serialize", async () => {
    await harness.control.migrate({
      appId,
      description: "migration log",
      idempotencyKey: "log",
      sql: "CREATE TABLE migration_log (label text, phase text, at timestamptz)",
    });
    const logged = (label: string) =>
      harness.control.migrate({
        appId,
        description: label,
        idempotencyKey: `log-${label}`,
        sql: `INSERT INTO migration_log VALUES ('${label}', 'start', clock_timestamp());
SELECT pg_sleep(0.2);
INSERT INTO migration_log VALUES ('${label}', 'end', clock_timestamp());`,
      });
    const results = await Promise.all([logged("a"), logged("b")]);
    expect(results.map((result) => result.replayed)).toEqual([false, false]);
    const order = (await rows("SELECT label || ':' || phase FROM migration_log ORDER BY at"))
      .flat()
      .map(String);
    expect([
      ["a:start", "a:end", "b:start", "b:end"],
      ["b:start", "b:end", "a:start", "a:end"],
    ]).toContainEqual(order);
  });

  test("the boundary parse refuses statements the platform owns", async () => {
    const attempts = [
      "GRANT SELECT ON orders TO PUBLIC",
      "DO $$ BEGIN PERFORM 1; END $$",
      "CREATE FUNCTION api.legacy() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$",
      "CREATE FUNCTION public.owner_only() RETURNS int LANGUAGE sql SECURITY DEFINER RETURN 1",
      "SET ROLE app_x",
      "COMMIT",
    ];
    const outcomes = await Promise.all(
      attempts.map(async (sql, index) => {
        const failure = await errorOf(
          harness.control.migrate({
            appId,
            description: "refused",
            idempotencyKey: `refused-${index}`,
            sql,
          }),
        );
        return `${String(failure.code)}: ${failure.message}`;
      }),
    );
    expect(outcomes).toEqual([
      "sql_rejected: Role and privilege statements are not allowed; the platform manages roles.",
      "sql_rejected: DO blocks are not allowed; write the logic as SQL statements or a function.",
      "sql_rejected: Functions in the api schema must be LANGUAGE sql functions with a BEGIN ATOMIC ... END body.",
      "sql_rejected: SECURITY DEFINER functions are not allowed.",
      "sql_rejected: SET ROLE and SET SESSION AUTHORIZATION are not allowed.",
      "sql_rejected: Transaction control is not allowed; the platform runs each migration in one transaction.",
    ]);
  });

  test("the post-migration catalog check rolls back an overloaded api function", async () => {
    const failure = await errorOf(
      harness.control.migrate({
        appId,
        description: "overload",
        idempotencyKey: "overload-1",
        sql: `CREATE TABLE marker (id int);
CREATE FUNCTION api.lookup(p_id int) RETURNS int LANGUAGE sql STABLE BEGIN ATOMIC SELECT p_id; END;
CREATE FUNCTION api.lookup(p_id text) RETURNS text LANGUAGE sql STABLE BEGIN ATOMIC SELECT p_id; END;`,
      }),
    );
    expect(failure).toEqual({
      code: "sql_rejected",
      message:
        "Function name lookup is defined more than once (api.lookup(integer), api.lookup(text)); the api and visitor schemas together allow one function per name.",
      name: "AppDatabaseError",
      statement: undefined,
    });
    expect(await rows("SELECT to_regclass('public.marker')::text")).toEqual([[null]]);
  });

  test("a function made SECURITY DEFINER through EXECUTE is rolled back with its migration", async () => {
    const failure = await errorOf(
      harness.control.migrate({
        appId,
        description: "definer",
        idempotencyKey: "definer",
        sql: `CREATE FUNCTION public.do_ddl() RETURNS void LANGUAGE plpgsql AS $$
BEGIN CREATE TABLE created_at_runtime (id int); END $$;
CREATE FUNCTION public.promote() RETURNS void LANGUAGE plpgsql AS $$
BEGIN EXECUTE 'ALTER FUNCTION public.do_ddl() SECURITY DEFINER'; END $$;
SELECT public.promote();`,
      }),
    );
    expect({
      failure,
      function: await rows("SELECT to_regprocedure('public.do_ddl()')::text"),
      ledger: (await ledgerKeys()).filter((key) => key.endsWith(":definer")),
    }).toEqual({
      failure: {
        code: "sql_rejected",
        message:
          "Function public.do_ddl is SECURITY DEFINER; app functions must run with their caller's privileges.",
        name: "AppDatabaseError",
        statement: undefined,
      },
      function: [[null]],
      ledger: [],
    });
  });

  test("the catalog check rejects forced row level security, relations in api, pinned roles, and changed call limits", async () => {
    const { owner } = appDatabaseNames(appId).roles;
    const outcomes = await Promise.all(
      [
        "CREATE TABLE forced (id int); ALTER TABLE forced ENABLE ROW LEVEL SECURITY; ALTER TABLE forced FORCE ROW LEVEL SECURITY;",
        "CREATE TABLE api.t (id int)",
        `CREATE FUNCTION public.as_owner() RETURNS text LANGUAGE sql RETURN current_user;
CREATE FUNCTION public.pin_role() RETURNS void LANGUAGE plpgsql AS $$
BEGIN EXECUTE 'ALTER FUNCTION public.as_owner() SET role = ${owner}'; END $$;
SELECT public.pin_role();`,
        `CREATE FUNCTION public.keep_alive() RETURNS void LANGUAGE plpgsql
SET client_connection_check_interval = 0 AS $$ BEGIN END $$`,
        `CREATE FUNCTION public.no_deadline() RETURNS int LANGUAGE sql RETURN 1;
ALTER FUNCTION public.no_deadline() SET statement_timeout = 0;`,
      ].map(async (sql, index) => {
        const failure = await errorOf(
          harness.control.migrate({
            appId,
            description: "catalog",
            idempotencyKey: `catalog-${index}`,
            sql,
          }),
        );
        return `${String(failure.code)}: ${failure.message}`;
      }),
    );
    expect({
      objects: await rows(
        "SELECT to_regclass('public.forced')::text, to_regclass('api.t')::text, to_regprocedure('public.as_owner()')::text, to_regprocedure('public.keep_alive()')::text, to_regprocedure('public.no_deadline()')::text",
      ),
      outcomes,
    }).toEqual({
      objects: [[null, null, null, null, null]],
      outcomes: [
        "sql_rejected: Table public.forced forces row level security, which would block the platform's export; enable row level security without FORCE.",
        "sql_rejected: Relation api.t is not a view; the api schema holds only views and functions, so create it in public.",
        `sql_rejected: Function public.as_owner sets role=${owner}; app functions must not change the session role.`,
        "sql_rejected: Function public.keep_alive sets client_connection_check_interval=0; app functions must not change the platform's call limits.",
        "sql_rejected: Function public.no_deadline sets statement_timeout=0; app functions must not change the platform's call limits.",
      ],
    });
  });

  test("a ledger row seeded by app SQL collides with its own migration's row", async () => {
    const seeded = await errorOf(
      harness.control.migrate({
        appId,
        description: "seed",
        idempotencyKey: "seed",
        sql: "INSERT INTO platform.migrations (idempotency_key, description, sql) VALUES ('approved-later', 'audit', 'CREATE TABLE audit_log (id int)')",
      }),
    );
    const approved = await harness.control.migrate({
      appId,
      description: "audit",
      idempotencyKey: "approved-later",
      sql: "CREATE TABLE audit_log (id int)",
    });
    expect({
      approved: approved.replayed,
      auditLog: await rows("SELECT to_regclass('public.audit_log')::text"),
      seeded: { code: seeded.code, message: seeded.message.split("\n")[0] },
    }).toEqual({
      approved: false,
      auditLog: [["audit_log"]],
      seeded: {
        code: "postgres_error",
        message: 'duplicate key value violates unique constraint "migrations_transaction_id_key"',
      },
    });
  });

  test("a deferred foreign key satisfied by the end of the migration applies, and a broken one rolls back", async () => {
    const applied = await harness.control.migrate({
      appId,
      description: "deferred foreign key",
      idempotencyKey: "deferred-fk",
      sql: `CREATE TABLE menus (id int PRIMARY KEY);
CREATE TABLE dishes (menu_id int REFERENCES menus DEFERRABLE INITIALLY DEFERRED);
INSERT INTO dishes VALUES (1);
INSERT INTO menus VALUES (1);`,
    });
    const broken = await errorOf(
      harness.control.migrate({
        appId,
        description: "broken foreign key",
        idempotencyKey: "broken-fk",
        sql: "INSERT INTO dishes VALUES (2)",
      }),
    );
    expect({
      applied: applied.replayed,
      broken: { code: broken.code, message: broken.message.split("\n")[0] },
      dishes: await rows("SELECT menu_id FROM dishes ORDER BY menu_id"),
      ledger: (await ledgerKeys()).at(-1),
    }).toEqual({
      applied: false,
      broken: {
        code: "postgres_error",
        message:
          'insert or update on table "dishes" violates foreign key constraint "dishes_menu_id_fkey"',
      },
      dishes: [["1"]],
      ledger: `${applied.migrationId}:deferred-fk`,
    });
  });
});
