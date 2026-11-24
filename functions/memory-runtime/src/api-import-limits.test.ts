import { describe, expect, it } from "bun:test";
import { MAX_IMPORT_SERIALIZED_BYTES, importItems } from "./api-support.ts";

describe("memory import API limits", () => {
  it("rejects batches whose aggregate serialized data exceeds the Lambda response budget", () => {
    const data = Array.from({ length: 80 }, () => ({
      content: "Memory",
      metadata: { payload: "x".repeat(60_000) },
      scope: "organization",
    }));

    expect(() => importItems(data)).toThrow(
      `data must serialize to at most ${MAX_IMPORT_SERIALIZED_BYTES} bytes.`,
    );
  });
});
