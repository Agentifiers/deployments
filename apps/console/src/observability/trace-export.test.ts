import { expect, test } from "bun:test";
import { exportFilename, selectExportedTraces, tracesCsv } from "./trace-export.ts";
import type { TraceSummary } from "./traces.ts";

const GENERATED_AT = "2026-10-03T12:00:00.000Z";

function trace(id: string, occurredAt: string, fields: Partial<TraceSummary> = {}): TraceSummary {
  return {
    environment_id: "env",
    fact_id: `fact-${id}`,
    occurred_at: occurredAt,
    project_id: "project",
    trace_id: id,
    ...fields,
  };
}

test("export selection keeps the window and filters, treating a missing outcome as unknown", () => {
  const items = [
    trace("a", "2026-10-03T11:00:00.000Z", { status: "ok" }),
    trace("b", "2026-10-03T10:00:00.000Z"),
    trace("c", "2026-10-02T11:59:59.999Z"),
  ];
  const all = selectExportedTraces(items, { range: "24h" }, GENERATED_AT);
  expect(all.items.map((item) => item.trace_id)).toEqual(["a", "b"]);
  expect(all.from).toBe("2026-10-02T12:00:00.000Z");
  expect(all.complete).toBe(true);
  const unknown = selectExportedTraces(items, { range: "7d", status: "unknown" }, GENERATED_AT);
  expect(unknown.items.map((item) => item.trace_id)).toEqual(["b", "c"]);
  // A trace lacking the filtered field never matches, as in the hot plane.
  const purpose = selectExportedTraces(
    items,
    { executionPurpose: "customer", range: "7d" },
    GENERATED_AT,
  );
  expect(purpose.items).toEqual([]);
});

test("export selection is incomplete when the cap cuts the window short or the range is too long", () => {
  const capped = [trace("a", "2026-10-03T11:00:00.000Z"), trace("b", "2026-10-03T06:00:00.000Z")];
  expect(selectExportedTraces(capped, { range: "24h" }, GENERATED_AT, 2).complete).toBe(false);
  const reachesStart = [...capped, trace("c", "2026-10-02T09:00:00.000Z")];
  expect(selectExportedTraces(reachesStart, { range: "24h" }, GENERATED_AT, 3).complete).toBe(true);
  expect(selectExportedTraces([], { range: "30d" }, GENERATED_AT).complete).toBe(false);
});

test("export filenames carry the range and window without separators", () => {
  expect(
    exportFilename(
      { from: "2026-10-02T12:00:00.000Z", to: "2026-10-03T12:00:00.000Z" },
      "24h",
      "csv",
    ),
  ).toBe("traces-24h-20261002T120000Z-20261003T120000Z.csv");
});

test("CSV quotes separators and neutralizes formula-like text", () => {
  const [header, row] = tracesCsv([
    {
      ...trace("a", GENERATED_AT),
      agentLabel: 'Triage, "beta"\nagent',
    },
  ]).split("\r\n");
  expect(header?.startsWith("trace_id,occurred_at,status,agent,")).toBe(true);
  expect(row).toStartWith(`a,${GENERATED_AT},unknown,"Triage, ""beta""`);
  expect(tracesCsv([trace("a", GENERATED_AT, { error_class: "=HYPERLINK()" })])).toContain(
    ",'=HYPERLINK(),",
  );
});
