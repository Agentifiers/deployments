import { describe, expect, test } from "bun:test";
import { formatUsdTick, valueAxis } from "./axis.ts";
import { formatBucket, formatCompact, formatDurationMs } from "./format.ts";

const MICROS = { integer: true, kind: "number", perUnit: 1e-6 } as const;

function usdLabels(maxUsd: number) {
  const axis = valueAxis(maxUsd * 1e6, MICROS);
  return axis.ticks.map((tick) => formatUsdTick(tick / 1e6, axis.step));
}

describe("value axes", () => {
  test("never repeat a label", () => {
    const maxima = [0, 3, 120, 4_000, 15_000, 20_000, 23_000, 190_000, 1_700_000, 12_300_000];
    for (const max of maxima) {
      const usd = usdLabels(max / 1e6);
      expect(new Set(usd).size).toBe(usd.length);
      const counts = valueAxis(max, { integer: true, kind: "number" }).ticks.map(formatCompact);
      expect(new Set(counts).size).toBe(counts.length);
      const durations = valueAxis(max, { kind: "duration" }).ticks.map(formatDurationMs);
      expect(new Set(durations).size).toBe(durations.length);
    }
  });

  test("carry the decimals a sub-cent step needs", () => {
    expect(usdLabels(0.02)).toEqual(["$0.000", "$0.005", "$0.010", "$0.015", "$0.020"]);
    expect(usdLabels(0.031)).toEqual(["$0.00", "$0.01", "$0.02", "$0.03", "$0.04"]);
    expect(usdLabels(12.3)).toEqual(["$0", "$5", "$10", "$15"]);
  });

  test("step counts by whole units", () => {
    expect(valueAxis(1, { integer: true, kind: "number" }).ticks).toEqual([0, 1]);
    expect(valueAxis(3, { integer: true, kind: "number" }).ticks).toEqual([0, 1, 2, 3]);
  });
});

describe("bucket labels", () => {
  // 02:00 UTC is still the previous evening in the Americas; every label stays on the UTC day.
  const bucket = "2026-10-02T02:00:00.000Z";

  test("daily buckets name their UTC date", () => {
    expect(formatBucket("2026-10-02T00:00:00.000Z", "day", "axis")).toBe("Oct 2");
    expect(formatBucket("2026-10-02T00:00:00.000Z", "day", "full")).toBe("Oct 2 (UTC)");
  });

  test("hourly buckets are UTC hours too", () => {
    expect(formatBucket(bucket, "hour", "axis")).toBe("2 AM");
    expect(formatBucket(bucket, "hour", "dated-axis")).toBe("Oct 2, 2 AM");
    expect(formatBucket(bucket, "hour", "full")).toBe("Oct 2, 2:00 AM (UTC)");
  });
});
