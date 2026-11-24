import { Schema } from "effect";

export const PDF_SCHEMA_VERSION = "2" as const;
export const MAX_PDF_AGGREGATE_DATA_ROWS = 5_000;
export const MAX_PDF_BLOCKS = 200;
export const MAX_PDF_CHART_ROWS = 1_000;
export const MAX_PDF_COLLECTION_ITEMS = 5_000;
export const MAX_PDF_DRAW_OPERATIONS = 100_000;
export const MAX_PDF_RENDERED_PAGES = 250;
export const MAX_PDF_TABLE_COLUMNS = 32;
export const MAX_PDF_TABLE_ROWS = 1_000;
export const MAX_PDF_TEXT_CHARACTERS = 300_000;

export const PDF_TEMPLATE_KEYS = [
  "executive-report",
  "research-brief",
  "marketing-brief",
  "release-risk-report",
  "incident-review",
  "handoff-brief",
  "financial-summary",
  "data-report",
  "one-page-brief",
] as const;

export const PDF_CHART_TYPES = [
  "bar",
  "stacked-bar",
  "line",
  "area",
  "composed",
  "pie",
  "donut",
  "scatter",
  "sparkline",
  "waterfall",
] as const;

export const PDF_CHART_VARIANTS = ["default", "gradient", "hatched", "duotone", "glowing"] as const;

export const PDF_FONT_FAMILIES = ["Helvetica", "Times-Roman", "Courier"] as const;

const PdfCitationSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  url: Schema.optional(Schema.String),
  accessedAt: Schema.optional(Schema.String),
  sourceArtifactId: Schema.optional(Schema.String),
  sourceToolCallId: Schema.optional(Schema.String),
});

const PdfThemeSchema = Schema.Struct({
  accentColor: Schema.optional(Schema.String),
  backgroundColor: Schema.optional(Schema.String),
  bodyColor: Schema.optional(Schema.String),
  fontFamily: Schema.optional(Schema.Literals(PDF_FONT_FAMILIES)),
  logoAssetId: Schema.optional(Schema.String),
  mutedColor: Schema.optional(Schema.String),
  palette: Schema.optional(Schema.Array(Schema.String)),
  surfaceColor: Schema.optional(Schema.String),
});

const PdfChartSeriesSchema = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  color: Schema.optional(Schema.String),
  format: Schema.optional(Schema.String),
  type: Schema.optional(Schema.Literals(["area", "bar", "line"])),
});

const PdfChartBlockSchema = Schema.Struct({
  type: Schema.Literal("chart"),
  chartType: Schema.Literals(PDF_CHART_TYPES),
  title: Schema.String,
  data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  series: Schema.Array(PdfChartSeriesSchema),
  xKey: Schema.String,
  altText: Schema.optional(Schema.String),
  height: Schema.optional(Schema.Number),
  showDataLabels: Schema.optional(Schema.Boolean),
  showDataTable: Schema.optional(Schema.Boolean),
  showGrid: Schema.optional(Schema.Boolean),
  showLegend: Schema.optional(Schema.Boolean),
  stacked: Schema.optional(Schema.Boolean),
  variant: Schema.optional(Schema.Literals(PDF_CHART_VARIANTS)),
});

const PdfHeadingBlockSchema = Schema.Struct({
  type: Schema.Literal("heading"),
  text: Schema.String,
  level: Schema.optional(Schema.Number),
  bookmark: Schema.optional(Schema.String),
});

const PdfParagraphBlockSchema = Schema.Struct({
  type: Schema.Literal("paragraph"),
  text: Schema.String,
  citationIds: Schema.optional(Schema.Array(Schema.String)),
  style: Schema.optional(Schema.Literals(["body", "caption", "lead"])),
});

const PdfListBlockSchema = Schema.Struct({
  type: Schema.Literal("list"),
  items: Schema.Array(Schema.String),
  ordered: Schema.optional(Schema.Boolean),
});

const PdfCalloutBlockSchema = Schema.Struct({
  type: Schema.Literal("callout"),
  body: Schema.String,
  title: Schema.optional(Schema.String),
  tone: Schema.optional(Schema.Literals(["info", "neutral", "positive", "warning"])),
});

const PdfMetricSchema = Schema.Struct({
  label: Schema.String,
  value: Schema.String,
  change: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  tone: Schema.optional(Schema.Literals(["negative", "neutral", "positive"])),
});

const PdfMetricsBlockSchema = Schema.Struct({
  type: Schema.Literal("metrics"),
  metrics: Schema.Array(PdfMetricSchema),
  columns: Schema.optional(Schema.Number),
});

const PdfTableColumnSchema = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  align: Schema.optional(Schema.Literals(["left", "right"])),
  width: Schema.optional(Schema.Number),
});

const PdfTableBlockSchema = Schema.Struct({
  type: Schema.Literal("table"),
  columns: Schema.Array(PdfTableColumnSchema),
  rows: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  caption: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
});

const PdfImageBlockSchema = Schema.Struct({
  type: Schema.Literal("image"),
  assetId: Schema.String,
  altText: Schema.String,
  caption: Schema.optional(Schema.String),
  height: Schema.optional(Schema.Number),
});

const PdfKeyValueBlockSchema = Schema.Struct({
  type: Schema.Literal("key-value"),
  items: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      value: Schema.String,
    }),
  ),
  columns: Schema.optional(Schema.Number),
});

const PdfDividerBlockSchema = Schema.Struct({ type: Schema.Literal("divider") });
const PdfPageBreakBlockSchema = Schema.Struct({ type: Schema.Literal("page-break") });

export const PdfBlockSchema = Schema.Union([
  PdfHeadingBlockSchema,
  PdfParagraphBlockSchema,
  PdfListBlockSchema,
  PdfCalloutBlockSchema,
  PdfMetricsBlockSchema,
  PdfTableBlockSchema,
  PdfChartBlockSchema,
  PdfImageBlockSchema,
  PdfKeyValueBlockSchema,
  PdfDividerBlockSchema,
  PdfPageBreakBlockSchema,
]);

export const PdfAssetInputSchema = Schema.Struct({
  id: Schema.String,
  artifactId: Schema.optional(Schema.String),
  contentBase64: Schema.optional(Schema.String),
  contentType: Schema.optional(Schema.String),
  sourceUrl: Schema.optional(Schema.String),
});

export const PdfReportInputSchema = Schema.Struct({
  schemaVersion: Schema.Literal(PDF_SCHEMA_VERSION),
  title: Schema.String,
  template: Schema.Struct({
    key: Schema.Literals(PDF_TEMPLATE_KEYS),
    version: Schema.optional(Schema.String),
  }),
  assets: Schema.optional(Schema.Array(PdfAssetInputSchema)),
  blocks: Schema.Array(PdfBlockSchema),
  citations: Schema.Array(PdfCitationSchema),
  locale: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  output: Schema.optional(
    Schema.Struct({
      fileName: Schema.optional(Schema.String),
      includeDataAppendix: Schema.optional(Schema.Boolean),
      includePageNumbers: Schema.optional(Schema.Boolean),
      orientation: Schema.optional(Schema.Literals(["landscape", "portrait"])),
      pageSize: Schema.optional(Schema.Literals(["A4", "LETTER"])),
      timezone: Schema.optional(Schema.String),
    }),
  ),
  subtitle: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  theme: Schema.optional(PdfThemeSchema),
});

export type PdfReportInput = typeof PdfReportInputSchema.Type;
export type PdfBlock = typeof PdfBlockSchema.Type;
export type PdfChartBlock = typeof PdfChartBlockSchema.Type;
export type PdfAssetInput = typeof PdfAssetInputSchema.Type;

export interface ResolvedPdfAsset {
  readonly content: Uint8Array;
  readonly contentType: string;
  readonly id: string;
}

export interface PdfRenderManifest {
  readonly chartCount: number;
  readonly createdAt: string;
  readonly inputSha256: string;
  readonly pageCount?: number;
  readonly rendererVersion: string;
  readonly schemaVersion: typeof PDF_SCHEMA_VERSION;
  readonly templateKey: (typeof PDF_TEMPLATE_KEYS)[number];
  readonly templateVersion: string;
  readonly warnings: readonly string[];
}

export interface RenderedPdfDocument {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly manifest: PdfRenderManifest;
  readonly source: PdfReportInput;
}

export const PDF_BLOCK_TOOL_INPUT_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { const: "heading" },
        text: { type: "string" },
        level: { type: "number", minimum: 1, maximum: 3 },
        bookmark: { type: "string" },
      },
      required: ["type", "text"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { const: "paragraph" },
        text: { type: "string" },
        citationIds: { type: "array", items: { type: "string" } },
        style: { type: "string", enum: ["body", "caption", "lead"] },
      },
      required: ["type", "text"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { const: "list" },
        items: {
          type: "array",
          maxItems: MAX_PDF_COLLECTION_ITEMS,
          items: { type: "string" },
        },
        ordered: { type: "boolean" },
      },
      required: ["type", "items"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { const: "callout" },
        title: { type: "string" },
        body: { type: "string" },
        tone: { type: "string", enum: ["info", "neutral", "positive", "warning"] },
      },
      required: ["type", "body"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { const: "metrics" },
        columns: { type: "number", minimum: 1, maximum: 4 },
        metrics: {
          type: "array",
          maxItems: MAX_PDF_COLLECTION_ITEMS,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              label: { type: "string" },
              value: { type: "string" },
              change: { type: "string" },
              detail: { type: "string" },
              tone: { type: "string", enum: ["negative", "neutral", "positive"] },
            },
            required: ["label", "value"],
          },
        },
      },
      required: ["type", "metrics"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { const: "table" },
        title: { type: "string" },
        caption: { type: "string" },
        columns: {
          type: "array",
          maxItems: MAX_PDF_TABLE_COLUMNS,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              key: { type: "string" },
              label: { type: "string" },
              align: { type: "string", enum: ["left", "right"] },
              width: { type: "number", exclusiveMinimum: 0 },
            },
            required: ["key", "label"],
          },
        },
        rows: {
          type: "array",
          maxItems: MAX_PDF_TABLE_ROWS,
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["type", "columns", "rows"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { const: "chart" },
        chartType: { type: "string", enum: [...PDF_CHART_TYPES] },
        title: { type: "string" },
        data: {
          type: "array",
          maxItems: MAX_PDF_CHART_ROWS,
          items: { type: "object", additionalProperties: true },
        },
        series: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              key: { type: "string" },
              label: { type: "string" },
              color: { type: "string" },
              format: { type: "string" },
              type: { type: "string", enum: ["area", "bar", "line"] },
            },
            required: ["key", "label"],
          },
        },
        xKey: { type: "string" },
        altText: { type: "string" },
        height: { type: "number", minimum: 120, maximum: 480 },
        showDataLabels: { type: "boolean" },
        showDataTable: { type: "boolean" },
        showGrid: { type: "boolean" },
        showLegend: { type: "boolean" },
        stacked: { type: "boolean" },
        variant: { type: "string", enum: [...PDF_CHART_VARIANTS] },
      },
      required: ["type", "chartType", "title", "data", "series", "xKey"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { const: "image" },
        assetId: { type: "string" },
        altText: { type: "string" },
        caption: { type: "string" },
        height: { type: "number", exclusiveMinimum: 0 },
      },
      required: ["type", "assetId", "altText"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { const: "key-value" },
        columns: { type: "number", minimum: 1, maximum: 3 },
        items: {
          type: "array",
          maxItems: MAX_PDF_COLLECTION_ITEMS,
          items: {
            type: "object",
            additionalProperties: false,
            properties: { label: { type: "string" }, value: { type: "string" } },
            required: ["label", "value"],
          },
        },
      },
      required: ["type", "items"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: { type: { const: "divider" } },
      required: ["type"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: { type: { const: "page-break" } },
      required: ["type"],
    },
  ],
} as const;

export const PDF_REPORT_TOOL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "string", const: PDF_SCHEMA_VERSION },
    title: { type: "string", minLength: 1, maxLength: 240 },
    subtitle: { type: "string", maxLength: 500 },
    summary: { type: "string", maxLength: 10_000 },
    template: {
      type: "object",
      additionalProperties: false,
      properties: {
        key: { type: "string", enum: [...PDF_TEMPLATE_KEYS] },
        version: { type: "string" },
      },
      required: ["key"],
    },
    blocks: {
      type: "array",
      maxItems: MAX_PDF_BLOCKS,
      items: PDF_BLOCK_TOOL_INPUT_SCHEMA,
    },
    citations: {
      type: "array",
      maxItems: 500,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          url: { type: "string" },
          accessedAt: { type: "string" },
          sourceArtifactId: { type: "string" },
          sourceToolCallId: { type: "string" },
        },
        required: ["id", "label"],
      },
    },
    assets: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          artifactId: { type: "string" },
          contentBase64: { type: "string" },
          contentType: { type: "string", enum: ["image/jpeg", "image/png"] },
          sourceUrl: { type: "string" },
        },
        required: ["id"],
        oneOf: [
          { required: ["artifactId"] },
          { required: ["contentBase64", "contentType"] },
          { required: ["sourceUrl"] },
        ],
      },
    },
    locale: { type: "string" },
    metadata: { type: "object" },
    output: {
      type: "object",
      additionalProperties: false,
      properties: {
        fileName: { type: "string" },
        includeDataAppendix: { type: "boolean" },
        includePageNumbers: { type: "boolean" },
        orientation: { type: "string", enum: ["landscape", "portrait"] },
        pageSize: { type: "string", enum: ["A4", "LETTER"] },
        timezone: { type: "string" },
      },
    },
    theme: {
      type: "object",
      additionalProperties: false,
      properties: {
        accentColor: { type: "string" },
        backgroundColor: { type: "string" },
        bodyColor: { type: "string" },
        fontFamily: { type: "string", enum: [...PDF_FONT_FAMILIES] },
        logoAssetId: { type: "string" },
        mutedColor: { type: "string" },
        palette: { type: "array", items: { type: "string" } },
        surfaceColor: { type: "string" },
      },
    },
    sections: { type: "array" },
    sourceCitations: { type: "array", items: { type: "string" }, minItems: 1 },
  },
  required: ["title"],
} as const;

export function decodePdfReportInput(input: unknown): PdfReportInput {
  return Schema.decodeUnknownSync(PdfReportInputSchema)(input);
}

function recordValue(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("PDF report input must be an object");
  }
  return input as Record<string, unknown>;
}

function requiredText(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`PDF report ${key} is required`);
  return value.trim();
}

function legacySources(input: Record<string, unknown>): string[] {
  const value = input.sourceCitations ?? input.citations ?? input.sources;
  const sources = Array.isArray(value)
    ? value.flatMap((entry) => (typeof entry === "string" && entry.trim() ? [entry.trim()] : []))
    : typeof value === "string" && value.trim()
      ? [value.trim()]
      : [];
  if (sources.length === 0) throw new Error("PDF report sourceCitations is required");
  return sources;
}

function legacyBlocks(input: Record<string, unknown>): PdfBlock[] {
  const sections = Array.isArray(input.sections) ? input.sections : [];
  const blocks = sections.flatMap((section, index): PdfBlock[] => {
    if (typeof section === "string" && section.trim()) {
      return [
        { type: "heading", level: 2, text: `Section ${index + 1}` },
        { type: "paragraph", text: section.trim() },
      ];
    }
    if (!section || typeof section !== "object" || Array.isArray(section)) return [];
    const record = section as Record<string, unknown>;
    const heading =
      typeof record.heading === "string" && record.heading.trim()
        ? record.heading.trim()
        : `Section ${index + 1}`;
    const bodyValue = record.body ?? record.content;
    const body = typeof bodyValue === "string" ? bodyValue.trim() : "";
    return body
      ? [
          { type: "heading", level: 2, text: heading },
          { type: "paragraph", text: body },
        ]
      : [];
  });
  if (blocks.length > 0) return blocks;
  return [{ type: "paragraph", style: "lead", text: requiredText(input, "summary") }];
}

export function normalizePdfReportInput(input: unknown): PdfReportInput {
  const record = recordValue(input);
  if (record.schemaVersion === PDF_SCHEMA_VERSION) return decodePdfReportInput(record);
  const sources = legacySources(record);
  return decodePdfReportInput({
    schemaVersion: PDF_SCHEMA_VERSION,
    title: requiredText(record, "title"),
    summary: typeof record.summary === "string" ? record.summary.trim() || undefined : undefined,
    template: { key: "executive-report", version: "1.0.0" },
    blocks: legacyBlocks(record),
    citations: sources.map((label, index) => ({ id: `source-${index + 1}`, label })),
  });
}
