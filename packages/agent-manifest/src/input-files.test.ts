import { describe, expect, test } from "bun:test";
import { inputFileHint, sniffInputMediaType } from "./input-files.ts";

const bytes = (...values: readonly (number | string)[]) =>
  Uint8Array.from(
    values.flatMap((value) =>
      typeof value === "string"
        ? Array.from(value, (character) => character.charCodeAt(0))
        : [value],
    ),
  );

describe("input media signatures", () => {
  test("types images and audio by their leading bytes and nothing else", () => {
    expect(
      [
        bytes(0xff, 0xd8, 0xff, 0xe0, 1),
        bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1),
        bytes("RIFF", 0, 0, 0, 0, "WEBP"),
        bytes("RIFF", 0, 0, 0, 0, "WAVE"),
        bytes("ID3", 4),
        bytes("%PDF-1.7"),
        bytes(0xff, 0xfe, "a", 0),
      ].map(sniffInputMediaType),
    ).toEqual([
      "image/jpeg",
      "image/png",
      "image/webp",
      "audio/wav",
      "audio/mpeg",
      undefined,
      undefined,
    ]);
  });
});

describe("input file hints", () => {
  test.each([
    [
      "the extension over a Windows CSV declaration",
      { fileName: "Q3.CSV", contentType: "application/vnd.ms-excel" },
      { kind: "document", mediaType: "text/csv" },
    ],
    [
      "a declared type with parameters",
      { contentType: "text/csv; charset=UTF-8" },
      { kind: "document", mediaType: "text/csv" },
    ],
    [
      "a bare extension as the declared type",
      { contentType: "pdf" },
      { kind: "document", mediaType: "application/pdf" },
    ],
    ["a declared alias", { contentType: "audio/x-wav" }, { kind: "audio", mediaType: "audio/wav" }],
    [
      "a legacy Office extension",
      { fileName: "q3.xls", contentType: "application/octet-stream" },
      { kind: "unsupported", reason: "legacy_office_format" },
    ],
    [
      "a PowerPoint deck",
      { fileName: "deck.pptx" },
      { kind: "unsupported", reason: "unsupported_type" },
    ],
    [
      "a name without an extension and a generic type",
      { fileName: "upload", contentType: "application/octet-stream" },
      undefined,
    ],
  ] as const)("reads %s", (_name, hint, expected) => {
    expect(inputFileHint(hint)).toEqual(expected);
  });
});
