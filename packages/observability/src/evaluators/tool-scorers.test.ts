import { describe, expect, test } from "bun:test";
import type { CaseExpectations } from "./config.ts";
import { runEvaluator } from "./run-evaluator.ts";
import type { EvaluationEvidence } from "./types.ts";

const clock = { now: () => 0 };

function evidence(
  tools: readonly string[],
  expectations: CaseExpectations = {},
): EvaluationEvidence {
  return {
    toolCalls: tools.map((name, index) => ({ name, status: index % 2 ? "failed" : "succeeded" })),
    expectations,
  };
}

describe("tool_called", () => {
  test("all mode scores the fraction of required tools called in any status", async () => {
    expect(
      await runEvaluator(
        { kind: "tool_called", tools: ["search", "fetch", "email"] },
        evidence(["search", "fetch", "search"]),
        clock,
      ),
    ).toMatchObject({ status: "succeeded", value: 2 / 3 });
  });

  test("any mode is 1 when any required tool was called", async () => {
    const config = { kind: "tool_called", mode: "any", tools: ["search", "fetch"] } as const;
    expect(await runEvaluator(config, evidence(["fetch"]), clock)).toMatchObject({ value: 1 });
    expect(await runEvaluator(config, evidence(["email"]), clock)).toMatchObject({ value: 0 });
  });

  test("case mustUseTools supplies tools; none anywhere is not applicable", async () => {
    expect(
      await runEvaluator(
        { kind: "tool_called" },
        evidence([], { mustUseTools: ["search"] }),
        clock,
      ),
    ).toMatchObject({ value: 0 });
    expect(await runEvaluator({ kind: "tool_called" }, evidence(["search"]), clock)).toEqual({
      status: "not_applicable",
    });
  });

  test("does not need a final response", async () => {
    expect(
      await runEvaluator({ kind: "tool_called", tools: ["search"] }, evidence(["search"]), clock),
    ).toMatchObject({ status: "succeeded", value: 1 });
  });
});

describe("no_tool", () => {
  test("scores 1 when no forbidden tool was called and 0 otherwise", async () => {
    const config = { kind: "no_tool", tools: ["delete"] } as const;
    expect(await runEvaluator(config, evidence(["search"]), clock)).toMatchObject({ value: 1 });
    expect(await runEvaluator(config, evidence(["search", "delete"]), clock)).toMatchObject({
      value: 0,
    });
  });

  test("case mustNotUseTools supplies the forbidden list", async () => {
    expect(
      await runEvaluator(
        { kind: "no_tool" },
        evidence(["delete"], { mustNotUseTools: ["delete"] }),
        clock,
      ),
    ).toMatchObject({ value: 0 });
    expect(
      await runEvaluator(
        { kind: "no_tool" },
        evidence(["search"], { mustNotUseTools: ["delete"] }),
        clock,
      ),
    ).toMatchObject({ value: 1 });
  });

  test("without any list it requires no tool calls at all and is always applicable", async () => {
    expect(await runEvaluator({ kind: "no_tool" }, evidence([]), clock)).toMatchObject({
      status: "succeeded",
      value: 1,
    });
    expect(await runEvaluator({ kind: "no_tool" }, evidence(["search"]), clock)).toMatchObject({
      status: "succeeded",
      value: 0,
    });
  });
});

describe("unavailable tool-call evidence", () => {
  test("is missing_evidence for tool evaluators, never a score", async () => {
    const unavailable: EvaluationEvidence = { expectations: {} };
    for (const config of [
      { kind: "tool_called", tools: ["search"] },
      { kind: "no_tool" },
    ] as const) {
      expect(await runEvaluator(config, unavailable, clock)).toEqual({
        status: "error",
        errorClass: "missing_evidence",
        message: "The run's tool calls are unavailable.",
        durationMs: 0,
      });
    }
  });
});
