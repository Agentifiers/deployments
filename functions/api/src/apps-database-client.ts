import { InvokeCommand } from "@aws-sdk/client-lambda";
import {
  AppsDatabaseRequest,
  VISITOR_DATABASE_LAYOUT,
} from "@deployments-ai/app-database/protocol";
import type { AppDatabaseConvergence, AppRecord } from "@deployments-ai/db";
import { Schema } from "effect";
import { AppsProblem } from "./apps-problem.ts";

export const APPS_RUNTIME_ENV = {
  bucket: "APPS_BUCKET",
  functionName: "APPS_DATABASE_FUNCTION_NAME",
} as const;

const ExportedTables = Schema.Struct({
  objects: Schema.Array(
    Schema.Struct({ key: Schema.String, rows: Schema.Number, table: Schema.String }),
  ),
});

export interface AppsDatabase {
  readonly convergence: AppDatabaseConvergence;
  readonly erase: (app: AppRecord) => Promise<void>;
  readonly exportTables: (input: {
    readonly app: AppRecord;
    readonly exportId: string;
  }) => Promise<typeof ExportedTables.Type>;
}

const decodeRequest = Schema.decodeUnknownSync(AppsDatabaseRequest);
const decodeEnvelope = Schema.decodeUnknownSync(
  Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
    Schema.Struct({
      error: Schema.Struct({ code: Schema.String, message: Schema.String }),
      ok: Schema.Literal(false),
    }),
  ]),
);
const decodeExportedTables = Schema.decodeUnknownSync(ExportedTables);

function databaseStarting() {
  return new AppsProblem(
    503,
    "database_unavailable",
    "The app's database is starting; retry in a few seconds.",
  );
}

export function lambdaAppsDatabase(options: {
  readonly client: {
    readonly send: (
      command: InvokeCommand,
      handlerOptions: { readonly abortSignal?: AbortSignal },
    ) => Promise<{
      readonly FunctionError?: string | undefined;
      readonly Payload?: Uint8Array | undefined;
    }>;
  };
  /** Only the wait ends at the deadline; the invoked function runs on to its own timeout. */
  readonly deadlineMs?: number;
  readonly functionName: string;
}): AppsDatabase {
  async function call(request: unknown) {
    const parsed = decodeRequest(request);
    const deadline =
      options.deadlineMs === undefined ? undefined : AbortSignal.timeout(options.deadlineMs);
    const response = await options.client
      .send(
        new InvokeCommand({
          FunctionName: options.functionName,
          InvocationType: "RequestResponse",
          Payload: Buffer.from(JSON.stringify(parsed)),
        }),
        deadline ? { abortSignal: deadline } : {},
      )
      .catch((error: unknown) => {
        throw deadline?.aborted ? databaseStarting() : error;
      });
    if (response.FunctionError) {
      throw new Error(`The apps-database function failed (${response.FunctionError}).`);
    }
    const envelope = decodeEnvelope(JSON.parse(new TextDecoder().decode(response.Payload)));
    if (!envelope.ok) {
      if (envelope.error.code === "database_unavailable") throw databaseStarting();
      throw new Error(
        `The apps-database ${parsed.op} failed with ${envelope.error.code}: ${envelope.error.message}`,
      );
    }
    return envelope.value;
  }
  return {
    convergence: {
      converge: async (app) => {
        await call({ appId: app.data.id, op: "provision", slug: app.data.slug });
      },
      layout: VISITOR_DATABASE_LAYOUT,
    },
    erase: async (app) => {
      await call({ appId: app.data.id, op: "erase", slug: app.data.slug });
    },
    exportTables: async ({ app, exportId }) =>
      decodeExportedTables(await call({ appId: app.data.id, exportId, op: "export" })),
  };
}

export function appsRuntimeFromEnvironment(environment: NodeJS.ProcessEnv) {
  const bucket = environment[APPS_RUNTIME_ENV.bucket]?.trim();
  const functionName = environment[APPS_RUNTIME_ENV.functionName]?.trim();
  if (!bucket && !functionName) return undefined;
  if (!bucket || !functionName) {
    throw new Error(
      `${APPS_RUNTIME_ENV.bucket} and ${APPS_RUNTIME_ENV.functionName} must be set together.`,
    );
  }
  return { bucket, functionName };
}
