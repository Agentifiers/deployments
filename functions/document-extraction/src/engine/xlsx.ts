import { MAX_FACT_NAME_LENGTH } from "@deployments-ai/file-text/wire";
import { LIMITS } from "../limits.ts";
import type { ExtractionContext, Extractor } from "./extractor.ts";
import { untilTextBudget, type TextSink } from "./text-sink.ts";
import { UnusableFile } from "./unusable.ts";
import { readXmlEntry } from "./xml.ts";
import { findEntry, readZipDirectory, type ZipArchive } from "./zip.ts";

type DateFormat = "date" | "time";

type CellType = "b" | "d" | "e" | "inlineStr" | "n" | "s" | "str";

interface WorkbookSheet {
  readonly name: string;
  readonly relationshipId: string | undefined;
  readonly hidden: boolean;
}

interface CellContext {
  readonly sharedStrings: readonly string[];
  readonly dateFormats: readonly (DateFormat | undefined)[];
  readonly date1904: boolean;
}

interface CellDraft {
  readonly column: number;
  readonly type: CellType;
  readonly style: number;
  cachedValue: string | undefined;
  formula: string;
  inline: string;
}

const MAX_COLUMNS = 16_384;
const MAX_ROWS = 1_048_576;
const SECONDS_PER_DAY = 86_400;
const DAY_MS = SECONDS_PER_DAY * 1_000;
/** Serials below 60 count from here; Excel's serial 60 is 1900-02-29, a day that never was. */
const EPOCH_1900 = Date.UTC(1899, 11, 31);
const EPOCH_1900_AFTER_LEAP_DAY = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);
const YEAR_10000 = Date.UTC(10_000, 0, 1);
const MAX_SERIAL = (YEAR_10000 - EPOCH_1900_AFTER_LEAP_DAY) / DAY_MS;

const BUILT_IN_DATE_FORMATS: ReadonlyMap<number, DateFormat> = new Map([
  [14, "date"],
  [15, "date"],
  [16, "date"],
  [17, "date"],
  [18, "time"],
  [19, "time"],
  [20, "time"],
  [21, "time"],
  [22, "date"],
  [45, "time"],
  [46, "time"],
  [47, "time"],
]);
const QUOTED_BRACKETED_OR_ESCAPED = /"[^"]*"|\[[^\]]*\]|[\\_*]./gu;

const ignore = () => {};

function localName(name: string) {
  return name.slice(name.indexOf(":") + 1);
}

function requiredPart(archive: ZipArchive, name: string, description: string) {
  const entry = findEntry(archive, name);
  if (entry === undefined)
    throw new UnusableFile("unreadable", `the ${description} part is missing`);
  return entry;
}

function readWorkbook(archive: ZipArchive, context: ExtractionContext) {
  const sheets: WorkbookSheet[] = [];
  let date1904 = false;
  readXmlEntry(
    archive,
    requiredPart(archive, "xl/workbook.xml", "workbook"),
    {
      open(name, attributes) {
        switch (localName(name)) {
          case "workbookPr":
            date1904 = attributes.date1904 === "1" || attributes.date1904 === "true";
            break;
          case "sheet":
            if (sheets.length === LIMITS.xlsx.maxSheets) {
              throw new UnusableFile(
                "limits_exceeded",
                `the workbook has more than ${LIMITS.xlsx.maxSheets} sheets`,
              );
            }
            sheets.push({
              name: attributes.name ?? "",
              relationshipId: Object.entries(attributes).find(([key]) => key.endsWith(":id"))?.[1],
              hidden: attributes.state === "hidden" || attributes.state === "veryHidden",
            });
            break;
        }
      },
      text: ignore,
      close: ignore,
    },
    context,
  );
  return { sheets, date1904 };
}

function readWorksheetPaths(archive: ZipArchive, context: ExtractionContext) {
  const paths = new Map<string, string>();
  readXmlEntry(
    archive,
    requiredPart(archive, "xl/_rels/workbook.xml.rels", "workbook relationships"),
    {
      open(name, { Id: id, Type: type, Target: target }) {
        if (localName(name) !== "Relationship" || !type?.endsWith("/worksheet")) return;
        if (id !== undefined && target !== undefined) {
          paths.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
        }
      },
      text: ignore,
      close: ignore,
    },
    context,
  );
  return paths;
}

function readSharedStrings(archive: ZipArchive, context: ExtractionContext) {
  const strings: string[] = [];
  const entry = findEntry(archive, "xl/sharedStrings.xml");
  if (entry === undefined) return strings;
  let current = "";
  let inText = false;
  let inPhonetic = false;
  readXmlEntry(
    archive,
    entry,
    {
      open(name) {
        switch (localName(name)) {
          case "si":
            if (strings.length === LIMITS.xlsx.maxSharedStrings) {
              throw new UnusableFile(
                "limits_exceeded",
                `the workbook has more than ${LIMITS.xlsx.maxSharedStrings} shared strings`,
              );
            }
            current = "";
            break;
          case "rPh":
            inPhonetic = true;
            break;
          case "t":
            inText = !inPhonetic;
            break;
        }
      },
      text(value) {
        if (inText) current += value;
      },
      close(name) {
        switch (localName(name)) {
          case "si":
            strings.push(current);
            break;
          case "rPh":
            inPhonetic = false;
            break;
          case "t":
            inText = false;
            break;
        }
      },
    },
    context,
  );
  return strings;
}

function dateFormatOfCode(code: string): DateFormat | undefined {
  const tokens = code.replaceAll(QUOTED_BRACKETED_OR_ESCAPED, "");
  if (/[dy]/iu.test(tokens)) return "date";
  if (/[hs]/iu.test(tokens)) return "time";
  return /m/iu.test(tokens) ? "date" : undefined;
}

function readDateFormats(archive: ZipArchive, context: ExtractionContext) {
  const formats: (DateFormat | undefined)[] = [];
  const entry = findEntry(archive, "xl/styles.xml");
  if (entry === undefined) return formats;
  const custom = new Map<number, DateFormat | undefined>();
  let inCellFormats = false;
  readXmlEntry(
    archive,
    entry,
    {
      open(name, attributes) {
        switch (localName(name)) {
          case "numFmt":
            custom.set(Number(attributes.numFmtId), dateFormatOfCode(attributes.formatCode ?? ""));
            break;
          case "cellXfs":
            inCellFormats = true;
            break;
          case "xf":
            if (inCellFormats) {
              const id = Number(attributes.numFmtId ?? 0);
              formats.push(custom.has(id) ? custom.get(id) : BUILT_IN_DATE_FORMATS.get(id));
            }
            break;
        }
      },
      text: ignore,
      close(name) {
        if (localName(name) === "cellXfs") inCellFormats = false;
      },
    },
    context,
  );
  return formats;
}

function isoDate(serial: number, format: DateFormat, date1904: boolean): string | undefined {
  if (!(serial >= 0 && serial < MAX_SERIAL)) return undefined;
  const seconds = Math.round(serial * SECONDS_PER_DAY);
  const days = Math.floor(seconds / SECONDS_PER_DAY);
  const secondOfDay = seconds - days * SECONDS_PER_DAY;
  const time = new Date(secondOfDay * 1_000).toISOString().slice(11, 19);
  if (format === "time" && days === 0) return time;
  let date = "1900-02-29";
  if (date1904 || days !== 60) {
    const epoch = date1904 ? EPOCH_1904 : days < 60 ? EPOCH_1900 : EPOCH_1900_AFTER_LEAP_DAY;
    const ms = epoch + days * DAY_MS;
    if (ms >= YEAR_10000) return undefined;
    date = new Date(ms).toISOString().slice(0, 10);
  }
  return secondOfDay === 0 ? date : `${date}T${time}`;
}

function cellType(value: string | undefined): CellType {
  switch (value) {
    case "b":
    case "d":
    case "e":
    case "inlineStr":
    case "s":
    case "str":
      return value;
    default:
      return "n";
  }
}

function cellText(cell: CellDraft, book: CellContext): string {
  if (cell.type === "inlineStr") return cell.inline;
  if (!cell.cachedValue) return cell.formula === "" ? "" : `=${cell.formula}`;
  switch (cell.type) {
    case "s":
      return book.sharedStrings[Number(cell.cachedValue)] ?? "";
    case "b":
      return cell.cachedValue === "1"
        ? "TRUE"
        : cell.cachedValue === "0"
          ? "FALSE"
          : cell.cachedValue;
    case "d":
    case "e":
    case "str":
      return cell.cachedValue;
    case "n": {
      const format = book.dateFormats[cell.style];
      const date = format && isoDate(Number.parseFloat(cell.cachedValue), format, book.date1904);
      return date ?? cell.cachedValue;
    }
    default: {
      const unhandled: never = cell.type;
      return unhandled;
    }
  }
}

function columnName(column: number) {
  let name = "";
  for (let rest = column; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    name = String.fromCharCode(65 + ((rest - 1) % 26)) + name;
  }
  return name;
}

function columnOfReference(reference: string) {
  const letters = /^([A-Z]{1,3})\d+$/u.exec(reference)?.[1] ?? "";
  let column = 0;
  for (const letter of letters) column = column * 26 + letter.charCodeAt(0) - 64;
  return column;
}

class SheetWriter {
  rows = 0;
  #lines: string[] = [];
  #heldLength = 0;
  #columns = 0;

  constructor(
    readonly sink: TextSink,
    readonly title: string,
  ) {}

  add(rowNumber: number, values: readonly (string | undefined)[]) {
    const fields = Array.from(values, (value = "") =>
      /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value,
    );
    const line = `${rowNumber},${fields.join(",")}\n`;
    this.#lines.push(line);
    this.#columns = Math.max(this.#columns, values.length);
    this.#heldLength += line.length;
    if (this.#heldLength > this.sink.capacity - this.sink.byteLength) {
      this.finish();
      this.sink.stop();
    }
  }

  finish() {
    this.sink.write(this.title);
    if (this.#columns > 0) {
      const header = Array.from({ length: this.#columns }, (_, index) => columnName(index + 1));
      this.sink.write(`row,${header.join(",")}\n`);
    }
    for (const line of this.#lines) {
      this.sink.write(line);
      this.rows += 1;
    }
    this.#lines = [];
  }
}

function readSheet(
  archive: ZipArchive,
  path: string,
  writer: SheetWriter,
  book: CellContext,
  cellsBefore: number,
  context: ExtractionContext,
) {
  let cells = cellsBefore;
  let rowNumber = 0;
  let values: string[] = [];
  let nextColumn = 1;
  let cell: CellDraft | undefined;
  let field: "cachedValue" | "formula" | "inline" | undefined;
  let inPhonetic = false;
  readXmlEntry(
    archive,
    requiredPart(archive, path, "worksheet"),
    {
      open(name, attributes) {
        switch (localName(name)) {
          case "row":
            rowNumber = attributes.r === undefined ? rowNumber + 1 : Number(attributes.r);
            if (!(Number.isInteger(rowNumber) && rowNumber >= 1 && rowNumber <= MAX_ROWS)) {
              throw new UnusableFile("unreadable", "a row number is invalid");
            }
            values = [];
            nextColumn = 1;
            break;
          case "c": {
            cells += 1;
            if (cells > LIMITS.xlsx.maxCells) {
              throw new UnusableFile(
                "limits_exceeded",
                `the workbook has more than ${LIMITS.xlsx.maxCells} cells`,
              );
            }
            const column =
              attributes.r === undefined ? nextColumn : columnOfReference(attributes.r);
            if (column < 1 || column > MAX_COLUMNS) {
              throw new UnusableFile("unreadable", "a cell reference is invalid");
            }
            cell = {
              column,
              type: cellType(attributes.t),
              style: Number(attributes.s ?? 0),
              cachedValue: undefined,
              formula: "",
              inline: "",
            };
            break;
          }
          case "v":
            if (cell !== undefined) cell.cachedValue = "";
            field = "cachedValue";
            break;
          case "f":
            field = "formula";
            break;
          case "rPh":
            inPhonetic = true;
            break;
          case "t":
            if (!inPhonetic) field = "inline";
            break;
        }
      },
      text(value) {
        if (cell === undefined) return;
        switch (field) {
          case "cachedValue":
            cell.cachedValue = (cell.cachedValue ?? "") + value;
            break;
          case "formula":
            cell.formula += value;
            break;
          case "inline":
            cell.inline += value;
            break;
        }
      },
      close(name) {
        switch (localName(name)) {
          case "v":
          case "f":
          case "t":
            field = undefined;
            break;
          case "rPh":
            inPhonetic = false;
            break;
          case "c":
            if (cell !== undefined) {
              const text = cellText(cell, book);
              if (text !== "") values[cell.column - 1] = text;
              nextColumn = cell.column + 1;
              cell = undefined;
            }
            break;
          case "row":
            if (values.length > 0) writer.add(rowNumber, values);
            break;
        }
      },
    },
    context,
  );
  writer.finish();
  return cells;
}

export const extractXlsx: Extractor<Uint8Array> = async (bytes, context) => {
  const archive = readZipDirectory(bytes);
  const workbook = readWorkbook(archive, context);
  const paths = readWorksheetPaths(archive, context);
  const book: CellContext = {
    sharedStrings: readSharedStrings(archive, context),
    dateFormats: readDateFormats(archive, context),
    date1904: workbook.date1904,
  };
  const sheets = workbook.sheets
    .flatMap(({ name, relationshipId, hidden }) => {
      const path = relationshipId === undefined ? undefined : paths.get(relationshipId);
      return hidden || path === undefined ? [] : [{ name, path }];
    })
    .map(({ name, path }, index) => ({
      name,
      path,
      writer: new SheetWriter(context.sink, `${index === 0 ? "" : "\f"}## Sheet "${name}"\n`),
    }));
  await untilTextBudget(() => {
    let cells = 0;
    for (const { path, writer } of sheets)
      cells = readSheet(archive, path, writer, book, cells, context);
  });
  return {
    kind: "workbook",
    sheets: sheets.map(({ name, writer }) => ({
      name: name.slice(0, MAX_FACT_NAME_LENGTH),
      rows: writer.rows,
    })),
    hiddenSheets: workbook.sheets.filter(({ hidden }) => hidden).length,
  };
};
