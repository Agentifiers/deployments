import { describe, expect, test } from "bun:test";
import { formatDelta } from "./format.ts";

describe("formatDelta", () => {
  test("signs candidate-minus-baseline deltas", () => {
    expect(formatDelta(0.05, "points")).toBe("+5.0 pp");
    expect(formatDelta(-0.125, "score")).toBe("−0.125");
    expect(formatDelta(-1_500, "duration")).toBe("−1.5 s");
    expect(formatDelta(2_500_000, "usd")).toBe("+$2.50");
    expect(formatDelta(-1_234, "count")).toBe("−1,234");
  });

  test("leaves deltas that display as zero unsigned", () => {
    expect(formatDelta(0, "count")).toBe("0");
    expect(formatDelta(0.0001, "points")).toBe("0.0 pp");
    expect(formatDelta(-0.3, "duration")).toBe("0 ms");
  });

  test("renders an absent delta as a dash", () => {
    expect(formatDelta(undefined, "score")).toBe("—");
  });
});
