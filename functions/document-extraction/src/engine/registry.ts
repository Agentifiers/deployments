import type { DocumentMediaType, InputFileHint } from "@deployments-ai/agent-manifest/input-files";
import type { ExtractionVerdict } from "@deployments-ai/file-text/wire";
import { LIMITS } from "../limits.ts";
import { archiveExtractor } from "./archive.ts";
import { extractDocx } from "./docx.ts";
import type {
  DecodedText,
  ExtractionContext,
  Extractor,
  TextDocumentMediaType,
} from "./extractor.ts";
import { extractHtml } from "./html.ts";
import { pdfDocumentResult, withRecognizedPages, type PdfReadingForOcr } from "./pdf-text.ts";
import { extractPdfTextLayer, readPdf, type ScanCollection } from "./pdf.ts";
import { sniff, type SniffedFile } from "./sniff.ts";
import { TextSink } from "./text-sink.ts";
import { extractText } from "./text.ts";
import { UnusableFile } from "./unusable.ts";
import { extractXlsx } from "./xlsx.ts";
import { InflationBudget } from "./zip.ts";

const EXTRACTORS: {
  readonly [T in DocumentMediaType]: Extractor<
    T extends TextDocumentMediaType ? DecodedText : Uint8Array
  >;
} = {
  "application/json": extractText,
  "application/pdf": extractPdfTextLayer,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": extractXlsx,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": extractDocx,
  "application/zip": archiveExtractor(extractSniffed),
  "text/csv": extractText,
  "text/html": extractHtml,
  "text/markdown": extractText,
  "text/plain": extractText,
};

function extractSniffed(sniffed: SniffedFile, bytes: Uint8Array, context: ExtractionContext) {
  switch (sniffed.family) {
    case "binary":
      return EXTRACTORS[sniffed.mediaType](bytes, context);
    case "text":
      return EXTRACTORS[sniffed.mediaType](sniffed.decoded, context);
    default: {
      const unhandled: never = sniffed;
      return unhandled;
    }
  }
}

export type ExtractedDocument =
  | (Extract<ExtractionVerdict, { readonly status: "text" }> & { readonly text: Uint8Array })
  | Extract<ExtractionVerdict, { readonly status: "unusable" }>;

const LAYOUT_BYTES = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x20]);

export type ChildResult =
  | ExtractedDocument
  | { readonly status: "pdf_pages"; readonly reading: PdfReadingForOcr };

export function extractDocument(
  bytes: Uint8Array,
  hint: InputFileHint,
  scans: "ignore",
): Promise<ExtractedDocument>;
export function extractDocument(
  bytes: Uint8Array,
  hint: InputFileHint,
  scans: ScanCollection,
): Promise<ChildResult>;
export async function extractDocument(
  bytes: Uint8Array,
  hint: InputFileHint,
  scans: ScanCollection,
): Promise<ChildResult> {
  const sink = new TextSink(LIMITS.maxTextBytes);
  try {
    const sniffed = sniff(bytes, hint);
    if (scans === "collect" && sniffed.mediaType === "application/pdf") {
      const reading = await readPdf(bytes, { layoutBudgetBytes: sink.capacity, scans });
      const [first, ...rest] = reading.scans;
      return first === undefined
        ? await pdfDocumentResult(withRecognizedPages(reading, []))
        : { status: "pdf_pages", reading: { ...reading, scans: [first, ...rest] } };
    }
    const facts = await extractSniffed(sniffed, bytes, { sink, inflation: new InflationBudget() });
    const text = sink.bytes();
    if (!text.some((byte) => !LAYOUT_BYTES.has(byte))) {
      throw new UnusableFile("no_text", "the file has no text");
    }
    return {
      status: "text",
      mediaType: sniffed.mediaType,
      truncated: sink.truncated,
      facts,
      text,
    };
  } catch (error) {
    const unusable =
      error instanceof UnusableFile
        ? error
        : new UnusableFile(
            "unreadable",
            `the parser failed (${error instanceof Error ? error.name : "unknown error"})`,
          );
    return { status: "unusable", reason: unusable.reason, detail: unusable.detail };
  }
}
