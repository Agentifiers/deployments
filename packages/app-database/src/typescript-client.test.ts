import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiFunction, PgType } from "./api-catalog.ts";
import { renderTypescriptClient } from "./typescript-client.ts";

function base(name: string, sql = name): PgType {
  return { base: { element: null, kind: "b", name }, sql };
}

const FUNCTIONS: readonly ApiFunction[] = [
  {
    arguments: [
      { hasDefault: false, name: "p_status", type: base("text") },
      {
        hasDefault: true,
        name: "p_tags",
        type: {
          base: { element: { kind: "b", name: "text" }, kind: "b", name: "_text" },
          sql: "text[]",
        },
      },
    ],
    name: "list_orders",
    result: {
      columns: [
        { name: "id", type: base("int4", "integer") },
        { name: "placed_at", type: base("timestamptz", "timestamp with time zone") },
        { name: "shape", type: base("geometry") },
      ],
      kind: "row",
    },
    returnsSet: true,
    schema: "api",
    volatility: "stable",
  },
  {
    arguments: [],
    name: "count_orders",
    result: { kind: "scalar", type: base("int8", "bigint") },
    returnsSet: false,
    schema: "visitor",
    volatility: "stable",
  },
  {
    arguments: [{ hasDefault: false, name: "p_id", type: base("int4", "integer") }],
    name: "delete",
    result: { kind: "void" },
    returnsSet: false,
    schema: "api",
    volatility: "volatile",
  },
];

interface Captured {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

let directory: string;
let requests: Captured[];
let responses: Response[];
let assigned: string[];
let redirected: PromiseWithResolvers<void>;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "platform-client-"));
  requests = [];
  responses = [];
  assigned = [];
  redirected = Promise.withResolvers<void>();
  globalThis.fetch = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ init, url: url instanceof Request ? url.url : url.toString() });
      const response = responses.shift();
      if (response === undefined) throw new Error("No response queued.");
      return response;
    },
    { preconnect: originalFetch.preconnect },
  );
  Object.assign(globalThis, {
    window: {
      location: {
        assign: (target: string) => {
          assigned.push(target);
          redirected.resolve();
        },
        hash: "#top",
        pathname: "/orders",
        search: "?page=2",
      },
    },
  });
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(globalThis, "window");
  await rm(directory, { force: true, recursive: true });
});

async function loadClient(): Promise<Record<string, (args?: object) => Promise<unknown>>> {
  const file = join(directory, "platform-client.ts");
  await writeFile(file, renderTypescriptClient(FUNCTIONS));
  return import(file);
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

describe("renderTypescriptClient", () => {
  test("types arguments and results conservatively", () => {
    const client = renderTypescriptClient(FUNCTIONS);
    expect(client).toContain(
      'export async function list_orders(args: { "p_status": string | null; "p_tags"?: Array<string | null> | null }): Promise<Array<{ "id": number | null; "placed_at": string | null; "shape": unknown }>> {',
    );
    expect(client).toContain(
      "export async function count_orders(args: Record<string, never> = {}): Promise<number | null> {",
    );
    expect(client).toContain(
      'async function delete_(args: { "p_id": number | null }): Promise<void> {',
    );
    expect(client).toContain("export { delete_ as delete };");
  });

  test("names each function's schema in its doc line", () => {
    const docs = renderTypescriptClient(FUNCTIONS)
      .split("\n")
      .filter((line) => line.startsWith("/** "));
    expect(docs).toEqual([
      "/** api.list_orders, stable. */",
      "/** visitor.count_orders, stable. */",
      "/** api.delete, volatile. */",
    ]);
  });

  test("posts named arguments as same-origin JSON and unwraps rows by shape", async () => {
    const client = await loadClient();
    responses.push(
      json(200, { rows: [{ id: 1, placed_at: "2026-10-08T12:00:00+00:00", shape: null }] }),
    );
    responses.push(json(200, { rows: [3] }));
    responses.push(json(200, { rows: [] }));

    const listed = await client.list_orders?.({ p_status: "open" });
    const counted = await client.count_orders?.();
    const deleted = await client.delete?.({ p_id: 7 });

    expect({ counted, deleted, listed }).toEqual({
      counted: 3,
      deleted: undefined,
      listed: [{ id: 1, placed_at: "2026-10-08T12:00:00+00:00", shape: null }],
    });
    expect(
      requests.map(({ init, url }) => ({
        body: init?.body,
        credentials: init?.credentials,
        headers: init?.headers,
        method: init?.method,
        url,
      })),
    ).toEqual([
      {
        body: '{"p_status":"open"}',
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        method: "POST",
        url: "/_platform/api/list_orders",
      },
      {
        body: "{}",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        method: "POST",
        url: "/_platform/api/count_orders",
      },
      {
        body: '{"p_id":7}',
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        method: "POST",
        url: "/_platform/api/delete",
      },
    ]);
  });

  test("retries once after Retry-After on 503", async () => {
    const client = await loadClient();
    responses.push(
      json(503, { error: { code: "unavailable", message: "busy" } }, { "retry-after": "0" }),
    );
    responses.push(json(200, { rows: [5] }));
    expect(await client.count_orders?.()).toBe(5);
    expect(requests).toHaveLength(2);
  });

  test("a second 503 surfaces as an error", async () => {
    const client = await loadClient();
    responses.push(json(503, {}, { "retry-after": "0" }));
    responses.push(json(503, { error: { code: "unavailable", message: "still busy" } }));
    const failure = await client.count_orders?.().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      code: "unavailable",
      message: "still busy",
      name: "PlatformApiError",
      status: 503,
    });
  });

  test("redirects to sign-in on 401 and never settles", async () => {
    const client = await loadClient();
    responses.push(json(401, { error: { code: "unauthenticated", message: "sign in" } }));
    let settled = false;
    void client.count_orders?.().finally(() => {
      settled = true;
    });
    await redirected.promise;
    await Promise.resolve();
    await Promise.resolve();
    const outcome = settled ? "settled" : "pending";
    expect({ assigned, outcome }).toEqual({
      assigned: ["/_platform/auth/login?return_to=%2Forders%3Fpage%3D2%23top"],
      outcome: "pending",
    });
  });

  test("throws other 401s and reports Retry-After seconds on 429", async () => {
    const client = await loadClient();
    responses.push(json(401, { error: { code: "invalid_token", message: "Bad token" } }));
    responses.push(
      json(429, { error: { code: "rate_limited", message: "Too many" } }, { "retry-after": "6" }),
    );
    const notAllowed = await client.count_orders?.().catch((error: unknown) => error);
    const limited = await client.count_orders?.().catch((error: unknown) => error);

    expect(assigned).toEqual([]);
    expect(notAllowed).toMatchObject({
      code: "invalid_token",
      name: "PlatformApiError",
      retryAfter: null,
      status: 401,
    });
    expect(limited).toMatchObject({
      code: "rate_limited",
      name: "PlatformApiError",
      retryAfter: 6,
      status: 429,
    });
  });
});
