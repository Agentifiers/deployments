import { describe, expect, test } from "bun:test";
import type { CaseExpectations } from "./config.ts";
import { runEvaluator } from "./run-evaluator.ts";
import type { EvaluationEvidence } from "./types.ts";

function evidence(
  output: string | undefined,
  expectations: CaseExpectations = {},
): EvaluationEvidence {
  return { ...(output !== undefined ? { output } : {}), toolCalls: [], expectations };
}

const clock = { now: () => 0 };

describe("contains", () => {
  test("all mode scores the fraction of values found, case-insensitively by default", async () => {
    expect(
      await runEvaluator(
        { kind: "contains", values: ["Refund", "ORDER", "missing"] },
        evidence("Your refund for order 42 is on its way."),
        clock,
      ),
    ).toMatchObject({ status: "succeeded", value: 2 / 3, durationMs: 0 });
  });

  test("case folding covers non-ASCII text", async () => {
    expect(
      await runEvaluator({ kind: "contains", values: ["ÉTÉ"] }, evidence("un été chaud"), clock),
    ).toMatchObject({ value: 1 });
  });

  test("caseSensitive compares exactly", async () => {
    expect(
      await runEvaluator(
        { kind: "contains", caseSensitive: true, values: ["Refund", "refund"] },
        evidence("refund issued"),
        clock,
      ),
    ).toMatchObject({ value: 0.5 });
  });

  test("any mode is 1 when any value is found and 0 otherwise", async () => {
    const config = { kind: "contains", mode: "any", values: ["alpha", "beta"] } as const;
    expect(await runEvaluator(config, evidence("BETA release"), clock)).toMatchObject({ value: 1 });
    expect(await runEvaluator(config, evidence("gamma"), clock)).toMatchObject({ value: 0 });
  });

  test("case mustInclude supplies values when the definition has none", async () => {
    expect(
      await runEvaluator(
        { kind: "contains" },
        evidence("alpha only", { mustInclude: ["alpha", "beta"] }),
        clock,
      ),
    ).toMatchObject({ status: "succeeded", value: 0.5 });
  });

  test("definition values win over case expectations", async () => {
    expect(
      await runEvaluator(
        { kind: "contains", values: ["gamma"] },
        evidence("alpha beta", { mustInclude: ["alpha", "beta"] }),
        clock,
      ),
    ).toMatchObject({ value: 0 });
  });

  test("no values from either side is not applicable, even without a response", async () => {
    expect(await runEvaluator({ kind: "contains" }, evidence("text"), clock)).toEqual({
      status: "not_applicable",
    });
    expect(await runEvaluator({ kind: "contains" }, evidence(undefined), clock)).toEqual({
      status: "not_applicable",
    });
  });

  test("a missing final response is a missing_evidence error, not a zero", async () => {
    expect(
      await runEvaluator({ kind: "contains", values: ["a"] }, evidence(undefined), clock),
    ).toEqual({
      status: "error",
      errorClass: "missing_evidence",
      message: "The run has no final response.",
      durationMs: 0,
    });
  });
});

describe("not_contains", () => {
  test("scores the fraction of forbidden values absent", async () => {
    expect(
      await runEvaluator(
        { kind: "not_contains", values: ["password", "SSN", "secret"] },
        evidence("Here is the Password."),
        clock,
      ),
    ).toMatchObject({ status: "succeeded", value: 2 / 3 });
  });

  test("caseSensitive compares exactly", async () => {
    expect(
      await runEvaluator(
        { kind: "not_contains", caseSensitive: true, values: ["password"] },
        evidence("Password"),
        clock,
      ),
    ).toMatchObject({ value: 1 });
  });

  test("case mustNot supplies values; none anywhere is not applicable", async () => {
    expect(
      await runEvaluator(
        { kind: "not_contains" },
        evidence("a secret", { mustNot: ["secret"] }),
        clock,
      ),
    ).toMatchObject({ value: 0 });
    expect(await runEvaluator({ kind: "not_contains" }, evidence("a secret"), clock)).toEqual({
      status: "not_applicable",
    });
  });

  test("a missing final response is a missing_evidence error", async () => {
    expect(
      await runEvaluator({ kind: "not_contains", values: ["a"] }, evidence(undefined), clock),
    ).toMatchObject({ status: "error", errorClass: "missing_evidence" });
  });
});
