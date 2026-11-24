import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { buildBundleForTest } from "./test-fixtures/bundle.ts";
import { CHILD_BUNDLE_FILE, SANDBOX_UNAVAILABLE_EXIT_CODE } from "./child-protocol.ts";
import type { ExtractedDocument } from "./engine/registry.ts";
import { ExtractionEnvironmentError, runChild, type ChildLimits } from "./supervisor.ts";
import { lambdaNodeBinary } from "./test-fixtures/lambda-node.ts";
import { pdfPages } from "./test-fixtures/pdf-pages.ts";
import { textPdf } from "./test-fixtures/pdf.ts";
import { zeroFilledZip } from "./test-fixtures/zip-bomb.ts";

const MiB = 1024 * 1024;
const node = lambdaNodeBinary();
const children = join(import.meta.dir, "test-children");
const limits: ChildLimits = { deadlineMs: 20_000, maxResidentBytes: 1_536 * MiB };
let bundle = "";

beforeAll(async () => {
  bundle = await buildBundleForTest();
});
afterAll(() => rm(bundle, { force: true, recursive: true }));

function runTestChild(name: string, childLimits: Partial<ChildLimits> = {}) {
  return runChild({
    bytes: new TextEncoder().encode("hello"),
    hint: { fileName: "hello.txt" },
    program: { nodePath: node, entry: join(children, name) },
    limits: { ...limits, ...childLimits },
    scans: "ignore",
  });
}

function textOf(document: ExtractedDocument) {
  if (document.status === "unusable") throw new Error(`The file was unusable: ${document.detail}`);
  return new TextDecoder().decode(document.text);
}

describe("extraction supervisor", () => {
  test("a child that generates code from a string is stopped, and the file is unusable", async () => {
    expect(await runTestChild("eval.mjs")).toEqual({
      status: "unusable",
      reason: "unreadable",
      detail: "the parser crashed (exit 1)",
    });
  });

  test("a child that reads /etc/hosts is denied, and the file is unusable", async () => {
    expect(await runTestChild("read-hosts.mjs")).toEqual({
      status: "unusable",
      reason: "unreadable",
      detail: "the parser crashed (exit 1)",
    });
  });

  test("a child sees none of the supervisor's environment", async () => {
    process.env.AWS_SECRET_ACCESS_KEY = "must-not-reach-the-child";
    try {
      const childKeys: string[] = JSON.parse(textOf(await runTestChild("environment.mjs")));
      // macOS itself adds __CF_USER_TEXT_ENCODING to every process.
      expect(childKeys.filter((key) => key !== "__CF_USER_TEXT_ENCODING")).toEqual([]);
      expect(process.env.AWS_SECRET_ACCESS_KEY).toBe("must-not-reach-the-child");
    } finally {
      delete process.env.AWS_SECRET_ACCESS_KEY;
    }
  });

  test("a sleeping child is killed at its deadline", async () => {
    const started = performance.now();
    expect(await runTestChild("sleep.mjs", { deadlineMs: 500 })).toEqual({
      status: "unusable",
      reason: "limits_exceeded",
      detail: "extraction did not finish within 500 ms",
    });
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test("a child that hoards memory outside the heap is killed by the watchdog", async () => {
    expect(await runTestChild("hog.mjs", { maxResidentBytes: 256 * MiB })).toEqual({
      status: "unusable",
      reason: "limits_exceeded",
      detail: "extraction used more than 268435456 bytes of memory",
    });
  });

  test("a child that cannot establish its sandbox fails the call instead of judging the file", async () => {
    expect(runTestChild("sandbox-missing.mjs")).rejects.toBeInstanceOf(ExtractionEnvironmentError);
  });

  test("the built child refuses to parse when started without the sandbox flags", () => {
    const result = Bun.spawnSync([node, join(bundle, CHILD_BUNDLE_FILE)], {
      env: {},
      stdin: new TextEncoder().encode('{"hint":{}}\nhello'),
    });
    expect([result.exitCode, result.stdout.toString()]).toEqual([
      SANDBOX_UNAVAILABLE_EXIT_CODE,
      "",
    ]);
  });

  test("the built child refuses to parse when code generation from strings is allowed", () => {
    const real = realpathSync(bundle);
    const result = Bun.spawnSync(
      [node, "--permission", `--allow-fs-read=${real}/*`, join(real, CHILD_BUNDLE_FILE)],
      { env: {}, stdin: new TextEncoder().encode('{"hint":{}}\nhello') },
    );
    expect([result.exitCode, result.stdout.toString()]).toEqual([
      SANDBOX_UNAVAILABLE_EXIT_CODE,
      "",
    ]);
  });

  test("the built child extracts a PDF under the sandbox", async () => {
    const result = await runChild({
      bytes: textPdf([["Quarterly revenue grew"], ["North region led"]]),
      hint: { fileName: "report.pdf" },
      program: { nodePath: node, entry: join(bundle, CHILD_BUNDLE_FILE) },
      limits,
      scans: "ignore",
    });
    expect({ ...result, text: textOf(result) }).toEqual({
      status: "text",
      mediaType: "application/pdf",
      truncated: false,
      facts: { kind: "pdf", pages: 2, pagesWithText: 2, ocrPages: 0 },
      text: "--- Page 1 ---\nQuarterly revenue grew\f--- Page 2 ---\nNorth region led",
    });
  });

  test("a 200 MiB ZIP bomb stops at the ratio cap while the child stays under 150 MiB", async () => {
    const result = await runChild({
      bytes: zeroFilledZip(200 * MiB),
      hint: { fileName: "bomb.zip" },
      program: { nodePath: node, entry: join(bundle, CHILD_BUNDLE_FILE) },
      limits: { ...limits, maxResidentBytes: 150 * MiB },
      scans: "ignore",
    });
    expect(result).toEqual({
      status: "unusable",
      reason: "limits_exceeded",
      detail: "an entry inflates more than 200:1",
    });
  });

  test("the built child cuts out scanned pages under the sandbox only when asked to collect them", async () => {
    const run = {
      bytes: textPdf([
        ["Cover letter for the quarterly review"],
        { scanWidth: 600 },
        "vector-only",
        { scanWidth: 601 },
      ]),
      hint: { fileName: "mixed.pdf" },
      program: { nodePath: node, entry: join(bundle, CHILD_BUNDLE_FILE) },
      limits,
    };
    const ignored = await runChild({ ...run, scans: "ignore" });
    const collected = await runChild({ ...run, scans: "collect" });

    expect({ ...ignored, text: textOf(ignored) }).toEqual({
      status: "text",
      mediaType: "application/pdf",
      truncated: false,
      facts: { kind: "pdf", pages: 4, pagesWithText: 1, ocrPages: 0 },
      text:
        "--- Page 1 ---\nCover letter for the quarterly review\f--- Page 2 ---\n" +
        "\f--- Page 3 ---\n\f--- Page 4 ---\n",
    });
    expect(
      collected.status === "pdf_pages" && {
        ...collected.reading,
        scans: await Promise.all(
          collected.reading.scans.map(async ({ pageNumber, pdf }) => ({
            pageNumber,
            pages: await pdfPages(pdf),
          })),
        ),
      },
    ).toEqual({
      pageCount: 4,
      readStop: "complete",
      layers: ["Cover letter for the quarterly review", "", "", ""],
      scans: [
        { pageNumber: 2, pages: [{ width: 600, imageXObjectPaints: 1 }] },
        { pageNumber: 4, pages: [{ width: 601, imageXObjectPaints: 1 }] },
      ],
    });
  });
});
