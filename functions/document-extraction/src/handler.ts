import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCUMENT_TEXT_EXTRACTOR } from "@deployments-ai/agent-manifest/input-files";
import {
  clampExtractionDeadline,
  ExtractionWireRequest,
  type ExtractionWireResponse,
} from "@deployments-ai/file-text/wire";
import { readBoundedRawBody } from "@deployments-ai/net-security";
import { Schema } from "effect";
import { CHILD_BUNDLE_FILE } from "./child-protocol.ts";
import { pdfDocumentResult, withRecognizedPages } from "./engine/pdf-text.ts";
import type { ExtractedDocument } from "./engine/registry.ts";
import { LIMITS, ocrTimeNeededMs } from "./limits.ts";
import { ocrFromEnvironment } from "./ocr.ts";
import { runChild, type ChildRun } from "./supervisor.ts";

const CHILD_ENTRY = join(dirname(fileURLToPath(import.meta.url)), CHILD_BUNDLE_FILE);
const decodeRequest = Schema.decodeUnknownSync(ExtractionWireRequest);
const ocr = ocrFromEnvironment(process.env);

async function fetchSource(source: ExtractionWireRequest["source"]) {
  const response = await fetch(source.url, {
    redirect: "error",
    signal: AbortSignal.timeout(LIMITS.sourceFetchTimeoutMs),
  });
  if (!response.ok) throw new Error(`The source fetch failed with HTTP ${response.status}.`);
  const bytes = await readBoundedRawBody(response.body, {
    maxBytes: source.byteSize,
    contentLengthHeader: response.headers.get("content-length"),
  });
  if (bytes.byteLength !== source.byteSize) throw new Error("The source is shorter than declared.");
  if (createHash("sha256").update(bytes).digest("hex") !== source.sha256) {
    throw new Error("The source does not match its SHA-256.");
  }
  return bytes;
}

async function extract(run: Omit<ChildRun, "scans">, deadline: number): Promise<ExtractedDocument> {
  if (ocr.kind === "off") return runChild({ ...run, scans: "ignore" });
  const read = await runChild({ ...run, scans: "collect" });
  if (read.status !== "pdf_pages") return read;
  const left = deadline - Date.now();
  if (left < ocrTimeNeededMs(read.reading.scans.length)) {
    return {
      status: "unusable",
      reason: "limits_exceeded",
      detail: "reading the PDF left too little of the deadline for OCR",
    };
  }
  const recognized = await ocr.recognize(read.reading.scans, AbortSignal.timeout(left));
  return pdfDocumentResult(withRecognizedPages(read.reading, recognized));
}

/**
 * Lambda entry. Throws (a function error the client treats as transient) for a malformed request,
 * a source it could not fetch and verify, or scanned pages Textract could not read in time;
 * returns a verdict for everything about the bytes.
 */
export async function handler(event: unknown): Promise<ExtractionWireResponse> {
  const request = decodeRequest(event);
  if (request.extractor !== DOCUMENT_TEXT_EXTRACTOR) {
    return { status: "skew", extractor: DOCUMENT_TEXT_EXTRACTOR };
  }
  if (request.source.byteSize > LIMITS.maxSourceBytes) {
    return {
      status: "unusable",
      reason: "limits_exceeded",
      detail: `the file is larger than ${LIMITS.maxSourceBytes} bytes`,
    };
  }
  const bytes = await fetchSource(request.source);
  const deadlineMs = clampExtractionDeadline(request.deadlineMs);
  const extracted = await extract(
    {
      bytes,
      hint: request.hint,
      program: { nodePath: process.execPath, entry: CHILD_ENTRY },
      limits: { deadlineMs, maxResidentBytes: LIMITS.child.maxResidentBytes },
    },
    Date.now() + deadlineMs,
  );
  if (extracted.status === "unusable") return extracted;
  const { text, ...verdict } = extracted;
  return {
    ...verdict,
    textBase64: Buffer.from(text).toString("base64"),
    textSha256: createHash("sha256").update(text).digest("hex"),
  };
}
