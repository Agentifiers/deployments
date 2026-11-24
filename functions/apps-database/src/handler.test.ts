import { describe, expect, test } from "bun:test";
import { ConflictException } from "@aws-sdk/client-cloudfront-keyvaluestore";
import { S3Client } from "@aws-sdk/client-s3";
import {
  AppDatabaseError,
  createAppDatabaseControl,
  type AppDatabaseControl,
} from "@deployments-ai/app-database";
import { createAppsDatabaseHandler } from "./handler.ts";
import { keyValueStoreSlugDirectory } from "./key-value-store.ts";
import { s3AppObjectStore } from "./s3-app-object-store.ts";

const APP_ID = "01J9Z3NDEKTSV4RRFFQ69G5FAV";

function harness(override: Partial<AppDatabaseControl> = {}) {
  const calls: unknown[] = [];
  const logged: unknown[] = [];
  let closed = 0;
  const record =
    (op: string) =>
    async (input: unknown): Promise<never> => {
      calls.push({ input, op });
      return { op } as never;
    };
  const control: AppDatabaseControl = {
    close: async () => {
      closed += 1;
    },
    describe: record("describe"),
    erase: record("erase"),
    exportTables: record("exportTables"),
    migrate: record("migrate"),
    provision: record("provision"),
    query: record("query"),
    ...override,
  };
  const handler = createAppsDatabaseHandler({
    bucket: "apps-bucket",
    logError: (entry) => logged.push(entry),
    openControl: () => control,
  });
  return { calls, closed: () => closed, handler, logged };
}

describe("apps-database handler", () => {
  test("answers with the operation's value and closes its session", async () => {
    const { calls, closed, handler } = harness();
    const response = await handler({
      appId: APP_ID,
      exportId: "01J9Z3NDEKTSV4RRFFQ69G5FAW",
      op: "export",
    });
    const observed: unknown = { calls, closed: closed(), response };
    expect(observed).toEqual({
      calls: [
        {
          input: { appId: APP_ID, bucket: "apps-bucket", exportId: "01J9Z3NDEKTSV4RRFFQ69G5FAW" },
          op: "exportTables",
        },
      ],
      closed: 1,
      response: { ok: true, value: { op: "exportTables" } },
    });
  });

  test("passes each operation its parsed input", async () => {
    const { calls, handler } = harness();
    await handler({ appId: APP_ID, op: "provision", slug: "orders-app" });
    await handler({
      appId: APP_ID,
      description: "d",
      idempotencyKey: "k",
      op: "migrate",
      sql: "SELECT 1",
    });
    await handler({ appId: APP_ID, maxRows: 10, op: "query", sql: "SELECT 1" });
    await handler({ appId: APP_ID, op: "describe" });
    await handler({ appId: APP_ID, op: "erase", slug: "orders-app" });
    expect(calls).toEqual([
      { input: { appId: APP_ID, slug: "orders-app" }, op: "provision" },
      {
        input: { appId: APP_ID, description: "d", idempotencyKey: "k", sql: "SELECT 1" },
        op: "migrate",
      },
      { input: { appId: APP_ID, maxRows: 10, sql: "SELECT 1" }, op: "query" },
      { input: APP_ID, op: "describe" },
      {
        input: { appId: APP_ID, bucket: "apps-bucket", slug: "orders-app" },
        op: "erase",
      },
    ]);
  });

  test.each([
    [{ appId: APP_ID.toLowerCase(), op: "describe" }],
    [{ appId: APP_ID, op: "provision", slug: "Bad--Slug" }],
    [{ appId: APP_ID, maxRows: 5000, op: "query", sql: "SELECT 1" }],
    [{ appId: APP_ID, op: "drop-everything" }],
  ])("refuses an invalid request without opening a session: %j", async (event) => {
    const { calls, closed, handler } = harness();
    const response = await handler(event);
    expect({ calls, closed: closed(), code: response.ok ? null : response.error.code }).toEqual({
      calls: [],
      closed: 0,
      code: "invalid_request",
    });
  });

  test("returns a database error with its code and failing statement", async () => {
    const { closed, handler } = harness({
      migrate: async () => {
        throw new AppDatabaseError({
          code: "postgres_error",
          message: 'relation "missing" does not exist',
          statement: "INSERT INTO missing VALUES (1)",
        });
      },
    });
    const response = await handler({
      appId: APP_ID,
      description: "d",
      idempotencyKey: "k",
      op: "migrate",
      sql: "INSERT INTO missing VALUES (1)",
    });
    expect({ closed: closed(), response }).toEqual({
      closed: 1,
      response: {
        error: {
          code: "postgres_error",
          message: 'relation "missing" does not exist',
          statement: "INSERT INTO missing VALUES (1)",
        },
        ok: false,
      },
    });
  });

  test("logs and reports an unexpected failure as internal_error", async () => {
    const { handler, logged } = harness({
      erase: async () => {
        throw new Error("AccessDenied: kvs:DeleteKey");
      },
    });
    const response = await handler({ appId: APP_ID, op: "erase", slug: "orders-app" });
    expect({ logged, response }).toEqual({
      logged: [{ appId: APP_ID, message: "AccessDenied: kvs:DeleteKey", op: "erase" }],
      response: {
        error: { code: "internal_error", message: "AccessDenied: kvs:DeleteKey" },
        ok: false,
      },
    });
  });

  test("answers key_value_store_conflict when every KeyValueStore write conflicts", async () => {
    const conflict = async () => {
      throw new ConflictException({ $metadata: {}, message: "Resource is not in expected state." });
    };
    const logged: unknown[] = [];
    const handler = createAppsDatabaseHandler({
      bucket: "apps-bucket",
      logError: (entry) => logged.push(entry),
      openControl: () =>
        createAppDatabaseControl({
          connections: {
            credentials: async () => "unused",
            host: "127.0.0.1",
            port: 1,
            resumeWaitMs: 0,
            tls: { kind: "disabled" },
          },
          objectStore: s3AppObjectStore(new S3Client({ region: "us-east-2" })),
          slugDirectory: keyValueStoreSlugDirectory(
            { currentEtag: async () => "etag-0", delete: conflict, put: conflict },
            3,
          ),
        }),
    });
    const response = await handler({ appId: APP_ID, op: "erase", slug: "orders-app" });
    expect({ logged, response }).toEqual({
      logged: [],
      response: {
        error: {
          code: "key_value_store_conflict",
          message:
            "The KeyValueStore entry for orders-app still conflicted with other writes after 3 attempts; retry the request.",
        },
        ok: false,
      },
    });
  });
});
