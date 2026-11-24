import { describe, expect, test } from "bun:test";
import { parseMigration, parseSingleQuery } from "./sql-policy.ts";

async function rejection(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    if (error instanceof Error && "code" in error && "statement" in error) {
      return { code: error.code, message: error.message, statement: error.statement };
    }
    throw error;
  }
  throw new Error("Expected a rejection.");
}

describe("parseMigration", () => {
  test("splits statements on their own source text, multi-byte characters included", async () => {
    const statements = await parseMigration(
      "-- café menu\nCREATE TABLE menu (name text DEFAULT 'crème brûlée');\n\nINSERT INTO menu VALUES ('naïve');",
    );
    expect(statements.map((statement) => statement.text)).toEqual([
      "-- café menu\nCREATE TABLE menu (name text DEFAULT 'crème brûlée')",
      "INSERT INTO menu VALUES ('naïve')",
    ]);
  });

  test("accepts api and visitor functions with a BEGIN ATOMIC body and plpgsql in public", async () => {
    const statements = await parseMigration(`
      CREATE FUNCTION api.count_orders() RETURNS bigint LANGUAGE sql STABLE
        BEGIN ATOMIC SELECT count(*) FROM orders; END;
      CREATE FUNCTION visitor.sign_up(p_email text) RETURNS void LANGUAGE sql VOLATILE
        BEGIN ATOMIC INSERT INTO signups (email) VALUES (p_email); END;
      CREATE FUNCTION public.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`);
    expect(statements).toHaveLength(3);
  });

  test.each([
    [
      "BEGIN",
      "Transaction control is not allowed; the platform runs each migration in one transaction.",
    ],
    [
      "SAVEPOINT a",
      "Transaction control is not allowed; the platform runs each migration in one transaction.",
    ],
    [
      "GRANT SELECT ON orders TO PUBLIC",
      "Role and privilege statements are not allowed; the platform manages roles.",
    ],
    [
      "REVOKE ALL ON orders FROM app_x_viewer",
      "Role and privilege statements are not allowed; the platform manages roles.",
    ],
    [
      "CREATE ROLE intruder",
      "Role and privilege statements are not allowed; the platform manages roles.",
    ],
    [
      "ALTER ROLE app_x_owner CREATEDB",
      "Role and privilege statements are not allowed; the platform manages roles.",
    ],
    [
      "DROP ROLE app_x_viewer",
      "Role and privilege statements are not allowed; the platform manages roles.",
    ],
    [
      "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC",
      "Role and privilege statements are not allowed; the platform manages roles.",
    ],
    ["SET ROLE app_b_owner", "SET ROLE and SET SESSION AUTHORIZATION are not allowed."],
    ["RESET ROLE", "SET ROLE and SET SESSION AUTHORIZATION are not allowed."],
    [
      "SET SESSION AUTHORIZATION app_b_owner",
      "SET ROLE and SET SESSION AUTHORIZATION are not allowed.",
    ],
    [
      "CREATE FUNCTION public.f() RETURNS int LANGUAGE sql SET role = 'app_b_owner' RETURN 1",
      "SET ROLE and SET SESSION AUTHORIZATION are not allowed.",
    ],
    ["COPY orders TO STDOUT", "COPY is not allowed in a migration."],
    ["DECLARE c CURSOR FOR SELECT 1", "Cursors are not allowed in a migration."],
    ["DECLARE c CURSOR WITH HOLD FOR SELECT public.f()", "Cursors are not allowed in a migration."],
    ["LISTEN changes", "LISTEN, UNLISTEN, and NOTIFY are not allowed."],
    ["NOTIFY changes", "LISTEN, UNLISTEN, and NOTIFY are not allowed."],
    [
      "CREATE RULE r AS ON INSERT TO orders DO ALSO NOTIFY changes",
      "LISTEN, UNLISTEN, and NOTIFY are not allowed.",
    ],
    [
      "CREATE EXTENSION hstore",
      "Extensions are managed by the platform; pgcrypto, citext, and pg_trgm are already installed.",
    ],
    [
      "DROP EXTENSION pgcrypto",
      "Extensions are managed by the platform; pgcrypto, citext, and pg_trgm are already installed.",
    ],
    [
      "DROP SCHEMA public CASCADE",
      "Schemas are managed by the platform; DROP SCHEMA and ALTER SCHEMA ... RENAME are not allowed.",
    ],
    [
      "DROP SCHEMA IF EXISTS visitor",
      "Schemas are managed by the platform; DROP SCHEMA and ALTER SCHEMA ... RENAME are not allowed.",
    ],
    [
      "ALTER SCHEMA visitor RENAME TO visitor_old",
      "Schemas are managed by the platform; DROP SCHEMA and ALTER SCHEMA ... RENAME are not allowed.",
    ],
    [
      "DO $$ BEGIN EXECUTE 'GRANT ALL ON orders TO PUBLIC'; END $$",
      "DO blocks are not allowed; write the logic as SQL statements or a function.",
    ],
    [
      "CREATE FUNCTION public.f() RETURNS int LANGUAGE sql SECURITY DEFINER RETURN 1",
      "SECURITY DEFINER functions are not allowed.",
    ],
    ["ALTER FUNCTION public.f() SECURITY DEFINER", "SECURITY DEFINER functions are not allowed."],
    [
      "CREATE FUNCTION api.f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$",
      "Functions in the api schema must be LANGUAGE sql functions with a BEGIN ATOMIC ... END body.",
    ],
    [
      "CREATE FUNCTION api.f() RETURNS int LANGUAGE sql AS 'SELECT 1'",
      "Functions in the api schema must be LANGUAGE sql functions with a BEGIN ATOMIC ... END body.",
    ],
    [
      "CREATE FUNCTION api.f() RETURNS int LANGUAGE sql RETURN 1",
      "Functions in the api schema must be LANGUAGE sql functions with a BEGIN ATOMIC ... END body.",
    ],
    [
      "CREATE PROCEDURE api.p() LANGUAGE sql BEGIN ATOMIC SELECT 1; END",
      "Functions in the api schema must be LANGUAGE sql functions with a BEGIN ATOMIC ... END body.",
    ],
    [
      "CREATE FUNCTION visitor.f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$",
      "Functions in the visitor schema must be LANGUAGE sql functions with a BEGIN ATOMIC ... END body.",
    ],
    [
      "CREATE PROCEDURE visitor.p() LANGUAGE sql BEGIN ATOMIC SELECT 1; END",
      "Functions in the visitor schema must be LANGUAGE sql functions with a BEGIN ATOMIC ... END body.",
    ],
  ])("rejects %s", async (sql, message) => {
    expect(await rejection(parseMigration(`CREATE TABLE ok (id int);\n${sql};`))).toEqual({
      code: "sql_rejected",
      message,
      statement: sql,
    });
  });

  test("reports a syntax error with its position", async () => {
    expect(await rejection(parseMigration("CREATE TABLE ("))).toEqual({
      code: "sql_rejected",
      message: 'syntax error at or near "(" at character 14',
      statement: undefined,
    });
  });

  test("rejects an empty migration", async () => {
    expect(await rejection(parseMigration("-- nothing\n;"))).toEqual({
      code: "sql_rejected",
      message: "The migration has no statements.",
      statement: undefined,
    });
  });
});

describe("parseSingleQuery", () => {
  test("returns the one statement", async () => {
    expect((await parseSingleQuery("  SELECT 1;  ")).text).toBe("SELECT 1");
  });

  test.each([
    ["SELECT 1; SELECT 2", "app.query runs exactly one statement; this SQL has 2."],
    ["-- nothing to run", "app.query runs exactly one statement; this SQL has 0."],
  ])("rejects %p", async (sql, message) => {
    expect(await rejection(parseSingleQuery(sql))).toEqual({
      code: "sql_rejected",
      message,
      statement: undefined,
    });
  });

  test("rejects transaction control", async () => {
    expect(await rejection(parseSingleQuery("COMMIT"))).toEqual({
      code: "sql_rejected",
      message: "Transaction control is not allowed; app.query runs in a read-only transaction.",
      statement: "COMMIT",
    });
  });
});
