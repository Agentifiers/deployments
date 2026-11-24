import { describe, expect, test } from "bun:test";
import { threadStreamUrl } from "./stream-gateway-url.ts";

const threadId = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";

describe("thread stream URL", () => {
  test.each(["https://streams.example.test", "https://streams.example.test/"])(
    "addresses the thread stream on the gateway origin %s",
    (baseUrl) => {
      expect(threadStreamUrl(baseUrl, threadId)).toBe(
        `https://streams.example.test/v1/threads/${threadId}/stream`,
      );
    },
  );

  test.each([
    ["unset", ""],
    ["not a URL", "streams.example.test"],
    ["plain HTTP", "http://streams.example.test"],
    ["a path prefix", "https://streams.example.test/v1"],
    ["a query", "https://streams.example.test/?x=1"],
    ["credentials", Object.assign(new URL("https://streams.example.test"), { username: "u" }).href],
  ])("refuses to issue sessions when the gateway URL is %s", (_label, baseUrl) => {
    expect(() => threadStreamUrl(baseUrl, threadId)).toThrow(
      expect.objectContaining({ code: "stream_gateway_unavailable", status: 503 }),
    );
  });
});
