/* eslint-disable no-await-in-loop -- a resuming cluster is retried sequentially by design. */
import { Schema } from "effect";
import { type CommandRunner, CommandFailure, log } from "./process.ts";
import type { TerraformOutputs } from "./terraform.ts";

const resumeRetryDelayMs = 10_000;
const resumeBudgetMs = 2 * 60_000;
const resumeAttempts = resumeBudgetMs / resumeRetryDelayMs + 1;

export type AppDatabaseName = "postgres" | "app_template";

export interface AppDatabaseExecutor {
  execute(database: AppDatabaseName, sql: string): Promise<ReadonlyArray<Record<string, unknown>>>;
}

const decodeStatementResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      formattedRecords: Schema.optionalKey(
        Schema.fromJsonString(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
      ),
    }),
  ),
);

export function dataApiExecutor(input: {
  readonly clusterArn: string;
  readonly region: string;
  readonly retryDelayMs?: number;
  readonly run: CommandRunner;
  readonly secretArn: string;
}): AppDatabaseExecutor {
  return {
    async execute(database, sql) {
      const command = [
        "aws",
        "rds-data",
        "execute-statement",
        "--region",
        input.region,
        "--resource-arn",
        input.clusterArn,
        "--secret-arn",
        input.secretArn,
        "--database",
        database,
        "--sql",
        sql,
        "--format-records-as",
        "JSON",
        "--output",
        "json",
        "--no-cli-pager",
      ];
      for (let attempt = 1; ; attempt += 1) {
        try {
          return decodeStatementResult(await input.run(command)).formattedRecords ?? [];
        } catch (error) {
          const resuming =
            error instanceof CommandFailure && error.stderr.includes("DatabaseResumingException");
          if (!resuming || attempt === resumeAttempts) {
            const [statement = ""] = sql.trim().split("\n", 1);
            throw new Error(`App database bootstrap failed in ${database} at "${statement}".`, {
              cause: error,
            });
          }
        }
        log(`app database cluster is resuming; retrying ${database} statement`);
        await Bun.sleep(input.retryDelayMs ?? resumeRetryDelayMs);
      }
    },
  };
}

function requiredField(value: object, field: string) {
  const nested: unknown = Reflect.get(value, field);
  if (typeof nested !== "string" || !nested) {
    throw new Error(`OpenTofu output app_runtime.${field} is empty.`);
  }
  return nested;
}

export async function bootstrapAppDatabase(input: {
  readonly outputs: TerraformOutputs;
  readonly region: string;
  readonly run: CommandRunner;
  readonly runBootstrap: (executor: AppDatabaseExecutor) => Promise<unknown>;
}) {
  const runtime = input.outputs.app_runtime;
  if (runtime === null || typeof runtime !== "object") {
    throw new Error("OpenTofu output app_runtime must be an object.");
  }
  await input.runBootstrap(
    dataApiExecutor({
      clusterArn: requiredField(runtime, "cluster_arn"),
      region: input.region,
      run: input.run,
      secretArn: requiredField(runtime, "master_user_secret_arn"),
    }),
  );
  log("Bootstrapped the app database cluster.");
}
