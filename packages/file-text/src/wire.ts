import {
  DOCUMENT_MEDIA_TYPES,
  INPUT_FILE_UNUSABLE_REASONS,
  MAX_DOCUMENT_TEXT_BYTES,
} from "@deployments-ai/agent-manifest/input-files";
import { Schema } from "effect";

export const EXTRACTION_DEADLINE_MS = { min: 1_000, max: 110_000 } as const;

export function clampExtractionDeadline(deadlineMs: number) {
  return Math.min(EXTRACTION_DEADLINE_MS.max, Math.max(EXTRACTION_DEADLINE_MS.min, deadlineMs));
}

const Count = Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)));
export const MAX_FACT_NAME_LENGTH = 256;
const FactName = Schema.String.pipe(Schema.check(Schema.isMaxLength(MAX_FACT_NAME_LENGTH)));
const Sha256Hex = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/u)));
const DocumentMediaType = Schema.Literals(DOCUMENT_MEDIA_TYPES);

export const ArchiveSkipReason = Schema.Literals([
  "directory_or_link",
  "nested_archive",
  ...INPUT_FILE_UNUSABLE_REASONS,
]);
export type ArchiveSkipReason = typeof ArchiveSkipReason.Type;

export const DocumentFacts = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("pdf"),
    pages: Count,
    pagesWithText: Count,
    ocrPages: Count,
  }).check(
    Schema.makeFilter((facts) =>
      facts.ocrPages <= facts.pagesWithText && facts.pagesWithText <= facts.pages
        ? undefined
        : "PDF facts must count ocrPages <= pagesWithText <= pages.",
    ),
  ),
  Schema.Struct({
    kind: Schema.Literal("workbook"),
    sheets: Schema.Array(Schema.Struct({ name: FactName, rows: Count })).pipe(
      Schema.check(Schema.isMaxLength(64)),
    ),
    hiddenSheets: Count,
  }),
  Schema.Struct({ kind: Schema.Literal("word"), paragraphs: Count, tables: Count }),
  Schema.Struct({
    kind: Schema.Literal("text"),
    encoding: Schema.Literals(["utf-16", "utf-8", "windows-1252"]),
    lines: Count,
  }),
  Schema.Struct({ kind: Schema.Literal("html") }),
  Schema.Struct({
    kind: Schema.Literal("archive"),
    extracted: Schema.Array(Schema.Struct({ path: FactName, mediaType: DocumentMediaType })).pipe(
      Schema.check(Schema.isMaxLength(32)),
    ),
    skipped: Schema.Array(Schema.Struct({ path: FactName, reason: ArchiveSkipReason })).pipe(
      Schema.check(Schema.isMaxLength(64)),
    ),
    skippedTotal: Count,
  }),
]);
export type DocumentFacts = typeof DocumentFacts.Type;

const textVerdictFields = {
  status: Schema.Literal("text"),
  mediaType: DocumentMediaType,
  truncated: Schema.Boolean,
  facts: DocumentFacts,
};

const UnusableVerdict = Schema.Struct({
  status: Schema.Literal("unusable"),
  reason: Schema.Literals(INPUT_FILE_UNUSABLE_REASONS),
  detail: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(200)))),
});

export const ExtractionVerdict = Schema.Union([Schema.Struct(textVerdictFields), UnusableVerdict]);
export type ExtractionVerdict = typeof ExtractionVerdict.Type;

export const MAX_HINT_CONTENT_TYPE_LENGTH = 256;
export const MAX_HINT_FILE_NAME_LENGTH = 1_024;

export const ExtractionWireRequest = Schema.Struct({
  extractor: Schema.String,
  source: Schema.Struct({
    url: Schema.String.pipe(Schema.check(Schema.isPattern(/^https?:\/\//u))),
    byteSize: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
    sha256: Sha256Hex,
  }),
  hint: Schema.Struct({
    contentType: Schema.optionalKey(
      Schema.String.pipe(Schema.check(Schema.isMaxLength(MAX_HINT_CONTENT_TYPE_LENGTH))),
    ),
    fileName: Schema.optionalKey(
      Schema.String.pipe(Schema.check(Schema.isMaxLength(MAX_HINT_FILE_NAME_LENGTH))),
    ),
  }),
  deadlineMs: Schema.Number.pipe(Schema.check(Schema.isInt())),
});
export type ExtractionWireRequest = typeof ExtractionWireRequest.Type;

/** Base64 of at most MAX_DOCUMENT_TEXT_BYTES; keeps the response under Lambda's 6 MB cap. */
const MAX_TEXT_BASE64_LENGTH = Math.ceil(MAX_DOCUMENT_TEXT_BYTES / 3) * 4;

export const ExtractionWireResponse = Schema.Union([
  Schema.Struct({
    ...textVerdictFields,
    textBase64: Schema.String.pipe(Schema.check(Schema.isMaxLength(MAX_TEXT_BASE64_LENGTH))),
    textSha256: Sha256Hex,
  }),
  UnusableVerdict,
  Schema.Struct({ status: Schema.Literal("skew"), extractor: Schema.String }),
]);
export type ExtractionWireResponse = typeof ExtractionWireResponse.Type;
