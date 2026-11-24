import { describe, expect, test } from "bun:test";
import { readTextPrefix } from "./artifact-data.ts";

function stream(...chunks: (string | Uint8Array)[]) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
        }
        controller.close();
      },
    }),
  ).body!;
}

describe("artifact text preview read", () => {
  test("returns a file within the cap whole", async () => {
    expect(await readTextPrefix(stream("id,total\n", "1,20\n"), 64)).toEqual({
      kind: "text",
      text: "id,total\n1,20\n",
      truncated: false,
    });
  });

  test("stops at the cap and says the text was cut", async () => {
    expect(await readTextPrefix(stream("abcdef", "ghij"), 4)).toEqual({
      kind: "text",
      text: "abcd",
      truncated: true,
    });
  });

  test("drops a character the cap split instead of calling the file binary", async () => {
    expect(await readTextPrefix(stream("aé"), 2)).toEqual({
      kind: "text",
      text: "a",
      truncated: true,
    });
  });

  test("calls bytes that are not UTF-8 text binary", async () => {
    expect(await readTextPrefix(stream(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), 64)).toEqual({
      kind: "binary",
    });
    expect(await readTextPrefix(stream("a\u0000b"), 64)).toEqual({ kind: "binary" });
  });
});
