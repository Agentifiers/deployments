import type { PdfBlock } from "@deployments-ai/tools";
import type { PDFFont, PDFPage, RGB } from "pdf-lib";
import { wrappedLines } from "./pdf-report-text.ts";

const CALLOUT_FONT_SIZE = 10;
const CALLOUT_LINE_HEIGHT = CALLOUT_FONT_SIZE * 1.35;
const CALLOUT_PADDING_HEIGHT = 17;
const MINIMUM_CALLOUT_HEIGHT = 44;

interface CalloutLine {
  readonly bold: boolean;
  readonly text: string;
}

export interface PdfCalloutSegment<T> {
  readonly height: number;
  readonly lines: readonly T[];
  readonly startsNewPage: boolean;
}

export function paginatePdfCalloutLines<T>(
  lines: readonly T[],
  initialAvailableHeight: number,
  pageAvailableHeight: number,
): readonly PdfCalloutSegment<T>[] {
  const segments: PdfCalloutSegment<T>[] = [];
  let availableHeight = initialAvailableHeight;
  let offset = 0;
  while (offset < lines.length) {
    let startsNewPage = segments.length > 0;
    let capacity = Math.floor((availableHeight - CALLOUT_PADDING_HEIGHT) / CALLOUT_LINE_HEIGHT);
    if (capacity < 1 || MINIMUM_CALLOUT_HEIGHT > availableHeight) {
      availableHeight = pageAvailableHeight;
      startsNewPage = true;
      capacity = Math.floor((availableHeight - CALLOUT_PADDING_HEIGHT) / CALLOUT_LINE_HEIGHT);
    }
    if (capacity < 1) throw new TypeError("PDF page is too small to render a callout.");
    const count = Math.min(capacity, lines.length - offset);
    const height = Math.max(
      MINIMUM_CALLOUT_HEIGHT,
      count * CALLOUT_LINE_HEIGHT + CALLOUT_PADDING_HEIGHT,
    );
    if (height > availableHeight) throw new TypeError("PDF page is too small to render a callout.");
    segments.push({ height, lines: lines.slice(offset, offset + count), startsNewPage });
    offset += count;
    availableHeight = pageAvailableHeight;
  }
  return segments;
}

export interface PdfCalloutRenderState {
  readonly bodyFont: PDFFont;
  readonly boldFont: PDFFont;
  readonly margin: number;
  readonly palette: {
    readonly accent: RGB;
    readonly body: RGB;
    readonly surface: RGB;
  };
  page: PDFPage;
  y: number;
}

export function renderPdfCallout(
  state: PdfCalloutRenderState,
  block: Extract<PdfBlock, { readonly type: "callout" }>,
  nextPage: () => void,
) {
  const textWidth = state.page.getWidth() - state.margin * 2 - 20;
  const lines: CalloutLine[] = [
    ...(block.title
      ? wrappedLines(block.title, state.boldFont, CALLOUT_FONT_SIZE, textWidth).map((text) => ({
          bold: true,
          text,
        }))
      : []),
    ...wrappedLines(block.body, state.bodyFont, CALLOUT_FONT_SIZE, textWidth).map((text) => ({
      bold: false,
      text,
    })),
  ];
  const pageAvailableHeight = state.page.getHeight() - state.margin * 2;
  for (const segment of paginatePdfCalloutLines(
    lines,
    state.y - state.margin,
    pageAvailableHeight,
  )) {
    if (segment.startsNewPage) nextPage();
    const top = state.y;
    state.page.drawRectangle({
      borderColor: state.palette.accent,
      borderWidth: 2,
      color: state.palette.surface,
      height: segment.height,
      opacity: block.tone === "warning" ? 0.7 : 0.45,
      width: state.page.getWidth() - state.margin * 2,
      x: state.margin,
      y: top - segment.height,
    });
    let cursor = top - 9;
    for (const line of segment.lines) {
      state.page.drawText(line.text, {
        color: state.palette.body,
        font: line.bold ? state.boldFont : state.bodyFont,
        size: CALLOUT_FONT_SIZE,
        x: state.margin + 10,
        y: cursor - CALLOUT_FONT_SIZE,
      });
      cursor -= CALLOUT_LINE_HEIGHT;
    }
    state.y = top - segment.height;
  }
}
