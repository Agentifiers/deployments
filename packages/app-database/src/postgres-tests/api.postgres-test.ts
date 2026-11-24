import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ApiCallInput } from "../api-call.ts";
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

let harness: TestControl;
let gateway: AppApiGateway;
let appId: AppId;
let slug: AppSlug;

const SCHEMA = `
CREATE TABLE orders (
  id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status text NOT NULL,
  created_by text NOT NULL DEFAULT current_setting('app.principal_id'),
  details jsonb
);
CREATE FUNCTION public.helper() RETURNS int LANGUAGE sql RETURN 1;
CREATE FUNCTION api.list_orders(p_status text DEFAULT 'open')
  RETURNS TABLE (id int, status text, details jsonb)
  LANGUAGE sql STABLE
  BEGIN ATOMIC SELECT o.id, o.status, o.details FROM orders o WHERE o.status = p_status ORDER BY o.id; END;
CREATE FUNCTION api.create_order(p_status text, p_details jsonb DEFAULT NULL) RETURNS int
  LANGUAGE sql VOLATILE
  BEGIN ATOMIC INSERT INTO orders (status, details) VALUES (p_status, p_details) RETURNING id; END;
CREATE FUNCTION api.order_count() RETURNS bigint
  LANGUAGE sql STABLE
  BEGIN ATOMIC SELECT count(*) FROM orders; END;
CREATE FUNCTION public.write_order() RETURNS int LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  INSERT INTO orders (status) VALUES ('sneaky');
  RETURN 1;
END $$;
CREATE FUNCTION api.sneaky_write() RETURNS int
  LANGUAGE sql STABLE
  BEGIN ATOMIC SELECT public.write_order(); END;
`;

const MEMBER = { email: "member@example.com", id: "principal-1" } as const;

function call(
  input: Pick<ApiCallInput, "args" | "functionName"> & { readonly role: "editor" | "viewer" },
) {
  return gateway.callApiFunction({ ...input, appId, appIsPublic: false, principal: MEMBER });
}

beforeAll(async () => {
  await prepareCluster();
  harness = createTestControl();
  gateway = createAppApiGateway({ connections: testConnections });
  appId = newAppId();
  slug = newSlug();
  await harness.control.provision({ appId, slug });
  await harness.control.migrate({
    appId,
    description: "orders",
    idempotencyKey: "orders",
    sql: SCHEMA,
  });
});

afterAll(async () => {
  await gateway.close();
  await harness.control.erase(eraseInput({ appId, slug }));
  await harness.control.close();
});

describe("callApiFunction", () => {
  test("an editor writes through a volatile function and a viewer reads through a stable one", async () => {
    const created = await call({
      args: { p_details: { rush: true, tags: ["a"] }, p_status: "open" },
      functionName: "create_order",
      role: "editor",
    });
    const listed = await call({ args: {}, functionName: "list_orders", role: "viewer" });
    const counted = await call({ args: {}, functionName: "order_count", role: "editor" });
    const audit = await harness.control.query({
      appId,
      maxRows: 10,
      sql: "SELECT created_by FROM orders",
    });
    expect({ audit: audit.rows, counted, created, listed }).toEqual({
      audit: [["principal-1"]],
      counted: { rows: [1] },
      created: { rows: [1] },
      listed: { rows: [{ details: { rush: true, tags: ["a"] }, id: 1, status: "open" }] },
    });
  });

  test("refuses a volatile function for the viewer role and names outside api", async () => {
    const outcomes = await Promise.all(
      [
        { functionName: "create_order", role: "viewer" as const },
        { functionName: "helper", role: "editor" as const },
        { functionName: "pg_sleep", role: "editor" as const },
      ].map(async (input) => {
        const failure = await errorOf(call({ ...input, args: { p_status: "open" } }));
        return `${String(failure.code)}: ${failure.message}`;
      }),
    );
    expect(outcomes).toEqual([
      "function_not_allowed: api.create_order is volatile and needs editor access.",
      'function_not_found: The api and visitor schemas have no function named "helper".',
      'function_not_found: The api and visitor schemas have no function named "pg_sleep".',
    ]);
  });

  test("a STABLE function that writes fails in the viewer's read-only transaction", async () => {
    const failure = await errorOf(call({ args: {}, functionName: "sneaky_write", role: "editor" }));
    expect(failure).toEqual({
      code: "postgres_error",
      message: "cannot execute INSERT in a read-only transaction",
      name: "AppDatabaseError",
      statement: "api.sneaky_write",
    });
  });

  test("checks argument names before calling", async () => {
    const outcomes = await Promise.all(
      [{ p_state: "open", p_status: "open" }, {}].map(async (args) => {
        const failure = await errorOf(call({ args, functionName: "create_order", role: "editor" }));
        return `${String(failure.code)}: ${failure.message}`;
      }),
    );
    expect(outcomes).toEqual([
      "invalid_arguments: api.create_order has no argument p_state; it takes p_status, p_details.",
      "invalid_arguments: api.create_order requires p_status.",
    ]);
  });

  test("sees a new function after a migration bumps the schema version", async () => {
    await harness.control.migrate({
      appId,
      description: "greet",
      idempotencyKey: "greet",
      sql: "CREATE FUNCTION api.greet(p_name text) RETURNS text LANGUAGE sql IMMUTABLE BEGIN ATOMIC SELECT 'hi ' || p_name; END",
    });
    expect(await call({ args: { p_name: "ada" }, functionName: "greet", role: "viewer" })).toEqual({
      rows: ["hi ada"],
    });
  });

  test("leaves no pooled session idle inside a transaction", async () => {
    await call({ args: {}, functionName: "order_count", role: "viewer" });
    const names = appDatabaseNames(appId);
    const states = await asSuperuser(
      "postgres",
      async (client) =>
        (
          await client.query(
            "SELECT DISTINCT state FROM pg_stat_activity WHERE datname = $1 AND usename = $2",
            [names.database, names.roles.viewer],
          )
        ).rows,
    );
    expect(states).toEqual([{ state: "idle" }]);
  });
});

describe("describe", () => {
  test("reports api functions and generates a typed client", async () => {
    const description = await harness.control.describe(appId);
    expect(description.functions.map((fn) => [fn.name, fn.volatility, fn.returns])).toEqual([
      ["create_order", "volatile", { columns: [], set: false, shape: "scalar", type: "integer" }],
      ["greet", "immutable", { columns: [], set: false, shape: "scalar", type: "text" }],
      [
        "list_orders",
        "stable",
        {
          columns: [
            { name: "id", type: "integer" },
            { name: "status", type: "text" },
            { name: "details", type: "jsonb" },
          ],
          set: true,
          shape: "row",
          type: null,
        },
      ],
      ["order_count", "stable", { columns: [], set: false, shape: "scalar", type: "bigint" }],
      ["sneaky_write", "stable", { columns: [], set: false, shape: "scalar", type: "integer" }],
    ]);
    expect(description.client).toContain(
      'export async function list_orders(args: { "p_status"?: string | null } = {}): Promise<Array<{ "id": number | null; "status": string | null; "details": JsonValue | null }>> {',
    );
    expect(description.client).toContain(
      'export async function create_order(args: { "p_status": string | null; "p_details"?: JsonValue | null }): Promise<number | null> {',
    );
    expect(description.relations.map((relation) => `${relation.schema}.${relation.name}`)).toEqual([
      "public.orders",
    ]);
  });
});

describe("result size", () => {
  test("a result over the byte cap fails before it reaches the caller", async () => {
    await harness.control.migrate({
      appId,
      description: "big",
      idempotencyKey: "big",
      sql: "CREATE FUNCTION api.big() RETURNS text LANGUAGE sql STABLE BEGIN ATOMIC SELECT repeat('x', 2097152); END",
    });
    expect(await errorOf(call({ args: {}, functionName: "big", role: "viewer" }))).toEqual({
      code: "result_too_large",
      message:
        "api.big returned 2097156 bytes of JSON, over the 1048576-byte limit; return fewer or smaller rows per call and page through the rest.",
      name: "AppDatabaseError",
      statement: "api.big",
    });
  });

  test("a public function that shadows a builtin cannot lift the byte cap", async () => {
    await harness.control.migrate({
      appId,
      description: "shadow",
      idempotencyKey: "shadow",
      sql: `CREATE FUNCTION public.octet_length(text) RETURNS integer LANGUAGE sql IMMUTABLE RETURN 0;
CREATE FUNCTION api.huge() RETURNS text LANGUAGE sql STABLE BEGIN ATOMIC SELECT repeat('x', 2097152); END;`,
    });
    expect(await errorOf(call({ args: {}, functionName: "huge", role: "viewer" }))).toEqual({
      code: "result_too_large",
      message:
        "api.huge returned 2097156 bytes of JSON, over the 1048576-byte limit; return fewer or smaller rows per call and page through the rest.",
      name: "AppDatabaseError",
      statement: "api.huge",
    });
  });
});
