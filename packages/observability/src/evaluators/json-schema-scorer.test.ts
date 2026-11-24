import { describe, expect, test } from "bun:test";
import type { CaseExpectations } from "./config.ts";
import { runEvaluator, validateEvaluatorConfig } from "./run-evaluator.ts";
import type { EvaluationEvidence } from "./types.ts";

const clock = { now: () => 0 };
const schema = {
  type: "object",
  required: ["answer"],
  properties: { answer: { type: "string" } },
};

function evidence(
  fields: { readonly output?: string; readonly structuredOutput?: unknown },
  expectations: CaseExpectations = {},
): EvaluationEvidence {
  return { ...fields, toolCalls: [], expectations };
}

describe("json_schema", () => {
  test("bare JSON satisfying the schema scores 1", async () => {
    expect(
      await runEvaluator(
        { kind: "json_schema", schema },
        evidence({ output: ' {"answer":"yes"} ' }),
        clock,
      ),
    ).toMatchObject({ status: "succeeded", value: 1 });
  });

  test("a single fenced json block is accepted", async () => {
    expect(
      await runEvaluator(
        { kind: "json_schema", schema },
        evidence({ output: '```json\n{"answer": "yes"}\n```' }),
        clock,
      ),
    ).toMatchObject({ value: 1 });
  });

  test("a schema violation scores 0 with the first validation error as rationale", async () => {
    const outcome = await runEvaluator(
      { kind: "json_schema", schema },
      evidence({ output: '{"answer": 3}' }),
      clock,
    );
    expect(outcome).toMatchObject({
      status: "succeeded",
      value: 0,
      rationale: "/answer must be string",
    });
    expect(outcome).not.toHaveProperty("label");
  });

  test("unparseable output is the agent's failure: value 0 labelled invalid_json", async () => {
    expect(
      await runEvaluator(
        { kind: "json_schema", schema },
        evidence({ output: "Sure! answer: yes" }),
        clock,
      ),
    ).toMatchObject({ status: "succeeded", value: 0, label: "invalid_json" });
  });

  test("structured output is preferred over the response text", async () => {
    expect(
      await runEvaluator(
        { kind: "json_schema", schema },
        evidence({ output: "not json", structuredOutput: { answer: "yes" } }),
        clock,
      ),
    ).toMatchObject({ status: "succeeded", value: 1 });
    expect(
      await runEvaluator(
        { kind: "json_schema", schema },
        evidence({ output: '{"answer":"yes"}', structuredOutput: { answer: 1 } }),
        clock,
      ),
    ).toMatchObject({ status: "succeeded", value: 0 });
  });

  test("a schema that does not compile is invalid_configuration", async () => {
    const broken = { type: "not-a-type" };
    expect(
      await runEvaluator(
        { kind: "json_schema", schema: broken },
        evidence({ output: "{}" }),
        clock,
      ),
    ).toMatchObject({ status: "error", errorClass: "invalid_configuration" });
    expect(validateEvaluatorConfig({ kind: "json_schema", schema: broken })).toStartWith(
      "The JSON schema does not compile",
    );
    expect(validateEvaluatorConfig({ kind: "json_schema", schema })).toBeUndefined();
  });

  test("case jsonSchema supplies the schema; none anywhere is not applicable", async () => {
    expect(
      await runEvaluator(
        { kind: "json_schema" },
        evidence({ output: '{"answer":"yes"}' }, { jsonSchema: schema }),
        clock,
      ),
    ).toMatchObject({ value: 1 });
    expect(await runEvaluator({ kind: "json_schema" }, evidence({ output: "{}" }), clock)).toEqual({
      status: "not_applicable",
    });
  });

  test("no response and no structured output is missing_evidence", async () => {
    expect(await runEvaluator({ kind: "json_schema", schema }, evidence({}), clock)).toMatchObject({
      status: "error",
      errorClass: "missing_evidence",
    });
  });

  test("pattern and patternProperties match pathological values in linear time", async () => {
    const hostile = `${"a".repeat(65_536)}x`;
    const startedAt = performance.now();
    expect(
      await runEvaluator(
        {
          kind: "json_schema",
          schema: {
            type: "object",
            properties: { answer: { type: "string", pattern: "^(a|a)+$" } },
            patternProperties: { "^(a+)+$": { type: "number" } },
          },
        },
        evidence({ structuredOutput: { answer: hostile, [hostile]: 1 } }),
        clock,
      ),
    ).toMatchObject({ status: "succeeded", value: 0 });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  test("patterns without linear-time matching do not compile", () => {
    expect(
      validateEvaluatorConfig({
        kind: "json_schema",
        schema: { type: "string", pattern: "(a)\\1" },
      }),
    ).toContain("does not compile");
  });
});
