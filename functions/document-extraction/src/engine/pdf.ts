import {
  getDocument,
  OPS,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { LIMITS } from "../limits.ts";
import type { Extractor } from "./extractor.ts";
import {
  pageBlock,
  withRecognizedPages,
  writePdfText,
  type PdfReading,
  type ScannedPage,
} from "./pdf-text.ts";
import { UnusableFile } from "./unusable.ts";

// pdf.js runs its "fake worker" in-thread from this global, so it never imports a worker script
// at runtime (the child may only read its own bundle).
Reflect.set(globalThis, "pdfjsWorker", pdfjsWorker);

export type ScanCollection = "collect" | "ignore";

const RASTER_PAINTS = new Set<number>([
  OPS.paintImageMaskXObject,
  OPS.paintImageMaskXObjectGroup,
  OPS.paintImageXObject,
  OPS.paintInlineImageXObject,
  OPS.paintInlineImageXObjectGroup,
  OPS.paintImageXObjectRepeat,
  OPS.paintImageMaskXObjectRepeat,
  OPS.paintSolidColorImageMask,
]);

async function paintsRaster(page: PDFPageProxy): Promise<boolean> {
  const operators = await page.getOperatorList().catch(() => undefined);
  return operators?.fnArray.some((operator) => RASTER_PAINTS.has(operator)) ?? false;
}

async function isScan(page: PDFPageProxy, text: string): Promise<boolean> {
  if (text.replaceAll(/\s/gu, "").length >= LIMITS.pdf.minTextCharacters) return false;
  return paintsRaster(page);
}

async function cutScans(
  document: PDFDocumentProxy,
  candidates: readonly number[],
): Promise<ScannedPage[]> {
  const scans: ScannedPage[] = [];
  let scanBytes = 0;
  for (const pageNumber of candidates) {
    const pdf = await document
      .extractPages([{ document: null, includePages: [pageNumber - 1] }])
      .catch(() => undefined);
    if (
      pdf !== undefined &&
      pdf.byteLength <= LIMITS.ocr.maxPageBytes &&
      scanBytes + pdf.byteLength <= LIMITS.ocr.maxTotalPageBytes
    ) {
      scans.push({ pageNumber, pdf });
      scanBytes += pdf.byteLength;
    }
  }
  return scans;
}

export async function readPdf(
  bytes: Uint8Array,
  options: { readonly layoutBudgetBytes: number; readonly scans: ScanCollection },
): Promise<PdfReading> {
  const task = getDocument({
    data: bytes,
    disableFontFace: true,
    stopAtErrors: false,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    const document = await task.promise.catch((error: unknown) => {
      if (error instanceof Error && error.name === "PasswordException") {
        throw new UnusableFile("encrypted", "the PDF requires a password");
      }
      throw new UnusableFile("unreadable", "the PDF structure is invalid");
    });
    const readable = Math.min(document.numPages, LIMITS.pdf.maxPages);
    const layers: string[] = [];
    const candidates: number[] = [];
    let layoutBytes = 0;
    let readStop: PdfReading["readStop"] = document.numPages > readable ? "page_limit" : "complete";
    for (let number = 1; number <= readable; number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? `${item.str}${item.hasEOL ? "\n" : ""}` : ""))
        .join("");
      if (
        options.scans === "collect" &&
        candidates.length < LIMITS.ocr.maxPages &&
        (await isScan(page, text))
      ) {
        candidates.push(number);
      }
      page.cleanup();
      layers.push(text);
      layoutBytes += Buffer.byteLength(pageBlock(number, { source: "layer", text }));
      if (layoutBytes > options.layoutBudgetBytes) {
        readStop = "text_budget";
        break;
      }
    }
    return {
      pageCount: document.numPages,
      readStop,
      layers,
      scans: await cutScans(document, candidates),
    };
  } finally {
    await task.destroy();
  }
}

export const extractPdfTextLayer: Extractor<Uint8Array> = async (bytes, context) => {
  const reading = await readPdf(bytes, {
    layoutBudgetBytes: context.sink.capacity - context.sink.byteLength,
    scans: "ignore",
  });
  return writePdfText(context.sink, withRecognizedPages(reading, []));
};
