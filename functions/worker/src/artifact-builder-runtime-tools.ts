import { createHash } from "node:crypto";
import {
  MAX_PDF_AGGREGATE_DATA_ROWS,
  MAX_PDF_BLOCKS,
  MAX_PDF_CHART_ROWS,
  MAX_PDF_COLLECTION_ITEMS,
  MAX_PDF_DRAW_OPERATIONS,
  MAX_PDF_RENDERED_PAGES,
  MAX_PDF_TABLE_COLUMNS,
  MAX_PDF_TABLE_ROWS,
  MAX_PDF_TEXT_CHARACTERS,
  normalizePdfReportInput,
  MAX_SPREADSHEET_COLUMNS,
  MAX_SPREADSHEET_ROWS,
  PDF_TEMPLATE_KEYS,
  type PdfReportInput,
} from "@deployments-ai/tools";
import type { ExecuteRuntimeBuiltinTool } from "./runtime-tools.ts";
import {
  jsonToolResult,
  optionalInteger,
  textToolResult,
  toolInput,
} from "./builtin-tool-support.ts";
import { mermaidToExcalidrawScene } from "./mermaid-to-diagram.ts";
import { resolvePdfAssets, type PdfAssetResolverOptions } from "./pdf-report-assets.ts";
import { renderPdfReport } from "./pdf-report-renderer.ts";

const MAX_SPREADSHEET_CELLS = 250_000;
const MAX_SPREADSHEET_BYTES = 5 * 1024 * 1024;

function assertPdfRenderBudget(input: PdfReportInput) {
  if (input.blocks.length > MAX_PDF_BLOCKS)
    throw new TypeError(`PDF reports must contain at most ${MAX_PDF_BLOCKS} blocks.`);
  let collectionItems = input.citations.length;
  let dataRows = 0;
  let drawOperations = input.blocks.length + input.citations.length;
  let explicitPages = 1;
  for (const block of input.blocks) {
    if (block.type === "page-break") explicitPages += 1;
    if (block.type === "list") collectionItems += block.items.length;
    if (block.type === "metrics") collectionItems += block.metrics.length;
    if (block.type === "key-value") collectionItems += block.items.length;
    if (block.type === "table") {
      if (block.columns.length > MAX_PDF_TABLE_COLUMNS || block.rows.length > MAX_PDF_TABLE_ROWS)
        throw new TypeError("PDF table dimensions exceed the rendering limit.");
      dataRows += block.rows.length;
      drawOperations += (block.rows.length + 1) * (block.columns.length + 1);
    }
    if (block.type === "chart") {
      if (block.data.length > MAX_PDF_CHART_ROWS)
        throw new TypeError("PDF chart data exceeds the rendering limit.");
      dataRows += block.data.length;
      drawOperations += block.data.length * Math.max(1, block.series.length) * 5;
      if (input.output?.includeDataAppendix)
        drawOperations += block.data.length * (block.series.length + 2);
    }
  }
  const textCharacters = JSON.stringify({
    blocks: input.blocks,
    citations: input.citations,
    subtitle: input.subtitle,
    summary: input.summary,
    title: input.title,
  }).length;
  const estimatedPages =
    explicitPages +
    Math.ceil(dataRows / 25) +
    Math.ceil(collectionItems / 25) +
    Math.ceil(textCharacters / 1_500);
  if (dataRows > MAX_PDF_AGGREGATE_DATA_ROWS)
    throw new TypeError(
      `PDF reports must contain at most ${MAX_PDF_AGGREGATE_DATA_ROWS} data rows.`,
    );
  if (collectionItems > MAX_PDF_COLLECTION_ITEMS)
    throw new TypeError(`PDF reports must contain at most ${MAX_PDF_COLLECTION_ITEMS} list items.`);
  if (textCharacters > MAX_PDF_TEXT_CHARACTERS)
    throw new TypeError(`PDF reports must contain at most ${MAX_PDF_TEXT_CHARACTERS} characters.`);
  if (drawOperations > MAX_PDF_DRAW_OPERATIONS)
    throw new TypeError(`PDF reports exceed the ${MAX_PDF_DRAW_OPERATIONS} draw-operation limit.`);
  if (estimatedPages > MAX_PDF_RENDERED_PAGES)
    throw new TypeError(`PDF reports must not exceed ${MAX_PDF_RENDERED_PAGES} estimated pages.`);
}

function safeName(value: unknown, fallback: string, extension: string) {
  const candidate =
    typeof value === "string" && value.trim()
      ? value
          .trim()
          .replace(/[^a-zA-Z0-9._-]+/gu, "-")
          .replace(/^-+|-+$/gu, "")
      : fallback;
  const base = candidate || fallback;
  const withoutExtension = base.toLowerCase().endsWith(extension)
    ? base.slice(0, -extension.length)
    : base;
  return `${withoutExtension.slice(0, 220 - extension.length)}${extension}`;
}

function boundedUtf8(value: string, maximumBytes: number) {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function optionalCodePointString(
  input: Readonly<Record<string, unknown>>,
  name: string,
  maximumCodePoints: number,
) {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  const normalized = value.trim();
  if (Array.from(normalized).length > maximumCodePoints) {
    throw new TypeError(`${name} is too long.`);
  }
  return normalized;
}

function requiredCodePointString(
  input: Readonly<Record<string, unknown>>,
  name: string,
  maximumCodePoints: number,
) {
  const value = optionalCodePointString(input, name, maximumCodePoints);
  if (value === undefined) throw new TypeError(`${name} must be a non-empty string.`);
  return value;
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function csvCell(value: unknown) {
  const raw = scalar(value);
  const formula =
    typeof value === "string"
      ? Array.from(raw).find((character) => {
          const codePoint = character.codePointAt(0)!;
          return character.trim() !== "" && codePoint > 0x20 && codePoint !== 0x7f;
        })
      : undefined;
  const text = formula && "=+-@".includes(formula) ? `'${raw}` : raw;
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvFromInput(input: Readonly<Record<string, unknown>>) {
  const rows = input.rows;
  if (!Array.isArray(rows) || rows.length === 0)
    throw new TypeError("rows must be a non-empty array.");
  if (rows.length > MAX_SPREADSHEET_ROWS) {
    throw new TypeError(`rows must contain at most ${MAX_SPREADSHEET_ROWS} entries.`);
  }
  const objects = rows.filter(
    (row): row is Readonly<Record<string, unknown>> =>
      Boolean(row) && typeof row === "object" && !Array.isArray(row),
  );
  if (objects.length !== rows.length) throw new TypeError("rows must contain objects.");
  if (input.columns !== undefined && !Array.isArray(input.columns)) {
    throw new TypeError("columns must be an array of unique non-empty strings.");
  }
  const requestedColumns = (input.columns ?? []).map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new TypeError("columns must contain unique non-empty strings.");
    }
    return entry.trim();
  });
  if (
    requestedColumns.length > MAX_SPREADSHEET_COLUMNS ||
    new Set(requestedColumns).size !== requestedColumns.length
  ) {
    throw new TypeError(`columns must contain at most ${MAX_SPREADSHEET_COLUMNS} unique entries.`);
  }
  const derivedColumns = new Set<string>();
  if (requestedColumns.length === 0) {
    for (const row of objects) {
      for (const column of Object.keys(row)) {
        derivedColumns.add(column);
        if (derivedColumns.size > MAX_SPREADSHEET_COLUMNS) {
          throw new TypeError(`rows must contain at most ${MAX_SPREADSHEET_COLUMNS} columns.`);
        }
      }
    }
  }
  const columns = requestedColumns.length > 0 ? requestedColumns : [...derivedColumns];
  if (columns.length === 0) throw new TypeError("rows must contain at least one column.");
  if (columns.length * objects.length > MAX_SPREADSHEET_CELLS) {
    throw new TypeError(`spreadsheet exports must not exceed ${MAX_SPREADSHEET_CELLS} cells.`);
  }
  const lines: string[] = [];
  let byteLength = 0;
  const append = (line: string) => {
    byteLength += Buffer.byteLength(line, "utf8") + 2;
    if (byteLength > MAX_SPREADSHEET_BYTES) {
      throw new TypeError(
        `spreadsheet exports must not exceed ${MAX_SPREADSHEET_BYTES} generated bytes.`,
      );
    }
    lines.push(line);
  };
  append(columns.map(csvCell).join(","));
  for (const row of objects) append(columns.map((column) => csvCell(row[column])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

function markdown(input: Readonly<Record<string, unknown>>, title: string) {
  const provided = input.content ?? input.body ?? input.text ?? input.description;
  return `# ${typeof input.title === "string" ? input.title : title}\n\n${typeof provided === "string" ? provided : `\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``}\n`;
}

function presentationHtml(input: Readonly<Record<string, unknown>>) {
  const slides = Array.isArray(input.slides) ? input.slides : [input];
  const sections = slides
    .map((slide, index) => {
      const record: Record<string, unknown> =
        slide && typeof slide === "object" && !Array.isArray(slide)
          ? (slide as Record<string, unknown>)
          : { content: slide };
      return `<section><h1>${escapeHtml(scalar(record.title ?? `Slide ${index + 1}`))}</h1><pre>${escapeHtml(scalar(record.content ?? record.body ?? record))}</pre></section>`;
    })
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(scalar(input.title ?? "Presentation"))}</title><style>body{margin:0;background:#111;color:#f7f5ef;font:24px system-ui}section{box-sizing:border-box;min-height:100vh;padding:8vh 10vw;border-bottom:1px solid #444}h1{font-size:2.4em}pre{white-space:pre-wrap;font:inherit}</style></head><body>${sections}</body></html>`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function referencedPdfAssetIds(input: PdfReportInput) {
  const assetIds = new Set<string>();
  if (input.theme?.logoAssetId) assetIds.add(input.theme.logoAssetId);
  for (const block of input.blocks) if (block.type === "image") assetIds.add(block.assetId);
  return assetIds;
}

function calendarEvent(input: Readonly<Record<string, unknown>>, defaultUid: string) {
  const date = (value: unknown, field: string) => {
    if (typeof value !== "string" || /\r|\n/u.test(value)) {
      throw new TypeError(`${field} must be a canonical UTC date or timestamp.`);
    }
    if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
      const parsed = new Date(`${value}T00:00:00.000Z`);
      if (parsed.toISOString().slice(0, 10) !== value) {
        throw new TypeError(`${field} must be a valid calendar date.`);
      }
      const compact = value.replaceAll("-", "");
      return {
        dateOnly: true,
        epochMilliseconds: parsed.getTime(),
        stamp: `${compact}T000000Z`,
        value: compact,
      } as const;
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
      throw new TypeError(`${field} must be a canonical UTC date or timestamp.`);
    }
    const parsed = new Date(value);
    const expected = value.includes(".") ? value : value.replace(/Z$/u, ".000Z");
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== expected) {
      throw new TypeError(`${field} must be a valid calendar timestamp.`);
    }
    const normalized = parsed
      .toISOString()
      .replaceAll(/[-:]/gu, "")
      .replace(/\.\d{3}Z$/u, "Z");
    return {
      dateOnly: false,
      epochMilliseconds: parsed.getTime(),
      stamp: normalized,
      value: normalized,
    } as const;
  };
  const escape = (value: unknown) =>
    scalar(value)
      .replaceAll("\\", "\\\\")
      .replaceAll(/\r\n|\r|\n/gu, "\\n")
      .replaceAll(",", "\\,")
      .replaceAll(";", "\\;");
  const startsAt = date(input.start ?? input.startsAt, "start");
  const endsAt = date(input.end ?? input.endsAt, "end");
  if (startsAt.dateOnly !== endsAt.dateOnly) {
    throw new TypeError("Calendar event start and end must both be dates or both be timestamps.");
  }
  if (endsAt.epochMilliseconds <= startsAt.epochMilliseconds) {
    throw new TypeError("Calendar event end must be after start.");
  }
  const dateValue = startsAt.dateOnly ? ";VALUE=DATE" : "";
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Deployments.ai//Agent Calendar Draft//EN",
    "BEGIN:VEVENT",
    `UID:${escape(input.uid ?? defaultUid)}`,
    `DTSTAMP:${startsAt.stamp}`,
    `DTSTART${dateValue}:${startsAt.value}`,
    `DTEND${dateValue}:${endsAt.value}`,
    `SUMMARY:${escape(input.title ?? input.summary ?? "Agent event")}`,
    `DESCRIPTION:${escape(input.description ?? input.body)}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

export function createRuntimeArtifactBuilderBuiltinExecutors(
  options: PdfAssetResolverOptions,
): Readonly<Record<string, ExecuteRuntimeBuiltinTool>> {
  return {
    "artifact.mermaid_to_diagram": async (request) => {
      const input = toolInput(request.input ?? {});
      const style = input.style ?? "clean";
      if (style !== "clean" && style !== "sketchy") {
        throw new TypeError("style must be clean or sketchy.");
      }
      const theme = input.theme ?? "light";
      if (theme !== "light" && theme !== "dark") {
        throw new TypeError("theme must be light or dark.");
      }
      const title = optionalCodePointString(input, "title", 200);
      const scene = await mermaidToExcalidrawScene({
        definition: requiredCodePointString(input, "definition", 50_000),
        fontSize: optionalInteger(input, "fontSize", { maximum: 48, minimum: 12 }) ?? 20,
        style,
        theme,
        ...(title ? { title } : {}),
      });
      const fileName = safeName(input.fileName, "diagram", ".excalidraw");
      return textToolResult({
        content: `${JSON.stringify(scene, null, 2)}\n`,
        contentType: "application/vnd.excalidraw+json",
        fileName,
        label: title ? boundedUtf8(title, 512) : "Mermaid diagram",
        summary: `Built editable Excalidraw diagram ${fileName}.`,
        type: "generated_file",
      });
    },
    "artifact.pdf_report": async (request) => {
      let input: PdfReportInput;
      try {
        input = normalizePdfReportInput(request.input ?? {});
      } catch (cause) {
        throw new TypeError("PDF report input is invalid.", { cause });
      }
      assertPdfRenderBudget(input);
      const assets = await resolvePdfAssets(
        options,
        request,
        input.assets ?? [],
        referencedPdfAssetIds(input),
      );
      const rendered = await renderPdfReport(input, assets);
      const fileName = safeName(input.output?.fileName, "report", ".pdf");
      return {
        artifacts: [
          {
            content: rendered.bytes,
            contentType: "application/pdf",
            fileName,
            label: input.title,
            metadata: {
              inputSha256: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
              chartCount: rendered.chartCount,
              pageCount: rendered.pageCount,
              schemaVersion: input.schemaVersion,
              templateKey: input.template.key,
            },
            type: "report",
            visibility: "private",
          },
        ],
        outputSummary: `Built PDF report ${fileName}.`,
        status: "completed",
      };
    },
    "artifact.spreadsheet_export": async (request) => {
      const input = toolInput(request.input ?? {});
      return textToolResult({
        content: csvFromInput(input),
        contentType: "text/csv; charset=utf-8",
        fileName: safeName(input.fileName, "export", ".csv"),
        label: "Spreadsheet export",
        summary: "Built CSV spreadsheet export.",
        type: "generated_file",
      });
    },
    "artifact.presentation_deck": async (request) => {
      const input = toolInput(request.input ?? {});
      return textToolResult({
        content: presentationHtml(input),
        contentType: "text/html; charset=utf-8",
        fileName: safeName(input.fileName, "presentation", ".html"),
        label: "Presentation deck",
        summary: "Built an HTML presentation deck.",
        type: "generated_file",
      });
    },
    "artifact.ticket_draft": async (request) =>
      textToolResult({
        content: markdown(toolInput(request.input ?? {}), "Ticket draft"),
        fileName: "ticket-draft.md",
        label: "Ticket draft",
        summary: "Built a ticket draft.",
        type: "generated_file",
      }),
    "artifact.pr_patch": async (request) => {
      const input = toolInput(request.input ?? {});
      const content = scalar(input.patch ?? input.diff ?? input.content);
      if (!content.trim()) throw new TypeError("patch, diff, or content is required.");
      return textToolResult({
        content: content.endsWith("\n") ? content : `${content}\n`,
        contentType: "text/x-diff; charset=utf-8",
        fileName: safeName(input.fileName, "changes", ".patch"),
        label: "PR patch",
        summary: "Built a PR patch artifact.",
        type: "diff",
      });
    },
    "artifact.communication_draft": async (request) =>
      textToolResult({
        content: markdown(toolInput(request.input ?? {}), "Communication draft"),
        fileName: "communication-draft.md",
        label: "Communication draft",
        summary: "Built a communication draft.",
        type: "generated_file",
      }),
    "artifact.calendar_event_draft": async (request) =>
      textToolResult({
        content: calendarEvent(
          toolInput(request.input ?? {}),
          `${createHash("sha256")
            .update(`${request.runId}:${request.idempotencyKey}:artifact.calendar_event_draft`)
            .digest("hex")}@deployments.ai`,
        ),
        contentType: "text/calendar; charset=utf-8",
        fileName: "calendar-event.ics",
        label: "Calendar event draft",
        summary: "Built a calendar event draft.",
        type: "generated_file",
      }),
    "artifact.slack_card": async (request) =>
      jsonToolResult({
        fileName: "slack-card.json",
        label: "Slack card",
        summary: "Built a Slack card artifact.",
        value: toolInput(request.input ?? {}),
      }),
    "artifact.pdf_templates.list": async () =>
      jsonToolResult({
        fileName: "pdf-templates.json",
        label: "PDF templates",
        summary: `Listed ${PDF_TEMPLATE_KEYS.length} PDF templates.`,
        value: PDF_TEMPLATE_KEYS.map((key) => ({ key, version: "1" })),
      }),
    "artifact.pdf_templates.get": async (request) => {
      const input = toolInput(request.input ?? {});
      const key = input.key;
      if (typeof key !== "string" || !PDF_TEMPLATE_KEYS.includes(key as never))
        throw new TypeError("Unknown PDF template key.");
      return jsonToolResult({
        fileName: `pdf-template-${key}.json`,
        label: `PDF template ${key}`,
        summary: `Loaded PDF template ${key}.`,
        value: {
          key,
          version: "1",
          supportedBlocks: [
            "heading",
            "paragraph",
            "list",
            "callout",
            "metrics",
            "table",
            "chart",
            "image",
            "key-value",
            "divider",
            "page-break",
          ],
        },
      });
    },
  };
}
