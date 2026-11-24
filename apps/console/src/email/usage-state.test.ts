import { describe, expect, test } from "bun:test";
import { parseUsageSearch, usageWindow } from "./usage-state.ts";

describe("usage search and window", () => {
  test("keeps known presets, drops the default and junk", () => {
    expect(parseUsageSearch({ range: "7d" })).toEqual({ range: "7d" });
    expect(parseUsageSearch({ range: "30d" })).toEqual({});
    expect(parseUsageSearch({ inbox: "nope", range: "90d" })).toEqual({});
    expect(parseUsageSearch({ inbox: "01J9ZQ4V6X8Y2K3M5N7P9R1TQ1" })).toEqual({
      inbox: "01J9ZQ4V6X8Y2K3M5N7P9R1TQ1",
    });
  });

  test("every preset stays inside the runtime's 31-day limit", () => {
    const now = new Date("2026-10-07T00:00:00.000Z");
    expect(usageWindow("24h", now)).toEqual({
      from: "2026-10-06T00:00:00.000Z",
      to: "2026-10-07T00:00:00.000Z",
    });
    expect(usageWindow("30d", now).from).toBe("2026-09-07T00:00:00.000Z");
  });
});
