import { expect, test } from "bun:test";
import { observabilityCommandCatalog } from "./catalog-observability.ts";
import { renderOutput } from "./output.ts";

test("renders observability identifiers and metrics with explicit columns", () => {
  const output: string[] = [];
  const columns = observabilityCommandCatalog.trace?.actions.list?.columns;
  expect(columns).toBeDefined();
  renderOutput({
    color: false,
    columns: columns!,
    data: {
      items: [
        {
          occurred_at: "2026-08-03T00:00:00.000Z",
          status: "ok",
          total_tokens: 12,
          trace_id: "trace-1",
        },
      ],
    },
    io: {
      isInteractive: false,
      stderr: () => undefined,
      stdout: (value) => void output.push(value),
    },
    json: false,
    kind: "list",
    listField: "items",
    quiet: false,
    reveal: false,
  });
  expect(output.join("\n")).toContain("TRACE_ID");
  expect(output.join("\n")).toContain("trace-1");
  expect(output.join("\n")).toContain("TOTAL_TOKENS");
});
