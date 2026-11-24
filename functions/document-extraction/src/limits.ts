import {
  MAX_DOCUMENT_SOURCE_BYTES,
  MAX_DOCUMENT_TEXT_BYTES,
} from "@deployments-ai/agent-manifest/input-files";

const MiB = 1024 * 1024;
const CHILD_HEAP_MiB = 1_024;
const CHILD_OFF_HEAP_ALLOWANCE_MiB = 512;
const OCR_TIMING = {
  phaseBudgetMs: 9_000,
  concurrency: 4,
  // About the p95 of six real DetectDocumentText calls on one-page scans in us-east-2
  // (1,384 to 3,140 ms, connection setup included).
  expectedPageMs: 3_000,
} as const;

export const LIMITS = {
  maxSourceBytes: MAX_DOCUMENT_SOURCE_BYTES,
  sourceFetchTimeoutMs: 8_000,
  maxTextBytes: MAX_DOCUMENT_TEXT_BYTES,
  child: {
    maxOldSpaceMiB: CHILD_HEAP_MiB,
    maxResidentBytes: (CHILD_HEAP_MiB + CHILD_OFF_HEAP_ALLOWANCE_MiB) * MiB,
    residentPollMs: 100,
    verdictHeaderAllowanceBytes: 64 * 1024,
  },
  zip: {
    maxCentralDirectoryEntries: 1_000,
    maxEntryInflatedBytes: 128 * MiB,
    maxTotalInflatedBytes: 256 * MiB,
    maxCompressionRatio: 200,
    ratioFloorBytes: 1 * MiB,
    inflateSliceBytes: 4 * 1024,
  },
  archive: {
    maxExtractedEntries: 32,
    maxEntryBytes: 10 * MiB,
    maxListedSkips: 64,
  },
  pdf: { maxPages: 1_000, minTextCharacters: 16 },
  ocr: {
    ...OCR_TIMING,
    maxPages:
      Math.floor(OCR_TIMING.phaseBudgetMs / OCR_TIMING.expectedPageMs) * OCR_TIMING.concurrency,
    maxPageBytes: 10_000_000,
    maxTotalPageBytes: 64 * MiB,
  },
  xlsx: { maxCells: 2_000_000, maxSharedStrings: 1_000_000, maxSheets: 64 },
  xml: { maxDepth: 256 },
} as const;

export function ocrTimeNeededMs(pages: number): number {
  return Math.ceil(pages / LIMITS.ocr.concurrency) * LIMITS.ocr.expectedPageMs;
}
