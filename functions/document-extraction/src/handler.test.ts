import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { zipSync } from "fflate";
import { buildBundleForTest } from "./test-fixtures/bundle.ts";
import { fakeTextract } from "./test-fixtures/fake-textract.ts";
import { invokeBundle } from "./test-fixtures/invoke-bundle.ts";
import { lambdaNodeBinary } from "./test-fixtures/lambda-node.ts";
import { docxFixture, xlsxFixture } from "./test-fixtures/ooxml.ts";
import { textPdf } from "./test-fixtures/pdf.ts";

const encoder = new TextEncoder();
const node = lambdaNodeBinary();
const files: Record<string, Uint8Array> = {
  "report.pdf": textPdf([["Revenue summary"], ["North region grew 8%"]]),
  "q3.xlsx": xlsxFixture([
    {
      name: "Revenue",
      rows: [
        ["Region", "Q2", "Date"],
        ["North", 1300, { kind: "formatted", value: 46112, format: 14 }],
      ],
    },
  ]),
  "terms.docx": docxFixture([{ kind: "styled", style: "Heading1", text: "Terms" }, "Net 30."]),
  "menu.csv": Uint8Array.from([
    ...encoder.encode("item,price\ncaf"),
    0xe9,
    ...encoder.encode(",3\n"),
  ]),
  "two.zip": zipSync({
    "a.txt": encoder.encode("first file\n"),
    "b.md": encoder.encode("# Second\n"),
  }),
  "scan.pdf": textPdf([{ scanWidth: 600 }, { scanWidth: 601 }]),
  "mixed.pdf": textPdf([
    ["Cover letter for the quarterly review"],
    { scanWidth: 600 },
    "vector-only",
  ]),
  "rejected.pdf": textPdf([{ scanWidth: 600 }, { scanWidth: 610 }]),
  "throttled.pdf": textPdf([{ scanWidth: 620 }]),
  "failing.pdf": textPdf([{ scanWidth: 630 }]),
  "blank-scan.pdf": textPdf([{ scanWidth: 640 }]),
};
const textract = fakeTextract({
  600: { lines: ["Invoice 4417 from Acme Corp", "Total due: 1,250.00 USD by 2026-11-30"] },
  601: { lines: ["Signed:\fJane\rExample"] },
  610: { error: "UnsupportedDocumentException", status: 400 },
  620: { error: "ThrottlingException", status: 400 },
  630: { error: "InternalServerError", status: 500 },
  640: { lines: [] },
});
const ocrOn = {
  DEPLOYMENTS_AI_TEXTRACT_ENDPOINT: textract.url,
  AWS_REGION: "us-east-2",
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
};
let bundle = "";
let server: Bun.Server<undefined> | undefined;

beforeAll(async () => {
  bundle = await buildBundleForTest();
  server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const file = files[new URL(request.url).pathname.slice(1)];
      return file ? new Response(file) : new Response("missing", { status: 404 });
    },
  });
});
beforeEach(() => {
  textract.requests.length = 0;
});
afterAll(async () => {
  await server?.stop(true);
  await textract.stop();
  await rm(bundle, { force: true, recursive: true });
});

const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

function eventFor(name: string, overrides: Record<string, unknown> = {}) {
  const file = files[name] ?? new Uint8Array([1]);
  return {
    extractor: "document-text-v1",
    source: { url: `${server?.url.href}${name}`, byteSize: file.byteLength, sha256: sha256(file) },
    hint: { fileName: name },
    deadlineMs: 20_000,
    ...overrides,
  };
}

async function responseTo(event: unknown, env: Record<string, string> = {}) {
  return (await invokeBundle({ node, bundle, event, env })).result;
}

function textOf(response: unknown) {
  if (typeof response !== "object" || response === null || !("textBase64" in response)) {
    return response;
  }
  const text = Buffer.from(String(response.textBase64), "base64");
  return {
    ...response,
    textBase64: undefined,
    text: text.toString("utf8"),
    hashMatches: "textSha256" in response && response.textSha256 === sha256(text),
  };
}

describe("document extraction bundle on the Lambda Node runtime", () => {
  test.each([
    [
      "report.pdf",
      "application/pdf",
      "--- Page 1 ---\nRevenue summary\f--- Page 2 ---\nNorth region grew 8%",
    ],
    [
      "q3.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      '## Sheet "Revenue"\nrow,A,B,C\n1,Region,Q2,Date\n2,North,1300,2026-03-31\n',
    ],
    [
      "terms.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "# Terms\nNet 30.\n",
    ],
    ["menu.csv", "text/csv", "item,price\ncafé,3\n"],
    [
      "two.zip",
      "application/zip",
      "# Archive: 2 of 2 entries extracted\n\f=== Entry 1/2: a.txt (text file) ===\nfirst file\n\f=== Entry 2/2: b.md (Markdown file) ===\n# Second\n",
    ],
  ] as const)("extracts %s", async (name, mediaType, text) => {
    expect(textOf(await responseTo(eventFor(name)))).toMatchObject({
      status: "text",
      mediaType,
      truncated: false,
      text,
      hashMatches: true,
    });
  });

  test("answers a request from another engine version with skew", async () => {
    expect(await responseTo(eventFor("menu.csv", { extractor: "document-text-v0" }))).toEqual({
      status: "skew",
      extractor: "document-text-v1",
    });
  });

  test("fails the call when the fetched bytes do not match the declared hash", async () => {
    const event = eventFor("menu.csv");
    expect(
      await responseTo({ ...event, source: { ...event.source, sha256: "0".repeat(64) } }),
    ).toEqual({ thrown: "The source does not match its SHA-256." });
  });

  test("fails the call when the source cannot be fetched", async () => {
    expect(await responseTo(eventFor("gone.pdf"))).toEqual({
      thrown: "The source fetch failed with HTTP 404.",
    });
  });

  test("bundles the PDF parser into the child only, and Textract into the handler only", async () => {
    const [handler, child] = await Promise.all([
      readFile(join(bundle, "handler.mjs"), "utf8"),
      readFile(join(bundle, "child.mjs"), "utf8"),
    ]);
    expect({
      handler: [handler.includes("function getDocument("), handler.includes("DetectDocumentText")],
      child: [child.includes("function getDocument("), child.includes("@aws-sdk")],
    }).toEqual({ handler: [false, true], child: [true, false] });
  });
});

describe("scanned PDF pages with Textract", () => {
  test("without the endpoint variable, a scan is no_text and nothing calls Textract", async () => {
    expect(await responseTo(eventFor("scan.pdf"))).toEqual({
      status: "unusable",
      reason: "no_text",
      detail: "the PDF has no text layer",
    });
    expect(textract.requests).toEqual([]);
  });

  test("reads every scanned page, one page per call, with no form feed or carriage return from a line", async () => {
    expect(textOf(await responseTo(eventFor("scan.pdf"), ocrOn))).toEqual({
      status: "text",
      mediaType: "application/pdf",
      truncated: false,
      facts: { kind: "pdf", pages: 2, pagesWithText: 2, ocrPages: 2 },
      textBase64: undefined,
      textSha256: expect.any(String),
      text:
        "--- Page 1 (OCR) ---\nInvoice 4417 from Acme Corp\nTotal due: 1,250.00 USD by 2026-11-30" +
        "\f--- Page 2 (OCR) ---\nSigned: Jane Example",
      hashMatches: true,
    });
    expect(textract.requests.toSorted((a, b) => a - b)).toEqual([600, 601]);
  });

  test("keeps text pages and pages without a raster image out of Textract", async () => {
    expect(textOf(await responseTo(eventFor("mixed.pdf"), ocrOn))).toMatchObject({
      facts: { kind: "pdf", pages: 3, pagesWithText: 2, ocrPages: 1 },
      text:
        "--- Page 1 ---\nCover letter for the quarterly review" +
        "\f--- Page 2 (OCR) ---\nInvoice 4417 from Acme Corp\nTotal due: 1,250.00 USD by 2026-11-30" +
        "\f--- Page 3 ---\n",
    });
    expect(textract.requests).toEqual([600]);
  });

  test("a page Textract rejects keeps its text layer while the rest is read, and the log counts it", async () => {
    const { result, logs } = await invokeBundle({
      node,
      bundle,
      event: eventFor("rejected.pdf"),
      env: ocrOn,
    });
    expect(textOf(result)).toMatchObject({
      facts: { kind: "pdf", pages: 2, pagesWithText: 1, ocrPages: 1 },
      text:
        "--- Page 1 (OCR) ---\nInvoice 4417 from Acme Corp\nTotal due: 1,250.00 USD by 2026-11-30" +
        "\f--- Page 2 ---\n",
    });
    expect(logs).toEqual([
      {
        message: "Read scanned PDF pages with Textract.",
        fields: { pageMs: [expect.any(Number), expect.any(Number)], pages: 2, rejected: 1 },
      },
    ]);
  });

  test("a scan where OCR finds nothing is no_text, and says OCR looked", async () => {
    expect(await responseTo(eventFor("blank-scan.pdf"), ocrOn)).toEqual({
      status: "unusable",
      reason: "no_text",
      detail: "the PDF has no text layer, and OCR found no text",
    });
  });

  test.each([
    ["throttling that outlasts the retries", "throttled.pdf", 620],
    ["a Textract server error", "failing.pdf", 630],
  ])(
    "%s fails the call after three attempts instead of judging the file",
    async (_name, file, width) => {
      expect(await responseTo(eventFor(file), ocrOn)).toEqual({
        thrown: "Textract could not read the scanned PDF pages.",
      });
      expect(textract.requests).toEqual([width, width, width]);
    },
  );

  test("refuses before calling Textract when reading the PDF left too little of the deadline", async () => {
    expect(await responseTo(eventFor("scan.pdf", { deadlineMs: 1_000 }), ocrOn)).toEqual({
      status: "unusable",
      reason: "limits_exceeded",
      detail: "reading the PDF left too little of the deadline for OCR",
    });
    expect(textract.requests).toEqual([]);
  });
});
