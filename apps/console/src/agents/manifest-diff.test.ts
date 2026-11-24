import { describe, expect, test } from "bun:test";
import { canonicalManifestJson, diffHunks, diffLines, manifestDiff } from "./manifest-diff.ts";

const render = (before: string, after: string) =>
  diffLines(before, after).map((line) => {
    if (line.kind === "added") return `+${line.text}`;
    return line.kind === "removed" ? `-${line.text}` : ` ${line.text}`;
  });

describe("canonicalManifestJson", () => {
  test("sorts keys by code unit at every depth and drops undefined members", () => {
    const printed = canonicalManifestJson({
      b: 1,
      a: { z: [{ y: 1, x: 2 }], Z: undefined, A: true },
    });
    expect(printed).toBe(JSON.stringify({ a: { A: true, z: [{ x: 2, y: 1 }] }, b: 1 }, null, 2));
  });

  test("keeps array order, which is meaningful in manifests", () => {
    expect(canonicalManifestJson({ tools: ["b", "a"] })).toContain('"b",\n    "a"');
  });
});

describe("diffLines", () => {
  test("finds a minimal edit script with insertions, deletions, and kept lines", () => {
    expect(render("a\nb\nc\nd", "a\nc\nd\ne")).toEqual([" a", "-b", " c", " d", "+e"]);
  });

  test("handles empty documents on either side", () => {
    expect(render("", "x")).toEqual(["-", "+x"]);
    expect(render("x\ny", "x\ny")).toEqual([" x", " y"]);
  });

  test("numbers lines in both documents", () => {
    const lines = diffLines("a\nb\nc", "a\nx\nc");
    expect(lines.map(({ newNumber, oldNumber }) => [oldNumber, newNumber])).toEqual([
      [1, 1],
      [2, undefined],
      [undefined, 2],
      [3, 3],
    ]);
  });

  test("marks the differing middle of paired changed lines", () => {
    const [, removed, added] = diffLines(
      'x\n  "instructions": "Be brief.",',
      'x\n  "instructions": "Be very brief.",',
    );
    expect(removed?.highlight).toEqual({ end: 22, start: 22 });
    expect(added?.highlight).toEqual({ end: 27, start: 22 });
  });

  test("does not highlight lines with nothing in common", () => {
    const lines = diffLines("abc", "xyz");
    expect(lines.every((line) => line.highlight === undefined)).toBe(true);
  });

  test("replaces the whole document when the edit distance exceeds the cap", () => {
    const before = Array.from({ length: 1_500 }, (_, index) => `old ${index}`).join("\n");
    const after = Array.from({ length: 1_500 }, (_, index) => `new ${index}`).join("\n");
    const lines = diffLines(before, after);
    expect(lines).toHaveLength(3_000);
    expect(lines.slice(0, 1_500).every((line) => line.kind === "removed")).toBe(true);
    expect(lines.slice(1_500).every((line) => line.kind === "added")).toBe(true);
  });
});

describe("diffHunks", () => {
  const document = (count: number) =>
    Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");

  test("keeps three context lines and splits distant changes", () => {
    const before = document(20);
    const after = before.replace("line 2\n", "line two\n").replace("line 18\n", "line eighteen\n");
    const hunks = diffHunks(diffLines(before, after));
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.oldStart).toBe(1);
    expect(hunks[0]?.lines).toHaveLength(6);
    expect(hunks[1]?.oldStart).toBe(15);
    expect(hunks[1]?.newStart).toBe(15);
  });

  test("merges changes whose context overlaps", () => {
    const before = document(12);
    const after = before.replace("line 3\n", "line three\n").replace("line 8\n", "line eight\n");
    expect(diffHunks(diffLines(before, after))).toHaveLength(1);
  });
});

describe("manifestDiff", () => {
  test("treats key order as irrelevant", () => {
    expect(manifestDiff({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual({
      added: 0,
      hunks: [],
      identical: true,
      removed: 0,
    });
  });

  test("counts added and removed lines", () => {
    const diff = manifestDiff({ model: "a", name: "x" }, { model: "b", name: "x", tools: [] });
    expect(diff.identical).toBe(false);
    expect(diff.removed).toBe(2);
    expect(diff.added).toBe(3);
  });
});
