import { describe, expect, test } from "bun:test";
import {
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
  type AthenaClient,
} from "@aws-sdk/client-athena";
import type { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import type { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
  runObservabilityErasure,
  type ObservabilityErasureConfig,
} from "./observability-erasure.ts";

const ORG = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_ORG = "01BX5ZZKBKACTAV9WEVGEMMVS1";
const OPERATION = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
const THREAD = "01HZY0Q2V3J4K5M6N7P8Q9R0T0";
const SIBLING_THREAD = "01HZY0Q2V3J4K5M6N7P8Q9R0T1";
const RUN = "01HZY0Q2V3J4K5M6N7P8Q9R0V0";
const USAGE_ONLY_RUN = "01HZY0Q2V3J4K5M6N7P8Q9R0V1";
const SIBLING_RUN = "01HZY0Q2V3J4K5M6N7P8Q9R0V2";
const START = Date.parse("2026-10-01T12:00:00.000Z");
const ANCHOR = "2026-10-01T11:45:00.000Z";
const SPANS = '"s3tablescatalog/agent-observability"."agent_observability"."spans"';
const TRACES = '"s3tablescatalog/agent-observability"."agent_observability"."traces"';
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PREDICATE =
  /WHERE organization_id = '([0-9A-Z]{26})'(?: AND (session_id|run_id) IN \(([^)]*)\))?$/u;

const config: ObservabilityErasureConfig = {
  controlTable: "control",
  drain: {
    drainSeconds: 600,
    firehoseFreshnessSeconds: 180,
    firehoseStreams: ["agent-observability-spans"],
    lambdaIteratorAgeSeconds: 120,
    pipelineFunctions: ["agent-observability-projector"],
  },
  hotPlanePollIntervalMs: 5_000,
  hotPlaneRequestTimeoutMs: 45_000,
  iceberg: {
    maxCommitRetries: 3,
    pollIntervalMs: 1_000,
    tables: [
      { name: "spans", reference: SPANS },
      { name: "traces", reference: TRACES },
    ],
    workgroup: "agent-observability-erasure",
  },
  removal: {
    clickhouseNativeBackupDays: 14,
    clickhouseSnapshotDays: 15,
    icebergNoncurrentFileDays: 1,
    icebergSnapshotMaxAgeHours: 24,
    icebergUnreferencedFileDays: 1,
  },
  safetyMarginMs: 60_000,
};

interface Row {
  readonly organization_id: string;
  readonly run_id?: string;
  readonly session_id?: string;
}

interface Operation {
  readonly kind: string;
  readonly organizationId?: string;
  readonly status: string;
}

function ulid(index: number) {
  let suffix = "";
  for (let value = index, position = 0; position < 4; position += 1, value >>= 5) {
    suffix = CROCKFORD[value & 31] + suffix;
  }
  return `01J0000000000000000000${suffix}`;
}

function harness(tables: Record<string, Row[]>, operation: Operation | null) {
  const queries: { readonly sql: string; readonly token: string; count?: number }[] = [];
  const keysRead: string[] = [];
  const hotPlaneScopes: unknown[] = [];
  const metricCalls: unknown[] = [];
  const clock = { now: START, remaining: 900_000 };

  const matches = (row: Row, sql: string) => {
    const [, organizationId, column, list] = PREDICATE.exec(sql) ?? [];
    if (!organizationId) throw new Error(`Unexpected Athena statement: ${sql}`);
    if (row.organization_id !== organizationId) return false;
    if (!column) return true;
    const ids = list!.split(", ").map((literal) => literal.slice(1, -1));
    return ids.includes((column === "session_id" ? row.session_id : row.run_id) ?? "");
  };
  const tableOf = (sql: string) => (sql.includes(SPANS) ? SPANS : TRACES);

  const athena = {
    send: async (command: unknown) => {
      if (command instanceof StartQueryExecutionCommand) {
        const sql = command.input.QueryString!;
        const token = command.input.ClientRequestToken!;
        const existing = queries.findIndex((query) => query.token === token);
        if (existing >= 0) return { QueryExecutionId: `q${existing}` };
        const rows = tables[tableOf(sql)]!;
        if (sql.startsWith("DELETE")) {
          tables[tableOf(sql)] = rows.filter((row) => !matches(row, sql));
          queries.push({ sql, token });
        } else {
          queries.push({ count: rows.filter((row) => matches(row, sql)).length, sql, token });
        }
        return { QueryExecutionId: `q${queries.length - 1}` };
      }
      if (command instanceof GetQueryExecutionCommand) {
        return { QueryExecution: { Status: { State: "SUCCEEDED" } } };
      }
      if (command instanceof GetQueryResultsCommand) {
        const query = queries[Number(command.input.QueryExecutionId!.slice(1))]!;
        return {
          ResultSet: {
            Rows: [
              { Data: [{ VarCharValue: "row_count" }] },
              { Data: [{ VarCharValue: String(query.count) }] },
            ],
          },
        };
      }
      throw new Error("Unexpected Athena command.");
    },
  } as unknown as Pick<AthenaClient, "send">;

  const cloudwatch = {
    send: async (command: GetMetricDataCommand) => {
      metricCalls.push(command);
      return {
        MetricDataResults: (command.input.MetricDataQueries ?? []).map((query) => ({
          Id: query.Id,
          StatusCode: "Complete",
          Timestamps: [],
          Values: [],
        })),
      };
    },
  } as unknown as Pick<CloudWatchClient, "send">;

  const dynamodb = {
    send: async (command: GetItemCommand) => {
      const sk = command.input.Key!.sk!.S!;
      keysRead.push(`${command.input.Key!.pk!.S!}|${sk}`);
      if (!operation || sk !== `GOVERNANCE-OPERATION#${OPERATION}`) return {};
      return {
        Item: marshall({
          data: {
            createdAt: "2026-10-01T11:00:00.000Z",
            id: OPERATION,
            idempotencyKey: "erase-thread",
            kind: operation.kind,
            organizationId: operation.organizationId ?? ORG,
            requestedByPrincipalId: "01BX5ZZKBKACTAV9WEVGEMMVS2",
            status: operation.status,
            updatedAt: "2026-10-01T11:00:00.000Z",
            version: 2,
          },
          itemType: "governance-operation",
          pk: `ORG#${ORG}`,
          sk,
        }),
      };
    },
  } as unknown as DynamoDBClient;

  const run = (scope: unknown) =>
    runObservabilityErasure(
      { drainAnchorAt: ANCHOR, operationId: OPERATION, organizationId: ORG, scope },
      config,
      {
        athena,
        cloudwatch,
        dynamodb,
        hotPlane: {
          erase: async (input) => {
            hotPlaneScopes.push(input.scope);
            return {
              rowsDeleted: 4,
              status: "complete",
              verifiedAt: new Date(clock.now).toISOString(),
            };
          },
        },
        now: () => new Date(clock.now),
        remainingTimeMs: () => clock.remaining,
        sleep: async (milliseconds) => {
          clock.now += milliseconds;
          clock.remaining -= milliseconds;
        },
      },
    );

  return { hotPlaneScopes, keysRead, metricCalls, queries, run, tables };
}

function conversationRows(): Record<string, Row[]> {
  return {
    [SPANS]: [
      { organization_id: ORG, run_id: RUN, session_id: THREAD },
      { organization_id: ORG, run_id: USAGE_ONLY_RUN },
      { organization_id: ORG, run_id: SIBLING_RUN, session_id: SIBLING_THREAD },
      { organization_id: OTHER_ORG, run_id: RUN, session_id: THREAD },
    ],
    [TRACES]: [
      { organization_id: ORG, run_id: RUN, session_id: THREAD },
      { organization_id: ORG, run_id: SIBLING_RUN, session_id: SIBLING_THREAD },
    ],
  };
}

const RUNNING_THREAD_ERASURE = { kind: "thread-erasure", status: "running" };
const SCOPE = { kind: "conversation", runIds: [RUN, USAGE_ONLY_RUN], threadIds: [THREAD] };

describe("conversation-scoped observability erasure", () => {
  test("deletes only the scoped threads' and runs' rows of the organization", async () => {
    const fixture = harness(conversationRows(), RUNNING_THREAD_ERASURE);

    const result = await fixture.run(SCOPE);

    expect(fixture.tables).toEqual({
      [SPANS]: [
        { organization_id: ORG, run_id: SIBLING_RUN, session_id: SIBLING_THREAD },
        { organization_id: OTHER_ORG, run_id: RUN, session_id: THREAD },
      ],
      [TRACES]: [{ organization_id: ORG, run_id: SIBLING_RUN, session_id: SIBLING_THREAD }],
    });
    expect(result).toMatchObject({
      receipt: {
        clickhouse: { rowsDeleted: 4 },
        iceberg: {
          rowsDeleted: 3,
          tables: [
            { rowsDeleted: 2, table: "spans" },
            { rowsDeleted: 1, table: "traces" },
          ],
        },
        operationId: OPERATION,
      },
      status: "complete",
    });
    expect(fixture.hotPlaneScopes).toEqual([SCOPE]);
    expect(fixture.keysRead).toEqual([`ORG#${ORG}|GOVERNANCE-OPERATION#${OPERATION}`]);
    expect(fixture.queries.find((query) => query.sql.startsWith("DELETE"))?.sql).toBe(
      `DELETE FROM ${SPANS} WHERE organization_id = '${ORG}' AND session_id IN ('${THREAD}')`,
    );
  });

  test("refuses to purge without a running thread or end-user erasure operation", async () => {
    for (const operation of [
      null,
      { kind: "tenant-erasure", status: "running" },
      { kind: "end-user-erasure", status: "completed" },
      { kind: "thread-erasure", status: "pending" },
      { ...RUNNING_THREAD_ERASURE, organizationId: OTHER_ORG },
    ]) {
      const fixture = harness(conversationRows(), operation);

      const failure = await fixture.run(SCOPE).then(
        () => "resolved",
        (cause: Error) => cause.message,
      );
      expect(failure).toBe(
        `Operation ${OPERATION} is not a running conversation erasure of organization ${ORG}.`,
      );
      expect(fixture.metricCalls).toEqual([]);
      expect(fixture.hotPlaneScopes).toEqual([]);
      expect(fixture.queries).toEqual([]);
      expect(fixture.tables).toEqual(conversationRows());
    }
  });

  test("an end-user erasure purges large scopes in batches of 1,000 identifiers", async () => {
    const runIds = Array.from({ length: 1_001 }, (_, index) => ulid(index));
    const fixture = harness(
      {
        [SPANS]: [
          { organization_id: ORG, run_id: runIds[0]! },
          { organization_id: ORG, run_id: runIds[1_000]! },
          { organization_id: ORG, run_id: SIBLING_RUN },
        ],
        [TRACES]: [],
      },
      { kind: "end-user-erasure", status: "running" },
    );

    const result = await fixture.run({ kind: "conversation", runIds, threadIds: [] });

    expect(result).toMatchObject({
      receipt: { iceberg: { rowsDeleted: 2 } },
      status: "complete",
    });
    expect(fixture.tables[SPANS]).toEqual([{ organization_id: ORG, run_id: SIBLING_RUN }]);
    const deletes = fixture.queries.filter((query) => query.sql.startsWith("DELETE"));
    expect(deletes.map((query) => query.sql.split("', '").length)).toEqual([1_000, 1]);
    expect(deletes.map((query) => query.token)).toEqual([
      `observability-erasure-${OPERATION}-spans-runs-0-2`,
      `observability-erasure-${OPERATION}-spans-runs-1-2`,
    ]);
  });

  test("rejects scope identifiers that are not ULIDs before any read", async () => {
    const fixture = harness(conversationRows(), RUNNING_THREAD_ERASURE);

    const failure = await fixture
      .run({ kind: "conversation", runIds: ["x') OR ('1'='1"], threadIds: [] })
      .then(
        () => "resolved",
        (cause: Error) => cause.message,
      );
    expect(failure).toBe('Expected a 26-character ULID.\n  at ["scope"]["runIds"][0]');
    expect(fixture.keysRead).toEqual([]);
    expect(fixture.queries).toEqual([]);
  });
});
