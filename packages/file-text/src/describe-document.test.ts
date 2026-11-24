import { describe, expect, test } from "bun:test";
import { describeDocument } from "./describe-document.ts";

describe("describeDocument", () => {
  test.each([
    [{ pages: 3, pagesWithText: 3, ocrPages: 0 }, "PDF, 3 pages"],
    [{ pages: 3, pagesWithText: 2, ocrPages: 0 }, "PDF, 3 pages (1 without text)"],
    [{ pages: 3, pagesWithText: 3, ocrPages: 2 }, "PDF, 3 pages (2 read by OCR)"],
    [
      { pages: 40, pagesWithText: 21, ocrPages: 20 },
      "PDF, 40 pages (20 read by OCR, 19 without text)",
    ],
    [{ pages: 1, pagesWithText: 1, ocrPages: 1 }, "PDF, 1 page (1 read by OCR)"],
  ])("summarizes PDF pages %o as %s", (pages, summary) => {
    expect(describeDocument("application/pdf", { kind: "pdf", ...pages })).toBe(summary);
  });

  test("names each sheet with its rows and counts hidden ones", () => {
    expect(
      describeDocument("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", {
        hiddenSheets: 1,
        kind: "workbook",
        sheets: [
          { name: "Revenue", rows: 1_204 },
          { name: "Notes", rows: 12 },
        ],
      }),
    ).toBe("Excel workbook, 2 sheets (Revenue 1,204 rows; Notes 12 rows), 1 hidden sheet omitted");
  });

  test("lists what an archive yielded and how much it skipped", () => {
    expect(
      describeDocument("application/zip", {
        extracted: [
          { mediaType: "text/csv", path: "a.csv" },
          { mediaType: "application/pdf", path: "docs/b.pdf" },
        ],
        kind: "archive",
        skipped: [{ path: "nested.zip", reason: "nested_archive" }],
        skippedTotal: 1,
      }),
    ).toBe("ZIP archive, 2 files extracted (a.csv, docs/b.pdf), 1 skipped");
  });

  test("stays within 200 characters when the file's names are long", () => {
    const summary = describeDocument(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      {
        hiddenSheets: 0,
        kind: "workbook",
        sheets: Array.from({ length: 20 }, (_, index) => ({ name: `Quarter ${index}`, rows: 10 })),
      },
    );
    expect([Array.from(summary).length, summary.slice(0, 40), summary.at(-1)]).toEqual([
      200,
      "Excel workbook, 20 sheets (Quarter 0 10 ",
      "…",
    ]);
  });

  test("counts UTF-16 code units, as the artifact record does, and never splits a character", () => {
    const summary = describeDocument(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      { hiddenSheets: 0, kind: "workbook", sheets: [{ name: `a${"📈".repeat(127)}`, rows: 10 }] },
    );
    expect([summary.length, summary.slice(0, 26), summary.slice(-3)]).toEqual([
      199,
      "Excel workbook, 1 sheet (a",
      "📈…",
    ]);
  });
});
