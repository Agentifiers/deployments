import { describe, expect, test } from "bun:test";
import { renderComparisonReport } from "./comparison-report.ts";
import {
  compareReleases,
  DEFAULT_COMPARISON_GATE_POLICY,
  type ComparisonArmInput,
  type ComparisonCaseInput,
  type ComparisonDefinitionInput,
} from "./comparison.ts";

const definition: ComparisonDefinitionInput = {
  scoreDefinitionId: "def-quality",
  revision: 2,
  name: "Answer quality",
  threshold: 0.5,
  evaluatorVersionHash: "a".repeat(64),
};

type CaseSpec = number | "error" | Omit<ComparisonCaseInput, "caseKey" | "scores">;

function arm(
  id: string,
  specs: readonly CaseSpec[],
  extra: Partial<ComparisonCaseInput>[] = [],
): ComparisonArmInput {
  return {
    evaluationRunId: `run-${id}`,
    agentReleaseId: `release-${id}`,
    cases: specs.map((spec, index): ComparisonCaseInput => {
      const caseKey = `case-${String(index).padStart(3, "0")}`;
      const fields = extra[index] ?? {};
      if (typeof spec === "object") return { caseKey, scores: [], ...spec, ...fields };
      return {
        caseKey,
        status: "scored",
        scores: [
          spec === "error"
            ? {
                scoreDefinitionId: definition.scoreDefinitionId,
                revision: 2,
                executionStatus: "error",
              }
            : {
                scoreDefinitionId: definition.scoreDefinitionId,
                revision: 2,
                executionStatus: "succeeded",
                value: spec,
                passed: spec >= definition.threshold,
              },
        ],
        ...fields,
      };
    }),
  };
}

function compare(baseline: ComparisonArmInput, candidate: ComparisonArmInput, policy = {}) {
  return compareReleases({ baseline, candidate, definitions: [definition], policy });
}

describe("compareReleases", () => {
  test("a clean improvement passes with deltas, pass rates, and a paired interval", () => {
    const result = compare(
      arm("b", [0.8, 0.8, 0.4, 0.8, 0.8]),
      arm("c", [0.9, 0.9, 0.6, 0.9, 0.9]),
    );
    expect(result.gateMode).toBe("advisory");
    expect(result.verdict).toBe("pass");
    expect(result.reasons).toEqual([]);
    expect(result.policy).toEqual(DEFAULT_COMPARISON_GATE_POLICY);
    expect(result.comparableCases).toBe(5);
    expect(result.totalCases).toBe(5);
    const [summary] = result.definitions;
    expect(summary).toMatchObject({
      scoreDefinitionId: "def-quality",
      revision: 2,
      baseline: { scored: 5, passed: 4, errors: 0, missing: 0, passRate: 0.8 },
      candidate: { scored: 5, passed: 5, errors: 0, missing: 0, passRate: 1 },
    });
    expect(summary!.baseline.mean).toBeCloseTo(0.72, 10);
    expect(summary!.meanDelta).toBeCloseTo(0.12, 10);
    expect(summary!.passRateDelta).toBeCloseTo(0.2, 10);
    // Differences 0.1, 0.1, 0.2, 0.1, 0.1: mean 0.12, sd 0.0447, t(4) = 2.776.
    expect(summary!.meanDeltaInterval95!.lower).toBeCloseTo(
      0.12 - 2.776 * (Math.sqrt(0.002) / Math.sqrt(5)),
      3,
    );
    expect(summary!.meanDeltaInterval95!.upper).toBeCloseTo(
      0.12 + 2.776 * (Math.sqrt(0.002) / Math.sqrt(5)),
      3,
    );
    expect(result.cases[2]!.scores[0]).toMatchObject({
      baselineValue: 0.4,
      candidateValue: 0.6,
      baselinePassed: false,
      candidatePassed: true,
    });
    expect(result.cases[2]!.scores[0]!.delta).toBeCloseTo(0.2, 10);
  });

  test("the interval needs at least five paired cases", () => {
    const result = compare(arm("b", [0.8, 0.8, 0.8, 0.8]), arm("c", [0.8, 0.9, 0.8, 0.8]));
    expect(result.definitions[0]).not.toHaveProperty("meanDeltaInterval95");
    expect(result.definitions[0]!.meanDelta).toBeCloseTo(0.025, 10);
  });

  test("latency percentiles use nearest rank; tokens and cost total and average", () => {
    const latencies = [1000, 100, 300, 200, 400];
    const result = compare(
      arm(
        "b",
        [1, 1, 1, 1, 1],
        latencies.map((latencyMs) => ({ latencyMs, totalTokens: 10, costUsdMicros: 5 })),
      ),
      arm(
        "c",
        [1, 1, 1, 1, 1],
        latencies.map((latencyMs, index) => ({
          latencyMs: latencyMs + 50,
          ...(index < 4 ? { totalTokens: 20, costUsdMicros: 3 } : {}),
        })),
      ),
    );
    expect(result.latency).toEqual({
      baseline: { p50: 300, p95: 1000 },
      candidate: { p50: 350, p95: 1050 },
      p50DeltaMs: 50,
      p95DeltaMs: 50,
    });
    expect(result.tokens).toEqual({
      baselineTotal: 50,
      candidateTotal: 80,
      delta: 30,
      baselineMean: 10,
      candidateMean: 20,
    });
    expect(result.costUsdMicros).toEqual({
      baselineTotal: 25,
      candidateTotal: 12,
      delta: -13,
      baselineMean: 5,
      candidateMean: 3,
    });
    expect(result.cases[0]!.latencyDeltaMs).toBe(50);
  });

  test("a pass-to-fail regression fails the gate even when aggregates stay within policy", () => {
    const result = compare(
      arm("b", [0.9, 0.9, 0.9, 0.9, 0.9]),
      arm("c", [0.9, 0.4, 0.9, 0.9, 0.9]),
      {
        maxMeanDecrease: 1,
        maxPassRateDecrease: 1,
      },
    );
    expect(result.verdict).toBe("fail");
    expect(result.reasons).toEqual([
      "1 case scores went from passing to failing; at most 0 allowed.",
    ]);
    expect(result.cases.map((entry) => entry.regressions)).toEqual([
      [],
      ["def-quality"],
      [],
      [],
      [],
    ]);
  });

  test("mean and pass-rate decreases beyond policy fail with one reason each", () => {
    const result = compare(arm("b", [0.9, 0.9, 0.9, 0.9]), arm("c", [0.9, 0.3, 0.9, 0.9]), {
      maxNewFailures: 5,
    });
    expect(result.verdict).toBe("fail");
    expect(result.reasons).toHaveLength(2);
    expect(result.reasons[0]).toContain("mean score decreased by 0.150");
    expect(result.reasons[1]).toContain("pass rate decreased by 25.0%");
  });

  test("a decrease exactly at the policy bound passes", () => {
    const result = compare(arm("b", [0.8]), arm("c", [0.75]));
    expect(result.verdict).toBe("pass");
  });

  test("missing evidence is an error verdict, never a failure", () => {
    const result = compare(
      arm("b", [0.9, 0.9, 0.9, 0.9, 0.9]),
      arm("c", [0.1, 0.1, 0.1, 0.1, { status: "timed_out" }]),
    );
    expect(result.verdict).toBe("error");
    expect(result.reasons).toEqual([
      '"Answer quality" is missing evidence for 20.0% of cases in the candidate run, above the 10.0% limit.',
    ]);
    expect(result.definitions[0]!.candidate.missing).toBe(1);
    expect(result.missingEvidence).toEqual({ baseline: 0, candidate: 1 });
    expect(result.comparableCases).toBe(4);
  });

  test("a case absent from one arm counts as missing for that arm", () => {
    const baseline = arm("b", [0.9, 0.9]);
    const result = compare(baseline, { ...baseline, cases: baseline.cases.slice(0, 1) });
    expect(result.totalCases).toBe(2);
    expect(result.definitions[0]!.candidate.missing).toBe(1);
    expect(result.cases[1]).not.toHaveProperty("candidateStatus");
    expect(result.verdict).toBe("error");
  });

  test("an evaluator error rate above policy is an error verdict", () => {
    const result = compare(
      arm("b", [0.9, 0.9, 0.9, 0.9, 0.9]),
      arm("c", [0.9, "error", 0.9, 0.9, 0.9]),
    );
    expect(result.verdict).toBe("error");
    expect(result.reasons).toEqual([
      '"Answer quality" evaluator error rate in the candidate run is 20.0%, above the 10.0% limit.',
    ]);
    expect(result.evaluatorErrors).toEqual({ baseline: 0, candidate: 1 });
    expect(result.definitions[0]!.candidate).toMatchObject({ scored: 4, errors: 1 });
  });

  test("too few comparable cases is an error verdict", () => {
    const result = compare(arm("b", [0.9]), arm("c", [0.9]), { minComparableCases: 2 });
    expect(result.verdict).toBe("error");
    expect(result.reasons).toEqual([
      "Only 1 cases were scored in both runs; at least 2 are required.",
    ]);
  });

  test("cases pair by key in sorted order across both arms", () => {
    const baseline: ComparisonArmInput = {
      evaluationRunId: "b",
      agentReleaseId: "rb",
      cases: [
        { caseKey: "z", status: "scored", scores: [] },
        { caseKey: "a", status: "scored", scores: [] },
      ],
    };
    const candidate: ComparisonArmInput = {
      evaluationRunId: "c",
      agentReleaseId: "rc",
      cases: [
        { caseKey: "m", status: "failed", scores: [] },
        { caseKey: "a", status: "scored", scores: [] },
      ],
    };
    const result = compare(baseline, candidate);
    expect(
      result.cases.map((entry) => [entry.caseKey, entry.baselineStatus, entry.candidateStatus]),
    ).toEqual([
      ["a", "scored", "scored"],
      ["m", undefined, "failed"],
      ["z", "scored", undefined],
    ]);
    // Scored cases without a score row are not applicable: neither scored nor missing.
    expect(result.definitions[0]!.baseline).toEqual({
      scored: 0,
      passed: 0,
      errors: 0,
      missing: 1,
    });
  });
});

describe("renderComparisonReport", () => {
  const meta = {
    comparisonId: "cmp-1",
    datasetId: "ds-1",
    datasetName: "Support | regressions",
    generatedAt: "2026-09-29T12:00:00.000Z",
  };

  test("renders verdict, advisory note, reasons, and tables", () => {
    const report = renderComparisonReport(
      compare(arm("b", [0.9, 0.9, 0.9, 0.9, 0.9]), arm("c", [0.9, 0.4, 0.9, 0.9, 0.9]), {
        maxMeanDecrease: 1,
        maxPassRateDecrease: 1,
      }),
      meta,
    );
    expect(report).toContain("## Verdict: FAIL");
    expect(report).toContain("advisory");
    expect(report).toContain("- 1 case scores went from passing to failing; at most 0 allowed.");
    expect(report).toContain("Support \\| regressions");
    expect(report).toContain(
      "| Score | Revision | Threshold | Baseline mean | Candidate mean | Mean Δ | Mean Δ 95% CI |",
    );
    expect(report).toContain("| Answer quality | 2 | 0.500 | 0.900 | 0.800 | -0.100 | [");
    expect(report).toContain("| Metric | Baseline | Candidate | Δ |");
    expect(report).toContain(
      "| Baseline errors | Candidate errors | Baseline missing | Candidate missing |",
    );
    expect(report).toContain("| case-001 | Answer quality | 0.900 | 0.400 | -0.500 |");
    expect(report).not.toContain("Showing the first");
  });

  test("a clean comparison states that no conditions triggered", () => {
    const report = renderComparisonReport(compare(arm("b", [0.9]), arm("c", [0.9])), meta);
    expect(report).toContain("## Verdict: PASS");
    expect(report).toContain("- No gate conditions were triggered.");
    expect(report).toContain("No case scores went from passing to failing.");
  });

  test("bounds the regressions table to 200 rows with a truncation note", () => {
    const count = 201;
    const report = renderComparisonReport(
      compare(arm("b", Array(count).fill(0.9)), arm("c", Array(count).fill(0.1))),
      meta,
    );
    expect(report).toContain("Showing the first 200 of 201 regressions.");
    expect(report).toContain("| case-199 |");
    expect(report).not.toContain("| case-200 |");
  });
});
