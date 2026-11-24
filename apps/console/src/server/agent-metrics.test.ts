import { describe, expect, test } from "bun:test";
import type { TraceSummary } from "../observability/traces.ts";
import {
  completeTotals,
  groupTotals,
  METRIC_GROUP_LIMIT,
  summarizeTraces,
} from "./agent-metrics.ts";

function point(group: string | undefined, traces: number, p95?: number) {
  return {
    bucket: "2026-10-01T00:00:00.000Z",
    error_count: 1,
    ...(group === undefined ? {} : { group_value: group }),
    ...(p95 === undefined ? {} : { p95_duration_ms: p95 }),
    total_cost_usd_micros: traces * 10,
    total_tokens: traces * 100,
    trace_count: traces,
  };
}

function trace(fields: Partial<TraceSummary>): TraceSummary {
  return {
    environment_id: "env",
    fact_id: crypto.randomUUID(),
    occurred_at: "2026-10-01T00:00:00.000Z",
    project_id: "project",
    trace_id: crypto.randomUUID(),
    ...fields,
  };
}

describe("groupTotals", () => {
  test("sums each group across buckets and keeps the highest bucket p95", () => {
    const result = groupTotals([point("a", 2, 300), point("a", 3), point("a", 1, 900)]);
    expect(result.groups.a).toEqual({
      costUsdMicros: 60,
      errors: 3,
      p95: { basis: "daily-peak", ms: 900 },
      tokens: 600,
      traces: 6,
    });
  });

  test("omits p95 when no bucket reported one", () => {
    expect(groupTotals([point("a", 1)]).groups.a?.p95).toBeUndefined();
  });

  test("keeps only wanted groups but counts every group toward completeness", () => {
    const items = Array.from({ length: METRIC_GROUP_LIMIT }, (_, index) => point(`g${index}`, 1));
    const result = groupTotals(items, new Set(["g3", "missing"]));
    expect(Object.keys(result.groups)).toEqual(["g3"]);
    expect(result.complete).toBe(false);
  });

  test("an unattributed group counts toward the limit but is never a group", () => {
    const attributed = Array.from({ length: METRIC_GROUP_LIMIT - 1 }, (_, index) =>
      point(`g${index}`, 1),
    );
    const result = groupTotals([...attributed, point(undefined, 5)]);
    expect(Object.keys(result.groups)).toHaveLength(METRIC_GROUP_LIMIT - 1);
    expect(result.complete).toBe(false);
    expect(groupTotals(attributed).complete).toBe(true);
  });

  test("ignores model-invocation points", () => {
    const model = {
      bucket: "2026-10-01T00:00:00.000Z",
      cached_tokens: 0,
      error_count: 0,
      group_value: "a",
      input_tokens: 1,
      invocation_count: 4,
      output_tokens: 1,
      total_cost_usd_micros: 5,
      total_tokens: 2,
    };
    expect(groupTotals([model])).toEqual({ complete: true, groups: {} });
  });
});

describe("summarizeTraces", () => {
  const byAgent = (item: TraceSummary) => item.agent_definition_id;

  test("totals each group and counts errored traces", () => {
    const groups = summarizeTraces(
      [
        trace({
          agent_definition_id: "a",
          status: "ok",
          total_cost_usd_micros: 5,
          total_tokens: 7,
        }),
        trace({ agent_definition_id: "a", status: "error" }),
        trace({ agent_definition_id: "b", status: "error", total_tokens: 1 }),
        trace({ status: "error" }),
      ],
      byAgent,
    );
    expect(groups).toEqual({
      a: { costUsdMicros: 5, errors: 1, tokens: 7, traces: 2 },
      b: { costUsdMicros: 0, errors: 1, tokens: 1, traces: 1 },
    });
  });

  test("interpolates the p95 over traces that report a duration", () => {
    const durations = [500, 100, 300, 200, 400];
    const groups = summarizeTraces(
      [
        ...durations.map((duration_ms) => trace({ agent_definition_id: "a", duration_ms })),
        trace({ agent_definition_id: "a" }),
      ],
      byAgent,
    );
    // Sorted 100…500: rank 0.95 × 4 = 3.8 lies 80% of the way from 400 to 500.
    expect(groups.a?.p95).toEqual({ basis: "traces", ms: 480 });
    expect(
      summarizeTraces([trace({ agent_definition_id: "a", duration_ms: 42 })], byAgent).a?.p95,
    ).toEqual({ basis: "traces", ms: 42 });
  });
});

describe("completeTotals", () => {
  test("keeps series figures and fills the groups the series left out", () => {
    const series = groupTotals([point("a", 2, 300)]);
    const truncated = { complete: false, groups: series.groups };
    const fromTraces = {
      a: { costUsdMicros: 1, errors: 0, tokens: 1, traces: 99 },
      b: { costUsdMicros: 3, errors: 1, tokens: 4, traces: 1 },
    };
    expect(completeTotals(truncated, fromTraces)).toEqual({
      complete: true,
      groups: { a: series.groups.a!, b: fromTraces.b },
    });
  });
});
