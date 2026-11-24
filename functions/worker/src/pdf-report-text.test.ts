import { describe, expect, test } from "bun:test";
import type { PDFFont } from "pdf-lib";
import { wrappedLines } from "./pdf-report-text.ts";

describe("PDF report text", () => {
  test("splits unbroken tokens to the available rendered width", () => {
    const font = {
      widthOfTextAtSize: (value: string) => Array.from(value).length,
    } as unknown as PDFFont;
    const lines = wrappedLines("prefix abcdefghijklmnopqrstuvwxyz suffix", font, 10, 10);
    expect(lines).toEqual(["prefix", "abcdefghij", "klmnopqrst", "uvwxyz", "suffix"]);
    expect(lines.every((line) => font.widthOfTextAtSize(line, 10) <= 10)).toBe(true);
  });
});
