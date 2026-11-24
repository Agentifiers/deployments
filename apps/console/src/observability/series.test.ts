import { describe, expect, test } from "bun:test";
import { bucketStarts, metricWindow, parseMetricSelection } from "./range.ts";
import { groupedMetrics, groupedRows, traceBuckets, traceTotals } from "./series.ts";

const NOW = new Date("2026-10-02T14:37:12.345Z");

describe("metric windows", () => {
  test("end at the next bucket boundary so every bucket is whole", () => {
    const hourly = metricWindow({ interval: "hour", range: "24h" }, NOW);
    expect(hourly).toEqual({
      from: "2026-10-01T15:00:00.000Z",
      interval: "hour",
      to: "2026-10-02T15:00:00.000Z",
    });
    const buckets = bucketStarts(hourly);
    expect(buckets).toHaveLength(24);
    expect(buckets.at(-1)).toBe("2026-10-02T14:00:00.000Z");
  });

  test("keep 30 daily UTC buckets inside the 30-day model retention", () => {
    const daily = metricWindow({ interval: "day", range: "30d" }, NOW);
    expect(daily.to).toBe("2026-10-03T00:00:00.000Z");
    expect(bucketStarts(daily)).toHaveLength(30);
    expect(Date.parse(daily.from)).toBeGreaterThan(NOW.getTime() - 30 * 86_400_000);
  });

  test("move a window that ends within two minutes one bucket later", () => {
    const beforeMidnight = new Date("2026-10-02T23:59:30.000Z");
    const daily = metricWindow({ interval: "day", range: "30d" }, beforeMidnight);
    expect(daily.to).toBe("2026-10-04T00:00:00.000Z");
    // Still inside the 30-day retention after the boundary passes at the hot plane.
    expect(Date.parse(daily.from)).toBeGreaterThan(
      Date.parse("2026-10-03T00:00:30.000Z") - 30 * 86_400_000,
    );
  });

  test("fall back to an interval the range allows", () => {
    expect(parseMetricSelection({ interval: "hour", range: "30d" })).toEqual({
      interval: "day",
      range: "30d",
    });
    expect(parseMetricSelection({ groupBy: "model", interval: "day", range: "7d" })).toEqual({
      groupBy: "model",
      interval: "day",
      range: "7d",
    });
    expect(parseMetricSelection({ groupBy: "workspace", range: "90d" })).toEqual({
      interval: "hour",
      range: "24h",
    });
  });
});

const BUCKETS = [
  "2026-10-02T12:00:00.000Z",
  "2026-10-02T13:00:00.000Z",
  "2026-10-02T14:00:00.000Z",
];

describe("trace buckets", () => {
  test("zero-fill counts but leave percentiles absent where no trace finished", () => {
    const rows = traceBuckets(
      [
        {
          bucket: "2026-10-02T13:00:00Z",
          error_count: 1,
          p50_duration_ms: 900,
          p95_duration_ms: 4_000,
          total_cost_usd_micros: 1_500,
          total_tokens: 320,
          trace_count: 4,
        },
      ],
      BUCKETS,
    );
    expect(rows).toEqual([
      { bucket: BUCKETS[0]!, costUsdMicros: 0, errors: 0, tokens: 0, traces: 0 },
      {
        bucket: BUCKETS[1]!,
        costUsdMicros: 1_500,
        errors: 1,
        p50: 900,
        p95: 4_000,
        tokens: 320,
        traces: 4,
      },
      { bucket: BUCKETS[2]!, costUsdMicros: 0, errors: 0, tokens: 0, traces: 0 },
    ]);
  });

  test("total every point of the window", () => {
    const point = {
      bucket: BUCKETS[0]!,
      error_count: 2,
      total_cost_usd_micros: 10,
      total_tokens: 5,
      trace_count: 3,
    };
    expect(traceTotals([point, { ...point, bucket: BUCKETS[2]! }])).toEqual({
      costUsdMicros: 20,
      errors: 4,
      tokens: 10,
      traces: 6,
    });
  });
});

describe("grouped metrics", () => {
  const tracePoint = (bucket: string, traces: number, group?: string) => ({
    bucket,
    error_count: 0,
    ...(group === undefined ? {} : { group_value: group }),
    p95_duration_ms: 100 * traces,
    total_cost_usd_micros: traces * 10,
    total_tokens: traces * 100,
    trace_count: traces,
  });

  test("rank groups by window volume with CSS-safe keys and an unattributed group", () => {
    const grouped = groupedMetrics(
      {
        items: [
          tracePoint(BUCKETS[0]!, 1, "deployment-b"),
          tracePoint(BUCKETS[0]!, 2),
          tracePoint(BUCKETS[1]!, 5, "deployment-a"),
          tracePoint(BUCKETS[2]!, 3, "deployment-b"),
        ],
        source: "traces",
      },
      BUCKETS,
      (value) => value?.toUpperCase() ?? "Unattributed",
    );
    expect(
      grouped.groups.map(({ groupValue, key, label }) => ({ groupValue, key, label })),
    ).toEqual([
      { groupValue: "deployment-a", key: "s0", label: "DEPLOYMENT-A" },
      { groupValue: "deployment-b", key: "s1", label: "DEPLOYMENT-B" },
      { groupValue: null, key: "s2", label: "Unattributed" },
    ]);
    expect(grouped.groups[1]!.totals).toEqual({
      costUsdMicros: 40,
      errors: 0,
      source: "traces",
      tokens: 400,
      traces: 4,
    });
    if (grouped.source !== "traces") throw new Error("expected a trace series");
    expect(grouped.values.traces).toEqual([
      [0, 5, 0],
      [1, 0, 3],
      [2, 0, 0],
    ]);
    expect(grouped.values.p95[0]).toEqual([null, 500, null]);
    expect(groupedRows(grouped.buckets, grouped.groups, grouped.values.p95)).toEqual([
      { bucket: BUCKETS[0]!, s1: 100, s2: 200 },
      { bucket: BUCKETS[1]!, s0: 500 },
      { bucket: BUCKETS[2]!, s1: 300 },
    ]);
  });

  test("aggregate model invocations by invocation volume", () => {
    const grouped = groupedMetrics(
      {
        items: [
          {
            bucket: BUCKETS[0]!,
            cached_tokens: 3,
            error_count: 1,
            group_value: "openai/gpt-5",
            input_tokens: 10,
            invocation_count: 2,
            output_tokens: 4,
            total_cost_usd_micros: 7,
            total_tokens: 14,
          },
        ],
        source: "model-invocations",
      },
      BUCKETS,
      (value) => value ?? "Unattributed",
    );
    expect(grouped.source).toBe("model-invocations");
    expect(grouped.groups).toEqual([
      {
        groupValue: "openai/gpt-5",
        key: "s0",
        label: "openai/gpt-5",
        totals: {
          cachedTokens: 3,
          costUsdMicros: 7,
          errors: 1,
          inputTokens: 10,
          invocations: 2,
          outputTokens: 4,
          source: "model-invocations",
          tokens: 14,
        },
      },
    ]);
  });
});
