import type { QueryValue } from "./athena-query.ts";
import type { RanQuery, SchemaDescription } from "./event-analytics.ts";

const TABLE_CELL_WIDTH = 48;

function clip(value: string, width: number) {
  const flat = value.replaceAll(/\s+/gu, " ");
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

/** Renders rows as an aligned text table; cells longer than the column width are clipped. */
export function formatTable(
  columns: readonly string[],
  rows: readonly Readonly<Record<string, QueryValue>>[],
) {
  const cells = rows.map((row) =>
    columns.map((column) => clip(String(row[column] ?? ""), TABLE_CELL_WIDTH)),
  );
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...cells.map((row) => row[index]?.length ?? 0)),
  );
  const line = (values: readonly string[]) =>
    values
      .map((value, index) => value.padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd();
  return [
    line(columns),
    line(widths.map((width) => "-".repeat(width))),
    ...cells.map((row) => line(row)),
  ].join("\n");
}

/** The text a terminal shows for a query: its rows, then a one-line summary. */
export function formatQueryText(result: RanQuery) {
  const bytes = result.statistics.dataScannedBytes;
  const summary = [
    `${String(result.rows.length)} row${result.rows.length === 1 ? "" : "s"}${result.truncated ? " (truncated; raise the limit or narrow the query)" : ""}`,
    `scanned ${bytes === null ? "unknown" : `${(bytes / 1_048_576).toFixed(2)} MiB`}`,
    `query ${result.statistics.queryExecutionId}`,
  ].join(" · ");
  const columns = result.columns.map((column) => column.name);
  return `${result.rows.length === 0 ? "No rows." : formatTable(columns, result.rows)}\n\n${summary}\n`;
}

export function formatSchemaText(schema: SchemaDescription) {
  return `${schema.table}\n\n${formatTable(
    ["name", "type", "description"],
    schema.columns,
  )}\n\n${schema.notes.map((note) => `- ${note}`).join("\n")}\n`;
}

/** The JSON document both the `--json` CLI output and the MCP tools return for a query. */
export function queryDocument(result: RanQuery, options: { readonly maxCellCharacters?: number }) {
  const limit = options.maxCellCharacters;
  let clippedCells = 0;
  const rows =
    limit === undefined
      ? result.rows
      : result.rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([column, value]) => {
              if (typeof value !== "string" || value.length <= limit) return [column, value];
              clippedCells += 1;
              return [column, `${value.slice(0, limit)}…`];
            }),
          ),
        );
  return {
    columns: result.columns,
    rows,
    row_count: result.rows.length,
    truncated: result.truncated,
    ...(clippedCells === 0 ? {} : { clipped_cells: clippedCells }),
    statistics: {
      data_scanned_bytes: result.statistics.dataScannedBytes,
      engine_execution_ms: result.statistics.engineExecutionMs,
      query_execution_id: result.statistics.queryExecutionId,
    },
    sql: result.sql,
  };
}
