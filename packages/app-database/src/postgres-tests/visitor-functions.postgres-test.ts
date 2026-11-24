import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ApiCallInput } from "../api-call.ts";
import { createAppApiGateway, type AppApiGateway } from "../app-database.ts";
import { AppDatabaseError } from "../errors.ts";
import { appDatabaseNames, type ApiCallerRole, type AppId, type AppSlug } from "../names.ts";
import {
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
CREATE TABLE signups (
  id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL,
  created_by text NOT NULL DEFAULT current_setting('app.principal_id')
);
CREATE FUNCTION api.signup_count() RETURNS bigint LANGUAGE sql STABLE
  BEGIN ATOMIC SELECT count(*) FROM signups; END;
CREATE FUNCTION visitor.whoami() RETURNS text LANGUAGE sql STABLE
  BEGIN ATOMIC
    SELECT format('%s read_only=%s principal=%s', current_user,
      current_setting('transaction_read_only'), current_setting('app.principal_id'));
  END;
CREATE FUNCTION visitor.sign_up(p_email text) RETURNS text LANGUAGE sql VOLATILE
  BEGIN ATOMIC
    INSERT INTO signups (email) VALUES (p_email)
    RETURNING format('%s read_only=%s created_by=%s', current_user,
      current_setting('transaction_read_only'), created_by);
  END;
CREATE FUNCTION visitor.fingerprint(p_email text) RETURNS text LANGUAGE sql IMMUTABLE
  BEGIN ATOMIC SELECT encode(digest(lower(p_email), 'sha256'), 'hex'); END;
`;

const MEMBER = { email: "member@example.com", id: "principal-1" } as const;

let harness: TestControl;
let gateway: AppApiGateway;
let appId: AppId;
let slug: AppSlug;
let rolePrefix: string;

beforeAll(async () => {
  await prepareCluster();
  harness = createTestControl();
  gateway = createAppApiGateway({ connections: testConnections });
  appId = newAppId();
  slug = newSlug();
  rolePrefix = `${appDatabaseNames(appId).database}_`;
  await harness.control.provision({ appId, slug });
  await harness.control.migrate({
    appId,
    description: "schema",
    idempotencyKey: "schema",
    sql: SCHEMA,
  });
});

afterAll(async () => {
  await gateway.close();
  await harness.control.erase(eraseInput({ appId, slug }));
  await harness.control.close();
});

async function outcome(
  caller: ApiCallerRole,
  appIsPublic: boolean,
  functionName: string,
  args: ApiCallInput["args"] = {},
) {
  const base = { appId, appIsPublic, args, functionName };
  const input: ApiCallInput =
    caller === "visitor" ? { ...base, role: caller } : { ...base, principal: MEMBER, role: caller };
  const answer = await gateway.callApiFunction(input).then(
    (result) => JSON.stringify(result.rows).replaceAll(rolePrefix, ""),
    (error: unknown) =>
      error instanceof AppDatabaseError ? `${error.code} ${error.message}` : String(error),
  );
  return `${appIsPublic ? "public" : "members"} ${caller} ${functionName}: ${answer}`;
}

function rejected(key: string, sql: string) {
  return errorOf(
    harness.control.migrate({ appId, description: key, idempotencyKey: key, sql }),
  ).then((failure) => `${String(failure.code)}: ${failure.message}`);
}

describe("visitor function calls", () => {
  test("run as the visitor role on a public app and follow the member rule otherwise", async () => {
    const email = { p_email: "guest@example.com" };
    const outcomes: string[] = [];
    for (const call of [
      () => outcome("viewer", false, "whoami"),
      () => outcome("viewer", false, "sign_up", email),
      () => outcome("editor", false, "sign_up", email),
      () => outcome("visitor", false, "whoami"),
      () => outcome("visitor", true, "whoami"),
      () => outcome("visitor", true, "sign_up", email),
      () => outcome("viewer", true, "sign_up", email),
      () => outcome("editor", true, "whoami"),
      () => outcome("viewer", true, "signup_count"),
      () => outcome("visitor", true, "signup_count"),
      () => outcome("visitor", true, "no_such_function"),
    ]) {
      outcomes.push(await call());
    }
    expect(outcomes).toEqual([
      'members viewer whoami: ["viewer read_only=on principal=principal-1"]',
      "members viewer sign_up: function_not_allowed visitor.sign_up is volatile and needs editor access.",
      'members editor sign_up: ["editor read_only=off created_by=principal-1"]',
      'members visitor whoami: visitor_not_allowed Visitors cannot call "whoami"; only the visitor functions of a public app are open to them.',
      'public visitor whoami: ["visitor read_only=on principal="]',
      'public visitor sign_up: ["visitor read_only=off created_by="]',
      'public viewer sign_up: ["visitor read_only=off created_by=principal-1"]',
      'public editor whoami: ["visitor read_only=on principal=principal-1"]',
      "public viewer signup_count: [3]",
      'public visitor signup_count: visitor_not_allowed Visitors cannot call "signup_count"; only the visitor functions of a public app are open to them.',
      'public visitor no_such_function: visitor_not_allowed Visitors cannot call "no_such_function"; only the visitor functions of a public app are open to them.',
    ]);
  });

  test("may call extension functions, which every role can execute", async () => {
    expect(await outcome("visitor", true, "fingerprint", { p_email: "Guest@Example.com" })).toBe(
      `public visitor fingerprint: ["${createHash("sha256").update("guest@example.com").digest("hex")}"]`,
    );
  });

  test("are reported with their schema by describe", async () => {
    const description = await harness.control.describe(appId);
    expect(description.functions.map((fn) => `${fn.schema}.${fn.name}`)).toEqual([
      "visitor.fingerprint",
      "visitor.sign_up",
      "api.signup_count",
      "visitor.whoami",
    ]);
  });
});

describe("the catalog check", () => {
  test("rejects every visitor-schema violation and rolls the migration back", async () => {
    const outcomes = [
      await rejected(
        "same-name",
        "CREATE FUNCTION visitor.signup_count() RETURNS bigint LANGUAGE sql STABLE BEGIN ATOMIC SELECT 1::bigint; END",
      ),
      await rejected("table", "CREATE TABLE visitor.drafts (id int)"),
      await rejected(
        "out-of-visitor",
        `CREATE FUNCTION visitor.moved() RETURNS int LANGUAGE sql STABLE BEGIN ATOMIC SELECT 1; END;
ALTER FUNCTION visitor.moved() SET SCHEMA api;`,
      ),
      await rejected(
        "into-visitor",
        `CREATE FUNCTION api.moved_in() RETURNS int LANGUAGE sql STABLE BEGIN ATOMIC SELECT 1; END;
ALTER FUNCTION api.moved_in() SET SCHEMA visitor;`,
      ),
      await rejected(
        "plpgsql-into-visitor",
        `CREATE FUNCTION public.legacy() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$;
ALTER FUNCTION public.legacy() SET SCHEMA visitor;`,
      ),
      await rejected(
        "public-helper",
        `CREATE FUNCTION public.clean_email(p text) RETURNS text LANGUAGE sql IMMUTABLE RETURN lower(p);
CREATE FUNCTION visitor.sign_up_clean(p_email text) RETURNS void LANGUAGE sql VOLATILE
  BEGIN ATOMIC INSERT INTO signups (email) VALUES (public.clean_email(p_email)); END;`,
      ),
      await rejected(
        "api-helper",
        "CREATE FUNCTION visitor.count_again() RETURNS bigint LANGUAGE sql STABLE BEGIN ATOMIC SELECT api.signup_count(); END",
      ),
      await rejected(
        "out-to-public",
        `CREATE FUNCTION visitor.moved_out() RETURNS int LANGUAGE sql STABLE BEGIN ATOMIC SELECT 1; END;
ALTER FUNCTION visitor.moved_out() SET SCHEMA public;`,
      ),
      await rejected(
        "api-view",
        `CREATE VIEW api.recent AS SELECT id FROM signups;
CREATE FUNCTION visitor.recent_count() RETURNS bigint LANGUAGE sql STABLE BEGIN ATOMIC SELECT count(*) FROM api.recent; END;`,
      ),
      await rejected("enum", "CREATE TYPE visitor.mood AS ENUM ('ok', 'great')"),
      await rejected(
        "ledger-view",
        "CREATE VIEW public.ledger AS SELECT idempotency_key, sql FROM platform.migrations",
      ),
    ];
    const ledger = (await harness.control.describe(appId)).migrations.map(
      (migration) => migration.idempotencyKey,
    );
    expect({ ledger, outcomes }).toEqual({
      ledger: ["schema"],
      outcomes: [
        "sql_rejected: Function name signup_count is defined more than once (api.signup_count(), visitor.signup_count()); the api and visitor schemas together allow one function per name.",
        "sql_rejected: table visitor.drafts is in the visitor schema, which holds only functions; create it in public.",
        "sql_rejected: Function api.moved is executable by visitors, but only functions in the visitor schema may be; drop it and create it again.",
        "sql_rejected: Function visitor.moved_in is not executable by visitors because it was created in another schema; drop it and create it in visitor.",
        [
          "sql_rejected: Function visitor.legacy is not executable by visitors because it was created in another schema; drop it and create it in visitor.",
          "Function visitor.legacy must be a LANGUAGE sql function with a BEGIN ATOMIC body.",
        ].join("\n"),
        "sql_rejected: Function visitor.sign_up_clean uses function public.clean_email(text), which the visitor role cannot use; a visitor function may use public tables and types, visitor functions, and functions every role may execute.",
        "sql_rejected: Function visitor.count_again uses function api.signup_count(), which the visitor role cannot use; a visitor function may use public tables and types, visitor functions, and functions every role may execute.",
        "sql_rejected: Function public.moved_out is executable by visitors, but only functions in the visitor schema may be; drop it and create it again.",
        "sql_rejected: Function visitor.recent_count uses view api.recent, which the visitor role cannot use; a visitor function may use public tables and types, visitor functions, and functions every role may execute.",
        "sql_rejected: type visitor.mood is in the visitor schema, which holds only functions; create it in public.",
        "sql_rejected: view public.ledger reads platform.migrations; views and rules must not use the platform schema.",
      ],
    });
  });

  test("refuses dropping the visitor or public schema and keeps the ledger", async () => {
    const outcomes = [
      await rejected("drop-visitor", "DROP SCHEMA visitor CASCADE"),
      await rejected("drop-public", "DROP SCHEMA public CASCADE"),
    ];
    const description = await harness.control.describe(appId);
    expect({
      functions: description.functions.map((fn) => `${fn.schema}.${fn.name}`).toSorted(),
      ledger: description.migrations.map((migration) => migration.idempotencyKey),
      outcomes,
    }).toEqual({
      functions: ["api.signup_count", "visitor.fingerprint", "visitor.sign_up", "visitor.whoami"],
      ledger: ["schema"],
      outcomes: [
        "sql_rejected: Schemas are managed by the platform; DROP SCHEMA and ALTER SCHEMA ... RENAME are not allowed.",
        "sql_rejected: Schemas are managed by the platform; DROP SCHEMA and ALTER SCHEMA ... RENAME are not allowed.",
      ],
    });
  });

  test("refuses dropping the visitor or public schema from inside a function", async () => {
    const throughFunction = (key: string, body: string) =>
      rejected(
        key,
        `CREATE FUNCTION public.${key}() RETURNS void ${body};\nSELECT public.${key}();`,
      );
    const outcomes = [
      await throughFunction("sql_drop_visitor", "LANGUAGE sql AS 'DROP SCHEMA visitor CASCADE'"),
      await throughFunction("sql_drop_public", "LANGUAGE sql AS 'DROP SCHEMA public CASCADE'"),
      await throughFunction(
        "plpgsql_drop_visitor",
        "LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'DROP SCHEMA visitor CASCADE'; END $$",
      ),
      await throughFunction(
        "plpgsql_drop_public",
        "LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'DROP SCHEMA public CASCADE'; END $$",
      ),
    ];
    const description = await harness.control.describe(appId);
    const schemas = await harness.control.query({
      appId,
      maxRows: 10,
      sql: "SELECT nspname FROM pg_namespace WHERE nspname IN ('public', 'api', 'visitor', 'platform') ORDER BY nspname",
    });
    expect({
      functions: description.functions.map((fn) => `${fn.schema}.${fn.name}`).toSorted(),
      ledger: description.migrations.map((migration) => migration.idempotencyKey),
      outcomes,
      schemas: schemas.rows,
    }).toEqual({
      functions: ["api.signup_count", "visitor.fingerprint", "visitor.sign_up", "visitor.whoami"],
      ledger: ["schema"],
      outcomes: [
        "sql_rejected: Schema visitor no longer exists; schemas are managed by the platform, so a migration must not drop or rename one.",
        "sql_rejected: Schema public no longer exists; schemas are managed by the platform, so a migration must not drop or rename one.",
        "sql_rejected: Schema visitor no longer exists; schemas are managed by the platform, so a migration must not drop or rename one.",
        "sql_rejected: Schema public no longer exists; schemas are managed by the platform, so a migration must not drop or rename one.",
      ],
      schemas: [["api"], ["platform"], ["public"], ["visitor"]],
    });
  });

  test("refuses a deferred constraint trigger that drops a schema at commit", async () => {
    const outcomes = [
      await rejected(
        "deferred_drop_api",
        `CREATE FUNCTION public.deferred_drop_api() RETURNS trigger LANGUAGE plpgsql
  AS $$ BEGIN EXECUTE 'DROP SCHEMA api CASCADE'; RETURN NULL; END $$;
CREATE TABLE deferred_rows (id int);
CREATE CONSTRAINT TRIGGER deferred_drop_api AFTER INSERT ON deferred_rows
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.deferred_drop_api();
INSERT INTO deferred_rows VALUES (1);`,
      ),
      await rejected(
        "set_deferred_drop_visitor",
        `CREATE FUNCTION public.set_deferred_drop_visitor() RETURNS trigger LANGUAGE plpgsql
  AS $$ BEGIN EXECUTE 'DROP SCHEMA visitor CASCADE'; RETURN NULL; END $$;
CREATE TABLE deferred_rows (id int);
CREATE CONSTRAINT TRIGGER set_deferred_drop_visitor AFTER INSERT ON deferred_rows
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION public.set_deferred_drop_visitor();
SET CONSTRAINTS ALL DEFERRED;
INSERT INTO deferred_rows VALUES (1);`,
      ),
    ];
    const description = await harness.control.describe(appId);
    const schemas = await harness.control.query({
      appId,
      maxRows: 10,
      sql: "SELECT nspname FROM pg_namespace WHERE nspname IN ('public', 'api', 'visitor', 'platform') ORDER BY nspname",
    });
    expect({
      ledger: description.migrations.map((migration) => migration.idempotencyKey),
      outcomes,
      schemas: schemas.rows,
    }).toEqual({
      ledger: ["schema"],
      outcomes: [
        "sql_rejected: Schema api no longer exists; schemas are managed by the platform, so a migration must not drop or rename one.",
        "sql_rejected: Schema visitor no longer exists; schemas are managed by the platform, so a migration must not drop or rename one.",
      ],
      schemas: [["api"], ["platform"], ["public"], ["visitor"]],
    });
  });
});
