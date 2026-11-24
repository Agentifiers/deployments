import { strToU8, unzipSync, zipSync } from "fflate";

const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const SPREADSHEET = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const WORDPROCESSING = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const OFFICE_DOCUMENT = `${RELATIONSHIPS}/officeDocument`;
const CUSTOM_FORMAT_IDS_START = 164;

function escapeXml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function encodeParts(parts: Readonly<Record<string, string>>) {
  return Object.fromEntries(Object.entries(parts).map(([name, xml]) => [name, strToU8(xml)]));
}

function contentTypes(overrides: Readonly<Record<string, string>>) {
  const entries = Object.entries(overrides)
    .map(([part, type]) => `<Override PartName="/${part}" ContentType="${type}"/>`)
    .join("");
  return `${DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${entries}</Types>`;
}

function relationships(targets: readonly { readonly type: string; readonly target: string }[]) {
  const entries = targets
    .map(
      ({ type, target }, index) =>
        `<Relationship Id="rId${index + 1}" Type="${type}" Target="${target}"/>`,
    )
    .join("");
  return `${DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries}</Relationships>`;
}

export function replaceParts(bytes: Uint8Array, parts: Readonly<Record<string, string>>) {
  return zipSync({ ...unzipSync(bytes), ...encodeParts(parts) }, { level: 0 });
}

export type XlsxCell =
  | string
  | number
  | { readonly kind: "inline"; readonly text: string }
  | { readonly kind: "formatted"; readonly value: number; readonly format: number | string }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "error"; readonly text: string }
  | {
      readonly kind: "formula";
      readonly formula: string;
      readonly cached?: number | string;
      readonly emptyValueElement?: true;
    };

export interface XlsxSheet {
  readonly name: string;
  readonly state?: "hidden" | "veryHidden";
  readonly rows: readonly (readonly (XlsxCell | undefined)[])[];
}

function columnName(column: number) {
  let name = "";
  for (let rest = column; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    name = String.fromCharCode(65 + ((rest - 1) % 26)) + name;
  }
  return name;
}

export function xlsxFixture(
  sheets: readonly XlsxSheet[],
  options: { readonly date1904?: boolean } = {},
) {
  const sharedStrings: string[] = [];
  const formats: (number | string)[] = [];
  const sharedIndex = (text: string) => {
    if (!sharedStrings.includes(text)) sharedStrings.push(text);
    return sharedStrings.indexOf(text);
  };
  const styleIndex = (format: number | string) => {
    if (!formats.includes(format)) formats.push(format);
    return formats.indexOf(format) + 1;
  };
  const cellXml = (cell: XlsxCell, ref: string) => {
    if (typeof cell === "string") return `<c r="${ref}" t="s"><v>${sharedIndex(cell)}</v></c>`;
    if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`;
    switch (cell.kind) {
      case "inline":
        return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(cell.text)}</t></is></c>`;
      case "formatted":
        return `<c r="${ref}" s="${styleIndex(cell.format)}"><v>${cell.value}</v></c>`;
      case "boolean":
        return `<c r="${ref}" t="b"><v>${cell.value ? 1 : 0}</v></c>`;
      case "error":
        return `<c r="${ref}" t="e"><v>${escapeXml(cell.text)}</v></c>`;
      case "formula": {
        const formula = `<f>${escapeXml(cell.formula)}</f>`;
        if (cell.emptyValueElement) return `<c r="${ref}">${formula}<v/></c>`;
        if (cell.cached === undefined) return `<c r="${ref}">${formula}</c>`;
        if (typeof cell.cached === "number")
          return `<c r="${ref}">${formula}<v>${cell.cached}</v></c>`;
        return `<c r="${ref}" t="str">${formula}<v>${escapeXml(cell.cached)}</v></c>`;
      }
      default: {
        const unhandled: never = cell;
        return unhandled;
      }
    }
  };
  const worksheets = sheets.map(({ rows }) => {
    const rowsXml = rows
      .map((cells, rowIndex) => {
        const cellsXml = cells
          .map((cell, columnIndex) =>
            cell === undefined
              ? ""
              : cellXml(cell, `${columnName(columnIndex + 1)}${rowIndex + 1}`),
          )
          .join("");
        return `<row r="${rowIndex + 1}">${cellsXml}</row>`;
      })
      .join("");
    return `${DECLARATION}<worksheet xmlns="${SPREADSHEET}" xmlns:r="${RELATIONSHIPS}"><sheetData>${rowsXml}</sheetData></worksheet>`;
  });

  const customFormats = formats.filter((format) => typeof format === "string");
  const formatId = (format: number | string) =>
    typeof format === "number" ? format : CUSTOM_FORMAT_IDS_START + customFormats.indexOf(format);
  const styles = `${DECLARATION}<styleSheet xmlns="${SPREADSHEET}"><numFmts count="${customFormats.length}">${customFormats
    .map((code) => `<numFmt numFmtId="${formatId(code)}" formatCode="${escapeXml(code)}"/>`)
    .join(
      "",
    )}</numFmts><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="${formats.length + 1}"><xf numFmtId="0" xfId="0"/>${formats
    .map((format) => `<xf numFmtId="${formatId(format)}" xfId="0" applyNumberFormat="1"/>`)
    .join("")}</cellXfs></styleSheet>`;

  const workbook = `${DECLARATION}<workbook xmlns="${SPREADSHEET}" xmlns:r="${RELATIONSHIPS}"><workbookPr${options.date1904 ? ' date1904="1"' : ""}/><sheets>${sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}"${sheet.state === undefined ? "" : ` state="${sheet.state}"`} r:id="rId${index + 1}"/>`,
    )
    .join("")}</sheets></workbook>`;

  const parts: Record<string, string> = {
    "[Content_Types].xml": contentTypes({
      "xl/workbook.xml":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
      "xl/styles.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
      ...Object.fromEntries(
        worksheets.map((_, index) => [
          `xl/worksheets/sheet${index + 1}.xml`,
          "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
        ]),
      ),
      ...(sharedStrings.length === 0
        ? {}
        : {
            "xl/sharedStrings.xml":
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml",
          }),
    }),
    "_rels/.rels": relationships([{ type: OFFICE_DOCUMENT, target: "xl/workbook.xml" }]),
    "xl/workbook.xml": workbook,
    "xl/_rels/workbook.xml.rels": relationships([
      ...worksheets.map((_, index) => ({
        type: `${RELATIONSHIPS}/worksheet`,
        target: `worksheets/sheet${index + 1}.xml`,
      })),
      { type: `${RELATIONSHIPS}/styles`, target: "styles.xml" },
      ...(sharedStrings.length === 0
        ? []
        : [{ type: `${RELATIONSHIPS}/sharedStrings`, target: "sharedStrings.xml" }]),
    ]),
    "xl/styles.xml": styles,
    ...Object.fromEntries(
      worksheets.map((xml, index) => [`xl/worksheets/sheet${index + 1}.xml`, xml]),
    ),
  };
  if (sharedStrings.length > 0) {
    parts["xl/sharedStrings.xml"] =
      `${DECLARATION}<sst xmlns="${SPREADSHEET}" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">${sharedStrings
        .map((text) => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`)
        .join("")}</sst>`;
  }
  return zipSync(encodeParts(parts));
}

export type DocxBlock =
  | string
  | { readonly kind: "styled"; readonly style: string; readonly text: string }
  | { readonly kind: "list"; readonly text: string }
  | { readonly kind: "table"; readonly rows: readonly (readonly DocxCell[])[] };

export type DocxCell = string | readonly string[];

function runXml(text: string) {
  const content = text
    .split(/(\t|\n)/u)
    .map((part) => {
      if (part === "\t") return "<w:tab/>";
      if (part === "\n") return "<w:br/>";
      return part === "" ? "" : `<w:t xml:space="preserve">${escapeXml(part)}</w:t>`;
    })
    .join("");
  return `<w:r><w:rPr><w:lang w:val="en-US"/></w:rPr>${content}</w:r>`;
}

function paragraphXml(text: string, properties = "") {
  return `<w:p>${properties === "" ? "" : `<w:pPr>${properties}</w:pPr>`}${runXml(text)}</w:p>`;
}

function blockXml(block: DocxBlock): string {
  if (typeof block === "string") return paragraphXml(block);
  switch (block.kind) {
    case "styled":
      return paragraphXml(block.text, `<w:pStyle w:val="${escapeXml(block.style)}"/>`);
    case "list":
      return paragraphXml(
        block.text,
        '<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs>',
      );
    case "table": {
      const columns = Math.max(0, ...block.rows.map((row) => row.length));
      const grid = '<w:gridCol w:w="2000"/>'.repeat(columns);
      const rows = block.rows
        .map((row) => {
          const cells = row
            .map((cell) => {
              const paragraphs = typeof cell === "string" ? [cell] : cell;
              return `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${paragraphs.map((text) => paragraphXml(text)).join("")}</w:tc>`;
            })
            .join("");
          return `<w:tr>${cells}</w:tr>`;
        })
        .join("");
      return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`;
    }
    default: {
      const unhandled: never = block;
      return unhandled;
    }
  }
}

export function docxFixture(
  blocks: readonly DocxBlock[],
  options: { readonly styles?: Readonly<Record<string, string>> } = {},
) {
  const styles = Object.entries({ Normal: "Normal", ...options.styles })
    .map(
      ([id, name]) =>
        `<w:style w:type="paragraph" w:styleId="${escapeXml(id)}"><w:name w:val="${escapeXml(name)}"/></w:style>`,
    )
    .join("");
  return zipSync(
    encodeParts({
      "[Content_Types].xml": contentTypes({
        "word/document.xml":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
        "word/styles.xml":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
      }),
      "_rels/.rels": relationships([{ type: OFFICE_DOCUMENT, target: "word/document.xml" }]),
      "word/_rels/document.xml.rels": relationships([
        { type: `${RELATIONSHIPS}/styles`, target: "styles.xml" },
      ]),
      "word/document.xml": `${DECLARATION}<w:document xmlns:w="${WORDPROCESSING}" xmlns:r="${RELATIONSHIPS}"><w:body>${blocks
        .map(blockXml)
        .join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`,
      "word/styles.xml": `${DECLARATION}<w:styles xmlns:w="${WORDPROCESSING}">${styles}</w:styles>`,
    }),
  );
}
