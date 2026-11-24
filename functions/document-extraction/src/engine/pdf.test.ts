import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { pdfPages } from "../test-fixtures/pdf-pages.ts";
import { passwordProtectedPdf, textPdf } from "../test-fixtures/pdf.ts";
import type { ScanCollection } from "./pdf.ts";
import { extractDocument } from "./registry.ts";

const MiB = 1024 * 1024;
const fullPage = (page: number) =>
  Array.from({ length: 50 }, (_, line) => `${page}.${line} ${"North region revenue ".repeat(4)}`);

async function observed(bytes: Uint8Array, fileName: string, scans: ScanCollection) {
  const document = await extractDocument(bytes, { fileName }, scans);
  if (document.status !== "text") return document;
  const { text, ...verdict } = document;
  return {
    ...verdict,
    textBytes: text.byteLength,
    textSha256: createHash("sha256").update(text).digest("hex"),
  };
}

async function collected(bytes: Uint8Array) {
  const result = await extractDocument(bytes, { fileName: "scan.pdf" }, "collect");
  if (result.status !== "pdf_pages") return result;
  return {
    ...result.reading,
    scans: await Promise.all(
      result.reading.scans.map(async ({ pageNumber, pdf }) => ({
        pageNumber,
        pages: await pdfPages(pdf),
      })),
    ),
  };
}

describe.each(["ignore", "collect"] as const)(
  "PDF text layer output with scans set to %s, pinned to what the engine wrote before OCR existed",
  (scans) => {
    test.each([
      [
        "three text pages",
        "report.pdf",
        textPdf([["Revenue summary"], ["North region", "grew 8%"], ["Appendix (draft)"]]),
        {
          status: "text",
          mediaType: "application/pdf",
          truncated: false,
          facts: { kind: "pdf", pages: 3, pagesWithText: 3, ocrPages: 0 },
          textBytes: 98,
          textSha256: "59c9bb613c7e31e498df51397349708b23d1040c47dcf7a1eb7f39c454489ff9",
        },
      ],
      [
        "a page without text between two text pages",
        "mixed.pdf",
        textPdf([["Cover letter for the quarterly review"], "vector-only", ["Appendix"]]),
        {
          status: "text",
          mediaType: "application/pdf",
          truncated: false,
          facts: { kind: "pdf", pages: 3, pagesWithText: 2, ocrPages: 0 },
          textBytes: 92,
          textSha256: "1f081b53429b7558ac8cb458e4f71d8e6d8143235daf2fe73f051888aa889ba6",
        },
      ],
      [
        "fewer visible characters than the text threshold",
        "short.pdf",
        textPdf([["Draft"], "vector-only"]),
        { status: "unusable", reason: "no_text", detail: "the PDF has no text layer" },
      ],
      [
        "more text than the text cap",
        "long.pdf",
        textPdf(Array.from({ length: 900 }, (_, page) => fullPage(page + 1))),
        {
          status: "text",
          mediaType: "application/pdf",
          truncated: true,
          facts: { kind: "pdf", pages: 900, pagesWithText: 692, ocrPages: 0 },
          textBytes: 3 * MiB,
          textSha256: "90348ad1debccb0500118dc5c5b684143d6f98287b4ec59d5376507440874472",
        },
      ],
      [
        "more pages than the page cap",
        "pages.pdf",
        textPdf(Array.from({ length: 1_001 }, (_, page) => [`p${page + 1}`])),
        {
          status: "text",
          mediaType: "application/pdf",
          truncated: true,
          facts: { kind: "pdf", pages: 1_001, pagesWithText: 1_000, ocrPages: 0 },
          textBytes: 21_785,
          textSha256: "d6a994008784a5a867e4e0e4b9909bade7035ef9c99abecf2468addd5b71d4e7",
        },
      ],
      [
        "a password",
        "locked.pdf",
        passwordProtectedPdf(),
        { status: "unusable", reason: "encrypted", detail: "the PDF requires a password" },
      ],
      [
        "an archive entry that meets the text cap",
        "bundle.zip",
        zipSync({
          "a.txt": [new TextEncoder().encode("a".repeat(3 * MiB - 120)), { level: 0 }],
          "b.pdf": textPdf([["Revenue summary"], ["North region grew 8%"]]),
        }),
        {
          status: "text",
          mediaType: "application/zip",
          truncated: true,
          facts: {
            kind: "archive",
            extracted: [
              { path: "a.txt", mediaType: "text/plain" },
              { path: "b.pdf", mediaType: "application/pdf" },
            ],
            skipped: [],
            skippedTotal: 0,
          },
          textBytes: 3 * MiB,
          textSha256: "8128e865cef50d522b37d4a9eb57fa8daa4da4bf1a5eeb56e00398063da7028e",
        },
      ],
    ] as const)("a PDF with %s", async (_name, fileName, bytes, expected) => {
      expect(await observed(bytes, fileName, scans)).toEqual(expected);
    });
  },
);

describe("scanned pages of a top-level PDF read with collect", () => {
  test("are cut out one page each, while text, blank and vector pages keep their layers", async () => {
    expect(
      await collected(
        textPdf([
          ["Cover letter for the quarterly review"],
          { scanWidth: 600 },
          "vector-only",
          [],
          { scanWidth: 601 },
        ]),
      ),
    ).toEqual({
      pageCount: 5,
      readStop: "complete",
      layers: ["Cover letter for the quarterly review", "", "", "", ""],
      scans: [
        { pageNumber: 2, pages: [{ width: 600, imageXObjectPaints: 1 }] },
        { pageNumber: 5, pages: [{ width: 601, imageXObjectPaints: 1 }] },
      ],
    });
  });

  test("stop at the first 12, and later scanned pages keep their layers", async () => {
    const result = await collected(
      textPdf(Array.from({ length: 14 }, (_, index) => ({ scanWidth: 600 + index }))),
    );
    expect(
      "scans" in result &&
        result.scans.map(({ pageNumber, pages }) => [pageNumber, pages[0]?.width]),
    ).toEqual(Array.from({ length: 12 }, (_, index) => [index + 1, 600 + index]));
  });

  test("inside a ZIP are not collected, so the archive reads as it always has", async () => {
    expect(
      await observed(
        zipSync({ "scan.pdf": textPdf([{ scanWidth: 600 }]) }),
        "bundle.zip",
        "collect",
      ),
    ).toEqual({
      status: "unusable",
      reason: "no_text",
      detail: "every entry in the archive was skipped: no readable text",
    });
  });
});
