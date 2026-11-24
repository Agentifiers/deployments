import type { InvokeCommand } from "@aws-sdk/client-lambda";
import { describe, expect, test } from "bun:test";
import { APP_ID, appRecord } from "./app-record.fixture.ts";
import { appsRuntimeFromEnvironment, lambdaAppsDatabase } from "./apps-database-client.ts";
import { AppsProblem } from "./apps-problem.ts";

const EXPORT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FD9";

function lambda(answer: { readonly FunctionError?: string; readonly payload?: unknown }) {
  const payloads: unknown[] = [];
  const appsDatabase = lambdaAppsDatabase({
    client: {
      send: async (command: InvokeCommand) => {
        const payload = command.input.Payload;
        if (!(payload instanceof Uint8Array)) throw new Error("The client sends bytes.");
        payloads.push({
          functionName: command.input.FunctionName,
          payload: JSON.parse(new TextDecoder().decode(payload)),
        });
        return {
          ...(answer.FunctionError ? { FunctionError: answer.FunctionError } : {}),
          Payload: new TextEncoder().encode(JSON.stringify(answer.payload ?? null)),
        };
      },
    },
    functionName: "apps-database",
  });
  return { appsDatabase, payloads };
}

async function failure(work: Promise<unknown>) {
  return work.then(
    () => "resolved",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

function problem(work: Promise<unknown>) {
  return work.then(
    () => "resolved",
    (error: unknown) =>
      error instanceof AppsProblem ? [error.status, error.code, error.message] : error,
  );
}

const DATABASE_STARTING = [
  503,
  "database_unavailable",
  "The app's database is starting; retry in a few seconds.",
];

describe("apps-database Lambda client", () => {
  test("sends the erase and export requests and returns the parsed export", async () => {
    const erase = lambda({ payload: { ok: true, value: { appId: APP_ID } } });
    const exported = lambda({
      payload: {
        ok: true,
        value: {
          objects: [
            { key: `apps/${APP_ID}/exports/${EXPORT_ID}/orders.csv`, rows: 3, table: "orders" },
          ],
        },
      },
    });

    await erase.appsDatabase.erase(appRecord());
    const tables = await exported.appsDatabase.exportTables({
      app: appRecord(),
      exportId: EXPORT_ID,
    });

    expect({ erase: erase.payloads, export: exported.payloads, tables }).toEqual({
      erase: [
        { functionName: "apps-database", payload: { appId: APP_ID, op: "erase", slug: "payroll" } },
      ],
      export: [
        {
          functionName: "apps-database",
          payload: { appId: APP_ID, exportId: EXPORT_ID, op: "export" },
        },
      ],
      tables: {
        objects: [
          { key: `apps/${APP_ID}/exports/${EXPORT_ID}/orders.csv`, rows: 3, table: "orders" },
        ],
      },
    });
  });

  test("turns a refused operation or a crashed function into an error", async () => {
    const refused = lambda({
      payload: {
        error: { code: "postgres_error", message: "permission denied for database." },
        ok: false,
      },
    });
    const crashed = lambda({ FunctionError: "Unhandled" });

    expect({
      crashed: await failure(crashed.appsDatabase.erase(appRecord())),
      refused: await failure(refused.appsDatabase.erase(appRecord())),
    }).toEqual({
      crashed: "The apps-database function failed (Unhandled).",
      refused:
        "The apps-database erase failed with postgres_error: permission denied for database.",
    });
  });

  test("answers a retryable 503 when the invoke outlives its deadline", async () => {
    const appsDatabase = lambdaAppsDatabase({
      client: {
        send: (_command, handlerOptions) => {
          const { promise, reject } = Promise.withResolvers<never>();
          handlerOptions.abortSignal?.addEventListener("abort", () => {
            reject(new Error("Request aborted"));
          });
          return promise;
        },
      },
      deadlineMs: 5,
      functionName: "apps-database",
    });

    expect(await problem(appsDatabase.erase(appRecord()))).toEqual(DATABASE_STARTING);
  });

  test("answers the same retryable 503 when the database is still resuming", async () => {
    const resuming = lambda({
      payload: {
        error: { code: "database_unavailable", message: "The database is resuming." },
        ok: false,
      },
    });

    expect(await problem(resuming.appsDatabase.erase(appRecord()))).toEqual(DATABASE_STARTING);
  });

  test("reads the runtime configuration only when both names are set", () => {
    expect(
      appsRuntimeFromEnvironment({
        APPS_BUCKET: " deployments-ai-apps ",
        APPS_DATABASE_FUNCTION_NAME: "apps-database",
      }),
    ).toEqual({ bucket: "deployments-ai-apps", functionName: "apps-database" });
    expect(appsRuntimeFromEnvironment({})).toBeUndefined();
    expect(() => appsRuntimeFromEnvironment({ APPS_BUCKET: "deployments-ai-apps" })).toThrow(
      "APPS_BUCKET and APPS_DATABASE_FUNCTION_NAME must be set together.",
    );
  });
});
