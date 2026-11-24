import { describe, expect, test } from "bun:test";
import {
  childStdoutLimit,
  decodeChildInput,
  decodeChildOutput,
  encodeChildInput,
  encodeChildOutput,
} from "./child-protocol.ts";
import type { ChildResult, ExtractedDocument } from "./engine/registry.ts";
import { LIMITS } from "./limits.ts";

const MiB = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TEXT_HEADER =
  '{"status":"text","mediaType":"text/plain","truncated":false,"facts":{"kind":"text","encoding":"utf-8","lines":1}}\n';
const frame = (header: string | object, ...body: readonly Uint8Array[]) =>
  Buffer.concat([
    encoder.encode(typeof header === "string" ? header : `${JSON.stringify(header)}\n`),
    ...body,
  ]);
const MALFORMED: ExtractedDocument = {
  status: "unusable",
  reason: "unreadable",
  detail: "the parser returned a malformed result",
};
const PAGES: ChildResult = {
  status: "pdf_pages",
  reading: {
    pageCount: 4,
    readStop: "complete",
    layers: ["Cover letter\n", "", "Seite 3 – Übersicht", ""],
    scans: [
      { pageNumber: 2, pdf: encoder.encode("%PDF-1.7 two") },
      { pageNumber: 4, pdf: encoder.encode("%PDF-1.7 four") },
    ],
  },
};
const pagesHeader = (overrides: object = {}) => ({
  status: "pdf_pages",
  pageCount: 2,
  readStop: "complete",
  layerBytes: [1, 0],
  scans: [{ pageNumber: 2, bytes: 3 }],
  ...overrides,
});

describe("child stdio protocol", () => {
  test("the child reads back the hint, the scan mode and the bytes the supervisor framed, newlines included", () => {
    const input = {
      hint: { fileName: "notes\n2026.txt", contentType: "text/plain" },
      bytes: encoder.encode("line one\nline two"),
      scans: "collect",
    } as const;

    expect(decoder.decode(encodeChildInput(input))).toBe(
      '{"hint":{"fileName":"notes\\n2026.txt","contentType":"text/plain"},"scans":"collect"}\nline one\nline two',
    );
    expect(decodeChildInput(encodeChildInput(input))).toEqual(input);
  });

  test("the supervisor reads back a text document the child framed", () => {
    const document: ExtractedDocument = {
      status: "text",
      mediaType: "text/plain",
      truncated: false,
      facts: { kind: "text", encoding: "utf-8", lines: 1 },
      text: encoder.encode("a\nb"),
    };

    expect(decoder.decode(encodeChildOutput(document))).toBe(`${TEXT_HEADER}a\nb`);
    expect(decodeChildOutput(encodeChildOutput(document), "ignore")).toEqual(document);
  });

  test("an unusable verdict travels without text, and bytes after it are ignored", () => {
    const document: ExtractedDocument = {
      status: "unusable",
      reason: "encrypted",
      detail: "the PDF requires a password",
    };

    expect(decoder.decode(encodeChildOutput(document))).toBe(
      '{"status":"unusable","reason":"encrypted","detail":"the PDF requires a password"}\n',
    );
    expect(
      decodeChildOutput(
        frame('{"status":"unusable","reason":"no_text"}\n', encoder.encode("x")),
        "ignore",
      ),
    ).toEqual({ status: "unusable", reason: "no_text" });
  });

  test("output without a header line, with a header that is not JSON, or with an unknown verdict is malformed", () => {
    expect([
      decodeChildOutput(encoder.encode('{"status":"unusable","reason":"no_text"}'), "ignore"),
      decodeChildOutput(encoder.encode("not json\ntext"), "ignore"),
      decodeChildOutput(encoder.encode('{"status":"text"}\ntext'), "ignore"),
    ]).toEqual([MALFORMED, MALFORMED, MALFORMED]);
  });

  test("text that is not UTF-8 or longer than the text cap is unreadable", () => {
    expect([
      decodeChildOutput(frame(TEXT_HEADER, Uint8Array.of(0xc3, 0x28)), "ignore"),
      decodeChildOutput(
        frame(TEXT_HEADER, new Uint8Array(LIMITS.maxTextBytes + 1).fill(0x61)),
        "ignore",
      ),
    ]).toEqual([
      {
        status: "unusable",
        reason: "unreadable",
        detail: "the parser returned text that is not UTF-8",
      },
      {
        status: "unusable",
        reason: "unreadable",
        detail: "the parser returned more text than allowed",
      },
    ]);
  });

  test("the supervisor reads back a PDF's layers and scanned pages the child framed", () => {
    expect(decoder.decode(encodeChildOutput(PAGES))).toBe(
      '{"status":"pdf_pages","pageCount":4,"readStop":"complete","layerBytes":[13,0,22,0],"scans":[{"pageNumber":2,"bytes":12},{"pageNumber":4,"bytes":13}]}\n' +
        "Cover letter\nSeite 3 – Übersicht%PDF-1.7 two%PDF-1.7 four",
    );
    expect(decodeChildOutput(encodeChildOutput(PAGES), "collect")).toEqual(PAGES);
  });

  test("layers past the text cap are cut on a code point before they travel", () => {
    const pages: ChildResult = {
      status: "pdf_pages",
      reading: {
        pageCount: 3,
        readStop: "text_budget",
        layers: ["a".repeat(3 * MiB - 1), "é and more", "never read"],
        scans: [{ pageNumber: 3, pdf: encoder.encode("%PDF") }],
      },
    };
    const decoded = decodeChildOutput(encodeChildOutput(pages), "collect");
    expect(decoded.status === "pdf_pages" && decoded.reading.layers.slice(1)).toEqual(["", ""]);
  });

  test("pdf_pages is malformed when the supervisor did not ask for scans", () => {
    expect(decodeChildOutput(encodeChildOutput(PAGES), "ignore")).toEqual(MALFORMED);
  });

  test.each([
    ["lengths that do not add up to the body", pagesHeader({ layerBytes: [2, 0] })],
    ["no scanned page", pagesHeader({ scans: [] })],
    ["a scanned page past the pages read", pagesHeader({ scans: [{ pageNumber: 3, bytes: 3 }] })],
    ["a scanned page numbered 0", pagesHeader({ scans: [{ pageNumber: 0, bytes: 3 }] })],
    [
      "scanned pages out of order",
      pagesHeader({
        layerBytes: [1, 0],
        scans: [
          { pageNumber: 2, bytes: 1 },
          { pageNumber: 1, bytes: 2 },
        ],
      }),
    ],
    [
      "a scanned page twice",
      pagesHeader({
        scans: [
          { pageNumber: 2, bytes: 1 },
          { pageNumber: 2, bytes: 2 },
        ],
      }),
    ],
    ["fewer pages than layers", pagesHeader({ pageCount: 1 })],
    ["an unknown read stop", pagesHeader({ readStop: "tired" })],
  ])("pdf_pages with %s is malformed", (_name, header) => {
    expect(decodeChildOutput(frame(header, encoder.encode("a%PD")), "collect")).toEqual(MALFORMED);
  });

  test("pdf_pages with a layer that is not UTF-8, or more layer text than the text cap, is malformed", () => {
    expect([
      decodeChildOutput(
        frame(
          pagesHeader({ layerBytes: [2, 0] }),
          Uint8Array.of(0xc3, 0x28),
          encoder.encode("%PD"),
        ),
        "collect",
      ),
      decodeChildOutput(
        frame(
          pagesHeader({ layerBytes: [LIMITS.maxTextBytes + 1, 0] }),
          new Uint8Array(LIMITS.maxTextBytes + 1).fill(0x61),
          encoder.encode("%PD"),
        ),
        "collect",
      ),
    ]).toEqual([MALFORMED, MALFORMED]);
  });

  test("pdf_pages with a scanned page over the page byte cap, or page PDFs over the total cap, is malformed", () => {
    const pages = (count: number, bytes: number) =>
      Array.from({ length: count }, (_, index) => ({ pageNumber: index + 1, bytes }));
    expect([
      decodeChildOutput(
        frame(
          pagesHeader({ layerBytes: [0], pageCount: 1, scans: pages(1, 10_000_001) }),
          new Uint8Array(10_000_001),
        ),
        "collect",
      ),
      decodeChildOutput(
        frame(
          pagesHeader({ layerBytes: Array(7).fill(0), pageCount: 7, scans: pages(7, 10_000_000) }),
          new Uint8Array(70_000_000),
        ),
        "collect",
      ),
    ]).toEqual([MALFORMED, MALFORMED]);
  });

  test("the child may write the page PDFs on top of the text only when it collects scans", () => {
    expect([childStdoutLimit("ignore"), childStdoutLimit("collect")]).toEqual([
      3 * MiB + 64 * 1024,
      67 * MiB + 64 * 1024,
    ]);
  });
});
