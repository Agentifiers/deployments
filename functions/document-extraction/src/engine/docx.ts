import type { Extractor, ExtractionContext } from "./extractor.ts";
import { untilTextBudget } from "./text-sink.ts";
import { UnusableFile } from "./unusable.ts";
import { readXmlEntry } from "./xml.ts";
import { findEntry, readZipDirectory, type ZipArchive } from "./zip.ts";

const SUBTREES_WITHOUT_CURRENT_BODY_TEXT: Readonly<Record<string, true>> = {
  "mc:Fallback": true,
  "w:moveFrom": true,
  "w:pPrChange": true,
  "w:txbxContent": true,
};

function headingLevel(style: string) {
  if (/^title$/iu.test(style)) return 1;
  const level = /^heading ?([1-6])$/iu.exec(style)?.[1];
  return level === undefined ? undefined : Number(level);
}

/** Style id → heading level, for styles whose `w:name` is a heading even when the id is localized. */
function readHeadingStyles(archive: ZipArchive, context: ExtractionContext) {
  const levels = new Map<string, number>();
  const entry = findEntry(archive, "word/styles.xml");
  if (entry === undefined) return levels;
  let styleId: string | undefined;
  readXmlEntry(
    archive,
    entry,
    {
      open(name, attributes) {
        if (name === "w:style") styleId = attributes["w:styleId"];
        if (name !== "w:name" || styleId === undefined) return;
        const level = headingLevel(attributes["w:val"] ?? "");
        if (level !== undefined) levels.set(styleId, level);
      },
      text() {},
      close(name) {
        if (name === "w:style") styleId = undefined;
      },
    },
    context,
  );
  return levels;
}

export const extractDocx: Extractor<Uint8Array> = async (bytes, context) => {
  const archive = readZipDirectory(bytes);
  const document = findEntry(archive, "word/document.xml");
  if (document === undefined) throw new UnusableFile("unreadable", "the document part is missing");
  const headingStyles = readHeadingStyles(archive, context);
  const { sink } = context;
  let paragraphs = 0;
  let tables = 0;
  let skippedDepth = 0;
  let inProperties = false;
  let inText = false;
  let text = "";
  let heading: number | undefined;
  let listItem = false;
  let tableDepth = 0;
  let row: string[] = [];
  let cell: string[] = [];
  await untilTextBudget(() =>
    readXmlEntry(
      archive,
      document,
      {
        open(name, attributes) {
          if (skippedDepth > 0 || Object.hasOwn(SUBTREES_WITHOUT_CURRENT_BODY_TEXT, name)) {
            skippedDepth += 1;
            return;
          }
          switch (name) {
            case "w:p":
              text = "";
              heading = undefined;
              listItem = false;
              break;
            case "w:pPr":
              inProperties = true;
              break;
            case "w:pStyle": {
              const style = attributes["w:val"] ?? "";
              heading = headingStyles.get(style) ?? headingLevel(style);
              break;
            }
            case "w:numPr":
              listItem = true;
              break;
            case "w:t":
              inText = true;
              break;
            case "w:tab":
              if (!inProperties) text += "\t";
              break;
            case "w:br":
            case "w:cr":
              text += "\n";
              break;
            case "w:tbl":
              tableDepth += 1;
              break;
            case "w:tr":
              if (tableDepth === 1) row = [];
              break;
            case "w:tc":
              if (tableDepth === 1) cell = [];
              break;
          }
        },
        text(value) {
          if (inText) text += value;
        },
        close(name) {
          if (skippedDepth > 0) {
            skippedDepth -= 1;
            return;
          }
          switch (name) {
            case "w:pPr":
              inProperties = false;
              break;
            case "w:t":
              inText = false;
              break;
            case "w:p":
              if (tableDepth > 0) {
                if (text !== "") cell.push(text);
              } else {
                const prefix =
                  heading === undefined ? (listItem ? "- " : "") : `${"#".repeat(heading)} `;
                sink.write(`${prefix}${text}\n`);
                paragraphs += 1;
              }
              break;
            case "w:tc":
              if (tableDepth === 1) {
                row.push(cell.join(" ").replaceAll("\n", " ").replaceAll("|", "\\|"));
              }
              break;
            case "w:tr":
              if (tableDepth === 1) sink.write(`| ${row.join(" | ")} |\n`);
              break;
            case "w:tbl":
              tableDepth -= 1;
              if (tableDepth === 0) tables += 1;
              break;
          }
        },
      },
      context,
    ),
  );
  return { kind: "word", paragraphs, tables };
};
