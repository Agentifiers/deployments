import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { LIMITS } from "../limits.ts";
import { docxFixture } from "../test-fixtures/ooxml.ts";
import { extractDocx } from "./docx.ts";
import { TextSink } from "./text-sink.ts";
import { UnusableFile } from "./unusable.ts";
import { InflationBudget } from "./zip.ts";

async function extract(bytes: Uint8Array, capacity: number = LIMITS.maxTextBytes) {
  const sink = new TextSink(capacity);
  const facts = await extractDocx(bytes, { sink, inflation: new InflationBudget() });
  return { text: new TextDecoder().decode(sink.bytes()), truncated: sink.truncated, facts };
}

const WORDPROCESSING = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

describe("DOCX extractor", () => {
  test("writes headings, list items, paragraphs, and table rows as lines", async () => {
    const bytes = docxFixture([
      { kind: "styled", style: "Title", text: "Quarterly report" },
      { kind: "styled", style: "Heading1", text: "Title text" },
      "Intro\twith a tab",
      { kind: "styled", style: "Heading2", text: "Background" },
      { kind: "list", text: "item" },
      { kind: "list", text: "second item" },
      {
        kind: "table",
        rows: [
          ["a", "b"],
          ["c", "d"],
        ],
      },
      { kind: "styled", style: "Heading6", text: "Deep" },
      "Line one\nline two",
    ]);

    expect(await extract(bytes)).toEqual({
      text:
        "# Quarterly report\n# Title text\nIntro\twith a tab\n## Background\n- item\n- second item\n" +
        "| a | b |\n| c | d |\n###### Deep\nLine one\nline two\n",
      truncated: false,
      facts: { kind: "word", paragraphs: 8, tables: 1 },
    });
  });

  test("treats a localized style id as a heading when styles.xml names it one", async () => {
    const bytes = docxFixture(
      [
        { kind: "styled", style: "berschrift2", text: "Hintergrund" },
        { kind: "styled", style: "Titel", text: "Bericht" },
        { kind: "styled", style: "Zitat", text: "Plain" },
      ],
      { styles: { berschrift2: "heading 2", Titel: "Title", Zitat: "Quote" } },
    );

    expect((await extract(bytes)).text).toBe("## Hintergrund\n# Bericht\nPlain\n");
  });

  test("joins a cell's paragraphs with a space and escapes pipes", async () => {
    const bytes = docxFixture([
      {
        kind: "table",
        rows: [
          [["first", "second"], "a|b"],
          ["", "line\nbreak"],
        ],
      },
    ]);

    expect(await extract(bytes)).toEqual({
      text: "| first second | a\\|b |\n|  | line break |\n",
      truncated: false,
      facts: { kind: "word", paragraphs: 0, tables: 1 },
    });
  });

  test("leaves out deleted, moved-away, field-code, text-box, and fallback text", async () => {
    const document = `<w:document xmlns:w="${WORDPROCESSING}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><w:body>
<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>
<w:r><w:t>Kept</w:t></w:r>
<w:del w:id="1"><w:r><w:delText>deleted</w:delText></w:r></w:del>
<w:ins w:id="2"><w:r><w:t xml:space="preserve"> inserted</w:t></w:r></w:ins>
<w:moveFrom w:id="3"><w:r><w:t>moved away</w:t></w:r></w:moveFrom>
<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t xml:space="preserve"> 7</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>
<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:txbx><w:txbxContent><w:p><w:r><w:t>text box</w:t></w:r></w:p></w:txbxContent></wps:txbx></w:drawing></mc:Choice><mc:Fallback><w:pict><w:t>fallback</w:t></w:pict></mc:Fallback></mc:AlternateContent></w:r>
</w:p>
<w:p><w:pPr><w:pStyle w:val="Normal"/><w:pPrChange w:id="4"><w:pPr><w:pStyle w:val="Heading1"/></w:pPr></w:pPrChange></w:pPr><w:r><w:t>Was a heading</w:t></w:r></w:p>
</w:body></w:document>`;

    expect(await extract(zipSync({ "word/document.xml": strToU8(document) }))).toEqual({
      text: "Kept inserted 7\nWas a heading\n",
      truncated: false,
      facts: { kind: "word", paragraphs: 2, tables: 0 },
    });
  });

  test("stops at a full sink with the prefix kept and facts for what was written", async () => {
    const bytes = docxFixture([
      "First paragraph",
      "Second paragraph",
      { kind: "table", rows: [["a"]] },
    ]);

    expect(await extract(bytes, 20)).toEqual({
      text: "First paragraph\nSeco",
      truncated: true,
      facts: { kind: "word", paragraphs: 1, tables: 0 },
    });
  });

  test("refuses a document part that declares a DOCTYPE and a package without one", () => {
    const doctype = `<!DOCTYPE w:document><w:document xmlns:w="${WORDPROCESSING}"><w:body><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:body></w:document>`;
    expect(extract(zipSync({ "word/document.xml": strToU8(doctype) }))).rejects.toThrow(
      new UnusableFile("unreadable", "an XML part declares a DOCTYPE"),
    );

    expect(extract(zipSync({ "notes.txt": strToU8("hello") }))).rejects.toThrow(
      new UnusableFile("unreadable", "the document part is missing"),
    );
  });
});
