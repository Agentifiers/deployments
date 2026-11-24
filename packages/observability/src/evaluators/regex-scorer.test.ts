import { describe, expect, test } from "bun:test";
import type { CaseExpectations } from "./config.ts";
import { compileSafeRegex, MAX_REGEX_INPUT_LENGTH, scoreRegex } from "./regex-scorer.ts";
import { runEvaluator, validateEvaluatorConfig } from "./run-evaluator.ts";
import type { EvaluationEvidence } from "./types.ts";

function evidence(
  output: string | undefined,
  expectations: CaseExpectations = {},
): EvaluationEvidence {
  return { ...(output !== undefined ? { output } : {}), toolCalls: [], expectations };
}

const clock = { now: () => 0 };

describe("regex scoring", () => {
  test("scores 1 on a match and 0 otherwise", async () => {
    const config = { kind: "regex", pattern: "order #\\d{3,}" } as const;
    expect(await runEvaluator(config, evidence("See order #12345."), clock)).toMatchObject({
      status: "succeeded",
      value: 1,
    });
    expect(await runEvaluator(config, evidence("See order #12."), clock)).toMatchObject({
      status: "succeeded",
      value: 0,
    });
  });

  test("applies definition flags", async () => {
    expect(
      await runEvaluator(
        { kind: "regex", pattern: "^done$", flags: "im" },
        evidence("step\nDONE"),
        clock,
      ),
    ).toMatchObject({ value: 1 });
  });

  test("case matches supplies pattern and flags together", async () => {
    expect(
      await runEvaluator(
        { kind: "regex" },
        evidence("HELLO", { matches: { pattern: "hello", flags: "i" } }),
        clock,
      ),
    ).toMatchObject({ value: 1 });
    expect(
      await runEvaluator(
        { kind: "regex", pattern: "^bye$" },
        evidence("HELLO", { matches: { pattern: "hello", flags: "i" } }),
        clock,
      ),
    ).toMatchObject({ value: 0 });
  });

  test("no pattern from either side is not applicable", async () => {
    expect(await runEvaluator({ kind: "regex" }, evidence("x"), clock)).toEqual({
      status: "not_applicable",
    });
  });

  test("a missing final response is a missing_evidence error", async () => {
    expect(
      await runEvaluator({ kind: "regex", pattern: "x" }, evidence(undefined), clock),
    ).toMatchObject({ status: "error", errorClass: "missing_evidence" });
  });

  test("matches only the first 65,536 characters of the response", async () => {
    const padding = "a".repeat(MAX_REGEX_INPUT_LENGTH);
    const config = { kind: "regex", pattern: "needle" } as const;
    expect(await runEvaluator(config, evidence(`${padding}needle`), clock)).toMatchObject({
      value: 0,
    });
    expect(await runEvaluator(config, evidence(`${padding.slice(6)}needle`), clock)).toMatchObject({
      value: 1,
    });
  });

  test("an unsupported case-sourced pattern is an invalid_configuration error", async () => {
    expect(
      await runEvaluator(
        { kind: "regex" },
        evidence("aa", { matches: { pattern: "(a)\\1" } }),
        clock,
      ),
    ).toMatchObject({ status: "error", errorClass: "invalid_configuration" });
  });
});

describe("regex safety", () => {
  test.each([
    ["(a)\\1", "backreferences"],
    ["(?<word>a)\\k<word>", "backreferences"],
    ["a(?=b)", "lookaround"],
    ["a(?!b)", "lookaround"],
    ["(?<=a)b", "lookaround"],
    ["(?<!a)b", "lookaround"],
    ["^[^]+$", "linear-time"],
  ])("rejects %p", (pattern, reason) => {
    const result = validateEvaluatorConfig({ kind: "regex", pattern });
    expect(result).toBeString();
    expect(result).toContain(reason);
  });

  test("rejects over-long and invalid patterns", () => {
    expect(validateEvaluatorConfig({ kind: "regex", pattern: "a".repeat(513) })).toContain(
      "must not exceed 512",
    );
    expect(validateEvaluatorConfig({ kind: "regex", pattern: "(unclosed" })).toBe(
      "The regular expression pattern is invalid.",
    );
  });

  test.each([
    "(a|a)+",
    "(a+)+$",
    "(?<name>[a-z]+)+",
    "(\\d+)?",
    "(?:ab){1}",
    "[(+)]+",
    "\\(a+\\)+",
    "\\p{L}+",
    "(?:\\u{61}+)?",
    "a+?b*?",
  ])("accepts %p", (pattern) => {
    expect(validateEvaluatorConfig({ kind: "regex", pattern, flags: "u" })).toBeUndefined();
    expect(typeof compileSafeRegex({ pattern, flags: "u" })).toBe("object");
  });

  test.each([
    ["(a|a)+$", `${"a".repeat(MAX_REGEX_INPUT_LENGTH - 1)}x`],
    ["a*a*a*a*b", "a".repeat(MAX_REGEX_INPUT_LENGTH)],
    ["(a+)+$", `${"a".repeat(MAX_REGEX_INPUT_LENGTH - 1)}x`],
    ["(.*a){20}", "a".repeat(MAX_REGEX_INPUT_LENGTH)],
  ])("matches %p against a pathological response in linear time", (pattern, output) => {
    const startedAt = performance.now();
    const result = scoreRegex({ pattern }, output);
    expect(result.status).toBe("succeeded");
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});
