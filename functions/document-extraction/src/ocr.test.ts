import { describe, expect, test } from "bun:test";
import { ocrFromEnvironment } from "./ocr.ts";

describe("OCR configuration", () => {
  test.each([
    [{}, "off"],
    [{ DEPLOYMENTS_AI_TEXTRACT_ENDPOINT: "https://textract.us-east-2.amazonaws.com" }, "textract"],
    [
      {
        DEPLOYMENTS_AI_TEXTRACT_ENDPOINT:
          "https://vpce-0abc-1def.textract.us-east-2.vpce.amazonaws.com",
      },
      "textract",
    ],
    [{ DEPLOYMENTS_AI_TEXTRACT_ENDPOINT: "http://127.0.0.1:8080" }, "textract"],
  ] as const)("%o turns OCR %s", (env, kind) => {
    expect(ocrFromEnvironment(env).kind).toBe(kind);
  });

  test.each([
    "",
    "textract.us-east-2.amazonaws.com",
    "http://textract.us-east-2.amazonaws.com",
    "ftp://127.0.0.1",
  ])("refuses the endpoint %p", (endpoint) => {
    expect(() => ocrFromEnvironment({ DEPLOYMENTS_AI_TEXTRACT_ENDPOINT: endpoint })).toThrow(
      "DEPLOYMENTS_AI_TEXTRACT_ENDPOINT must be an absolute https URL, or http for a loopback host.",
    );
  });
});
