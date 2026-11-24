import unifontSource from "@fontsource/unifont/files/unifont-latin-400-normal.woff";
import fontkit from "@pdf-lib/fontkit";
import type { PdfReportInput } from "@deployments-ai/tools";
import { readFile } from "node:fs/promises";
import type { PDFDocument } from "pdf-lib";
import { pdfFontNames } from "./pdf-report-theme.ts";

// Fontsource names its only Unifont CSS subset "latin", but this WOFF contains the
// complete 57k-code-point GNU Unifont cmap (including CJK, Cyrillic, and Arabic).
export async function unicodeFontBytes() {
  const marker = ";base64,";
  const markerIndex = unifontSource.indexOf(marker);
  return markerIndex >= 0
    ? Uint8Array.from(Buffer.from(unifontSource.slice(markerIndex + marker.length), "base64"))
    : new Uint8Array(await readFile(unifontSource));
}

export async function embedPdfReportFonts(document: PDFDocument, input: PdfReportInput) {
  if (Array.from(JSON.stringify(input)).some((character) => character.codePointAt(0)! > 0x7f)) {
    document.registerFontkit(fontkit);
    const font = await document.embedFont(await unicodeFontBytes(), { subset: true });
    return [font, font] as const;
  }
  const [fontName, boldFontName] = pdfFontNames(input.theme?.fontFamily);
  return Promise.all([document.embedFont(fontName), document.embedFont(boldFontName)]);
}
