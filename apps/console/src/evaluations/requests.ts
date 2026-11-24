/**
 * Form text to request bodies. The server decodes every body against its contract schema, so
 * these helpers only shape input (blank means "use the API default") and catch what would not
 * survive serialization (non-numbers, malformed JSON) before submission.
 */

export type Parsed<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly error: string; readonly ok: false };

/** A blank field is omitted; anything else must be a finite number. */
export function optionalNumber(text: string, label: string): Parsed<number | undefined> {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: undefined };
  const value = Number(trimmed);
  return Number.isFinite(value)
    ? { ok: true, value }
    : { error: `${label} must be a number.`, ok: false };
}

/** A JSON object (not an array or scalar), such as an evaluator configuration. */
export function jsonObject(text: string, label: string): Parsed<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: `${label} is not valid JSON.`, ok: false };
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ok: true, value: value as Record<string, unknown> }
    : { error: `${label} must be a JSON object.`, ok: false };
}

/** The import endpoint's batch limit. */
export const MAX_IMPORTED_CASES = 100;

/**
 * A JSON case file: an array of cases, or an object with a `cases` array (the import request
 * itself). Case fields are checked by the server against the contract.
 */
export function parseCaseFile(text: string): Parsed<readonly unknown[]> {
  if (text.trim() === "") return { error: "Paste or upload a JSON case file.", ok: false };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: "The case file is not valid JSON.", ok: false };
  }
  const cases =
    typeof value === "object" && value !== null && !Array.isArray(value) && "cases" in value
      ? value.cases
      : value;
  if (!Array.isArray(cases)) {
    return { error: "The case file must be a JSON array of cases.", ok: false };
  }
  if (cases.length === 0) return { error: "The case file has no cases.", ok: false };
  if (cases.length > MAX_IMPORTED_CASES) {
    return {
      error: `Import at most ${MAX_IMPORTED_CASES} cases at a time (the file has ${cases.length}).`,
      ok: false,
    };
  }
  return { ok: true, value: cases };
}

/** Optional numeric fields keyed by request field; blank entries are omitted. */
function optionalNumbers<const Key extends string>(
  fields: Readonly<Record<Key, { readonly label: string; readonly text: string }>>,
): Parsed<Partial<Record<Key, number>>> {
  const value: Partial<Record<Key, number>> = {};
  for (const [key, field] of Object.entries(fields) as [
    Key,
    { readonly label: string; readonly text: string },
  ][]) {
    const parsed = optionalNumber(field.text, field.label);
    if (!parsed.ok) return parsed;
    if (parsed.value !== undefined) value[key] = parsed.value;
  }
  return { ok: true, value };
}

export const GATE_POLICY_FIELDS = {
  maxEvaluatorErrorRate: "Max evaluator error rate",
  maxMeanDecrease: "Max mean decrease",
  maxMissingEvidenceRate: "Max missing evidence rate",
  maxNewFailures: "Max new failures",
  maxPassRateDecrease: "Max pass-rate decrease",
  minComparableCases: "Min comparable cases",
} as const;

export type GatePolicyField = keyof typeof GATE_POLICY_FIELDS;

interface ReplayControlsText {
  readonly caseTimeoutSeconds: string;
  readonly concurrency: string;
}

export interface ComparisonForm extends ReplayControlsText {
  readonly baselineReleaseId: string;
  readonly candidateReleaseId: string;
  readonly datasetId: string;
  readonly gatePolicy: Readonly<Record<GatePolicyField, string>>;
  readonly runtimeConfigFromAgentDeploymentId: string;
  readonly scoreDefinitionIds: readonly string[];
}

function replayControls(form: ReplayControlsText) {
  return optionalNumbers({
    caseTimeoutSeconds: { label: "Case timeout", text: form.caseTimeoutSeconds },
    concurrency: { label: "Concurrency", text: form.concurrency },
  });
}

/** `CreateReleaseComparisonRequest` from the dialog; an empty gate policy uses the defaults. */
export function comparisonRequest(form: ComparisonForm): Parsed<Record<string, unknown>> {
  if (!form.baselineReleaseId || !form.candidateReleaseId) {
    return { error: "Choose a baseline and a candidate release.", ok: false };
  }
  if (form.baselineReleaseId === form.candidateReleaseId) {
    return { error: "Baseline and candidate releases must differ.", ok: false };
  }
  if (!form.datasetId) return { error: "Choose a dataset.", ok: false };
  if (form.scoreDefinitionIds.length === 0) {
    return { error: "Choose at least one scorer.", ok: false };
  }
  const controls = replayControls(form);
  if (!controls.ok) return controls;
  const { gatePolicy: text } = form;
  const gatePolicy = optionalNumbers({
    maxEvaluatorErrorRate: {
      label: GATE_POLICY_FIELDS.maxEvaluatorErrorRate,
      text: text.maxEvaluatorErrorRate,
    },
    maxMeanDecrease: { label: GATE_POLICY_FIELDS.maxMeanDecrease, text: text.maxMeanDecrease },
    maxMissingEvidenceRate: {
      label: GATE_POLICY_FIELDS.maxMissingEvidenceRate,
      text: text.maxMissingEvidenceRate,
    },
    maxNewFailures: { label: GATE_POLICY_FIELDS.maxNewFailures, text: text.maxNewFailures },
    maxPassRateDecrease: {
      label: GATE_POLICY_FIELDS.maxPassRateDecrease,
      text: text.maxPassRateDecrease,
    },
    minComparableCases: {
      label: GATE_POLICY_FIELDS.minComparableCases,
      text: text.minComparableCases,
    },
  });
  if (!gatePolicy.ok) return gatePolicy;
  return {
    ok: true,
    value: {
      baselineReleaseId: form.baselineReleaseId,
      candidateReleaseId: form.candidateReleaseId,
      datasetId: form.datasetId,
      scoreDefinitionIds: form.scoreDefinitionIds,
      ...controls.value,
      ...(Object.keys(gatePolicy.value).length > 0 ? { gatePolicy: gatePolicy.value } : {}),
      ...(form.runtimeConfigFromAgentDeploymentId
        ? { runtimeConfigFromAgentDeploymentId: form.runtimeConfigFromAgentDeploymentId }
        : {}),
    },
  };
}

export interface EvaluationRunForm extends ReplayControlsText {
  readonly agentReleaseId: string;
  readonly datasetId: string;
  readonly kind: "dataset-replay" | "trace-score";
  readonly runtimeConfigFromAgentDeploymentId: string;
  readonly scoreDefinitionIds: readonly string[];
  /** Trace IDs separated by commas, spaces, or lines (trace-score runs). */
  readonly traceIds: string;
}

/** `CreateEvaluationRunRequest`: a dataset replay against a release, or trace scoring. */
export function evaluationRunRequest(form: EvaluationRunForm): Parsed<Record<string, unknown>> {
  if (form.scoreDefinitionIds.length === 0) {
    return { error: "Choose at least one scorer.", ok: false };
  }
  if (form.kind === "trace-score") {
    const traceIds = form.traceIds.split(/[\s,]+/u).filter(Boolean);
    if (traceIds.length === 0) return { error: "Enter at least one trace ID.", ok: false };
    return {
      ok: true,
      value: { kind: "trace-score", scoreDefinitionIds: form.scoreDefinitionIds, traceIds },
    };
  }
  if (!form.datasetId) return { error: "Choose a dataset.", ok: false };
  if (!form.agentReleaseId) return { error: "Choose a release to replay.", ok: false };
  const controls = replayControls(form);
  if (!controls.ok) return controls;
  return {
    ok: true,
    value: {
      datasetId: form.datasetId,
      kind: "dataset-replay",
      scoreDefinitionIds: form.scoreDefinitionIds,
      target: {
        agentReleaseId: form.agentReleaseId,
        type: "release",
        ...(form.runtimeConfigFromAgentDeploymentId
          ? { runtimeConfigFromAgentDeploymentId: form.runtimeConfigFromAgentDeploymentId }
          : {}),
      },
      ...controls.value,
    },
  };
}

export interface ScorerConfigurationForm {
  readonly evaluator: string;
  readonly samplingRate: string;
  readonly target: "" | "root-run" | "trace";
  readonly threshold: string;
  readonly weight: string;
}

/**
 * The configuration fields shared by `CreateScoreDefinitionRequest` and
 * `ReviseScoreDefinitionRequest`; blank fields take the API defaults.
 */
export function scorerConfiguration(
  form: ScorerConfigurationForm,
): Parsed<Record<string, unknown>> {
  const evaluator = jsonObject(form.evaluator, "The evaluator");
  if (!evaluator.ok) return evaluator;
  const numbers = optionalNumbers({
    samplingRate: { label: "Sampling rate", text: form.samplingRate },
    threshold: { label: "Threshold", text: form.threshold },
    weight: { label: "Weight", text: form.weight },
  });
  if (!numbers.ok) return numbers;
  const { samplingRate, threshold, weight } = numbers.value;
  return {
    ok: true,
    value: {
      evaluator: evaluator.value,
      ...(samplingRate === undefined ? {} : { sampling: { rate: samplingRate } }),
      ...(form.target ? { target: form.target } : {}),
      ...(threshold === undefined ? {} : { threshold }),
      ...(weight === undefined ? {} : { weight }),
    },
  };
}

/** Starting points for each evaluator kind; values left out are read from each case. */
export const EVALUATOR_TEMPLATES = {
  contains: { kind: "contains", mode: "all", values: ["refund"] },
  human: { kind: "human", labels: ["good", "bad"] },
  imported: { kind: "imported", source: "external-grader" },
  json_schema: { kind: "json_schema", schema: { type: "object" } },
  model_judge: {
    kind: "model_judge",
    modelId: "",
    prompt: "Score from 0 to 1 how well {{output}} answers {{input}}.",
  },
  no_tool: { kind: "no_tool" },
  not_contains: { kind: "not_contains", values: ["internal error"] },
  regex: { flags: "i", kind: "regex", pattern: "order #\\d+" },
  tool_called: { kind: "tool_called", mode: "any", tools: [] },
} as const;

export type EvaluatorKind = keyof typeof EVALUATOR_TEMPLATES;
