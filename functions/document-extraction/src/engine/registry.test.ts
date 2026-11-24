import { describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { docxFixture } from "../test-fixtures/ooxml.ts";
import { passwordProtectedPdf, textPdf } from "../test-fixtures/pdf.ts";
import { zeroFilledZip } from "../test-fixtures/zip-bomb.ts";
import { extractDocument } from "./registry.ts";

const MiB = 1024 * 1024;
const encoder = new TextEncoder();
const bytes = (...values: readonly (number | string)[]) =>
  Uint8Array.from(
    values.flatMap((value) =>
      typeof value === "string" ? Array.from(encoder.encode(value)) : [value],
    ),
  );

async function extracted(input: Uint8Array, fileName: string) {
  const document = await extractDocument(input, { fileName }, "ignore");
  if (document.status === "unusable") return { verdict: document, text: "" };
  const { text, ...verdict } = document;
  return { verdict, text: new TextDecoder().decode(text) };
}

describe("document extraction engine", () => {
  test("marks every PDF page and separates pages with form feeds", async () => {
    expect(
      await extracted(
        textPdf([["Revenue summary"], ["North region", "grew 8%"], ["Appendix (draft)"]]),
        "report.pdf",
      ),
    ).toEqual({
      verdict: {
        status: "text",
        mediaType: "application/pdf",
        truncated: false,
        facts: { kind: "pdf", pages: 3, pagesWithText: 3, ocrPages: 0 },
      },
      text: "--- Page 1 ---\nRevenue summary\f--- Page 2 ---\nNorth region\ngrew 8%\f--- Page 3 ---\nAppendix (draft)",
    });
  });

  test("refuses a password-protected PDF as encrypted", async () => {
    expect((await extracted(passwordProtectedPdf(), "locked.pdf")).verdict).toEqual({
      status: "unusable",
      reason: "encrypted",
      detail: "the PDF requires a password",
    });
  });

  test("refuses a PDF whose pages draw only vector shapes and have no text layer", async () => {
    expect((await extracted(textPdf(["vector-only", "vector-only"]), "scan.pdf")).verdict).toEqual({
      status: "unusable",
      reason: "no_text",
      detail: "the PDF has no text layer",
    });
  });

  test("decodes a Windows-1252 CSV", async () => {
    expect(await extracted(bytes("item,price\r\ncaf", 0xe9, " au lait,3\r\n"), "menu.csv")).toEqual(
      {
        verdict: {
          status: "text",
          mediaType: "text/csv",
          truncated: false,
          facts: { kind: "text", encoding: "windows-1252", lines: 2 },
        },
        text: "item,price\ncafé au lait,3\n",
      },
    );
  });

  test("decodes a UTF-16 CSV whose byte-order mark resembles MPEG audio", async () => {
    const utf16 = new Uint8Array([
      0xff,
      0xfe,
      ...Array.from("a,b\n", (c) => [c.charCodeAt(0), 0]).flat(),
    ]);
    expect(await extracted(utf16, "export.csv")).toEqual({
      verdict: {
        status: "text",
        mediaType: "text/csv",
        truncated: false,
        facts: { kind: "text", encoding: "utf-16", lines: 1 },
      },
      text: "a,b\n",
    });
  });

  test("delivers JSON that does not parse as plain text", async () => {
    expect((await extracted(bytes('{"region": "North",'), "broken.json")).verdict).toEqual({
      status: "text",
      mediaType: "text/plain",
      truncated: false,
      facts: { kind: "text", encoding: "utf-8", lines: 1 },
    });
  });

  test("reads HTML as text without scripts or styles", async () => {
    const html =
      "<html><head><title>Q3</title><style>p{}</style><script>alert(1)</script></head>" +
      "<body><h2>Totals</h2><ul><li>North &amp; South</li></ul><table><tr><td>A</td><td>1</td></tr></table></body></html>";
    expect(await extracted(bytes(html), "q3.html")).toEqual({
      verdict: {
        status: "text",
        mediaType: "text/html",
        truncated: false,
        facts: { kind: "html" },
      },
      text: "Q3\n## Totals\n- North & South\nA | 1\n",
    });
  });

  test("extracts both documents of an archive and lists the nested archive it skipped", async () => {
    const archive = zipSync({
      "a.csv": encoder.encode("region,total\nNorth,1200\n"),
      "docs/b.docx": docxFixture([{ kind: "styled", style: "Heading1", text: "Terms" }, "Net 30."]),
      "inner.zip": zipSync({ "c.txt": encoder.encode("hidden") }),
      "__MACOSX/._a.csv": encoder.encode("resource fork"),
    });
    expect(await extracted(archive, "two.zip")).toEqual({
      verdict: {
        status: "text",
        mediaType: "application/zip",
        truncated: false,
        facts: {
          kind: "archive",
          extracted: [
            { path: "a.csv", mediaType: "text/csv" },
            {
              path: "docs/b.docx",
              mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            },
          ],
          skipped: [{ path: "inner.zip", reason: "nested_archive" }],
          skippedTotal: 1,
        },
      },
      text:
        "# Archive: 2 of 3 entries extracted\nSkipped: inner.zip (nested archive)\n" +
        "\f=== Entry 1/2: a.csv (CSV file) ===\nregion,total\nNorth,1200\n" +
        "\f=== Entry 2/2: docs/b.docx (Word document) ===\n# Terms\nNet 30.\n",
    });
  });

  test("refuses a ZIP bomb before inflating it", async () => {
    const bomb = zeroFilledZip(200 * MiB);
    expect((await extracted(bomb, "bomb.zip")).verdict).toEqual({
      status: "unusable",
      reason: "limits_exceeded",
      detail: "an entry inflates more than 200:1",
    });
  });

  test("calls a document that yields no text bytes no_text", async () => {
    expect((await extracted(docxFixture([]), "blank.docx")).verdict).toEqual({
      status: "unusable",
      reason: "no_text",
      detail: "the file has no text",
    });
  });

  test("names the one reason every entry of an archive was skipped for", async () => {
    const noise = new Uint8Array(11 * MiB);
    for (let offset = 0; offset < noise.length; offset += 65_536) {
      crypto.getRandomValues(noise.subarray(offset, offset + 65_536));
    }
    const legacy = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, "Workbook");
    expect([
      (await extracted(zipSync({ "big.txt": noise }, { level: 0 }), "big.zip")).verdict,
      (await extracted(zipSync({ "q1.xls": legacy, "q2.xls": legacy }), "old.zip")).verdict,
      (
        await extracted(
          zipSync({ "inner.zip": zipSync({ "a.txt": noise.subarray(0, 8) }) }),
          "n.zip",
        )
      ).verdict,
    ]).toEqual([
      {
        status: "unusable",
        reason: "limits_exceeded",
        detail: "every entry in the archive was skipped: over the processing limits",
      },
      {
        status: "unusable",
        reason: "legacy_office_format",
        detail: "every entry in the archive was skipped: legacy Office file",
      },
      {
        status: "unusable",
        reason: "no_text",
        detail: "no entry in the archive has readable text",
      },
    ]);
  });

  test.each([
    [
      "legacy Office bytes",
      bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, "WordDocument"),
      "q3.doc",
      { reason: "legacy_office_format", detail: "the file is a legacy Office document" },
    ],
    [
      "an encrypted Office document",
      bytes(
        0xd0,
        0xcf,
        0x11,
        0xe0,
        0xa1,
        0xb1,
        0x1a,
        0xe1,
        ...Array.from("EncryptedPackage", (c) => [c, 0]).flat(),
      ),
      "q3.xlsx",
      { reason: "encrypted", detail: "the Office document is password-protected" },
    ],
    [
      "a PNG named as a PDF",
      bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0),
      "scan.pdf",
      { reason: "unsupported_type", detail: "the bytes are image/png, not a document" },
    ],
    [
      "a PowerPoint deck",
      zipSync({ "ppt/presentation.xml": encoder.encode("<p:presentation/>") }),
      "deck.pptx",
      { reason: "unsupported_type", detail: "PowerPoint presentations are not supported" },
    ],
    [
      "an empty text file",
      bytes(" \n\n"),
      "notes.txt",
      { reason: "no_text", detail: "the file is empty" },
    ],
  ] as const)("refuses %s by name", async (_name, input, fileName, verdict) => {
    expect((await extracted(input, fileName)).verdict).toEqual({ status: "unusable", ...verdict });
  });

  test("stops at the text cap on a code point and says so", async () => {
    const document = await extractDocument(
      bytes("é".repeat(2 * MiB)),
      { fileName: "long.txt" },
      "ignore",
    );
    expect(document.status === "text" && [document.truncated, document.text.byteLength]).toEqual([
      true,
      3 * MiB,
    ]);
  });
});
