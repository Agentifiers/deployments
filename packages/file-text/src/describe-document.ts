import {
  INPUT_FILE_TYPES,
  type DocumentMediaType,
} from "@deployments-ai/agent-manifest/input-files";
import { MAX_DOCUMENT_SUMMARY_LENGTH } from "@deployments-ai/db";
import type { DocumentFacts } from "./wire.ts";

const count = (value: number, noun: string) =>
  `${value.toLocaleString("en-US")} ${noun}${value === 1 ? "" : "s"}`;

const ENCODING_LABELS = {
  "utf-16": " (UTF-16)",
  "utf-8": "",
  "windows-1252": " (Windows-1252)",
} as const satisfies Record<Extract<DocumentFacts, { kind: "text" }>["encoding"], string>;

function structure(facts: DocumentFacts): string | undefined {
  switch (facts.kind) {
    case "pdf": {
      const withoutText = facts.pages - facts.pagesWithText;
      const notes = [
        ...(facts.ocrPages > 0 ? [`${facts.ocrPages} read by OCR`] : []),
        ...(withoutText > 0 ? [`${withoutText} without text`] : []),
      ];
      return `${count(facts.pages, "page")}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`;
    }
    case "workbook": {
      const sheets = facts.sheets.map((sheet) => `${sheet.name} ${count(sheet.rows, "row")}`);
      const hidden =
        facts.hiddenSheets > 0 ? `, ${count(facts.hiddenSheets, "hidden sheet")} omitted` : "";
      return `${count(facts.sheets.length, "sheet")} (${sheets.join("; ")})${hidden}`;
    }
    case "word":
      return `${count(facts.paragraphs, "paragraph")}, ${count(facts.tables, "table")}`;
    case "text":
      return `${count(facts.lines, "line")}${ENCODING_LABELS[facts.encoding]}`;
    case "html":
      return undefined;
    case "archive": {
      const extracted = facts.extracted.map((entry) => entry.path).join(", ");
      const skipped = facts.skippedTotal > 0 ? `, ${facts.skippedTotal} skipped` : "";
      return `${count(facts.extracted.length, "file")} extracted (${extracted})${skipped}`;
    }
    default: {
      const unhandled: never = facts;
      return unhandled;
    }
  }
}

export function describeDocument(mediaType: DocumentMediaType, facts: DocumentFacts): string {
  const shape = structure(facts);
  const summary = shape
    ? `${INPUT_FILE_TYPES[mediaType].label}, ${shape}`
    : INPUT_FILE_TYPES[mediaType].label;
  if (summary.length <= MAX_DOCUMENT_SUMMARY_LENGTH) return summary;
  const cut = MAX_DOCUMENT_SUMMARY_LENGTH - 1;
  const lastUnit = summary.charCodeAt(cut - 1);
  const end = lastUnit >= 0xd800 && lastUnit <= 0xdbff ? cut - 1 : cut;
  return `${summary.slice(0, end)}…`;
}
