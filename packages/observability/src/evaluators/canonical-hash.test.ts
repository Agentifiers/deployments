import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  evaluatorVersionHash,
  judgePromptHash,
  sampledForAutomaticScoring,
  scorePassed,
  sha256Hex,
} from "./canonical-hash.ts";

describe("canonicalJson", () => {
  test("sorts keys at every depth by code unit and drops whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" }, B: true })).toBe(
      '{"B":true,"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  test("rejects values without a JSON representation", () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
  });
});

describe("hashes", () => {
  test("sha256Hex and judgePromptHash are lowercase hex digests", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(judgePromptHash("abc")).toBe(sha256Hex("abc"));
  });

  test("evaluatorVersionHash ignores key order and tracks every input", () => {
    const base = evaluatorVersionHash({
      evaluator: { kind: "contains", mode: "all", values: ["a"] },
      threshold: 0.5,
      target: "root-run",
    });
    expect(
      evaluatorVersionHash({
        target: "root-run",
        threshold: 0.5,
        evaluator: { values: ["a"], mode: "all", kind: "contains" },
      }),
    ).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/u);
    const variants = [
      {
        evaluator: { kind: "contains", mode: "all", values: ["a"] },
        threshold: 0.6,
        target: "root-run",
      },
      {
        evaluator: { kind: "contains", mode: "all", values: ["a"] },
        threshold: 0.5,
        target: "trace",
      },
      {
        evaluator: { kind: "contains", mode: "any", values: ["a"] },
        threshold: 0.5,
        target: "root-run",
      },
      { evaluator: { kind: "not_contains", values: ["a"] }, threshold: 0.5, target: "root-run" },
    ] as const;
    for (const variant of variants) expect(evaluatorVersionHash(variant)).not.toBe(base);
  });
});

describe("sampledForAutomaticScoring", () => {
  test("rate 0 never samples and rate 1 always samples", () => {
    for (let index = 0; index < 50; index += 1) {
      expect(sampledForAutomaticScoring(`trace-${index}`, "definition", 0)).toBe(false);
      expect(sampledForAutomaticScoring(`trace-${index}`, "definition", 1)).toBe(true);
    }
  });

  test("decisions are deterministic, follow the hash bucket, and approximate the rate", () => {
    let sampled = 0;
    for (let index = 0; index < 2_000; index += 1) {
      const traceId = `trace-${index}`;
      const decision = sampledForAutomaticScoring(traceId, "definition", 0.25);
      expect(sampledForAutomaticScoring(traceId, "definition", 0.25)).toBe(decision);
      const bucket =
        Number.parseInt(sha256Hex(`${traceId}\u0000definition`).slice(0, 8), 16) / 0xffffffff;
      expect(decision).toBe(bucket < 0.25);
      if (decision) sampled += 1;
    }
    expect(sampled / 2_000).toBeGreaterThan(0.2);
    expect(sampled / 2_000).toBeLessThan(0.3);
  });

  test("a trace sampled at a lower rate stays sampled at a higher rate", () => {
    for (let index = 0; index < 200; index += 1) {
      if (sampledForAutomaticScoring(`trace-${index}`, "definition", 0.1))
        expect(sampledForAutomaticScoring(`trace-${index}`, "definition", 0.2)).toBe(true);
    }
  });
});

test("scorePassed passes at and above the threshold", () => {
  expect(scorePassed(0.5, 0.5)).toBe(true);
  expect(scorePassed(0.49, 0.5)).toBe(false);
  expect(scorePassed(0, 0)).toBe(true);
});
