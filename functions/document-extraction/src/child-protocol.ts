import { isUtf8 } from "node:buffer";
import type { InputFileHint } from "@deployments-ai/agent-manifest/input-files";
import { ExtractionVerdict, ExtractionWireRequest } from "@deployments-ai/file-text/wire";
import { Exit, Schema } from "effect";
import type { ScannedPage } from "./engine/pdf-text.ts";
import type { ScanCollection } from "./engine/pdf.ts";
import type { ChildResult, ExtractedDocument } from "./engine/registry.ts";
import { LIMITS } from "./limits.ts";

export const CHILD_BUNDLE_FILE = "child.mjs";
export const SANDBOX_UNAVAILABLE_EXIT_CODE = 78;

export interface ChildInput {
  readonly hint: InputFileHint;
  readonly bytes: Uint8Array;
  readonly scans: ScanCollection;
}

const HEADER_END = 0x0a;
const Count = Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)));
const decodeInputHeader = Schema.decodeUnknownSync(
  Schema.Struct({
    hint: ExtractionWireRequest.fields.hint,
    scans: Schema.Literals(["collect", "ignore"]),
  }),
);
const decodeVerdict = Schema.decodeUnknownExit(ExtractionVerdict);
const decodePdfPagesHeader = Schema.decodeUnknownExit(
  Schema.Struct({
    status: Schema.Literal("pdf_pages"),
    pageCount: Count,
    readStop: Schema.Literals(["complete", "page_limit", "text_budget"]),
    layerBytes: Schema.Array(Count).pipe(Schema.check(Schema.isMaxLength(LIMITS.pdf.maxPages))),
    scans: Schema.Array(Schema.Struct({ pageNumber: Count, bytes: Count })).pipe(
      Schema.check(Schema.isMinLength(1), Schema.isMaxLength(LIMITS.ocr.maxPages)),
    ),
  }),
);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeFrame(header: object, ...body: readonly Uint8Array[]): Uint8Array {
  return Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), ...body]);
}

function decodeFrame(
  frame: Uint8Array,
): { readonly header: unknown; readonly body: Uint8Array } | undefined {
  const headerEnd = frame.indexOf(HEADER_END);
  if (headerEnd < 0) return undefined;
  try {
    return {
      header: JSON.parse(decoder.decode(frame.subarray(0, headerEnd))),
      body: new Uint8Array(frame.subarray(headerEnd + 1)),
    };
  } catch {
    return undefined;
  }
}

const unreadable = (detail: string): ExtractedDocument => ({
  status: "unusable",
  reason: "unreadable",
  detail,
});
const MALFORMED = unreadable("the parser returned a malformed result");

export function childStdoutLimit(scans: ScanCollection): number {
  const verdict = LIMITS.maxTextBytes + LIMITS.child.verdictHeaderAllowanceBytes;
  return scans === "collect" ? verdict + LIMITS.ocr.maxTotalPageBytes : verdict;
}

export function encodeChildInput({ hint, bytes, scans }: ChildInput): Uint8Array {
  return encodeFrame({ hint, scans }, bytes);
}

export function decodeChildInput(input: Uint8Array): ChildInput {
  const frame = decodeFrame(input);
  if (frame === undefined) throw new Error("The supervisor sent a malformed input frame.");
  return { ...decodeInputHeader(frame.header), bytes: frame.body };
}

function encodeLayersWithinTextCap(layers: readonly string[]): readonly Uint8Array[] {
  const budget = new Uint8Array(LIMITS.maxTextBytes);
  let used = 0;
  let cut = false;
  return layers.map((layer) => {
    if (cut) return new Uint8Array();
    const { read, written } = encoder.encodeInto(layer, budget.subarray(used));
    cut = read < layer.length;
    used += written;
    return budget.subarray(used - written, used);
  });
}

export function encodeChildOutput(result: ChildResult): Uint8Array {
  switch (result.status) {
    case "unusable":
      return encodeFrame(result);
    case "text": {
      const { text, ...verdict } = result;
      return encodeFrame(verdict, text);
    }
    case "pdf_pages": {
      const { pageCount, readStop, layers, scans } = result.reading;
      const layerBytes = encodeLayersWithinTextCap(layers);
      return encodeFrame(
        {
          status: "pdf_pages",
          pageCount,
          readStop,
          layerBytes: layerBytes.map((layer) => layer.byteLength),
          scans: scans.map(({ pageNumber, pdf }) => ({ pageNumber, bytes: pdf.byteLength })),
        },
        ...layerBytes,
        ...scans.map(({ pdf }) => pdf),
      );
    }
    default: {
      const unhandled: never = result;
      return unhandled;
    }
  }
}

function decodePdfPages(
  header: unknown,
  body: Uint8Array,
): Extract<ChildResult, { readonly status: "pdf_pages" }> | undefined {
  const decoded = decodePdfPagesHeader(header);
  if (Exit.isFailure(decoded)) return undefined;
  const { pageCount, readStop, layerBytes, scans } = decoded.value;
  const layerTotal = layerBytes.reduce((sum, bytes) => sum + bytes, 0);
  const scanTotal = scans.reduce((sum, scan) => sum + scan.bytes, 0);
  if (
    layerTotal + scanTotal !== body.byteLength ||
    layerTotal > LIMITS.maxTextBytes ||
    scanTotal > LIMITS.ocr.maxTotalPageBytes ||
    pageCount < layerBytes.length ||
    scans.some(
      ({ pageNumber, bytes }, index) =>
        pageNumber < 1 ||
        pageNumber > layerBytes.length ||
        pageNumber <= (scans[index - 1]?.pageNumber ?? 0) ||
        bytes > LIMITS.ocr.maxPageBytes,
    )
  ) {
    return undefined;
  }
  let offset = 0;
  const take = (bytes: number) => {
    const part = body.subarray(offset, offset + bytes);
    offset += bytes;
    return part;
  };
  const layers = layerBytes.map(take);
  if (!layers.every((layer) => isUtf8(layer))) return undefined;
  const [first, ...rest] = scans.map(
    ({ pageNumber, bytes }): ScannedPage => ({ pageNumber, pdf: take(bytes) }),
  );
  if (first === undefined) return undefined;
  return {
    status: "pdf_pages",
    reading: {
      pageCount,
      readStop,
      layers: layers.map((layer) => decoder.decode(layer)),
      scans: [first, ...rest],
    },
  };
}

export function decodeChildOutput(output: Uint8Array, scans: "ignore"): ExtractedDocument;
export function decodeChildOutput(output: Uint8Array, scans: ScanCollection): ChildResult;
export function decodeChildOutput(output: Uint8Array, scans: ScanCollection): ChildResult {
  const frame = decodeFrame(output);
  if (frame === undefined) return MALFORMED;
  const verdict = decodeVerdict(frame.header);
  if (Exit.isFailure(verdict)) {
    const pages = scans === "collect" ? decodePdfPages(frame.header, frame.body) : undefined;
    return pages ?? MALFORMED;
  }
  if (verdict.value.status === "unusable") return verdict.value;
  if (!isUtf8(frame.body)) return unreadable("the parser returned text that is not UTF-8");
  if (frame.body.byteLength > LIMITS.maxTextBytes) {
    return unreadable("the parser returned more text than allowed");
  }
  return { ...verdict.value, text: frame.body };
}
