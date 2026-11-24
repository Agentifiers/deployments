import { deepStrictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invokeBundle } from "../src/test-fixtures/invoke-bundle.ts";
import { lambdaNodeBinary } from "../src/test-fixtures/lambda-node.ts";
import { buildFunctionBundle } from "./build.ts";

const region = process.env.AWS_REGION;
if (region === undefined) {
  throw new Error("Set AWS_REGION, and credentials such as AWS_PROFILE, for the Textract smoke.");
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const scan = new Uint8Array(
  await readFile(new URL("../src/test-fixtures/scan.pdf", import.meta.url)),
);
const bundle = await mkdtemp(join(tmpdir(), "document-extraction-smoke-"));
const source = Bun.serve({ port: 0, fetch: () => new Response(scan) });
try {
  await buildFunctionBundle(bundle);
  const started = performance.now();
  const { result, logs } = await invokeBundle({
    node: lambdaNodeBinary(),
    bundle,
    event: {
      extractor: "document-text-v1",
      source: {
        url: `${source.url.href}scan.pdf`,
        byteSize: scan.byteLength,
        sha256: sha256(scan),
      },
      hint: { fileName: "scan.pdf" },
      deadlineMs: 15_000,
    },
    env: {
      ...process.env,
      DEPLOYMENTS_AI_TEXTRACT_ENDPOINT: `https://textract.${region}.amazonaws.com`,
    },
  });
  const handlerMs = Math.round(performance.now() - started);
  if (
    typeof result !== "object" ||
    result === null ||
    !("textBase64" in result) ||
    !("textSha256" in result)
  ) {
    throw new Error(`The handler did not return text: ${JSON.stringify(result)}`);
  }
  const { textBase64, textSha256, ...verdict } = result;
  const text = Buffer.from(String(textBase64), "base64");
  deepStrictEqual(
    { ...verdict, text: text.toString("utf8"), textSha256 },
    {
      status: "text",
      mediaType: "application/pdf",
      truncated: false,
      facts: { kind: "pdf", pages: 2, pagesWithText: 2, ocrPages: 2 },
      text:
        "--- Page 1 (OCR) ---\nInvoice 4417 from Acme Corp\nTotal due: 1,250.00 USD by 2026-11-30\nScanned page one" +
        "\f--- Page 2 (OCR) ---\nSecond scanned page\nSigned: Jane Example",
      textSha256: sha256(text),
    },
  );
  console.log(JSON.stringify({ region, handlerMs, logs }));
} finally {
  await source.stop(true);
  await rm(bundle, { force: true, recursive: true });
}
