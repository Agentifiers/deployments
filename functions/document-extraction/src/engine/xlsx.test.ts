import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { LIMITS } from "../limits.ts";
import { replaceParts, xlsxFixture, type XlsxCell } from "../test-fixtures/ooxml.ts";
import { TextSink } from "./text-sink.ts";
import { UnusableFile } from "./unusable.ts";
import { extractXlsx } from "./xlsx.ts";
import { InflationBudget } from "./zip.ts";

async function extract(bytes: Uint8Array, capacity: number = LIMITS.maxTextBytes) {
  const sink = new TextSink(capacity);
  const facts = await extractXlsx(bytes, { sink, inflation: new InflationBudget() });
  return { text: new TextDecoder().decode(sink.bytes()), truncated: sink.truncated, facts };
}

const date = (value: number, format: number | string = 14): XlsxCell => ({
  kind: "formatted",
  value,
  format,
});

describe("XLSX extractor", () => {
  test("writes visible sheets as CSV with row numbers and counts a hidden sheet without showing it", async () => {
    const bytes = xlsxFixture([
      {
        name: "Revenue",
        rows: [
          ["Region", "Q1", "Q2", "Total"],
          ["North", 1200.5, 1300, { kind: "formula", formula: "B2+C2" }],
          ["South", 900, 950, { kind: "formula", formula: "B3+C3", cached: 1850 }],
          ["West", 700, 710, { kind: "formula", formula: "B4+C4", emptyValueElement: true }],
        ],
      },
      { name: "Payroll", state: "hidden", rows: [["salary", 250_000]] },
      { name: "Notes", rows: [[], [undefined, 'a,"b"', undefined, "two\nlines"]] },
      { name: "Empty", rows: [] },
    ]);

    expect(await extract(bytes)).toEqual({
      text:
        '## Sheet "Revenue"\nrow,A,B,C,D\n1,Region,Q1,Q2,Total\n2,North,1200.5,1300,=B2+C2\n3,South,900,950,1850\n4,West,700,710,=B4+C4\n' +
        '\f## Sheet "Notes"\nrow,A,B,C,D\n2,,"a,""b""",,"two\nlines"\n' +
        '\f## Sheet "Empty"\n',
      truncated: false,
      facts: {
        kind: "workbook",
        sheets: [
          { name: "Revenue", rows: 4 },
          { name: "Notes", rows: 1 },
          { name: "Empty", rows: 0 },
        ],
        hiddenSheets: 1,
      },
    });
  });

  test("renders date-formatted serials as ISO 8601 with Excel's 1900 leap-year bug", async () => {
    const bytes = xlsxFixture([
      {
        name: "Dates",
        rows: [
          [date(46112), date(46112.604166666664, "yyyy-mm-dd hh:mm"), date(0.6041666666666666, 20)],
          [date(59), date(60), date(61), date(46112.5, "[$-409]mmmm d, yyyy")],
          [date(46112, '0.0 "days"'), date(46112, "[Red]0"), date(46112, "\\d0"), 46112],
        ],
      },
    ]);

    expect((await extract(bytes)).text).toBe(
      '## Sheet "Dates"\nrow,A,B,C,D\n' +
        "1,2026-03-31,2026-03-31T14:30:00,14:30:00\n" +
        "2,1900-02-28,1900-02-29,1900-03-01,2026-03-31T12:00:00\n" +
        "3,46112,46112,46112,46112\n",
    );
  });

  test("counts days from 1904 when the workbook says so and counts a very hidden sheet", async () => {
    const bytes = xlsxFixture(
      [
        { name: "Plan", rows: [[date(44650)]] },
        { name: "Macros", state: "veryHidden", rows: [["hidden"]] },
      ],
      { date1904: true },
    );

    expect(await extract(bytes)).toEqual({
      text: '## Sheet "Plan"\nrow,A\n1,2026-03-31\n',
      truncated: false,
      facts: { kind: "workbook", sheets: [{ name: "Plan", rows: 1 }], hiddenSheets: 1 },
    });
  });

  test("renders booleans, errors, inline strings, and cached string results as Excel shows them", async () => {
    const bytes = xlsxFixture([
      {
        name: "Values",
        rows: [
          [
            { kind: "boolean", value: true },
            { kind: "boolean", value: false },
            { kind: "error", text: "#DIV/0!" },
            { kind: "inline", text: "inline text" },
            { kind: "formula", formula: 'UPPER("north")', cached: "NORTH" },
          ],
        ],
      },
    ]);

    expect((await extract(bytes)).text).toBe(
      '## Sheet "Values"\nrow,A,B,C,D,E\n1,TRUE,FALSE,#DIV/0!,inline text,NORTH\n',
    );
  });

  test("reads prefixed elements, rich shared strings without phonetic runs, and absolute sheet targets", async () => {
    const main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    const bytes = replaceParts(xlsxFixture([{ name: "Offices", rows: [["placeholder"]] }]), {
      "xl/_rels/workbook.xml.rels":
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet1.xml"/></Relationships>',
      "xl/sharedStrings.xml": `<x:sst xmlns:x="${main}"><x:si><x:r><x:t>東京</x:t></x:r><x:r><x:t xml:space="preserve"> office</x:t></x:r><x:rPh sb="0" eb="2"><x:t>トウキョウ</x:t></x:rPh></x:si></x:sst>`,
      "xl/worksheets/sheet1.xml": `<x:worksheet xmlns:x="${main}"><x:sheetData><x:row><x:c t="s"><x:v>0</x:v></x:c><x:c><x:v>7</x:v></x:c></x:row></x:sheetData></x:worksheet>`,
    });

    expect((await extract(bytes)).text).toBe('## Sheet "Offices"\nrow,A,B\n1,東京 office,7\n');
  });

  test("stops at a full sink with the prefix kept and facts for every visible sheet", async () => {
    const bytes = xlsxFixture([
      {
        name: "Revenue",
        rows: [
          ["Region", "Q1"],
          ["North", 1200],
          ["South", 900],
        ],
      },
      { name: "Notes", rows: [["n"]] },
    ]);

    expect(await extract(bytes, 40)).toEqual({
      text: '## Sheet "Revenue"\nrow,A,B\n1,Region,Q1\n2',
      truncated: true,
      facts: {
        kind: "workbook",
        sheets: [
          { name: "Revenue", rows: 1 },
          { name: "Notes", rows: 0 },
        ],
        hiddenSheets: 0,
      },
    });
  });

  test("stops reading a sheet once its held rows outgrow the sink", async () => {
    const rows = ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc", "dddddddddd"]
      .map(
        (text, index) => `<row r="${index + 1}"><c t="inlineStr"><is><t>${text}</t></is></c></row>`,
      )
      .join("");
    const bytes = replaceParts(xlsxFixture([{ name: "S", rows: [] }]), {
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${rows}<row r="0"/></sheetData></worksheet>`,
    });

    expect(await extract(bytes, 40)).toEqual({
      text: '## Sheet "S"\nrow,A\n1,aaaaaaaaaa\n2,bbbbbb',
      truncated: true,
      facts: { kind: "workbook", sheets: [{ name: "S", rows: 1 }], hiddenSheets: 0 },
    });
  });

  test("lists at most 256 characters of a sheet name while the title keeps all of it", async () => {
    const name = "n".repeat(300);
    const { text, facts } = await extract(xlsxFixture([{ name, rows: [["x"]] }]));

    expect(text).toBe(`## Sheet "${name}"\nrow,A\n1,x\n`);
    expect(facts).toEqual({
      kind: "workbook",
      sheets: [{ name: "n".repeat(256), rows: 1 }],
      hiddenSheets: 0,
    });
  });

  test("refuses workbooks past the sheet, shared-string, and cell caps", () => {
    const manySheets = xlsxFixture(
      Array.from({ length: 65 }, (_, index) => ({ name: `S${index}`, rows: [] })),
    );
    expect(extract(manySheets)).rejects.toThrow(
      new UnusableFile("limits_exceeded", "the workbook has more than 64 sheets"),
    );

    const manyStrings = replaceParts(xlsxFixture([{ name: "S", rows: [["a"]] }]), {
      "xl/sharedStrings.xml": `<sst>${"<si><t>a</t></si>".repeat(1_000_001)}</sst>`,
    });
    expect(extract(manyStrings)).rejects.toThrow(
      new UnusableFile("limits_exceeded", "the workbook has more than 1000000 shared strings"),
    );

    const manyCells = replaceParts(xlsxFixture([{ name: "S", rows: [] }]), {
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${`<row>${"<c/>".repeat(1_000)}</row>`.repeat(2_001)}</sheetData></worksheet>`,
    });
    expect(extract(manyCells)).rejects.toThrow(
      new UnusableFile("limits_exceeded", "the workbook has more than 2000000 cells"),
    );
  });

  test("refuses a sheet nested deeper than 256 elements and a package without a workbook", () => {
    const deep = replaceParts(xlsxFixture([{ name: "S", rows: [] }]), {
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${"<x>".repeat(255)}${"</x>".repeat(255)}</sheetData></worksheet>`,
    });
    expect(extract(deep)).rejects.toThrow(
      new UnusableFile("limits_exceeded", "an XML part nests deeper than 256 elements"),
    );

    expect(extract(zipSync({ "notes.txt": strToU8("hello") }))).rejects.toThrow(
      new UnusableFile("unreadable", "the workbook part is missing"),
    );
  });
});
