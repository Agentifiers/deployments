import { describe, expect, test } from "bun:test";
import { canonicalJson, ordinalCompare } from "./canonical.ts";

describe("governance canonical JSON", () => {
  test("orders object keys by deterministic UTF-16 code units", () => {
    expect(["é", "a", "Z"].sort(ordinalCompare)).toEqual(["Z", "a", "é"]);
    expect(canonicalJson({ a: 2, Z: 1, é: 3 })).toBe('{"Z":1,"a":2,"é":3}');
  });

  test("rejects values that JSON cannot represent", () => {
    expect(() => canonicalJson(undefined)).toThrow("Canonical JSON does not support");
    expect(() => canonicalJson(Symbol("unsupported"))).toThrow("Canonical JSON does not support");
  });
});
