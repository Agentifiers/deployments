import { describe, expect, test } from "bun:test";
import { parseBrainUploadQuotas } from "./upload-quotas.ts";

const parse = (encoded: string | undefined) =>
  parseBrainUploadQuotas({ DEPLOYMENTS_AI_BRAIN_UPLOAD_QUOTAS: encoded });

const invalid =
  "DEPLOYMENTS_AI_BRAIN_UPLOAD_QUOTAS must be a JSON object of positive integer Brain upload quotas";

describe("Brain upload quota configuration", () => {
  test.each([undefined, "", "  "])("keeps the platform defaults for %p", (encoded) => {
    expect(parse(encoded)).toEqual({
      hourlyIssuance: { caller: 60, organization: 500 },
      outstandingBytes: { brain: 1_073_741_824, caller: 134_217_728, organization: 4_294_967_296 },
      outstandingTickets: { brain: 100, caller: 10, organization: 500 },
    });
  });

  test("merges a partial override over the defaults", () => {
    expect(
      parse('{"hourlyIssuance":{"caller":5000},"outstandingTickets":{"organization":20000}}'),
    ).toEqual({
      hourlyIssuance: { caller: 5000, organization: 500 },
      outstandingBytes: { brain: 1_073_741_824, caller: 134_217_728, organization: 4_294_967_296 },
      outstandingTickets: { brain: 100, caller: 10, organization: 20000 },
    });
  });

  test.each([
    ['{"hourlyIssuance":{"caller":0}}', "Expected a value greater than 0, got 0"],
    ['{"outstandingBytes":{"brain":-1}}', "Expected a value greater than 0, got -1"],
    ['{"outstandingTickets":{"caller":2.5}}', "Expected an integer, got 2.5"],
    ['{"hourlyIssuance":{"brain":5}}', "Unexpected key"],
    ['{"uploadsPerDay":5}', "Unexpected key"],
  ])("rejects %s", (encoded, issue) => {
    expect(() => parse(encoded)).toThrow(`${invalid}: ${issue}`);
  });

  test("rejects an override that is not JSON", () => {
    expect(() => parse("{")).toThrow(invalid);
  });
});
