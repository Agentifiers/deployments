import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { AthenaClient } from "@aws-sdk/client-athena";
import type { AthenaSender, QueryClock } from "./athena-query.ts";
import { coordinateOptions, resolveCoordinates } from "./coordinates.ts";
import { createEventAnalytics, type RanQuery } from "./event-analytics.ts";
import { formatQueryText, formatSchemaText, queryDocument } from "./output.ts";

export const USAGE = `Usage: bun run events -- <command> [options]

Query the semantic event log (internal operator analytics) with your own AWS credentials.
The log holds every tenant's events; it is for platform operators only.

Commands:
  recent           Newest events, one row per event_id
  counts           Distinct events per event type, busiest first
  sql <query>      Run one read-only SELECT or WITH statement; the table is named events
  schema           Show the table's columns and how to query it (runs no query)

Filters for recent and counts:
  --organization <ulid>   Only this tenant organization
  --type <event-type>     Only this event type; end it with * to match a prefix
  --since <time>          Window start: 30m, 24h, 7d, or an ISO 8601 date or time (default 24h)
  --until <time>          Window end (default now)
  --limit <n>             Rows to return, 1-1000 (default 50 for recent, 100 for counts)
  --payload               recent only: include payload_json

Options for sql:
  --file <path>           Read the statement from a file instead of the argument
  --max-rows <n>          Rows to return, 1-1000 (default 100)

Output:
  --json                  Print JSON instead of a table

Where to query (flags, then DEPLOYMENTS_AI_EVENT_ANALYTICS_<NAME> variables, then defaults):
  --root <dir>            Read the event_analytics_athena output of an initialized OpenTofu root
  --region <region>       AWS Region (defaults to the AWS SDK's region resolution)
  --workgroup <name>      Athena workgroup (default semantic-events)
  --catalog <name>        Catalog (default s3tablescatalog/semantic-events)
  --database <name>       Database (default semantic_events)
  --table <name>          Table (default events)
`;

export interface CliEnvironment {
  readonly clock?: QueryClock;
  readonly createClient: (region: string | undefined) => AthenaSender;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readOutput?: (root: string, name: string) => unknown;
  readonly stderr: (text: string) => void;
  readonly stdout: (text: string) => void;
}

function parseCli(args: readonly string[]) {
  return parseArgs({
    allowPositionals: true,
    args: [...args],
    options: {
      ...coordinateOptions,
      file: { type: "string" },
      help: { short: "h", type: "boolean" },
      json: { type: "boolean" },
      limit: { type: "string" },
      "max-rows": { type: "string" },
      organization: { type: "string" },
      payload: { type: "boolean" },
      since: { type: "string" },
      type: { type: "string" },
      until: { type: "string" },
    },
    strict: true,
  });
}

interface WindowFlags {
  readonly limit?: string | undefined;
  readonly organization?: string | undefined;
  readonly since?: string | undefined;
  readonly type?: string | undefined;
  readonly until?: string | undefined;
}

function windowRequest(values: WindowFlags) {
  return {
    ...(values.organization === undefined ? {} : { organization_id: values.organization }),
    ...(values.type === undefined ? {} : { event_type: values.type }),
    ...(values.since === undefined ? {} : { since: values.since }),
    ...(values.until === undefined ? {} : { until: values.until }),
    ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
  };
}

async function statement(positionals: readonly string[], file: string | undefined) {
  if (file !== undefined) {
    if (positionals.length > 1)
      throw new Error("Pass the statement as an argument or --file, not both.");
    return readFile(file, "utf8");
  }
  const [sql, ...extra] = positionals.slice(1);
  if (sql === undefined || extra.length > 0) {
    throw new Error(
      'sql takes one quoted statement, for example: bun run events -- sql "SELECT 1"',
    );
  }
  return sql;
}

/** Runs one CLI invocation and returns its exit code. */
export async function runCli(args: readonly string[], environment: CliEnvironment) {
  try {
    const { positionals, values } = parseCli(args);
    const [command] = positionals;
    if (values.help === true || command === undefined || command === "help") {
      environment.stdout(USAGE);
      return command === undefined && values.help !== true ? 1 : 0;
    }
    if (command !== "sql" && positionals.length > 1) {
      throw new Error(`${command} takes no arguments; got ${positionals.slice(1).join(" ")}.`);
    }
    const coordinates = resolveCoordinates({
      env: environment.env,
      flags: values,
      ...(environment.readOutput === undefined ? {} : { readOutput: environment.readOutput }),
    });
    const analytics = createEventAnalytics({
      client: environment.createClient(coordinates.region),
      coordinates,
      ...(environment.clock === undefined ? {} : { clock: environment.clock }),
    });
    const json = values.json === true;
    if (command === "schema") {
      const schema = analytics.describeSchema();
      environment.stdout(json ? `${JSON.stringify(schema, null, 2)}\n` : formatSchemaText(schema));
      return 0;
    }
    let result: RanQuery;
    if (command === "recent") {
      result = await analytics.recentEvents({
        ...windowRequest(values),
        ...(values.payload === true ? { include_payload: true } : {}),
      });
    } else if (command === "counts") {
      result = await analytics.eventTypeCounts(windowRequest(values));
    } else if (command === "sql") {
      result = await analytics.runQuery({
        sql: await statement(positionals, values.file),
        ...(values["max-rows"] === undefined ? {} : { max_rows: Number(values["max-rows"]) }),
      });
    } else {
      throw new Error(`Unknown command ${command}. Run bun run events -- help.`);
    }
    environment.stdout(
      json ? `${JSON.stringify(queryDocument(result, {}), null, 2)}\n` : formatQueryText(result),
    );
    return 0;
  } catch (error) {
    environment.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2), {
    createClient: (region) => new AthenaClient(region === undefined ? {} : { region }),
    env: process.env,
    stderr: (text) => process.stderr.write(text),
    stdout: (text) => process.stdout.write(text),
  });
}
