import { Schema } from "effect";

/**
 * Bump when a built-in evaluator changes how it scores identical evidence. The value is part
 * of every evaluator version hash, so results scored by different semantics never compare as
 * the same evaluator version.
 */
export const EVALUATOR_CATALOG_VERSION = "2026-09-29.1";

export const MAX_EVALUATOR_VALUES = 20;
export const MAX_EVALUATOR_VALUE_LENGTH = 1_000;
export const MAX_REGEX_PATTERN_LENGTH = 512;
export const MAX_JUDGE_PROMPT_LENGTH = 8_192;
export const MAX_JSON_SCHEMA_BYTES = 16_384;
export const MAX_CASE_INPUT_LENGTH = 32_768;
export const MAX_SCORE_RATIONALE_LENGTH = 2_000;
export const MAX_SCORE_LABEL_LENGTH = 64;

function boundedText(label: string, maximum: number) {
  return Schema.String.check(
    Schema.isMinLength(1, { message: `${label} must not be empty.` }),
    Schema.isMaxLength(maximum, { message: `${label} must not exceed ${maximum} characters.` }),
  );
}

function boundedArray<S extends Schema.Top>(item: S, label: string, maximum: number) {
  return Schema.Array(item).check(
    Schema.isMinLength(1, { message: `${label} must include at least one value.` }),
    Schema.isMaxLength(maximum, { message: `${label} must not exceed ${maximum} values.` }),
  );
}

export const EvaluatorText = boundedText("Evaluator values", MAX_EVALUATOR_VALUE_LENGTH);
export const EvaluatorValues = boundedArray(
  EvaluatorText,
  "Evaluator values",
  MAX_EVALUATOR_VALUES,
);
export const EvaluatorToolName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_.:-]{1,128}$/u, {
    message: "Tool names must be 1-128 letters, digits, '_', '.', ':', or '-'.",
  }),
);
export const EvaluatorToolNames = boundedArray(
  EvaluatorToolName,
  "Tool names",
  MAX_EVALUATOR_VALUES,
);
export const EvaluatorMatchMode = Schema.Literals(["all", "any"]);
export const RegexPattern = boundedText("Regular expression patterns", MAX_REGEX_PATTERN_LENGTH);
export const RegexFlags = Schema.String.check(
  Schema.isPattern(/^(?!.*(.).*\1)[imsu]{0,4}$/u, {
    message: "Regular expression flags may only contain distinct i, m, s, and u flags.",
  }),
);
export const JsonSchemaDocument = Schema.Record(Schema.String, Schema.Unknown).check(
  Schema.makeFilter((schema) =>
    new TextEncoder().encode(JSON.stringify(schema)).byteLength <= MAX_JSON_SCHEMA_BYTES
      ? undefined
      : `JSON schemas must not exceed ${MAX_JSON_SCHEMA_BYTES} bytes.`,
  ),
);

/** Passes when the final response contains the configured (or case `mustInclude`) values. */
export const ContainsEvaluator = Schema.Struct({
  caseSensitive: Schema.optional(Schema.Boolean),
  kind: Schema.Literal("contains"),
  mode: Schema.optional(EvaluatorMatchMode),
  values: Schema.optional(EvaluatorValues),
});

/** Passes when the final response contains none of the configured (or case `mustNot`) values. */
export const NotContainsEvaluator = Schema.Struct({
  caseSensitive: Schema.optional(Schema.Boolean),
  kind: Schema.Literal("not_contains"),
  values: Schema.optional(EvaluatorValues),
});

/** Passes when the final response matches the configured (or case `matches`) expression. */
export const RegexEvaluator = Schema.Struct({
  flags: Schema.optional(RegexFlags),
  kind: Schema.Literal("regex"),
  pattern: Schema.optional(RegexPattern),
});

/** Passes when the final response parses as JSON that satisfies the configured schema. */
export const JsonSchemaEvaluator = Schema.Struct({
  kind: Schema.Literal("json_schema"),
  schema: Schema.optional(JsonSchemaDocument),
});

/** Passes when the configured (or case `mustUseTools`) tools were called. */
export const ToolCalledEvaluator = Schema.Struct({
  kind: Schema.Literal("tool_called"),
  mode: Schema.optional(EvaluatorMatchMode),
  tools: Schema.optional(EvaluatorToolNames),
});

/**
 * Passes when none of the configured (or case `mustNotUseTools`) tools were called. Without a
 * tool list it requires that no tool was called at all.
 */
export const NoToolEvaluator = Schema.Struct({
  kind: Schema.Literal("no_tool"),
  tools: Schema.optional(EvaluatorToolNames),
});

export const DeterministicEvaluatorConfig = Schema.Union([
  ContainsEvaluator,
  NotContainsEvaluator,
  RegexEvaluator,
  JsonSchemaEvaluator,
  ToolCalledEvaluator,
  NoToolEvaluator,
]);
export type DeterministicEvaluatorConfig = typeof DeterministicEvaluatorConfig.Type;

/** A model grades the response; the prompt may use {{input}}, {{output}}, and {{expectations}}. */
export const ModelJudgeEvaluator = Schema.Struct({
  kind: Schema.Literal("model_judge"),
  maxOutputTokens: Schema.optional(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(16),
      Schema.isLessThanOrEqualTo(2_048),
    ),
  ),
  modelId: boundedText("Judge model IDs", 200),
  prompt: boundedText("Judge prompts", MAX_JUDGE_PROMPT_LENGTH),
  timeoutMs: Schema.optional(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1_000),
      Schema.isLessThanOrEqualTo(60_000),
    ),
  ),
});

/** Scores recorded by people through the API. */
export const HumanEvaluator = Schema.Struct({
  kind: Schema.Literal("human"),
  labels: Schema.optional(
    boundedArray(boundedText("Score labels", MAX_SCORE_LABEL_LENGTH), "Score labels", 20),
  ),
});

/** Scores produced by an external system and recorded through the API. */
export const ImportedEvaluator = Schema.Struct({
  kind: Schema.Literal("imported"),
  source: boundedText("Imported score sources", 128),
});

export const EvaluatorConfig = Schema.Union([
  ContainsEvaluator,
  NotContainsEvaluator,
  RegexEvaluator,
  JsonSchemaEvaluator,
  ToolCalledEvaluator,
  NoToolEvaluator,
  ModelJudgeEvaluator,
  HumanEvaluator,
  ImportedEvaluator,
]);
export type EvaluatorConfig = typeof EvaluatorConfig.Type;
export type EvaluatorKind = EvaluatorConfig["kind"];

export const ScoreDefinitionType = Schema.Literals([
  "deterministic",
  "human",
  "imported",
  "model-judged",
]);
export type ScoreDefinitionType = typeof ScoreDefinitionType.Type;

export function scoreDefinitionTypeForEvaluator(config: EvaluatorConfig): ScoreDefinitionType {
  switch (config.kind) {
    case "human":
      return "human";
    case "imported":
      return "imported";
    case "model_judge":
      return "model-judged";
    default:
      return "deterministic";
  }
}

/** Automated evaluators run in workers; human and imported scores are recorded through the API. */
export function evaluatorIsAutomated(config: EvaluatorConfig): boolean {
  return config.kind !== "human" && config.kind !== "imported";
}

/** Which evidence a score reads: the root run only, or every run in the trace graph. */
export const ScoreTarget = Schema.Literals(["root-run", "trace"]);
export type ScoreTarget = typeof ScoreTarget.Type;

export const ScoreThreshold = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0, { message: "Thresholds must be between 0 and 1." }),
  Schema.isLessThanOrEqualTo(1, { message: "Thresholds must be between 0 and 1." }),
);

/** The maximum automatic sampling rate for model-judged definitions (budget control). */
export const MAX_MODEL_JUDGE_SAMPLING_RATE = 0.25;

/**
 * Automatic scoring of finalized hosted customer traces. A rate of 0 disables automatic
 * scoring; evaluation runs always score every case regardless of sampling.
 */
export const ScoreSamplingPolicy = Schema.Struct({
  rate: ScoreThreshold,
});
export type ScoreSamplingPolicy = typeof ScoreSamplingPolicy.Type;

/** Expected behavior carried by a dataset case. Case-sourced evaluators read these fields. */
export const CaseExpectations = Schema.Struct({
  /** Opaque expected constraints owned by the dataset author; never interpreted by scorers. */
  constraints: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  jsonSchema: Schema.optional(JsonSchemaDocument),
  matches: Schema.optional(
    Schema.Struct({
      flags: Schema.optional(RegexFlags),
      pattern: RegexPattern,
    }),
  ),
  mustInclude: Schema.optional(EvaluatorValues),
  mustNot: Schema.optional(EvaluatorValues),
  mustNotUseTools: Schema.optional(EvaluatorToolNames),
  mustUseTools: Schema.optional(EvaluatorToolNames),
});
export type CaseExpectations = typeof CaseExpectations.Type;

/**
 * The user input a dataset case submits as a conversation turn. Conversations trim turn content
 * and reject blank input, so whitespace-only input is not a valid case.
 */
export const CaseInputContent = Schema.String.check(
  Schema.isPattern(/\S/u, { message: "Case input content must not be blank." }),
  Schema.isMaxLength(MAX_CASE_INPUT_LENGTH, {
    message: `Case input content must not exceed ${MAX_CASE_INPUT_LENGTH} characters.`,
  }),
);

/** Immutable, content-addressed dataset case material stored as canonical JSON. */
export const EvaluationCaseMaterial = Schema.Struct({
  expectations: CaseExpectations,
  input: Schema.Struct({ content: CaseInputContent }),
  schemaVersion: Schema.Literal(1),
});
export type EvaluationCaseMaterial = typeof EvaluationCaseMaterial.Type;

export const EvaluatorErrorClass = Schema.Literals([
  "evaluator_failed",
  "invalid_configuration",
  "judge_invalid_output",
  "judge_timeout",
  "judge_unavailable",
  "missing_evidence",
]);
export type EvaluatorErrorClass = typeof EvaluatorErrorClass.Type;
