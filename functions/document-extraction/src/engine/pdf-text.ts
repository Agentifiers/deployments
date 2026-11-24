import type { DocumentFacts } from "@deployments-ai/file-text";
import { LIMITS } from "../limits.ts";
import type { ExtractedDocument } from "./registry.ts";
import { TextSink, untilTextBudget } from "./text-sink.ts";
import { UnusableFile } from "./unusable.ts";

export type PdfReadStop = "complete" | "page_limit" | "text_budget";

export interface PdfPageText {
  readonly source: "layer" | "ocr";
  readonly text: string;
}

export interface PdfText {
  readonly pageCount: number;
  readonly readStop: PdfReadStop;
  readonly pages: readonly PdfPageText[];
}

export interface ScannedPage {
  readonly pageNumber: number;
  readonly pdf: Uint8Array;
}

export type NonEmpty<T> = readonly [T, ...T[]];

export interface PdfReading {
  readonly pageCount: number;
  readonly readStop: PdfReadStop;
  readonly layers: readonly string[];
  readonly scans: readonly ScannedPage[];
}

export type PdfReadingForOcr = PdfReading & { readonly scans: NonEmpty<ScannedPage> };

export type PageRecognition =
  | { readonly pageNumber: number; readonly result: "text"; readonly text: string }
  | { readonly pageNumber: number; readonly result: "rejected" };

type PdfFacts = Extract<DocumentFacts, { readonly kind: "pdf" }>;

export function pageBlock(number: number, page: PdfPageText): string {
  const header = `--- Page ${number}${page.source === "ocr" ? " (OCR)" : ""} ---`;
  return `${number > 1 ? "\f" : ""}${header}\n${page.text}`;
}

export async function writePdfText(sink: TextSink, pdf: PdfText): Promise<PdfFacts> {
  let pagesWithText = 0;
  let ocrPages = 0;
  let characters = 0;
  await untilTextBudget(() => {
    for (const [index, page] of pdf.pages.entries()) {
      const visible = page.text.replaceAll(/\s/gu, "").length;
      characters += visible;
      if (visible > 0) pagesWithText += 1;
      if (visible > 0 && page.source === "ocr") ocrPages += 1;
      sink.write(pageBlock(index + 1, page));
    }
  });
  const textCut = sink.truncated || pdf.readStop === "text_budget";
  if (characters < LIMITS.pdf.minTextCharacters && !textCut) {
    throw new UnusableFile(
      "no_text",
      pdf.pages.some((page) => page.source === "ocr")
        ? "the PDF has no text layer, and OCR found no text"
        : "the PDF has no text layer",
    );
  }
  if (pdf.readStop !== "complete") sink.markTruncated();
  return { kind: "pdf", pages: pdf.pageCount, pagesWithText, ocrPages };
}

export async function pdfDocumentResult(pdf: PdfText): Promise<ExtractedDocument> {
  const sink = new TextSink(LIMITS.maxTextBytes);
  try {
    const facts = await writePdfText(sink, pdf);
    return {
      status: "text",
      mediaType: "application/pdf",
      truncated: sink.truncated,
      facts,
      text: sink.bytes(),
    };
  } catch (error) {
    if (!(error instanceof UnusableFile)) throw error;
    return { status: "unusable", reason: error.reason, detail: error.detail };
  }
}

export function withRecognizedPages(
  reading: PdfReading,
  recognized: readonly PageRecognition[],
): PdfText {
  const ocrText = new Map(
    recognized.flatMap((page) => (page.result === "text" ? [[page.pageNumber, page.text]] : [])),
  );
  return {
    pageCount: reading.pageCount,
    readStop: reading.readStop,
    pages: reading.layers.map((text, index) => {
      const read = ocrText.get(index + 1);
      return read === undefined ? { source: "layer", text } : { source: "ocr", text: read };
    }),
  };
}
