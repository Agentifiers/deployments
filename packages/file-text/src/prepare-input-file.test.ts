import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Exit, Schema } from "effect";
import { makeLambdaFileTextExtractor } from "./extraction.ts";
import { prepareInputFile } from "./prepare-input-file.ts";
import { ExtractionWireRequest } from "./wire.ts";

const TEXT = new TextEncoder().encode("Quarterly revenue grew.");

function extractionFunction() {
  const hints: unknown[] = [];
  const extractor = makeLambdaFileTextExtractor({
    functionName: "document-extraction",
    lambda: {
      send: async (command) => {
        const body = command.input.Payload;
        if (!(body instanceof Uint8Array))
          throw new Error("The client sends the request as bytes.");
        const request = Schema.decodeUnknownExit(ExtractionWireRequest)(
          JSON.parse(new TextDecoder().decode(body)),
        );
        if (Exit.isFailure(request)) {
          return {
            FunctionError: "Unhandled",
            Payload: new TextEncoder().encode(JSON.stringify({ errorType: "SchemaError" })),
          };
        }
        hints.push(request.value.hint);
        return {
          Payload: new TextEncoder().encode(
            JSON.stringify({
              facts: { kind: "pdf", pages: 1, pagesWithText: 1, ocrPages: 0 },
              mediaType: "application/pdf",
              status: "text",
              textBase64: Buffer.from(TEXT).toString("base64"),
              textSha256: createHash("sha256").update(TEXT).digest("hex"),
              truncated: false,
            }),
          ),
        };
      },
    },
  });
  return { extractor, hints };
}

describe("prepareInputFile", () => {
  test("bounds a declared type and file name to what the extraction request accepts", async () => {
    const { extractor, hints } = extractionFunction();
    const fileName = `${"q".repeat(1_100)}.pdf`;

    const input = await prepareInputFile(
      {
        artifactId: "01ARZ3NDEKTSV4RRFFQ69G5FB4",
        bucket: "artifacts",
        byteSize: 24,
        hint: { contentType: `application/pdf; name="${"x".repeat(900)}"`, fileName },
        key: "artifacts/organizations/o/projects/p/environments/e/customer/a/s/@input",
        scope: { environmentId: "e", organizationId: "o", projectId: "p" },
        sha256: "c".repeat(64),
        versionId: "source-1",
      },
      {
        deadlineMs: 20_000,
        extractor,
        objects: {
          presignSource: async () => "https://artifacts.example/input?X-Amz-Signature=abc",
          putTextOnce: async () => ({ versionId: "text-1" }),
          readLeadingBytes: async () => new Uint8Array(),
        },
      },
    );

    expect(input).toMatchObject({ kind: "document", summary: "PDF, 1 page" });
    expect(hints).toEqual([{ contentType: "application/pdf", fileName: fileName.slice(-1_024) }]);
  });
});
