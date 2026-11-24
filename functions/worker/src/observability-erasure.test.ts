import { describe, expect, test } from "bun:test";
import {
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
  type AthenaClient,
} from "@aws-sdk/client-athena";
import { GetMetricDataCommand, type CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import type { ObservabilityErasureProgress } from "./observability-erasure-contract.ts";
import type { HotPlaneErasureResult } from "./observability-erasure-hot-plane.ts";
import {
  runObservabilityErasure,
  type ObservabilityErasureConfig,
} from "./observability-erasure.ts";

const ORG = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OPERATION = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
const START = Date.parse("2026-10-01T12:00:00.000Z");
const ANCHOR = "2026-10-01T11:45:00.000Z";
const SPANS = '"s3tablescatalog/agent-observability"."agent_observability"."spans"';
const TRACES = '"s3tablescatalog/agent-observability"."agent_observability"."traces"';

const config: ObservabilityErasureConfig = {
  controlTable: "control",
  drain: {
    drainSeconds: 600,
    firehoseFreshnessSeconds: 180,
    firehoseStreams: ["agent-observability-spans", "agent-observability-traces"],
    lambdaIteratorAgeSeconds: 120,
    pipelineFunctions: [
      "agent-observability-normalizer-execution",
      "agent-observability-normalizer-usage",
      "agent-observability-projector",
    ],
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

interface Query {
  readonly id: string;
  readonly sql: string;
  readonly token: string;
  polls: number;
  outcome?: { readonly count?: number; readonly error?: string };
}

interface HarnessOptions {
  readonly fenceOperationId?: string | null;
  /** Metric values by query ID prefix (lambda0, firehose1, ...). */
  readonly metrics?: Readonly<Record<string, number>>;
  /** Rows per table reference for the organization. */
  readonly rows?: Record<string, number>;
  readonly hotPlane?: HotPlaneErasureResult[] | null;
  /** Commit-conflict failures to inject per statement prefix before success. */
  readonly conflicts?: Record<string, number>;
  /** Polls a query reports RUNNING before settling. */
  readonly runningPolls?: number;
  readonly remainingMs?: number;
}

function harness(options: HarnessOptions = {}) {
  const rows: Record<string, number> = { [SPANS]: 3, [TRACES]: 0, ...options.rows };
  const conflicts = { ...options.conflicts };
  const queries: Query[] = [];
  const hotPlaneCalls: { readonly at: number; readonly drainAnchorAt: string }[] = [];
  const hotPlaneResults = [...(options.hotPlane ?? [])];
  const metricCalls: GetMetricDataCommand[] = [];
  const clock = {
    now: START,
    remaining: options.remainingMs ?? 900_000,
    runningPolls: options.runningPolls ?? 0,
  };

  const settle = (query: Query): NonNullable<Query["outcome"]> => {
    const reference = [SPANS, TRACES].find((candidate) => query.sql.includes(candidate))!;
    if (query.sql.startsWith("SELECT")) return { count: rows[reference] ?? 0 };
    const prefix = query.sql.split(" ")[0]!;
    if ((conflicts[prefix] ?? 0) > 0) {
      conflicts[prefix] = conflicts[prefix]! - 1;
      return { error: "ICEBERG_COMMIT_ERROR: Failed to commit Iceberg update to table" };
    }
    if (prefix === "DELETE") rows[reference] = 0;
    return {};
  };

  const athena = {
    send: async (command: unknown) => {
      if (command instanceof StartQueryExecutionCommand) {
        const token = command.input.ClientRequestToken!;
        const existing = queries.find((query) => query.token === token);
        if (existing) return { QueryExecutionId: existing.id };
        expect(command.input.WorkGroup).toBe("agent-observability-erasure");
        const query = {
          id: `q${queries.length + 1}`,
          polls: 0,
          sql: command.input.QueryString!,
          token,
        };
        queries.push(query);
        return { QueryExecutionId: query.id };
      }
      if (command instanceof GetQueryExecutionCommand) {
        const query = queries.find((candidate) => candidate.id === command.input.QueryExecutionId)!;
        query.polls += 1;
        if (query.polls <= clock.runningPolls) {
          return { QueryExecution: { Status: { State: "RUNNING" } } };
        }
        const outcome = (query.outcome ??= settle(query));
        return outcome.error
          ? {
              QueryExecution: {
                Status: { AthenaError: { ErrorMessage: outcome.error }, State: "FAILED" },
              },
            }
          : { QueryExecution: { Status: { State: "SUCCEEDED" } } };
      }
      if (command instanceof GetQueryResultsCommand) {
        const query = queries.find((candidate) => candidate.id === command.input.QueryExecutionId)!;
        return {
          ResultSet: {
            Rows: [
              { Data: [{ VarCharValue: "row_count" }] },
              { Data: [{ VarCharValue: String(query.outcome!.count) }] },
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
        MetricDataResults: (command.input.MetricDataQueries ?? []).map((query) => {
          const value = options.metrics?.[query.Id!];
          return value === undefined
            ? { Id: query.Id, StatusCode: "Complete", Timestamps: [], Values: [] }
            : {
                Id: query.Id,
                StatusCode: "Complete",
                Timestamps: [new Date(START - 300_000)],
                Values: [value],
              };
        }),
      };
    },
  } as unknown as Pick<CloudWatchClient, "send">;

  const fenceOperationId =
    options.fenceOperationId === undefined ? OPERATION : options.fenceOperationId;
  const dynamodb = {
    send: async () => ({
      Item:
        fenceOperationId === null
          ? undefined
          : marshall({
              data: {
                createdAt: "2026-10-01T11:00:00.000Z",
                id: fenceOperationId,
                operationId: fenceOperationId,
                organizationId: ORG,
              },
              itemType: "erasure-fence",
              pk: `ORG#${ORG}`,
              sk: `ERASURE-FENCE#${ORG}`,
            }),
    }),
  } as unknown as DynamoDBClient;

  const dependencies = {
    athena,
    cloudwatch,
    dynamodb,
    ...(options.hotPlane === null
      ? {}
      : {
          hotPlane: {
            erase: async (input: { readonly drainAnchorAt: string }) => {
              hotPlaneCalls.push({ at: clock.now, drainAnchorAt: input.drainAnchorAt });
              return (
                hotPlaneResults.shift() ?? {
                  rowsDeleted: 0,
                  status: "complete" as const,
                  verifiedAt: new Date(clock.now).toISOString(),
                }
              );
            },
          },
        }),
    now: () => new Date(clock.now),
    remainingTimeMs: () => clock.remaining,
    sleep: async (milliseconds: number) => {
      clock.now += milliseconds;
      clock.remaining -= milliseconds;
    },
  };

  const run = (progress?: ObservabilityErasureProgress, overrides: Record<string, unknown> = {}) =>
    runObservabilityErasure(
      {
        drainAnchorAt: ANCHOR,
        operationId: OPERATION,
        organizationId: ORG,
        ...(progress ? { progress } : {}),
        ...overrides,
      },
      config,
      dependencies,
    );

  return { clock, hotPlaneCalls, metricCalls, queries, rows, run };
}

const statements = (queries: readonly Query[]) => queries.map((query) => query.sql.split(" ")[0]);

describe("observability erasure", () => {
  test("refuses to purge without the operation's erasure fence", async () => {
    for (const fenceOperationId of [null, "01BX5ZZKBKACTAV9WEVGEMMVS0"]) {
      const { hotPlaneCalls, metricCalls, queries, run } = harness({ fenceOperationId });
      expect(run()).rejects.toThrow("is not fenced for erasure operation");
      expect(metricCalls).toHaveLength(0);
      expect(hotPlaneCalls).toHaveLength(0);
      expect(queries).toHaveLength(0);
    }
  });

  test("rejects non-ULID organization IDs before any SQL", async () => {
    const { queries, run } = harness();
    expect(run(undefined, { organizationId: "x' OR '1'='1" })).rejects.toThrow();
    expect(queries).toHaveLength(0);
  });

  test("stays pending while any pipeline stage is still draining", async () => {
    const early = harness();
    expect(await early.run(undefined, { drainAnchorAt: "2026-10-01T11:55:00.000Z" })).toEqual({
      progress: { clickhouse: { pendingRows: 0, rowsDeleted: 0 }, iceberg: { tables: {} } },
      reason: "pipeline_draining",
      status: "pending",
    });
    expect(early.metricCalls).toHaveLength(0);

    for (const metrics of [{ lambda0: 121_000 }, { lambda2: 300_000 }, { firehose1: 181 }]) {
      const { hotPlaneCalls, queries, run } = harness({ metrics });
      const result = await run();
      expect(result).toMatchObject({ reason: "pipeline_draining", status: "pending" });
      expect(hotPlaneCalls).toHaveLength(0);
      expect(queries).toHaveLength(0);
    }

    const healthy = harness({ metrics: { firehose0: 180, lambda1: 119_000 } });
    expect(await healthy.run()).toMatchObject({ status: "complete" });
  });

  test("an idle facts stream does not hold the purge", async () => {
    // Every stage idle: no datapoints at all. The facts stream's growing
    // GetRecords.IteratorAgeMilliseconds is never consulted.
    const { hotPlaneCalls, metricCalls, run } = harness();

    expect(await run()).toMatchObject({ status: "complete" });

    const namespaces = metricCalls.flatMap((call) =>
      (call.input.MetricDataQueries ?? []).map((query) => query.MetricStat?.Metric?.Namespace),
    );
    expect(namespaces).not.toContain("AWS/Kinesis");
    expect(new Set(namespaces)).toEqual(new Set(["AWS/Firehose", "AWS/Lambda"]));
    expect(hotPlaneCalls).toEqual([{ at: START, drainAnchorAt: ANCHOR }]);
  });

  test("purges ClickHouse and Iceberg and returns the receipt with accumulated counts", async () => {
    const { hotPlaneCalls, queries, run } = harness({
      hotPlane: [
        { reason: "mutation_running", remainingRows: 7, status: "pending" },
        { reason: "writer_catching_up", status: "pending" },
        { reason: "mutation_running", remainingRows: 2, status: "pending" },
        { rowsDeleted: 1, status: "complete", verifiedAt: "2026-10-01T12:00:10.000Z" },
      ],
      rows: { [SPANS]: 3, [TRACES]: 4 },
    });

    const result = await run();

    expect(hotPlaneCalls).toHaveLength(4);
    expect(statements(queries)).toEqual([
      "SELECT",
      "DELETE",
      "SELECT",
      "SELECT",
      "DELETE",
      "SELECT",
    ]);
    expect(queries[1]!.sql).toBe(`DELETE FROM ${SPANS} WHERE organization_id = '${ORG}'`);
    // Athena cannot OPTIMIZE S3 Tables; a table is done once it recounts zero.
    expect(queries.some((query) => /OPTIMIZE/iu.test(query.sql))).toBe(false);
    expect(result).toEqual({
      receipt: {
        clickhouse: { absenceVerifiedAt: "2026-10-01T12:00:10.000Z", rowsDeleted: 8 },
        clickhouseBackupsExpireBy: "2026-10-16T12:00:10.000Z",
        iceberg: {
          absenceVerifiedAt: "2026-10-01T12:00:15.000Z",
          physicalRemovalBy: "2026-10-04T12:00:15.000Z",
          rowsDeleted: 7,
          tables: [
            { rowsDeleted: 3, table: "spans" },
            { rowsDeleted: 4, table: "traces" },
          ],
        },
        operationId: OPERATION,
      },
      status: "complete",
    });
  });

  test("resumes from returned progress without repeating finished work", async () => {
    const harnessed = harness({
      hotPlane: null,
      remainingMs: 63_000,
      rows: { [SPANS]: 3, [TRACES]: 2 },
      runningPolls: 1,
    });

    const partial = await harnessed.run();
    expect(partial).toMatchObject({ reason: "iceberg_purge_running", status: "pending" });
    if (partial.status !== "pending") throw new Error("Expected pending.");
    expect(partial.progress.drainedAt).toBe("2026-10-01T12:00:00.000Z");
    // Spans finished DELETE and its zero recount; traces has not started.
    expect(partial.progress.iceberg.tables).toEqual({
      spans: { attempt: 3, conflicts: 0, pendingRows: 0, rowsDeleted: 3, step: "complete" },
      traces: { attempt: 0, conflicts: 0, pendingRows: 0, rowsDeleted: 0, step: "count" },
    });
    const persisted = JSON.parse(JSON.stringify(partial.progress)) as ObservabilityErasureProgress;

    harnessed.clock.remaining = 900_000;
    const result = await harnessed.run(persisted);

    expect(harnessed.metricCalls).toHaveLength(1);
    expect(statements(harnessed.queries)).toEqual([
      "SELECT",
      "DELETE",
      "SELECT",
      "SELECT",
      "DELETE",
      "SELECT",
    ]);
    expect(result).toMatchObject({
      receipt: {
        clickhouse: { absenceVerifiedAt: "2026-10-01T12:00:00.000Z", rowsDeleted: 0 },
        iceberg: {
          rowsDeleted: 5,
          tables: [
            { rowsDeleted: 3, table: "spans" },
            { rowsDeleted: 2, table: "traces" },
          ],
        },
      },
      status: "complete",
    });
  });

  test("retries Iceberg commit conflicts with a fresh submission", async () => {
    const { queries, run } = harness({ conflicts: { DELETE: 2 }, hotPlane: null });

    const result = await run();

    const deletes = queries.filter((query) => query.sql.startsWith("DELETE"));
    expect(deletes).toHaveLength(3);
    expect(new Set(deletes.map((query) => query.token)).size).toBe(3);
    expect(result).toMatchObject({
      receipt: {
        clickhouse: { rowsDeleted: 0 },
        iceberg: {
          rowsDeleted: 3,
          tables: [{ rowsDeleted: 3, table: "spans" }, { table: "traces" }],
        },
      },
      status: "complete",
    });

    const exhausted = harness({ conflicts: { DELETE: 4 } });
    expect(exhausted.run()).rejects.toThrow("Iceberg commit conflicts");
  });

  test("returns pending progress before the deadline and re-attaches to the running query", async () => {
    const { clock, queries, run } = harness({
      hotPlane: null,
      remainingMs: 70_000,
      runningPolls: 1_000,
    });

    const first = await run();

    expect(clock.remaining).toBeGreaterThanOrEqual(config.safetyMarginMs);
    expect(first).toMatchObject({
      progress: {
        iceberg: {
          tables: { spans: { attempt: 1, queryExecutionId: "q1", step: "count" } },
        },
      },
      reason: "iceberg_purge_running",
      status: "pending",
    });
    if (first.status !== "pending") throw new Error("Expected pending.");

    clock.remaining = 900_000;
    clock.runningPolls = 0;
    const resumed = await run(first.progress);
    expect(queries.filter((query) => query.token.endsWith("-spans-1"))).toHaveLength(1);
    expect(statements(queries)).toEqual(["SELECT", "DELETE", "SELECT", "SELECT"]);
    expect(resumed).toMatchObject({ status: "complete" });

    const clickhouse = harness({ remainingMs: 100_000 });
    expect(await clickhouse.run()).toMatchObject({
      reason: "clickhouse_purge_running",
      status: "pending",
    });
    expect(clickhouse.hotPlaneCalls).toHaveLength(0);
  });

  test("resumes a table persisted at the removed optimize step with a fresh recount", async () => {
    // Progress persisted by the first dev erasure: spans had deleted and
    // recounted zero rows and was waiting on an OPTIMIZE execution.
    const persisted = {
      clickhouse: { pendingRows: 0, rowsDeleted: 4, verifiedAt: "2026-10-01T11:58:00.000Z" },
      drainedAt: "2026-10-01T11:57:00.000Z",
      iceberg: {
        tables: {
          spans: {
            attempt: 4,
            conflicts: 1,
            pendingRows: 0,
            queryExecutionId: "optimize-execution",
            rowsDeleted: 3,
            step: "optimize",
          },
        },
      },
    };
    const { hotPlaneCalls, metricCalls, queries, run } = harness({ rows: { [SPANS]: 0 } });

    const result = await run(persisted as unknown as ObservabilityErasureProgress);

    expect(metricCalls).toHaveLength(0);
    expect(hotPlaneCalls).toHaveLength(0);
    expect(queries.map((query) => [query.sql.split(" ")[0], query.token])).toEqual([
      ["SELECT", `observability-erasure-${OPERATION}-spans-5`],
      ["SELECT", `observability-erasure-${OPERATION}-traces-1`],
    ]);
    expect(queries[0]!.sql).toBe(
      `SELECT count(*) AS row_count FROM ${SPANS} WHERE organization_id = '${ORG}'`,
    );
    expect(result).toMatchObject({
      receipt: {
        clickhouse: { absenceVerifiedAt: "2026-10-01T11:58:00.000Z", rowsDeleted: 4 },
        iceberg: {
          rowsDeleted: 3,
          tables: [
            { rowsDeleted: 3, table: "spans" },
            { rowsDeleted: 0, table: "traces" },
          ],
        },
      },
      status: "complete",
    });
  });

  test("reports the pipeline as draining while the hot-plane writer catches up", async () => {
    const { hotPlaneCalls, queries, run } = harness({
      hotPlane: Array.from({ length: 50 }, () => ({
        reason: "writer_catching_up" as const,
        status: "pending" as const,
      })),
      remainingMs: 130_000,
    });

    const result = await run();

    expect(result).toEqual({
      progress: {
        clickhouse: { pendingRows: 0, rowsDeleted: 0 },
        drainedAt: "2026-10-01T12:00:00.000Z",
        iceberg: { tables: {} },
      },
      reason: "pipeline_draining",
      status: "pending",
    });
    expect(hotPlaneCalls.length).toBeGreaterThan(1);
    expect(hotPlaneCalls.every((call) => call.drainAnchorAt === ANCHOR)).toBe(true);
    expect(queries).toHaveLength(0);
  });
});
