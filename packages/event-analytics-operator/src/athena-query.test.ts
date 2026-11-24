import { describe, expect, it } from "bun:test";
import {
  AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
} from "@aws-sdk/client-athena";
import { AthenaQueryError, type AthenaSender, cellValue, runAthenaQuery } from "./athena-query.ts";
import {
  eventColumns,
  eventRows,
  FakeAthena,
  fakeClock,
  testCoordinates,
} from "./fake-athena.fixture.ts";

describe("Athena query runner", () => {
  it("accepts the real Athena client as its sender", () => {
    const client: AthenaSender = new AthenaClient({ region: "us-east-2" });
    expect(client).toBeInstanceOf(AthenaClient);
  });

  it("runs in the analytics workgroup, waits for completion, and skips the header row", async () => {
    const athena = new FakeAthena(() => ({
      columns: eventColumns,
      pendingStates: ["QUEUED", "RUNNING", "RUNNING"],
      rows: eventRows,
      scannedBytes: 2048,
    }));
    const clock = fakeClock();
    const result = await runAthenaQuery({
      client: athena,
      clock,
      coordinates: testCoordinates,
      maxRows: 10,
      sql: "SELECT 1",
    });

    expect(athena.started).toEqual([
      {
        QueryExecutionContext: {
          Catalog: "s3tablescatalog/semantic-events",
          Database: "semantic_events",
        },
        QueryString: "SELECT 1",
        WorkGroup: "semantic-events",
      },
    ]);
    expect(clock.slept).toEqual([250, 500, 1000]);
    expect(
      athena.commands.filter((command) => command instanceof GetQueryExecutionCommand),
    ).toHaveLength(4);
    expect(result).toEqual({
      columns: eventColumns,
      rows: [
        {
          aggregate_version: 1,
          event_id: "01JA0000000000000000000010",
          event_type: "agent.created",
          occurred_at: "2026-10-16T11:59:00.000Z",
          organization_id: "01JA0000000000000000000001",
          trace_id: null,
        },
        {
          aggregate_version: 2,
          event_id: "01JA0000000000000000000011",
          event_type: "agent.updated",
          occurred_at: "2026-10-16T11:58:00.000Z",
          organization_id: "01JA0000000000000000000001",
          trace_id: "trace-1",
        },
      ],
      statistics: { dataScannedBytes: 2048, engineExecutionMs: 420, queryExecutionId: "query-1" },
      truncated: false,
    });
  });

  it("follows result pages and reports truncation past maxRows", async () => {
    const rows = Array.from({ length: 7 }, (_, index) => [`event-${String(index)}`]);
    const athena = new FakeAthena(() => ({
      columns: [{ name: "event_id", type: "varchar" }],
      pageSize: 3,
      rows,
    }));
    const result = await runAthenaQuery({
      client: athena,
      clock: fakeClock(),
      coordinates: testCoordinates,
      maxRows: 5,
      sql: "SELECT event_id FROM events",
    });
    expect(result.rows.map((row) => row.event_id)).toEqual([
      "event-0",
      "event-1",
      "event-2",
      "event-3",
      "event-4",
    ]);
    expect(result.truncated).toBe(true);
    expect(
      athena.commands
        .filter((command) => command instanceof GetQueryResultsCommand)
        .map((command) => command.input.NextToken),
    ).toEqual([undefined, "3"]);

    const exact = await runAthenaQuery({
      client: new FakeAthena(() => ({ columns: [{ name: "event_id", type: "varchar" }], rows })),
      clock: fakeClock(),
      coordinates: testCoordinates,
      maxRows: 7,
      sql: "SELECT event_id FROM events",
    });
    expect(exact.rows).toHaveLength(7);
    expect(exact.truncated).toBe(false);
  });

  it("surfaces Athena's failure reason", () => {
    const athena = new FakeAthena(() => ({
      columns: [],
      failureReason: "Query exhausted resources: bytes scanned cutoff",
      rows: [],
    }));
    expect(
      runAthenaQuery({
        client: athena,
        clock: fakeClock(),
        coordinates: testCoordinates,
        maxRows: 5,
        sql: "SELECT 1",
      }),
    ).rejects.toThrow(
      "Athena query query-1 failed: Query exhausted resources: bytes scanned cutoff",
    );
  });

  it("stops a query that outlives the timeout", async () => {
    const athena = new FakeAthena(() => ({
      columns: [],
      pendingStates: Array.from({ length: 100 }, () => "RUNNING"),
      rows: [],
    }));
    const error = await runAthenaQuery({
      client: athena,
      clock: fakeClock(),
      coordinates: testCoordinates,
      maxRows: 5,
      sql: "SELECT 1",
      timeoutMs: 5000,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AthenaQueryError);
    expect(String(error)).toContain("did not finish within 5 seconds");
    expect(athena.stopped).toEqual(["query-1"]);
    expect(athena.commands.some((command) => command instanceof StartQueryExecutionCommand)).toBe(
      true,
    );
  });

  it("converts Athena's text cells by column type", () => {
    expect(cellValue("bigint", "42")).toBe(42);
    expect(cellValue("bigint", "9223372036854775807")).toBe("9223372036854775807");
    expect(cellValue("double", "1.5")).toBe(1.5);
    expect(cellValue("boolean", "true")).toBe(true);
    expect(cellValue("decimal(38,9)", "1.000000001")).toBe("1.000000001");
    expect(cellValue("varchar", "")).toBe("");
    expect(cellValue("varchar", undefined)).toBeNull();
  });
});
