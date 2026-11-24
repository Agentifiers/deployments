import { expect, test } from "bun:test";
import { formatDurationMs } from "./format.ts";

test("durations carry into the next unit instead of showing 60", () => {
  expect(formatDurationMs(999.6)).toBe("1.0 s");
  expect(formatDurationMs(59_960)).toBe("1m");
  expect(formatDurationMs(119_600)).toBe("2m");
  expect(formatDurationMs(125_400)).toBe("2m 5s");
  expect(formatDurationMs(850)).toBe("850 ms");
  expect(formatDurationMs(1_250)).toBe("1.3 s");
});
