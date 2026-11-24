import { describe, expect, test } from "bun:test";
import { paginatePdfCalloutLines } from "./pdf-report-callout.ts";

describe("PDF callout pagination", () => {
  test("bounds every decorated callout segment to its page", () => {
    const lines = Array.from({ length: 100 }, (_, index) => `line ${index}`);
    const segments = paginatePdfCalloutLines(lines, 100, 600);

    expect(segments.length).toBeGreaterThan(1);
    expect(segments.flatMap((segment) => segment.lines)).toEqual(lines);
    expect(segments[0]!.startsNewPage).toBe(false);
    expect(segments[0]!.height).toBeLessThanOrEqual(100);
    for (const segment of segments.slice(1)) {
      expect(segment.startsNewPage).toBe(true);
      expect(segment.height).toBeLessThanOrEqual(600);
    }
  });

  test("moves a callout to a fresh page when the current remainder is too small", () => {
    const [segment] = paginatePdfCalloutLines(["one line"], 20, 600);
    expect(segment).toMatchObject({ startsNewPage: true });
    expect(segment!.height).toBeLessThanOrEqual(600);
  });
});
