import { describe, expect, test } from "bun:test";
import { isSlug, slugFromName } from "./slug.ts";

describe("slugFromName", () => {
  test.each([
    ["Console QA", "console-qa"],
    ["  Ünïcode   Org!! ", "unicode-org"],
    ["!!!", ""],
    ["a".repeat(62) + " b", "a".repeat(62)],
  ])("%p → %p", (name, slug) => {
    expect(slugFromName(name)).toBe(slug);
  });
});

describe("isSlug", () => {
  test("accepts 1 to 63 lowercase letters, digits, or inner hyphens", () => {
    expect(["", "-qa", "a".repeat(64), "QA"].map(isSlug)).toEqual([false, false, false, false]);
    expect(["qa-1", "a".repeat(63)].map(isSlug)).toEqual([true, true]);
  });
});
