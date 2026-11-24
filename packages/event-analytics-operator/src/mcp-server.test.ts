import { afterEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createEventAnalytics } from "./event-analytics.ts";
import {
  eventColumns,
  eventRows,
  FakeAthena,
  type FakeQueryOutcome,
  fakeClock,
  testCoordinates,
} from "./fake-athena.fixture.ts";
import { createEventAnalyticsServer, MAX_TOOL_CELL_CHARACTERS } from "./mcp-server.ts";

const open: Client[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()));
});

async function connect(outcome: (sql: string) => FakeQueryOutcome) {
  const athena = new FakeAthena(outcome);
  const server = createEventAnalyticsServer(
    createEventAnalytics({ client: athena, clock: fakeClock(), coordinates: testCoordinates }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "event-analytics-test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  open.push(client);
  return { athena, client };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = CallToolResultSchema.parse(await client.callTool({ arguments: args, name }));
  const [block] = result.content;
  if (block?.type !== "text") throw new Error("Expected a text tool result.");
  return { isError: result.isError === true, text: block.text };
}

const events = () => ({ columns: eventColumns, rows: eventRows });

describe("event analytics MCP server", () => {
  it("lists the four read-only tools with typed input schemas", async () => {
    const { client } = await connect(events);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "describe_schema",
      "recent_events",
      "event_type_counts",
      "run_query",
    ]);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    const runQuery = tools.find((tool) => tool.name === "run_query");
    expect(runQuery?.inputSchema.required).toEqual(["sql"]);
    const recent = tools.find((tool) => tool.name === "recent_events");
    expect(Object.keys(recent?.inputSchema.properties ?? {})).toEqual([
      "organization_id",
      "event_type",
      "since",
      "until",
      "limit",
      "include_payload",
    ]);
    expect(recent?.inputSchema.properties?.limit).toMatchObject({
      allOf: [{ maximum: 1000, minimum: 1 }],
      type: "integer",
    });
  });

  it("describes the schema without querying Athena", async () => {
    const { athena, client } = await connect(events);
    const result = await call(client, "describe_schema");
    const schema: unknown = JSON.parse(result.text);
    expect(schema).toMatchObject({
      coordinates: { workgroup: "semantic-events" },
      table: '"s3tablescatalog/semantic-events"."semantic_events"."events"',
    });
    expect(result.text).toContain("at least once");
    expect(athena.commands).toHaveLength(0);
  });

  it("returns deduplicated recent events from the analytics workgroup", async () => {
    const { athena, client } = await connect(events);
    const result = await call(client, "recent_events", {
      event_type: "agent.*",
      limit: 10,
      organization_id: "01JA0000000000000000000001",
    });
    expect(result.isError).toBe(false);
    const [started] = athena.started;
    expect(started?.WorkGroup).toBe("semantic-events");
    expect(started?.QueryString).toContain("PARTITION BY event_id");
    expect(started?.QueryString).toContain("AND organization_id = '01JA0000000000000000000001'");
    expect(started?.QueryString).toContain("LIMIT 11");
    expect(JSON.parse(result.text)).toMatchObject({
      row_count: 2,
      rows: [{ aggregate_version: 1, event_type: "agent.created" }, { trace_id: "trace-1" }],
      statistics: { data_scanned_bytes: 1_048_576, query_execution_id: "query-1" },
      truncated: false,
    });
  });

  it("counts events by type", async () => {
    const { athena, client } = await connect(() => ({
      columns: [
        { name: "event_type", type: "varchar" },
        { name: "event_count", type: "bigint" },
      ],
      rows: [
        ["agent.created", "12"],
        ["agent.updated", "3"],
      ],
    }));
    const result = await call(client, "event_type_counts", { since: "7d" });
    expect(athena.started[0]?.QueryString).toContain("count(DISTINCT event_id)");
    expect(JSON.parse(result.text)).toMatchObject({
      rows: [
        { event_count: 12, event_type: "agent.created" },
        { event_count: 3, event_type: "agent.updated" },
      ],
    });
  });

  it("runs a guarded read-only query and clips oversized cells", async () => {
    const { athena, client } = await connect(() => ({
      columns: [{ name: "payload_json", type: "varchar" }],
      rows: [["x".repeat(MAX_TOOL_CELL_CHARACTERS + 10)]],
    }));
    const result = await call(client, "run_query", {
      max_rows: 20,
      sql: "SELECT payload_json FROM events",
    });
    expect(athena.started[0]?.QueryString).toBe("SELECT payload_json FROM events\nLIMIT 21");
    const document: unknown = JSON.parse(result.text);
    expect(document).toMatchObject({
      clipped_cells: 1,
      sql: "SELECT payload_json FROM events\nLIMIT 21",
    });
    expect(result.text).toContain(`${"x".repeat(MAX_TOOL_CELL_CHARACTERS)}…`);
  });

  it("refuses unsafe SQL and invalid arguments as tool errors without calling Athena", async () => {
    const { athena, client } = await connect(events);
    const drop = await call(client, "run_query", { sql: "SELECT 1; DROP TABLE events" });
    expect(drop).toEqual({ isError: true, text: "UnsafeQueryError: Run one statement at a time." });
    const hidden = await call(client, "run_query", { sql: "SELECT 1 /* ; DELETE FROM events */" });
    expect(hidden.isError).toBe(true);
    const organization = await call(client, "recent_events", { organization_id: "acme" });
    expect(organization.isError).toBe(true);
    expect(organization.text).toContain("InvalidRequestError");
    const tooMany = await call(client, "run_query", { max_rows: 5000, sql: "SELECT 1" });
    expect(tooMany.isError).toBe(true);
    const unknown = await call(client, "drop_everything");
    expect(unknown).toEqual({ isError: true, text: "Unknown tool drop_everything." });
    expect(athena.commands).toHaveLength(0);
  });

  it("reports an Athena failure as a tool error", async () => {
    const { client } = await connect(() => ({
      columns: [],
      failureReason: "TABLE_NOT_FOUND: events",
      rows: [],
    }));
    const result = await call(client, "run_query", { sql: "SELECT * FROM events" });
    expect(result).toEqual({
      isError: true,
      text: "AthenaQueryError: Athena query query-1 failed: TABLE_NOT_FOUND: events",
    });
  });
});
