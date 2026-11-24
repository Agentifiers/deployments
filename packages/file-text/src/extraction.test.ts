import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { InvokeCommand } from "@aws-sdk/client-lambda";
import {
  ExtractionUnavailableError,
  makeLambdaFileTextExtractor,
  type ExtractionRequest,
} from "./extraction.ts";

const request: ExtractionRequest = {
  source: {
    url: "https://artifacts.example/q3.csv?X-Amz-Signature=abc",
    byteSize: 24,
    sha256: "a".repeat(64),
  },
  hint: { fileName: "q3.csv", contentType: "text/csv" },
  deadlineMs: 500_000,
};

function lambda(respond: () => Promise<{ FunctionError?: string; Payload?: Uint8Array }>) {
  const sent: InvokeCommand[] = [];
  const extractor = makeLambdaFileTextExtractor({
    functionName: "document-extraction",
    lambda: {
      send: async (command) => {
        sent.push(command);
        return respond();
      },
    },
  });
  return { extractor, sent };
}

const payload = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const text = "row,A,B\n1,North,1200\n";
const textSha256 = createHash("sha256").update(text).digest("hex");
const csvFacts = { kind: "text", encoding: "utf-8", lines: 2 } as const;

describe("Lambda file text extractor", () => {
  test("invokes the function synchronously with a clamped deadline", async () => {
    const { extractor, sent } = lambda(async () => ({
      Payload: payload({ status: "unusable", reason: "no_text", detail: "the file is empty" }),
    }));
    await extractor.extract(request);
    expect(sent[0]?.input.FunctionName).toBe("document-extraction");
    expect(sent[0]?.input.InvocationType).toBe("RequestResponse");
    const body = sent[0]?.input.Payload;
    expect(body instanceof Uint8Array && JSON.parse(new TextDecoder().decode(body))).toEqual({
      extractor: "document-text-v1",
      source: request.source,
      hint: request.hint,
      deadlineMs: 110_000,
    });
  });

  test("returns verified text with its facts", async () => {
    const { extractor } = lambda(async () => ({
      Payload: payload({
        status: "text",
        mediaType: "text/csv",
        textBase64: Buffer.from(text).toString("base64"),
        textSha256,
        truncated: false,
        facts: csvFacts,
      }),
    }));
    const outcome = await extractor.extract(request);
    expect(outcome.status === "text" && new TextDecoder().decode(outcome.text)).toBe(text);
    expect({ ...outcome, text: undefined }).toEqual({
      status: "text",
      mediaType: "text/csv",
      text: undefined,
      textSha256,
      truncated: false,
      facts: csvFacts,
    });
  });

  test("stores the function's verdict about the bytes", async () => {
    const { extractor } = lambda(async () => ({
      Payload: payload({
        status: "unusable",
        reason: "encrypted",
        detail: "the PDF requires a password",
      }),
    }));
    expect(await extractor.extract(request)).toEqual({
      status: "unusable",
      reason: "encrypted",
      detail: "the PDF requires a password",
    });
  });

  test("maps the function running out of memory to a limits verdict", async () => {
    const { extractor } = lambda(async () => ({
      FunctionError: "Unhandled",
      Payload: payload({ errorType: "Runtime.OutOfMemory", errorMessage: "Runtime exited" }),
    }));
    expect(await extractor.extract(request)).toEqual({
      status: "unusable",
      reason: "limits_exceeded",
      detail: "function memory",
    });
  });

  test("answers a request the function would refuse with a verdict, without invoking it", async () => {
    const { extractor, sent } = lambda(async () => ({
      FunctionError: "Unhandled",
      Payload: payload({ errorType: "SchemaError" }),
    }));
    const empty = { ...request, source: { ...request.source, byteSize: 0 } };

    expect(await extractor.extract(empty)).toEqual({
      status: "unusable",
      reason: "unreadable",
      detail: "the file's size or names are outside what extraction accepts",
    });
    expect(sent.length).toBe(0);
  });

  test.each([
    [
      "an unclassified function error",
      async () => ({ FunctionError: "Unhandled", Payload: payload({ errorType: "Error" }) }),
      "Document extraction failed (Unhandled).",
    ],
    [
      "throttling",
      async () => {
        throw Object.assign(new Error("Rate exceeded"), { name: "TooManyRequestsException" });
      },
      "Document extraction could not be invoked.",
    ],
    [
      "deploy skew",
      async () => ({ Payload: payload({ status: "skew", extractor: "document-text-v2" }) }),
      "Document extraction runs document-text-v2, not document-text-v1.",
    ],
    [
      "a malformed response",
      async () => ({ Payload: payload({ status: "text", mediaType: "image/png" }) }),
      "Document extraction returned a malformed response.",
    ],
    [
      "PDF facts that count more OCR-read pages than pages with text",
      async () => ({
        Payload: payload({
          status: "text",
          mediaType: "application/pdf",
          textBase64: Buffer.from(text).toString("base64"),
          textSha256,
          truncated: false,
          facts: { kind: "pdf", pages: 2, pagesWithText: 1, ocrPages: 2 },
        }),
      }),
      "Document extraction returned a malformed response.",
    ],
    [
      "text that does not match its hash",
      async () => ({
        Payload: payload({
          status: "text",
          mediaType: "text/csv",
          textBase64: Buffer.from(`${text}tampered`).toString("base64"),
          textSha256,
          truncated: false,
          facts: csvFacts,
        }),
      }),
      "Extracted text does not match its SHA-256.",
    ],
  ] as const)("treats %s as transient", async (_name, respond, message) => {
    const { extractor } = lambda(respond);
    const failure = await extractor.extract(request).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExtractionUnavailableError);
    expect(failure instanceof Error && failure.message).toBe(message);
  });
});
