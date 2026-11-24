import {
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
  type StartQueryExecutionCommandInput,
  StopQueryExecutionCommand,
} from "@aws-sdk/client-athena";
import type { AthenaCommand, AthenaSender, QueryClock, QueryColumn } from "./athena-query.ts";
import type { EventAnalyticsCoordinates } from "./coordinates.ts";

export const testCoordinates: EventAnalyticsCoordinates = {
  catalog: "s3tablescatalog/semantic-events",
  database: "semantic_events",
  region: "us-east-2",
  table: "events",
  workgroup: "semantic-events",
};

export const fixedNow = new Date("2026-10-16T12:00:00.000Z");

export interface FakeQueryOutcome {
  readonly columns: readonly QueryColumn[];
  readonly failureReason?: string;
  readonly pageSize?: number;
  readonly rows: readonly (readonly (string | null)[])[];
  readonly scannedBytes?: number;
  /** States GetQueryExecution reports before SUCCEEDED, or before FAILED with a failure reason. */
  readonly pendingStates?: readonly string[];
}

interface Execution {
  readonly outcome: FakeQueryOutcome;
  readonly pending: string[];
}

/** An in-memory Athena that answers the four commands the operator tooling sends. */
export class FakeAthena implements AthenaSender {
  readonly commands: AthenaCommand[] = [];
  readonly started: StartQueryExecutionCommandInput[] = [];
  readonly stopped: string[] = [];
  readonly #executions = new Map<string, Execution>();
  readonly #outcome: (sql: string) => FakeQueryOutcome;

  constructor(outcome: (sql: string) => FakeQueryOutcome) {
    this.#outcome = outcome;
  }

  #execution(id: string | undefined) {
    const execution = id === undefined ? undefined : this.#executions.get(id);
    if (!execution) throw new Error(`Unknown query execution ${String(id)}.`);
    return execution;
  }

  async send(command: AthenaCommand): Promise<unknown> {
    this.commands.push(command);
    if (command instanceof StartQueryExecutionCommand) {
      const id = `query-${String(this.started.length + 1)}`;
      this.started.push(command.input);
      const outcome = this.#outcome(command.input.QueryString ?? "");
      this.#executions.set(id, { outcome, pending: [...(outcome.pendingStates ?? [])] });
      return { $metadata: {}, QueryExecutionId: id };
    }
    if (command instanceof GetQueryExecutionCommand) {
      const execution = this.#execution(command.input.QueryExecutionId);
      const pending = execution.pending.shift();
      const failed = execution.outcome.failureReason;
      return {
        $metadata: {},
        QueryExecution: {
          Statistics: {
            DataScannedInBytes: execution.outcome.scannedBytes ?? 1_048_576,
            EngineExecutionTimeInMillis: 420,
          },
          Status:
            pending !== undefined
              ? { State: pending }
              : failed === undefined
                ? { State: "SUCCEEDED" }
                : { State: "FAILED", StateChangeReason: failed },
        },
      };
    }
    if (command instanceof GetQueryResultsCommand) {
      const { outcome } = this.#execution(command.input.QueryExecutionId);
      const pageSize = outcome.pageSize ?? 1000;
      const offset = Number(command.input.NextToken ?? "0");
      const rows = [
        { Data: outcome.columns.map((column) => ({ VarCharValue: column.name })) },
        ...outcome.rows.map((row) => ({
          Data: row.map((value) => (value === null ? {} : { VarCharValue: value })),
        })),
      ];
      const end = offset + pageSize;
      return {
        $metadata: {},
        NextToken: end < rows.length ? String(end) : undefined,
        ResultSet: {
          ResultSetMetadata: {
            ColumnInfo: outcome.columns.map((column) => ({ Name: column.name, Type: column.type })),
          },
          Rows: rows.slice(offset, end),
        },
      };
    }
    if (command instanceof StopQueryExecutionCommand) {
      this.stopped.push(command.input.QueryExecutionId ?? "");
      return { $metadata: {} };
    }
    throw new Error("Unexpected Athena command.");
  }
}

/** A clock whose sleeps advance time instantly. */
export function fakeClock(start = fixedNow.getTime()): QueryClock & { readonly slept: number[] } {
  let now = start;
  const slept: number[] = [];
  return {
    now: () => now,
    sleep: async (milliseconds) => {
      slept.push(milliseconds);
      now += milliseconds;
    },
    slept,
  };
}

export const eventColumns: readonly QueryColumn[] = [
  { name: "event_id", type: "varchar" },
  { name: "event_type", type: "varchar" },
  { name: "organization_id", type: "varchar" },
  { name: "aggregate_version", type: "bigint" },
  { name: "occurred_at", type: "varchar" },
  { name: "trace_id", type: "varchar" },
];

export const eventRows = [
  [
    "01JA0000000000000000000010",
    "agent.created",
    "01JA0000000000000000000001",
    "1",
    "2026-10-16T11:59:00.000Z",
    null,
  ],
  [
    "01JA0000000000000000000011",
    "agent.updated",
    "01JA0000000000000000000001",
    "2",
    "2026-10-16T11:58:00.000Z",
    "trace-1",
  ],
] as const;
