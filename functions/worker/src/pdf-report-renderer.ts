import type {
  PdfBlock,
  PdfChartBlock,
  PdfReportInput,
  ResolvedPdfAsset,
} from "@deployments-ai/tools";
import { MAX_PDF_RENDERED_PAGES } from "@deployments-ai/tools";
import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import { embedPdfReportFonts } from "./pdf-report-font.ts";
import { renderPdfCallout } from "./pdf-report-callout.ts";
import { printable, wrappedLines } from "./pdf-report-text.ts";
import {
  PDF_TEMPLATES,
  pdfColor,
  pdfPageSize,
  pdfPalette,
  type PdfPalette,
  type PdfTemplateStyle,
} from "./pdf-report-theme.ts";

interface RenderState {
  readonly assets: ReadonlyMap<string, PDFImage>;
  readonly bodyFont: PDFFont;
  readonly boldFont: PDFFont;
  readonly document: PDFDocument;
  readonly input: PdfReportInput;
  readonly margin: number;
  readonly pageSize: readonly [number, number];
  readonly palette: PdfPalette;
  readonly template: PdfTemplateStyle;
  chartCount: number;
  page: PDFPage;
  y: number;
}

function text(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function addPage(state: Omit<RenderState, "page" | "y"> | RenderState) {
  if (state.document.getPageCount() >= MAX_PDF_RENDERED_PAGES)
    throw new TypeError(`PDF reports must not exceed ${MAX_PDF_RENDERED_PAGES} rendered pages.`);
  const page = state.document.addPage([...state.pageSize]);
  const { width, height } = page.getSize();
  page.drawRectangle({ color: state.palette.background, height, width, x: 0, y: 0 });
  page.drawRectangle({ color: state.palette.accent, height: 6, width, x: 0, y: height - 6 });
  page.drawText(printable(state.input.template.key.replaceAll("-", " ").toUpperCase()), {
    color: state.palette.muted,
    font: state.boldFont,
    size: 7,
    x: state.margin,
    y: height - 22,
  });
  return { page, y: height - state.margin };
}

function ensure(state: RenderState, height: number) {
  if (state.y - height >= state.margin) return;
  const next = addPage(state);
  state.page = next.page;
  state.y = next.y;
}

function paragraph(
  state: RenderState,
  value: string,
  options: {
    readonly bold?: boolean;
    readonly color?: RGB;
    readonly indent?: number;
    readonly size?: number;
  } = {},
) {
  const font = options.bold ? state.boldFont : state.bodyFont;
  const size = options.size ?? 10;
  const indent = options.indent ?? 0;
  const lineHeight = size * 1.35;
  const width = state.page.getWidth() - state.margin * 2 - indent;
  for (const line of wrappedLines(value, font, size, width)) {
    ensure(state, lineHeight);
    state.page.drawText(line, {
      color: options.color ?? state.palette.body,
      font,
      size,
      x: state.margin + indent,
      y: state.y - size,
    });
    state.y -= lineHeight;
  }
}

function heading(state: RenderState, value: string, level = 2) {
  const size = level <= 1 ? 20 : level === 2 ? 15 : 12;
  ensure(state, size * 2);
  state.y -= size * 0.35;
  paragraph(state, value, { bold: true, color: state.palette.accent, size });
  state.y -= 4;
}

function blockGap(state: RenderState, gap = 10) {
  state.y -= gap;
}

function renderTable(
  state: RenderState,
  columns: readonly { readonly key: string; readonly label: string }[],
  rows: readonly Readonly<Record<string, unknown>>[],
) {
  const width = state.page.getWidth() - state.margin * 2;
  const cellWidth = width / Math.max(columns.length, 1);
  const drawRow = (values: readonly string[], header: boolean) => {
    ensure(state, 20);
    if (header) {
      state.page.drawRectangle({
        color: state.palette.surface,
        height: 18,
        width,
        x: state.margin,
        y: state.y - 16,
      });
    }
    values.forEach((value, index) => {
      const clipped = printable(value).slice(0, Math.max(6, Math.floor(cellWidth / 5.5)));
      state.page.drawText(clipped, {
        color: header ? state.palette.accent : state.palette.body,
        font: header ? state.boldFont : state.bodyFont,
        size: 8,
        x: state.margin + index * cellWidth + 3,
        y: state.y - 12,
      });
    });
    state.y -= 18;
    state.page.drawLine({
      color: state.palette.muted,
      end: { x: state.margin + width, y: state.y },
      opacity: 0.25,
      start: { x: state.margin, y: state.y },
      thickness: 0.5,
    });
  };
  drawRow(
    columns.map((column) => column.label),
    true,
  );
  for (const row of rows)
    drawRow(
      columns.map((column) => text(row[column.key])),
      false,
    );
}

function numeric(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function chartDomain(block: PdfChartBlock) {
  let values: number[];
  if (block.chartType === "waterfall") {
    let cumulative = 0;
    values = [0];
    for (const row of block.data) {
      cumulative += block.series.reduce((sum, series) => sum + numeric(row[series.key]), 0);
      values.push(cumulative);
    }
  } else if (block.chartType === "stacked-bar" || block.stacked) {
    values = block.data.flatMap((row) => {
      const rowValues = block.series.map((series) => numeric(row[series.key]));
      return [
        rowValues.filter((value) => value < 0).reduce((sum, value) => sum + value, 0),
        rowValues.filter((value) => value > 0).reduce((sum, value) => sum + value, 0),
      ];
    });
  } else {
    values = block.data.flatMap((row) => block.series.map((series) => numeric(row[series.key])));
  }
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(1, ...values);
  return { maximum, minimum, span: maximum - minimum || 1 };
}

export function pieSliceValues(block: PdfChartBlock) {
  const seriesKey = block.series[0]?.key;
  return seriesKey ? block.data.map((row) => Math.max(0, numeric(row[seriesKey]))) : [];
}

export function chartConnectsPoints(chartType: PdfChartBlock["chartType"]) {
  return chartType !== "scatter";
}

function drawPie(state: RenderState, block: PdfChartBlock, x: number, y: number, size: number) {
  const values = pieSliceValues(block);
  const total = values.reduce((sum, value) => sum + value, 0) || 1;
  let angle = -Math.PI / 2;
  values.forEach((value, index) => {
    const end = angle + (value / total) * Math.PI * 2;
    const steps = Math.max(2, Math.ceil((end - angle) / (Math.PI / 18)));
    const points = Array.from({ length: steps + 1 }, (_, point) => {
      const theta = angle + ((end - angle) * point) / steps;
      return [Math.cos(theta) * size, Math.sin(theta) * size] as const;
    });
    const path = `M 0 0 ${points.map(([px, py]) => `L ${px.toFixed(2)} ${py.toFixed(2)}`).join(" ")} Z`;
    state.page.drawSvgPath(path, {
      color: state.palette.chart[index % state.palette.chart.length]!,
      x,
      y,
    });
    angle = end;
  });
  if (block.chartType === "donut") {
    state.page.drawCircle({ color: state.palette.background, size: size * 0.48, x, y });
  }
}

function drawCartesian(
  state: RenderState,
  block: PdfChartBlock,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const bounds = chartDomain(block);
  const baseline = y + ((0 - bounds.minimum) / bounds.span) * height;
  const valueY = (value: number) => y + ((value - bounds.minimum) / bounds.span) * height;
  if (block.showGrid !== false) {
    for (let index = 0; index <= 4; index += 1) {
      const gridY = y + (height * index) / 4;
      state.page.drawLine({
        color: state.palette.muted,
        end: { x: x + width, y: gridY },
        opacity: 0.18,
        start: { x, y: gridY },
        thickness: 0.5,
      });
    }
  }
  const categoryWidth = width / Math.max(block.data.length, 1);
  const point = (row: Readonly<Record<string, unknown>>, seriesKey: string, index: number) => ({
    x: x + categoryWidth * (index + 0.5),
    y: valueY(numeric(row[seriesKey])),
  });
  if (block.chartType === "waterfall") {
    let cumulative = 0;
    block.data.forEach((row, index) => {
      const change = block.series.reduce((sum, series) => sum + numeric(row[series.key]), 0);
      const next = cumulative + change;
      const from = valueY(cumulative);
      const to = valueY(next);
      const barWidth = categoryWidth * 0.62;
      state.page.drawRectangle({
        color: change < 0 ? rgb(0.75, 0.18, 0.18) : rgb(0.05, 0.55, 0.32),
        height: Math.max(1, Math.abs(to - from)),
        width: barWidth,
        x: x + categoryWidth * index + (categoryWidth - barWidth) / 2,
        y: Math.min(from, to),
      });
      if (index < block.data.length - 1) {
        state.page.drawLine({
          color: state.palette.muted,
          end: { x: x + categoryWidth * (index + 1.18), y: to },
          start: { x: x + categoryWidth * (index + 0.82), y: to },
          thickness: 0.6,
        });
      }
      if (block.showDataLabels) {
        state.page.drawText(printable(String(next)), {
          color: state.palette.body,
          font: state.bodyFont,
          size: 6,
          x: x + categoryWidth * (index + 0.35),
          y: Math.max(from, to) + 3,
        });
      }
      cumulative = next;
    });
    return;
  }
  if (block.chartType === "stacked-bar" || (block.chartType === "bar" && block.stacked)) {
    block.data.forEach((row, index) => {
      let positive = 0;
      let negative = 0;
      block.series.forEach((series, seriesIndex) => {
        const value = numeric(row[series.key]);
        const fromValue = value < 0 ? negative : positive;
        const toValue = fromValue + value;
        if (value < 0) negative = toValue;
        else positive = toValue;
        const from = valueY(fromValue);
        const to = valueY(toValue);
        const barWidth = categoryWidth * 0.68;
        state.page.drawRectangle({
          color: series.color
            ? pdfColor(series.color, "#000000")
            : state.palette.chart[seriesIndex % state.palette.chart.length]!,
          height: Math.max(1, Math.abs(to - from)),
          width: barWidth,
          x: x + categoryWidth * index + (categoryWidth - barWidth) / 2,
          y: Math.min(from, to),
        });
      });
      if (block.showDataLabels) {
        state.page.drawText(printable(String(positive + negative)), {
          color: state.palette.body,
          font: state.bodyFont,
          size: 6,
          x: x + categoryWidth * (index + 0.35),
          y: valueY(positive) + 3,
        });
      }
    });
    return;
  }
  const bars = block.chartType === "bar";
  block.series.forEach((series, seriesIndex) => {
    const seriesColor = series.color
      ? pdfColor(series.color, "#000000")
      : state.palette.chart[seriesIndex % state.palette.chart.length]!;
    const seriesBars = bars || (block.chartType === "composed" && series.type === "bar");
    if (seriesBars) {
      block.data.forEach((row, index) => {
        const top = point(row, series.key, index).y;
        const barWidth = Math.max(2, (categoryWidth * 0.72) / block.series.length);
        const barX = x + categoryWidth * index + categoryWidth * 0.14 + seriesIndex * barWidth;
        state.page.drawRectangle({
          color: seriesColor,
          height: Math.max(1, Math.abs(top - baseline)),
          opacity: block.variant === "glowing" ? 0.72 : 0.9,
          width: barWidth,
          x: barX,
          y: Math.min(top, baseline),
        });
        if (block.showDataLabels) {
          state.page.drawText(printable(String(numeric(row[series.key]))), {
            color: state.palette.body,
            font: state.bodyFont,
            size: 6,
            x: barX,
            y: Math.max(top, baseline) + 3,
          });
        }
      });
      return;
    }
    const points = block.data.map((row, index) => point(row, series.key, index));
    if (block.chartType === "area" || (block.chartType === "composed" && series.type === "area")) {
      points.forEach((current) => {
        state.page.drawRectangle({
          color: seriesColor,
          height: Math.max(1, Math.abs(current.y - baseline)),
          opacity: 0.2,
          width: Math.max(1, categoryWidth),
          x: current.x - categoryWidth / 2,
          y: Math.min(current.y, baseline),
        });
      });
    }
    points.forEach((current, index) => {
      if (block.chartType === "scatter") {
        state.page.drawCircle({ color: seriesColor, size: 3, x: current.x, y: current.y });
      }
      const previous = points[index - 1];
      if (previous && chartConnectsPoints(block.chartType)) {
        state.page.drawLine({
          color: seriesColor,
          end: current,
          start: previous,
          thickness: block.chartType === "sparkline" ? 2.5 : 1.5,
        });
      }
      if (block.showDataLabels) {
        state.page.drawText(printable(String(numeric(block.data[index]?.[series.key]))), {
          color: state.palette.body,
          font: state.bodyFont,
          size: 6,
          x: current.x + 2,
          y: current.y + 2,
        });
      }
    });
  });
}

function renderChart(state: RenderState, block: PdfChartBlock) {
  state.chartCount += 1;
  heading(state, block.title, 3);
  const availableWidth = state.page.getWidth() - state.margin * 2;
  const height = Math.min(block.height ?? 220, state.page.getHeight() - state.margin * 2);
  ensure(state, height + 28);
  const bottom = state.y - height;
  state.page.drawRectangle({
    borderColor: state.palette.muted,
    borderOpacity: 0.25,
    borderWidth: 0.5,
    color: state.palette.surface,
    height,
    opacity: 0.35,
    width: availableWidth,
    x: state.margin,
    y: bottom,
  });
  if (block.chartType === "pie" || block.chartType === "donut") {
    drawPie(
      state,
      block,
      state.margin + availableWidth / 2,
      bottom + height / 2,
      Math.min(height, availableWidth) * 0.32,
    );
  } else {
    drawCartesian(state, block, state.margin + 24, bottom + 22, availableWidth - 48, height - 44);
  }
  state.y = bottom - 6;
  if (block.showLegend !== false) {
    paragraph(state, block.series.map((series) => series.label).join("  |  "), {
      color: state.palette.muted,
      size: 8,
    });
  }
  if (block.showDataTable) {
    renderTable(
      state,
      [
        { key: block.xKey, label: block.xKey },
        ...block.series.map((series) => ({ key: series.key, label: series.label })),
      ],
      block.data,
    );
  }
  if (block.altText) paragraph(state, block.altText, { color: state.palette.muted, size: 8 });
}

export function fitPdfImage(options: {
  readonly availableHeight: number;
  readonly availableWidth: number;
  readonly naturalHeight: number;
  readonly naturalWidth: number;
  readonly requestedHeight: number;
}) {
  const scale = Math.min(
    options.availableWidth / options.naturalWidth,
    options.availableHeight / options.naturalHeight,
    options.requestedHeight / options.naturalHeight,
  );
  return { height: options.naturalHeight * scale, width: options.naturalWidth * scale };
}

function renderImage(state: RenderState, block: Extract<PdfBlock, { readonly type: "image" }>) {
  const image = state.assets.get(block.assetId);
  if (!image) throw new TypeError(`PDF image block references unknown asset ${block.assetId}.`);
  const availableWidth = state.page.getWidth() - state.margin * 2;
  const natural = image.scale(1);
  const requestedHeight = block.height ?? Math.min(280, natural.height);
  const { height, width } = fitPdfImage({
    availableHeight: state.page.getHeight() - state.margin * 2 - 18,
    availableWidth,
    naturalHeight: natural.height,
    naturalWidth: natural.width,
    requestedHeight,
  });
  ensure(state, height + 18);
  state.page.drawImage(image, {
    height,
    width,
    x: state.margin + (availableWidth - width) / 2,
    y: state.y - height,
  });
  state.y -= height + 4;
  if (block.caption) paragraph(state, block.caption, { color: state.palette.muted, size: 8 });
}

function renderBlock(state: RenderState, block: PdfBlock) {
  switch (block.type) {
    case "heading":
      heading(state, block.text, block.level ?? 2);
      break;
    case "paragraph":
      paragraph(state, block.text, {
        color: block.style === "caption" ? state.palette.muted : state.palette.body,
        size: block.style === "lead" ? 13 : block.style === "caption" ? 8 : 10,
      });
      if (block.citationIds?.length) {
        paragraph(state, block.citationIds.map((id) => `[${id}]`).join(" "), {
          color: state.palette.accent,
          size: 8,
        });
      }
      break;
    case "list":
      block.items.forEach((item, index) =>
        paragraph(state, `${block.ordered ? `${index + 1}.` : "-"} ${item}`, { indent: 10 }),
      );
      break;
    case "callout": {
      renderPdfCallout(state, block, () => {
        const next = addPage(state);
        state.page = next.page;
        state.y = next.y;
      });
      break;
    }
    case "metrics":
      block.metrics.forEach((metric) => {
        paragraph(state, `${metric.label}: ${metric.value}`, {
          bold: true,
          color: state.palette.accent,
        });
        if (metric.change || metric.detail) {
          paragraph(state, [metric.change, metric.detail].filter(Boolean).join(" - "), {
            color: state.palette.muted,
            indent: 10,
            size: 8,
          });
        }
      });
      break;
    case "table":
      if (block.title) heading(state, block.title, 3);
      renderTable(state, block.columns, block.rows);
      if (block.caption) paragraph(state, block.caption, { color: state.palette.muted, size: 8 });
      break;
    case "chart":
      renderChart(state, block);
      break;
    case "image":
      renderImage(state, block);
      break;
    case "key-value":
      block.items.forEach((item) =>
        paragraph(state, `${item.label}: ${item.value}`, { bold: true }),
      );
      break;
    case "divider":
      ensure(state, 12);
      state.page.drawLine({
        color: state.palette.muted,
        end: { x: state.page.getWidth() - state.margin, y: state.y - 4 },
        opacity: 0.4,
        start: { x: state.margin, y: state.y - 4 },
      });
      state.y -= 12;
      break;
    case "page-break": {
      const next = addPage(state);
      state.page = next.page;
      state.y = next.y;
      break;
    }
  }
  blockGap(state);
}

async function embedAssets(document: PDFDocument, assets: ReadonlyMap<string, ResolvedPdfAsset>) {
  const embedded = new Map<string, PDFImage>();
  for (const [id, asset] of assets) {
    try {
      embedded.set(
        id,
        asset.contentType === "image/png"
          ? await document.embedPng(asset.content)
          : await document.embedJpg(asset.content),
      );
    } catch (cause) {
      throw new TypeError(`PDF asset ${id} is not a valid ${asset.contentType} image.`, { cause });
    }
  }
  return embedded;
}

export async function renderPdfReport(
  input: PdfReportInput,
  resolvedAssets: ReadonlyMap<string, ResolvedPdfAsset>,
) {
  const document = await PDFDocument.create({ updateMetadata: false });
  const template = PDF_TEMPLATES[input.template.key];
  const selectedPalette = pdfPalette(input, template);
  const [[bodyFont, boldFont], assets] = await Promise.all([
    embedPdfReportFonts(document, input),
    embedAssets(document, resolvedAssets),
  ]);
  document.setTitle(printable(input.title));
  document.setAuthor("Deployments.ai");
  document.setCreator("Deployments.ai agent worker");
  document.setProducer("Deployments.ai PDF renderer v2");
  document.setSubject(printable(input.summary ?? `${input.template.key} report`));
  document.setKeywords([input.template.key, input.schemaVersion, input.locale ?? "en"]);
  const core = {
    assets,
    bodyFont,
    boldFont,
    chartCount: 0,
    document,
    input,
    margin: template.margin,
    pageSize: pdfPageSize(input),
    palette: selectedPalette,
    template,
  };
  const first = addPage(core);
  const state: RenderState = { ...core, page: first.page, y: first.y };
  const logo = input.theme?.logoAssetId ? assets.get(input.theme.logoAssetId) : undefined;
  if (input.theme?.logoAssetId && !logo) {
    throw new TypeError(`PDF theme logoAssetId ${input.theme.logoAssetId} was not provided.`);
  }
  if (logo) {
    const scaled = logo.scaleToFit(80, 32);
    state.page.drawImage(logo, {
      ...scaled,
      x: state.page.getWidth() - state.margin - scaled.width,
      y: state.page.getHeight() - state.margin - 4,
    });
  }
  paragraph(state, input.title, {
    bold: true,
    color: state.palette.accent,
    size: template.titleSize,
  });
  if (input.subtitle) paragraph(state, input.subtitle, { color: state.palette.muted, size: 13 });
  if (input.summary) {
    blockGap(state, 6);
    paragraph(state, input.summary, { size: 11 });
  }
  blockGap(state, 14);
  for (const block of input.blocks) renderBlock(state, block);
  if (input.output?.includeDataAppendix) {
    const next = addPage(state);
    state.page = next.page;
    state.y = next.y;
    heading(state, "Data appendix", 1);
    for (const block of input.blocks) {
      if (block.type !== "chart") continue;
      heading(state, block.title, 3);
      renderTable(
        state,
        [
          { key: block.xKey, label: block.xKey },
          ...block.series.map((series) => ({ key: series.key, label: series.label })),
        ],
        block.data,
      );
      blockGap(state);
    }
  }
  if (input.citations.length > 0) {
    heading(state, "Sources", 1);
    input.citations.forEach((citation) =>
      paragraph(
        state,
        `[${citation.id}] ${citation.label}${citation.url ? ` - ${citation.url}` : ""}`,
        { size: 8 },
      ),
    );
  }
  const pages = document.getPages();
  if (input.output?.includePageNumbers) {
    pages.forEach((page, index) => {
      const label = `${index + 1} / ${pages.length}`;
      page.drawText(label, {
        color: selectedPalette.muted,
        font: bodyFont,
        size: 8,
        x: page.getWidth() - template.margin - bodyFont.widthOfTextAtSize(label, 8),
        y: 16,
      });
    });
  }
  return {
    bytes: await document.save({ addDefaultPage: false, useObjectStreams: false }),
    chartCount: state.chartCount,
    pageCount: pages.length,
  };
}
