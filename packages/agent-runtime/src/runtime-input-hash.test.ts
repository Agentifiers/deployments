import { describe, expect, test } from "bun:test";
import { runtimeToolInputHash } from "./runtime-input-hash.ts";

describe("runtime tool input hash", () => {
  test("is stable across object key order while preserving array order", () => {
    expect(runtimeToolInputHash({ b: [2, 1], a: { d: true, c: null } })).toBe(
      runtimeToolInputHash({ a: { c: null, d: true }, b: [2, 1] }),
    );
    expect(runtimeToolInputHash({ values: [1, 2] })).not.toBe(
      runtimeToolInputHash({ values: [2, 1] }),
    );
    expect(runtimeToolInputHash({})).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });
});
