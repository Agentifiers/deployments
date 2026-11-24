import type { PdfReportInput } from "@deployments-ai/tools";
import { PageSizes, StandardFonts, rgb, type RGB } from "pdf-lib";

export interface PdfTemplateStyle {
  readonly accent: string;
  readonly margin: number;
  readonly titleSize: number;
}

export interface PdfPalette {
  readonly accent: RGB;
  readonly background: RGB;
  readonly body: RGB;
  readonly chart: readonly RGB[];
  readonly muted: RGB;
  readonly surface: RGB;
}

export const PDF_TEMPLATES: Readonly<Record<PdfReportInput["template"]["key"], PdfTemplateStyle>> =
  {
    "data-report": { accent: "#2563eb", margin: 38, titleSize: 25 },
    "executive-report": { accent: "#1d4ed8", margin: 48, titleSize: 28 },
    "financial-summary": { accent: "#047857", margin: 42, titleSize: 26 },
    "handoff-brief": { accent: "#7c3aed", margin: 46, titleSize: 27 },
    "incident-review": { accent: "#b91c1c", margin: 44, titleSize: 27 },
    "marketing-brief": { accent: "#be185d", margin: 46, titleSize: 28 },
    "one-page-brief": { accent: "#0f766e", margin: 36, titleSize: 24 },
    "release-risk-report": { accent: "#c2410c", margin: 44, titleSize: 27 },
    "research-brief": { accent: "#4338ca", margin: 50, titleSize: 28 },
  };

export function pdfColor(value: string | undefined, fallback: string) {
  const candidate = value ?? fallback;
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/iu.exec(candidate);
  if (!match) throw new TypeError(`PDF theme color ${candidate} must use #RRGGBB.`);
  return rgb(
    Number.parseInt(match[1]!, 16) / 255,
    Number.parseInt(match[2]!, 16) / 255,
    Number.parseInt(match[3]!, 16) / 255,
  );
}

export function pdfPalette(input: PdfReportInput, template: PdfTemplateStyle): PdfPalette {
  const defaults = [template.accent, "#0891b2", "#7c3aed", "#db2777", "#ca8a04"];
  const chart = (input.theme?.palette?.length ? input.theme.palette : defaults).map((value) =>
    pdfColor(value, template.accent),
  );
  return {
    accent: pdfColor(input.theme?.accentColor, template.accent),
    background: pdfColor(input.theme?.backgroundColor, "#ffffff"),
    body: pdfColor(input.theme?.bodyColor, "#111827"),
    chart,
    muted: pdfColor(input.theme?.mutedColor, "#6b7280"),
    surface: pdfColor(input.theme?.surfaceColor, "#f3f4f6"),
  };
}

export function pdfPageSize(input: PdfReportInput): readonly [number, number] {
  const base = input.output?.pageSize === "A4" ? PageSizes.A4 : PageSizes.Letter;
  return input.output?.orientation === "landscape" ? [base[1], base[0]] : base;
}

export function pdfFontNames(family: "Courier" | "Helvetica" | "Times-Roman" | undefined) {
  switch (family) {
    case "Courier":
      return [StandardFonts.Courier, StandardFonts.CourierBold] as const;
    case "Times-Roman":
      return [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold] as const;
    default:
      return [StandardFonts.Helvetica, StandardFonts.HelveticaBold] as const;
  }
}
