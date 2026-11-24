import {
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
  StopQueryExecutionCommand,
} from "@aws-sdk/client-athena";
import { Schema } from "effect";
import type { EventAnalyticsCoordinates } from "./coordinates.ts";

export type AthenaCommand =
  | GetQueryExecutionCommand
  | GetQueryResultsCommand
  | StartQueryExecutionCommand
  | StopQueryExecutionCommand;

/** The slice of the Athena client the operator tooling uses; `AthenaClient` satisfies it. */
export interface AthenaSender {
  send(command: AthenaCommand): Promise<unknown>;
}

export interface QueryClock {
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export const systemClock: QueryClock = {
  now: () => Date.now(),
  sleep: (milliseconds) => Bun.sleep(milliseconds),
};

export const DEFAULT_QUERY_TIMEOUT_MS = 300_000;
const RESULT_PAGE_SIZE = 1000;
const FIRST_POLL_MS = 250;
const MAX_POLL_MS = 2000;

export type QueryValue = boolean | number | string | null;

export interface QueryColumn {
  readonly name: string;
  readonly type: string;
}

export interface QueryStatistics {
  readonly dataScannedBytes: number | null;
  readonly engineExecutionMs: number | null;
  readonly queryExecutionId: string;
}

export interface QueryResult {
  readonly columns: readonly QueryColumn[];
  readonly rows: readonly Readonly<Record<string, QueryValue>>[];
  readonly statistics: QueryStatistics;
  /** True when the query had more rows than the caller asked for. */
  readonly truncated: boolean;
}

const StartOutput = Schema.Struct({ QueryExecutionId: Schema.String });

const ExecutionOutput = Schema.Struct({
  QueryExecution: Schema.Struct({
    Statistics: Schema.optional(
      Schema.Struct({
        DataScannedInBytes: Schema.optional(Schema.Number),
        EngineExecutionTimeInMillis: Schema.optional(Schema.Number),
      }),
    ),
    Status: Schema.Struct({
      State: Schema.String,
      StateChangeReason: Schema.optional(Schema.String),
    }),
  }),
});

const ResultsOutput = Schema.Struct({
  NextToken: Schema.optional(Schema.String),
  ResultSet: Schema.Struct({
    ResultSetMetadata: Schema.Struct({
      ColumnInfo: Schema.Array(Schema.Struct({ Name: Schema.String, Type: Schema.String })),
    }),
    Rows: Schema.Array(
      Schema.Struct({
        Data: Schema.Array(Schema.Struct({ VarCharValue: Schema.optional(Schema.String) })),
      }),
    ),
  }),
});

const decodeStart = Schema.decodeUnknownSync(StartOutput);
const decodeExecution = Schema.decodeUnknownSync(ExecutionOutput);
const decodeResults = Schema.decodeUnknownSync(ResultsOutput);

export class AthenaQueryError extends Error {
  override readonly name = "AthenaQueryError";
}

const INTEGER_TYPES: Readonly<Record<string, true>> = {
  bigint: true,
  integer: true,
  smallint: true,
  tinyint: true,
};
const FLOAT_TYPES: Readonly<Record<string, true>> = { double: true, float: true, real: true };

/** Converts Athena's text cell to JSON: integers that fit, floats, and booleans become values. */
export function cellValue(type: string, text: string | undefined): QueryValue {
  if (text === undefined) return null;
  if (Object.hasOwn(INTEGER_TYPES, type)) {
    const value = Number(text);
    return Number.isSafeInteger(value) ? value : text;
  }
  if (Object.hasOwn(FLOAT_TYPES, type)) {
    const value = Number(text);
    return Number.isFinite(value) ? value : text;
  }
  if (type === "boolean") return text === "true";
  return text;
}

async function awaitCompletion(input: {
  readonly client: AthenaSender;
  readonly clock: QueryClock;
  readonly queryExecutionId: string;
  readonly timeoutMs: number;
}) {
  const deadline = input.clock.now() + input.timeoutMs;
  let delay = FIRST_POLL_MS;
  for (;;) {
    const { QueryExecution } = decodeExecution(
      await input.client.send(
        new GetQueryExecutionCommand({ QueryExecutionId: input.queryExecutionId }),
      ),
    );
    const { State, StateChangeReason } = QueryExecution.Status;
    if (State === "SUCCEEDED") return QueryExecution.Statistics;
    if (State === "FAILED" || State === "CANCELLED") {
      throw new AthenaQueryError(
        `Athena query ${input.queryExecutionId} ${State.toLowerCase()}: ${StateChangeReason ?? "no reason given"}`,
      );
    }
    if (input.clock.now() + delay > deadline) {
      await input.client.send(
        new StopQueryExecutionCommand({ QueryExecutionId: input.queryExecutionId }),
      );
      throw new AthenaQueryError(
        `Athena query ${input.queryExecutionId} did not finish within ${String(input.timeoutMs / 1000)} seconds and was stopped.`,
      );
    }
    await input.clock.sleep(delay);
    delay = Math.min(delay * 2, MAX_POLL_MS);
  }
}

/**
 * Runs one statement in the event analytics workgroup, which enforces its result location and
 * bytes-scanned cutoff, and returns at most `maxRows` rows.
 */
export async function runAthenaQuery(input: {
  readonly client: AthenaSender;
  readonly clock?: QueryClock;
  readonly coordinates: EventAnalyticsCoordinates;
  readonly maxRows: number;
  readonly sql: string;
  readonly timeoutMs?: number;
}): Promise<QueryResult> {
  const { QueryExecutionId: queryExecutionId } = decodeStart(
    await input.client.send(
      new StartQueryExecutionCommand({
        QueryExecutionContext: {
          Catalog: input.coordinates.catalog,
          Database: input.coordinates.database,
        },
        QueryString: input.sql,
        WorkGroup: input.coordinates.workgroup,
      }),
    ),
  );
  const statistics = await awaitCompletion({
    client: input.client,
    clock: input.clock ?? systemClock,
    queryExecutionId,
    timeoutMs: input.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
  });

  let columns: readonly QueryColumn[] = [];
  const rows: Readonly<Record<string, QueryValue>>[] = [];
  let truncated = false;
  let nextToken: string | undefined;
  let firstPage = true;
  do {
    const page = decodeResults(
      await input.client.send(
        new GetQueryResultsCommand({
          MaxResults: RESULT_PAGE_SIZE,
          NextToken: nextToken,
          QueryExecutionId: queryExecutionId,
        }),
      ),
    );
    if (firstPage) {
      columns = page.ResultSet.ResultSetMetadata.ColumnInfo.map(({ Name, Type }) => ({
        name: Name,
        type: Type,
      }));
    }
    // The first row of a SELECT result repeats the column names.
    for (const row of page.ResultSet.Rows.slice(firstPage ? 1 : 0)) {
      if (rows.length === input.maxRows) {
        truncated = true;
        break;
      }
      rows.push(
        Object.fromEntries(
          columns.map((column, index) => [
            column.name,
            cellValue(column.type, row.Data[index]?.VarCharValue),
          ]),
        ),
      );
    }
    firstPage = false;
    nextToken = page.NextToken;
    if (rows.length === input.maxRows && nextToken !== undefined) truncated = true;
  } while (nextToken !== undefined && !truncated);

  return {
    columns,
    rows,
    statistics: {
      dataScannedBytes: statistics?.DataScannedInBytes ?? null,
      engineExecutionMs: statistics?.EngineExecutionTimeInMillis ?? null,
      queryExecutionId,
    },
    truncated,
  };
}
