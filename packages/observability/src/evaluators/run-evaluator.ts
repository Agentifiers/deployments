import { MAX_JUDGE_PROMPT_LENGTH, type EvaluatorConfig } from "./config.ts";
import { compileJsonSchema, scoreJsonSchema } from "./json-schema-scorer.ts";
import { runModelJudge } from "./model-judge.ts";
import { compileSafeRegex, scoreRegex } from "./regex-scorer.ts";
import { scoreContains, scoreNotContains } from "./text-scorers.ts";
import { scoreNoTool, scoreToolCalled } from "./tool-scorers.ts";
import {
  scorerError,
  type EvaluationEvidence,
  type EvaluatorDependencies,
  type EvaluatorOutcome,
  type ScorerResult,
} from "./types.ts";

const MISSING_RESPONSE = "The run has no final response.";
const MISSING_TOOL_CALLS = "The run's tool calls are unavailable.";

/**
 * Scores one run. Definition parameters win; when absent, case expectations supply them.
 * A case-sourced evaluator without parameters from either side is not applicable.
 */
async function score(
  config: EvaluatorConfig,
  evidence: EvaluationEvidence,
  dependencies: EvaluatorDependencies,
): Promise<ScorerResult> {
  const { expectations, output, toolCalls } = evidence;
  switch (config.kind) {
    case "contains": {
      const values = config.values ?? expectations.mustInclude;
      if (!values) return { status: "not_applicable" };
      if (output === undefined) return scorerError("missing_evidence", MISSING_RESPONSE);
      return scoreContains(
        { values, mode: config.mode ?? "all", caseSensitive: config.caseSensitive ?? false },
        output,
      );
    }
    case "not_contains": {
      const values = config.values ?? expectations.mustNot;
      if (!values) return { status: "not_applicable" };
      if (output === undefined) return scorerError("missing_evidence", MISSING_RESPONSE);
      return scoreNotContains({ values, caseSensitive: config.caseSensitive ?? false }, output);
    }
    case "regex": {
      // Flags belong to the pattern they were written for, so the pair resolves together.
      const parameters =
        config.pattern !== undefined
          ? {
              pattern: config.pattern,
              ...(config.flags !== undefined ? { flags: config.flags } : {}),
            }
          : expectations.matches;
      if (!parameters) return { status: "not_applicable" };
      if (output === undefined) return scorerError("missing_evidence", MISSING_RESPONSE);
      return scoreRegex(parameters, output);
    }
    case "json_schema": {
      const schema = config.schema ?? expectations.jsonSchema;
      if (!schema) return { status: "not_applicable" };
      return scoreJsonSchema(schema, evidence);
    }
    case "tool_called": {
      const tools = config.tools ?? expectations.mustUseTools;
      if (!tools) return { status: "not_applicable" };
      if (toolCalls === undefined) return scorerError("missing_evidence", MISSING_TOOL_CALLS);
      return scoreToolCalled({ tools, mode: config.mode ?? "all" }, toolCalls);
    }
    case "no_tool":
      if (toolCalls === undefined) return scorerError("missing_evidence", MISSING_TOOL_CALLS);
      return scoreNoTool(config.tools ?? expectations.mustNotUseTools, toolCalls);
    case "model_judge":
      return runModelJudge(config, evidence, dependencies.judge);
    case "human":
    case "imported":
      return scorerError(
        "invalid_configuration",
        `${config.kind === "human" ? "Human" : "Imported"} scores are recorded through the API and never run automatically.`,
      );
  }
}

/**
 * Runs one evaluator against run evidence. Execution failures become `error` outcomes with an
 * error class; they never produce a value.
 */
export async function runEvaluator(
  config: EvaluatorConfig,
  evidence: EvaluationEvidence,
  dependencies: EvaluatorDependencies = {},
): Promise<EvaluatorOutcome> {
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  let result: ScorerResult;
  try {
    result = await score(config, evidence, dependencies);
  } catch {
    result = scorerError("evaluator_failed", "The evaluator failed unexpectedly.");
  }
  if (result.status === "not_applicable") return result;
  return { ...result, durationMs: Math.max(0, now() - startedAt) };
}

/**
 * Semantic checks beyond the config schema: regex patterns compile and are safe, JSON schemas
 * compile, and judge settings are usable. Returns an error message, or `undefined` when valid.
 */
export function validateEvaluatorConfig(config: EvaluatorConfig): string | undefined {
  switch (config.kind) {
    case "regex": {
      if (config.pattern === undefined) return undefined;
      const expression = compileSafeRegex({
        pattern: config.pattern,
        ...(config.flags !== undefined ? { flags: config.flags } : {}),
      });
      return typeof expression === "string" ? expression : undefined;
    }
    case "json_schema": {
      if (config.schema === undefined) return undefined;
      const validate = compileJsonSchema(config.schema);
      return typeof validate === "string" ? validate : undefined;
    }
    case "model_judge":
      if (config.modelId.trim().length === 0) return "Judge model IDs must not be empty.";
      if (config.prompt.trim().length === 0) return "Judge prompts must not be empty.";
      if (config.prompt.length > MAX_JUDGE_PROMPT_LENGTH)
        return `Judge prompts must not exceed ${MAX_JUDGE_PROMPT_LENGTH} characters.`;
      return undefined;
    default:
      return undefined;
  }
}
