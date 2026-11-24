import { describe, expect, test } from "bun:test";
import { bootstrapAppDatabase, dataApiExecutor } from "./app-database-bootstrap.ts";
import { CommandFailure, type CommandRunner, describeError } from "./process.ts";

const clusterArn = "arn:aws:rds:us-east-2:123456789012:cluster:apps";
const secretArn = "arn:aws:secretsmanager:us-east-2:123456789012:secret:rds!cluster-apps";
const dataApiCommand = ["aws", "rds-data", "execute-statement"];
const resuming = () =>
  new CommandFailure(
    "\nAn error occurred (DatabaseResumingException) when calling the ExecuteStatement operation: The Aurora DB instance is resuming after being auto-paused. Please wait a few seconds and try again.\n",
    dataApiCommand,
  );

function fakeDataApi(responses: readonly (CommandFailure | string)[]) {
  const commands: string[][] = [];
  const pending = [...responses];
  const run: CommandRunner = async (command) => {
    commands.push([...command]);
    const response = pending.shift();
    if (response === undefined) throw new Error("Unexpected Data API call.");
    if (response instanceof CommandFailure) throw response;
    return response;
  };
  return { commands, run };
}

function executor(run: CommandRunner) {
  return dataApiExecutor({ clusterArn, region: "us-east-2", retryDelayMs: 0, run, secretArn });
}

describe("app database Data API executor", () => {
  test("runs a statement as the master user and returns its JSON-formatted rows", async () => {
    const api = fakeDataApi([
      JSON.stringify({
        formattedRecords: '[{"datname":"app_template","owned":true},{"datname":"postgres"}]',
        numberOfRecordsUpdated: 0,
      }),
    ]);

    const rows = await executor(api.run).execute("postgres", "SELECT datname FROM pg_database");

    expect(rows).toEqual([{ datname: "app_template", owned: true }, { datname: "postgres" }]);
    expect(api.commands).toEqual([
      [
        "aws",
        "rds-data",
        "execute-statement",
        "--region",
        "us-east-2",
        "--resource-arn",
        clusterArn,
        "--secret-arn",
        secretArn,
        "--database",
        "postgres",
        "--sql",
        "SELECT datname FROM pg_database",
        "--format-records-as",
        "JSON",
        "--output",
        "json",
        "--no-cli-pager",
      ],
    ]);
  });

  test("returns no rows for a statement without a result set", async () => {
    const api = fakeDataApi([JSON.stringify({ generatedFields: [], numberOfRecordsUpdated: 0 })]);
    expect(await executor(api.run).execute("app_template", "CREATE EXTENSION pgcrypto")).toEqual(
      [],
    );
  });

  test("retries while the auto-paused cluster resumes", async () => {
    const api = fakeDataApi([resuming(), resuming(), JSON.stringify({ formattedRecords: "[]" })]);
    expect(await executor(api.run).execute("postgres", "SELECT 1")).toEqual([]);
    expect(api.commands).toHaveLength(3);
  });

  test("stops retrying a cluster that never resumes", async () => {
    const api = fakeDataApi(Array.from({ length: 14 }, resuming));
    const failure = await executor(api.run)
      .execute("postgres", "SELECT 1")
      .catch((error: unknown) => error);
    expect(describeError(failure, "single-line")).toContain("DatabaseResumingException");
    expect(api.commands).toHaveLength(13);
  });

  test("fails any other error at once, naming the database and statement", async () => {
    const api = fakeDataApi([
      new CommandFailure(
        'An error occurred (BadRequestException) when calling the ExecuteStatement operation: ERROR: permission denied to create role "app_owner"',
        dataApiCommand,
      ),
    ]);
    const failure = await executor(api.run)
      .execute("app_template", "CREATE ROLE app_owner\n  NOLOGIN")
      .catch((error: unknown) => error);
    expect(describeError(failure, "single-line")).toBe(
      'App database bootstrap failed in app_template at "CREATE ROLE app_owner". Caused by: aws rds-data execute-statement failed: An error occurred (BadRequestException) when calling the ExecuteStatement operation: ERROR: permission denied to create role "app_owner"',
    );
    expect(api.commands).toHaveLength(1);
  });
});

describe("app database cluster bootstrap", () => {
  test("drives the bootstrap through the applied cluster and master secret", async () => {
    const api = fakeDataApi([JSON.stringify({ formattedRecords: '[{"ready":1}]' })]);
    const results: unknown[] = [];

    await bootstrapAppDatabase({
      outputs: {
        app_runtime: {
          cluster_arn: clusterArn,
          database_function_name: "apps-database",
          master_user_secret_arn: secretArn,
        },
      },
      region: "us-east-2",
      run: api.run,
      runBootstrap: async (bound) => {
        results.push(await bound.execute("app_template", "SELECT 1 AS ready"));
      },
    });

    expect(results).toEqual([[{ ready: 1 }]]);
    expect(api.commands[0]?.slice(5, 9)).toEqual([
      "--resource-arn",
      clusterArn,
      "--secret-arn",
      secretArn,
    ]);
  });

  test("fails before any statement when the applied cluster output is incomplete", async () => {
    const api = fakeDataApi([]);
    expect(
      bootstrapAppDatabase({
        outputs: { app_runtime: { cluster_arn: clusterArn } },
        region: "us-east-2",
        run: api.run,
        runBootstrap: async (bound) => bound.execute("postgres", "SELECT 1"),
      }),
    ).rejects.toThrow("OpenTofu output app_runtime.master_user_secret_arn is empty.");
    expect(api.commands).toEqual([]);
  });
});
