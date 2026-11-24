import { describe, expect, test } from "bun:test";
import {
  pdfDocumentResult,
  withRecognizedPages,
  type PageRecognition,
  type PdfReading,
} from "./pdf-text.ts";

const MiB = 1024 * 1024;
const reading = (layers: readonly string[], readStop: PdfReading["readStop"] = "complete") => ({
  pageCount: layers.length,
  readStop,
  layers,
  scans: [],
});

async function written(source: PdfReading, recognized: readonly PageRecognition[]) {
  const document = await pdfDocumentResult(withRecognizedPages(source, recognized));
  if (document.status === "unusable") return document;
  const { text, ...verdict } = document;
  return { ...verdict, text: new TextDecoder().decode(text) };
}

describe("PDF text with OCR pages", () => {
  test("marks pages Textract read, keeps the layer of a page it rejected, and counts both", async () => {
    expect(
      await written(reading(["Cover letter for the quarterly review\n", "", "7", ""]), [
        {
          pageNumber: 2,
          result: "text",
          text: "Invoice 4417 from Acme Corp\nTotal due: 1,250.00 USD",
        },
        { pageNumber: 3, result: "rejected" },
        { pageNumber: 4, result: "text", text: "" },
      ]),
    ).toEqual({
      status: "text",
      mediaType: "application/pdf",
      truncated: false,
      facts: { kind: "pdf", pages: 4, pagesWithText: 3, ocrPages: 1 },
      text:
        "--- Page 1 ---\nCover letter for the quarterly review\n" +
        "\f--- Page 2 (OCR) ---\nInvoice 4417 from Acme Corp\nTotal due: 1,250.00 USD" +
        "\f--- Page 3 ---\n7" +
        "\f--- Page 4 (OCR) ---\n",
    });
  });

  test("names OCR in the no_text detail only when a page went through it", async () => {
    expect([
      await written(reading(["", ""]), [{ pageNumber: 1, result: "text", text: " \n" }]),
      await written(reading(["", ""]), [{ pageNumber: 1, result: "rejected" }]),
      await written(reading(["", ""]), []),
    ]).toEqual([
      {
        status: "unusable",
        reason: "no_text",
        detail: "the PDF has no text layer, and OCR found no text",
      },
      { status: "unusable", reason: "no_text", detail: "the PDF has no text layer" },
      { status: "unusable", reason: "no_text", detail: "the PDF has no text layer" },
    ]);
  });

  test("OCR text shares the text cap and stops on it in page order", async () => {
    const document = await written(reading(["", "Appendix"]), [
      { pageNumber: 1, result: "text", text: "é".repeat(2 * MiB) },
    ]);
    expect(
      document.status === "text" && [
        document.truncated,
        document.facts,
        Buffer.byteLength(document.text),
        document.text.includes("Page 2"),
      ],
    ).toEqual([true, { kind: "pdf", pages: 2, pagesWithText: 1, ocrPages: 1 }, 3 * MiB - 1, false]);
  });

  test("a reading that stopped at the text budget or the page cap is truncated even if it fits", async () => {
    const recognized: PageRecognition[] = [
      { pageNumber: 1, result: "text", text: "Scanned page one, read by OCR" },
    ];
    expect([
      await written(reading([""], "text_budget"), recognized),
      await written(reading([""], "page_limit"), recognized),
      await written(reading([""]), recognized),
    ]).toMatchObject([{ truncated: true }, { truncated: true }, { truncated: false }]);
  });
});
