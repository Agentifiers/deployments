export interface ComparisonScoreInput {
  readonly scoreDefinitionId: string;
  readonly revision: number;
  readonly executionStatus: "succeeded" | "error";
  readonly value?: number;
  readonly passed?: boolean;
}

export type ComparisonCaseStatus = "scored" | "failed" | "timed_out" | "canceled";

export interface ComparisonCaseInput {
  readonly caseKey: string;
  readonly status: ComparisonCaseStatus;
  readonly latencyMs?: number;
  readonly totalTokens?: number;
  readonly costUsdMicros?: number;
  readonly scores: readonly ComparisonScoreInput[];
}

export interface ComparisonArmInput {
  readonly evaluationRunId: string;
  readonly agentReleaseId: string;
  readonly releaseContentHash?: string;
  readonly cases: readonly ComparisonCaseInput[];
}

export interface ComparisonDefinitionInput {
  readonly scoreDefinitionId: string;
  readonly revision: number;
  readonly name: string;
  readonly threshold: number;
  readonly evaluatorVersionHash: string;
}

export interface ComparisonGatePolicy {
  readonly maxMeanDecrease: number;
  readonly maxPassRateDecrease: number;
  readonly maxNewFailures: number;
  readonly maxEvaluatorErrorRate: number;
  readonly maxMissingEvidenceRate: number;
  readonly minComparableCases: number;
}

export const DEFAULT_COMPARISON_GATE_POLICY: ComparisonGatePolicy = {
  maxMeanDecrease: 0.05,
  maxPassRateDecrease: 0.05,
  maxNewFailures: 0,
  maxEvaluatorErrorRate: 0.1,
  maxMissingEvidenceRate: 0.1,
  minComparableCases: 1,
};

export interface ArmScoreSummary {
  readonly scored: number;
  readonly passed: number;
  readonly errors: number;
  /** Cases not scored for the definition because the case did not finish or is absent. */
  readonly missing: number;
  readonly mean?: number;
  readonly passRate?: number;
}

export interface DefinitionComparison {
  readonly scoreDefinitionId: string;
  readonly revision: number;
  readonly name: string;
  readonly threshold: number;
  readonly evaluatorVersionHash: string;
  readonly baseline: ArmScoreSummary;
  readonly candidate: ArmScoreSummary;
  readonly meanDelta?: number;
  readonly passRateDelta?: number;
  /** Paired t-interval over cases scored in both arms; present only when n >= 5. */
  readonly meanDeltaInterval95?: { readonly lower: number; readonly upper: number };
}

export interface LatencySummary {
  readonly p50?: number;
  readonly p95?: number;
}

export interface UsageTotals {
  readonly baselineTotal: number;
  readonly candidateTotal: number;
  readonly delta: number;
  readonly baselineMean?: number;
  readonly candidateMean?: number;
}

export interface CaseScoreComparison {
  readonly scoreDefinitionId: string;
  readonly baselineValue?: number;
  readonly candidateValue?: number;
  readonly delta?: number;
  readonly baselinePassed?: boolean;
  readonly candidatePassed?: boolean;
}

export interface CaseComparison {
  readonly caseKey: string;
  readonly baselineStatus?: ComparisonCaseStatus;
  readonly candidateStatus?: ComparisonCaseStatus;
  readonly latencyDeltaMs?: number;
  readonly scores: readonly CaseScoreComparison[];
  /** Definition ids whose score went from passed to scored-and-not-passed. */
  readonly regressions: readonly string[];
}

export interface ReleaseComparisonResult {
  readonly gateMode: "advisory";
  readonly verdict: "pass" | "fail" | "error";
  readonly reasons: readonly string[];
  readonly policy: ComparisonGatePolicy;
  /** Cases present and scored in both arms. */
  readonly comparableCases: number;
  /** Cases present in either arm. */
  readonly totalCases: number;
  readonly definitions: readonly DefinitionComparison[];
  readonly latency: {
    readonly baseline: LatencySummary;
    readonly candidate: LatencySummary;
    readonly p50DeltaMs?: number;
    readonly p95DeltaMs?: number;
  };
  readonly tokens: UsageTotals;
  readonly costUsdMicros: UsageTotals;
  /** Evaluator execution errors summed over every definition. */
  readonly evaluatorErrors: { readonly baseline: number; readonly candidate: number };
  /** Cases that are absent or did not finish scoring in each arm. */
  readonly missingEvidence: { readonly baseline: number; readonly candidate: number };
  readonly cases: readonly CaseComparison[];
}

/** Absorbs floating-point noise so a delta exactly at a policy bound does not trip it. */
const GATE_EPSILON = 1e-9;

type ArmCases = ReadonlyMap<string, ComparisonCaseInput>;

type SlotScore =
  | { readonly kind: "missing" }
  | { readonly kind: "not_applicable" }
  | { readonly kind: "error" }
  | { readonly kind: "scored"; readonly value: number; readonly passed: boolean };

function indexCases(arm: ComparisonArmInput): ArmCases {
  const cases = new Map<string, ComparisonCaseInput>();
  for (const entry of arm.cases) if (!cases.has(entry.caseKey)) cases.set(entry.caseKey, entry);
  return cases;
}

function slotScore(
  entry: ComparisonCaseInput | undefined,
  definition: ComparisonDefinitionInput,
): SlotScore {
  if (!entry || entry.status !== "scored") return { kind: "missing" };
  const score = entry.scores.find(
    (candidate) =>
      candidate.scoreDefinitionId === definition.scoreDefinitionId &&
      candidate.revision === definition.revision,
  );
  if (!score) return { kind: "not_applicable" };
  if (
    score.executionStatus === "error" ||
    score.value === undefined ||
    !Number.isFinite(score.value)
  )
    return { kind: "error" };
  return {
    kind: "scored",
    value: score.value,
    passed: score.passed ?? score.value >= definition.threshold,
  };
}

function mean(values: readonly number[]): number | undefined {
  return values.length === 0
    ? undefined
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarize(slots: readonly SlotScore[]): ArmScoreSummary {
  const values: number[] = [];
  let passed = 0;
  let errors = 0;
  let missing = 0;
  for (const slot of slots) {
    if (slot.kind === "missing") missing += 1;
    else if (slot.kind === "error") errors += 1;
    else if (slot.kind === "scored") {
      values.push(slot.value);
      if (slot.passed) passed += 1;
    }
  }
  const average = mean(values);
  return {
    scored: values.length,
    passed,
    errors,
    missing,
    ...(average !== undefined ? { mean: average, passRate: passed / values.length } : {}),
  };
}

/** Two-sided 97.5% Student t quantile via the Cornish-Fisher expansion (accurate for df >= 4). */
function tQuantile975(degreesOfFreedom: number): number {
  const z = 1.959963984540054;
  const df = degreesOfFreedom;
  return (
    z +
    (z ** 3 + z) / (4 * df) +
    (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df ** 2) +
    (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / (384 * df ** 3) +
    (79 * z ** 9 + 776 * z ** 7 + 1482 * z ** 5 - 1920 * z ** 3 - 945 * z) / (92_160 * df ** 4)
  );
}

function pairedInterval95(
  differences: readonly number[],
): { readonly lower: number; readonly upper: number } | undefined {
  const n = differences.length;
  const center = mean(differences);
  if (n < 5 || center === undefined) return undefined;
  const variance =
    differences.reduce((sum, difference) => sum + (difference - center) ** 2, 0) / (n - 1);
  const halfWidth = tQuantile975(n - 1) * Math.sqrt(variance / n);
  return { lower: center - halfWidth, upper: center + halfWidth };
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: readonly number[], percent: number): number | undefined {
  if (sorted.length === 0) return undefined;
  return sorted[Math.max(1, Math.ceil((percent / 100) * sorted.length)) - 1];
}

function latencySummary(arm: ComparisonArmInput): LatencySummary {
  const latencies = arm.cases
    .map((entry) => entry.latencyMs)
    .filter((latency): latency is number => latency !== undefined && Number.isFinite(latency))
    .toSorted((left, right) => left - right);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  return { ...(p50 !== undefined ? { p50 } : {}), ...(p95 !== undefined ? { p95 } : {}) };
}

function usageTotals(
  baseline: ComparisonArmInput,
  candidate: ComparisonArmInput,
  pick: (entry: ComparisonCaseInput) => number | undefined,
): UsageTotals {
  const armValues = (arm: ComparisonArmInput) =>
    arm.cases.map(pick).filter((value): value is number => value !== undefined);
  const baselineValues = armValues(baseline);
  const candidateValues = armValues(candidate);
  const baselineTotal = baselineValues.reduce((sum, value) => sum + value, 0);
  const candidateTotal = candidateValues.reduce((sum, value) => sum + value, 0);
  const baselineMean = mean(baselineValues);
  const candidateMean = mean(candidateValues);
  return {
    baselineTotal,
    candidateTotal,
    delta: candidateTotal - baselineTotal,
    ...(baselineMean !== undefined ? { baselineMean } : {}),
    ...(candidateMean !== undefined ? { candidateMean } : {}),
  };
}

function difference(candidate: number | undefined, baseline: number | undefined) {
  return candidate !== undefined && baseline !== undefined ? candidate - baseline : undefined;
}

function caseScore(
  definition: ComparisonDefinitionInput,
  baseline: SlotScore,
  candidate: SlotScore,
): CaseScoreComparison {
  const baselineValue = baseline.kind === "scored" ? baseline.value : undefined;
  const candidateValue = candidate.kind === "scored" ? candidate.value : undefined;
  const delta = difference(candidateValue, baselineValue);
  return {
    scoreDefinitionId: definition.scoreDefinitionId,
    ...(baselineValue !== undefined ? { baselineValue } : {}),
    ...(candidateValue !== undefined ? { candidateValue } : {}),
    ...(delta !== undefined ? { delta } : {}),
    ...(baseline.kind === "scored" ? { baselinePassed: baseline.passed } : {}),
    ...(candidate.kind === "scored" ? { candidatePassed: candidate.passed } : {}),
  };
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function percentText(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function gateReasons(result: Omit<ReleaseComparisonResult, "verdict" | "reasons" | "gateMode">): {
  readonly verdict: ReleaseComparisonResult["verdict"];
  readonly reasons: string[];
} {
  const { policy } = result;
  const errors: string[] = [];
  if (result.comparableCases < policy.minComparableCases)
    errors.push(
      `Only ${result.comparableCases} cases were scored in both runs; at least ${policy.minComparableCases} are required.`,
    );
  for (const definition of result.definitions) {
    for (const [arm, summary] of [
      ["baseline", definition.baseline],
      ["candidate", definition.candidate],
    ] as const) {
      const errorRate = rate(summary.errors, summary.scored + summary.errors);
      if (errorRate > policy.maxEvaluatorErrorRate + GATE_EPSILON)
        errors.push(
          `"${definition.name}" evaluator error rate in the ${arm} run is ${percentText(errorRate)}, above the ${percentText(policy.maxEvaluatorErrorRate)} limit.`,
        );
      const missingRate = rate(summary.missing, result.totalCases);
      if (missingRate > policy.maxMissingEvidenceRate + GATE_EPSILON)
        errors.push(
          `"${definition.name}" is missing evidence for ${percentText(missingRate)} of cases in the ${arm} run, above the ${percentText(policy.maxMissingEvidenceRate)} limit.`,
        );
    }
  }
  if (errors.length > 0) return { verdict: "error", reasons: errors };

  const failures: string[] = [];
  for (const definition of result.definitions) {
    if (
      definition.meanDelta !== undefined &&
      definition.meanDelta < -(policy.maxMeanDecrease + GATE_EPSILON)
    )
      failures.push(
        `"${definition.name}" mean score decreased by ${(-definition.meanDelta).toFixed(3)}, more than the allowed ${policy.maxMeanDecrease.toFixed(3)}.`,
      );
    if (
      definition.passRateDelta !== undefined &&
      definition.passRateDelta < -(policy.maxPassRateDecrease + GATE_EPSILON)
    )
      failures.push(
        `"${definition.name}" pass rate decreased by ${percentText(-definition.passRateDelta)}, more than the allowed ${percentText(policy.maxPassRateDecrease)}.`,
      );
  }
  const regressions = result.cases.reduce((sum, entry) => sum + entry.regressions.length, 0);
  if (regressions > policy.maxNewFailures)
    failures.push(
      `${regressions} case scores went from passing to failing; at most ${policy.maxNewFailures} allowed.`,
    );
  return failures.length > 0
    ? { verdict: "fail", reasons: failures }
    : { verdict: "pass", reasons: [] };
}

/**
 * Compares a candidate release's evaluation run against a baseline run over the same dataset.
 * Missing evidence and evaluator errors yield an "error" verdict, never "fail".
 */
export function compareReleases(input: {
  readonly baseline: ComparisonArmInput;
  readonly candidate: ComparisonArmInput;
  readonly definitions: readonly ComparisonDefinitionInput[];
  readonly policy?: Partial<ComparisonGatePolicy>;
}): ReleaseComparisonResult {
  const policy: ComparisonGatePolicy = { ...DEFAULT_COMPARISON_GATE_POLICY, ...input.policy };
  const baselineCases = indexCases(input.baseline);
  const candidateCases = indexCases(input.candidate);
  const caseKeys = [...new Set([...baselineCases.keys(), ...candidateCases.keys()])].sort();

  const slots = input.definitions.map((definition) =>
    caseKeys.map((caseKey) => ({
      baseline: slotScore(baselineCases.get(caseKey), definition),
      candidate: slotScore(candidateCases.get(caseKey), definition),
    })),
  );

  const definitions = input.definitions.map((definition, index): DefinitionComparison => {
    const definitionSlots = slots[index]!;
    const baseline = summarize(definitionSlots.map((slot) => slot.baseline));
    const candidate = summarize(definitionSlots.map((slot) => slot.candidate));
    const meanDelta = difference(candidate.mean, baseline.mean);
    const passRateDelta = difference(candidate.passRate, baseline.passRate);
    const interval = pairedInterval95(
      definitionSlots.flatMap(({ baseline: before, candidate: after }) =>
        before.kind === "scored" && after.kind === "scored" ? [after.value - before.value] : [],
      ),
    );
    return {
      scoreDefinitionId: definition.scoreDefinitionId,
      revision: definition.revision,
      name: definition.name,
      threshold: definition.threshold,
      evaluatorVersionHash: definition.evaluatorVersionHash,
      baseline,
      candidate,
      ...(meanDelta !== undefined ? { meanDelta } : {}),
      ...(passRateDelta !== undefined ? { passRateDelta } : {}),
      ...(interval ? { meanDeltaInterval95: interval } : {}),
    };
  });

  const cases = caseKeys.map((caseKey, caseIndex): CaseComparison => {
    const before = baselineCases.get(caseKey);
    const after = candidateCases.get(caseKey);
    const scores = input.definitions.map((definition, index) => {
      const slot = slots[index]![caseIndex]!;
      return caseScore(definition, slot.baseline, slot.candidate);
    });
    const latencyDeltaMs = difference(after?.latencyMs, before?.latencyMs);
    return {
      caseKey,
      ...(before ? { baselineStatus: before.status } : {}),
      ...(after ? { candidateStatus: after.status } : {}),
      ...(latencyDeltaMs !== undefined ? { latencyDeltaMs } : {}),
      scores,
      regressions: scores
        .filter((score) => score.baselinePassed === true && score.candidatePassed === false)
        .map((score) => score.scoreDefinitionId),
    };
  });

  const baselineLatency = latencySummary(input.baseline);
  const candidateLatency = latencySummary(input.candidate);
  const p50DeltaMs = difference(candidateLatency.p50, baselineLatency.p50);
  const p95DeltaMs = difference(candidateLatency.p95, baselineLatency.p95);
  const missingCases = (arm: ArmCases) =>
    caseKeys.filter((caseKey) => arm.get(caseKey)?.status !== "scored").length;
  const summary = {
    policy,
    comparableCases: caseKeys.filter(
      (caseKey) =>
        baselineCases.get(caseKey)?.status === "scored" &&
        candidateCases.get(caseKey)?.status === "scored",
    ).length,
    totalCases: caseKeys.length,
    definitions,
    latency: {
      baseline: baselineLatency,
      candidate: candidateLatency,
      ...(p50DeltaMs !== undefined ? { p50DeltaMs } : {}),
      ...(p95DeltaMs !== undefined ? { p95DeltaMs } : {}),
    },
    tokens: usageTotals(input.baseline, input.candidate, (entry) => entry.totalTokens),
    costUsdMicros: usageTotals(input.baseline, input.candidate, (entry) => entry.costUsdMicros),
    evaluatorErrors: {
      baseline: definitions.reduce((sum, definition) => sum + definition.baseline.errors, 0),
      candidate: definitions.reduce((sum, definition) => sum + definition.candidate.errors, 0),
    },
    missingEvidence: {
      baseline: missingCases(baselineCases),
      candidate: missingCases(candidateCases),
    },
    cases,
  };
  return { gateMode: "advisory", ...gateReasons(summary), ...summary };
}
