import { parseArgs } from "node:util";
import { AthenaClient } from "@aws-sdk/client-athena";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Schema } from "effect";
import { coordinateOptions, resolveCoordinates, tableReference } from "./coordinates.ts";
import { createEventAnalytics, type EventAnalytics } from "./event-analytics.ts";
import { EventTypeCountsRequest, RecentEventsRequest, RunQueryRequest } from "./event-queries.ts";
import { queryDocument } from "./output.ts";

/** Longest string cell a tool result carries, so one large payload cannot flood the context. */
export const MAX_TOOL_CELL_CHARACTERS = 2000;

const SERVER_INSTRUCTIONS =
  "Query the platform's semantic event log (internal operator analytics) in Athena. The log spans every tenant: use it for operating the platform only. Delivery is at least once, so deduplicate by event_id in custom SQL; the canned tools already do. Start with describe_schema.";

function inputSchema(schema: Schema.Top): Tool["inputSchema"] {
  const document = Schema.toJsonSchemaDocument(schema);
  if (Object.keys(document.definitions).length > 0) {
    throw new Error("Tool input schemas must not use JSON Schema definitions.");
  }
  return { ...document.schema, type: "object" };
}

export const eventAnalyticsTools = [
  {
    annotations: { readOnlyHint: true, title: "Describe the semantic event table" },
    description:
      "Describe the semantic event table: its columns, where it lives, and how to query it correctly. Runs no query.",
    inputSchema: { additionalProperties: false, properties: {}, type: "object" },
    name: "describe_schema",
  },
  {
    annotations: { readOnlyHint: true, title: "Recent semantic events" },
    description:
      "Newest semantic events in a time window (default the last 24 hours), one row per event_id. Filter by organization and event type.",
    inputSchema: inputSchema(RecentEventsRequest),
    name: "recent_events",
  },
  {
    annotations: { readOnlyHint: true, title: "Semantic event counts by type" },
    description:
      "Distinct semantic events per event type in a time window (default the last 24 hours), busiest first.",
    inputSchema: inputSchema(EventTypeCountsRequest),
    name: "event_type_counts",
  },
  {
    annotations: { readOnlyHint: true, title: "Run a read-only Athena query" },
    description:
      "Run one read-only SELECT or WITH statement against the semantic event table, named events. Comments, multiple statements, writes, DDL, and UNLOAD are rejected, and results stop at max_rows.",
    inputSchema: inputSchema(RunQueryRequest),
    name: "run_query",
  },
] as const satisfies readonly Tool[];

export type EventAnalyticsToolName = (typeof eventAnalyticsTools)[number]["name"];

function textResult(value: unknown): CallToolResult {
  return { content: [{ text: JSON.stringify(value, null, 2), type: "text" }] };
}

/** Runs one tool call. Failures become tool errors the model can read and correct. */
export async function callEventAnalyticsTool(
  analytics: EventAnalytics,
  name: string,
  args: unknown,
): Promise<CallToolResult> {
  const options = { maxCellCharacters: MAX_TOOL_CELL_CHARACTERS };
  try {
    switch (name) {
      case "describe_schema":
        return textResult(analytics.describeSchema());
      case "recent_events":
        return textResult(queryDocument(await analytics.recentEvents(args), options));
      case "event_type_counts":
        return textResult(queryDocument(await analytics.eventTypeCounts(args), options));
      case "run_query":
        return textResult(queryDocument(await analytics.runQuery(args), options));
      default:
        return { content: [{ text: `Unknown tool ${name}.`, type: "text" }], isError: true };
    }
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { content: [{ text: message, type: "text" }], isError: true };
  }
}

export function createEventAnalyticsServer(analytics: EventAnalytics) {
  const server = new Server(
    { name: "deployments-event-analytics", version: "0.0.0" },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...eventAnalyticsTools] }));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    callEventAnalyticsTool(analytics, request.params.name, request.params.arguments ?? {}),
  );
  return server;
}

const USAGE = `Usage: bun run events:mcp -- [--root <opentofu-root>] [--region <region>] [--workgroup <name>] [--catalog <name>] [--database <name>] [--table <name>]

Starts a stdio MCP server over the operator's own AWS credentials.`;

async function main(args: readonly string[]) {
  const { values } = parseArgs({
    args: [...args],
    options: { ...coordinateOptions, help: { type: "boolean" } },
    strict: true,
  });
  if (values.help === true) {
    process.stderr.write(`${USAGE}\n`);
    return;
  }
  const coordinates = resolveCoordinates({ env: process.env, flags: values });
  const client = new AthenaClient(
    coordinates.region === undefined ? {} : { region: coordinates.region },
  );
  const server = createEventAnalyticsServer(createEventAnalytics({ client, coordinates }));
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `event analytics MCP server ready: workgroup ${coordinates.workgroup}, table ${tableReference(coordinates)}\n`,
  );
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
