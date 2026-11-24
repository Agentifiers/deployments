import type { ReleaseComparisonResult, UsageTotals } from "./comparison.ts";

export const MAX_REPORT_REGRESSION_ROWS = 200;

const EMPTY = "—";

function cell(text: string): string {
  return text
    .replace(/\\/gu, "\\\\")
    .replace(/\|/gu, "\\|")
    .replace(/\s*[\r\n]+\s*/gu, " ");
}

function row(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [row(header), row(header.map(() => "---")), ...rows.map(row)];
}

function score(value: number | undefined): string {
  return value === undefined ? EMPTY : value.toFixed(3);
}

function signedScore(value: number | undefined): string {
  return value === undefined ? EMPTY : `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}

function percent(value: number | undefined): string {
  return value === undefined ? EMPTY : `${(value * 100).toFixed(1)}%`;
}

function signedPercent(value: number | undefined): string {
  return value === undefined ? EMPTY : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

function count(value: number | undefined, unit = ""): string {
  return value === undefined ? EMPTY : `${Math.round(value).toLocaleString("en-US")}${unit}`;
}

function signedCount(value: number | undefined, unit = ""): string {
  return value === undefined ? EMPTY : `${value >= 0 ? "+" : ""}${count(value, unit)}`;
}

function usd(micros: number | undefined): string {
  return micros === undefined ? EMPTY : `$${(micros / 1_000_000).toFixed(6)}`;
}

function signedUsd(micros: number | undefined): string {
  return micros === undefined ? EMPTY : `${micros >= 0 ? "+" : "-"}${usd(Math.abs(micros))}`;
}

function usageRows(
  label: string,
  totals: UsageTotals,
  format: (value: number | undefined) => string,
  signed: (value: number | undefined) => string,
): string[][] {
  const meanDelta =
    totals.baselineMean !== undefined && totals.candidateMean !== undefined
      ? totals.candidateMean - totals.baselineMean
      : undefined;
  return [
    [
      `Total ${label}`,
      format(totals.baselineTotal),
      format(totals.candidateTotal),
      signed(totals.delta),
    ],
    [
      `Mean ${label} per case`,
      format(totals.baselineMean),
      format(totals.candidateMean),
      signed(meanDelta),
    ],
  ];
}

/** Markdown summary of a release comparison for operators. */
export function renderComparisonReport(
  result: ReleaseComparisonResult,
  meta: {
    readonly comparisonId: string;
    readonly datasetId: string;
    readonly datasetName?: string;
    readonly generatedAt: string;
  },
): string {
  const dataset =
    meta.datasetName !== undefined
      ? `${cell(meta.datasetName)} (\`${cell(meta.datasetId)}\`)`
      : `\`${cell(meta.datasetId)}\``;
  const lines: string[] = [
    "# Release comparison",
    "",
    `- Comparison: \`${cell(meta.comparisonId)}\``,
    `- Dataset: ${dataset}`,
    `- Generated: ${cell(meta.generatedAt)}`,
    `- Comparable cases: ${result.comparableCases} of ${result.totalCases}`,
    "",
    `## Verdict: ${result.verdict.toUpperCase()}`,
    "",
    "This gate is advisory: the verdict informs promotion decisions but does not block them.",
    "",
    "## Reasons",
    "",
    ...(result.reasons.length > 0
      ? result.reasons.map((reason) => `- ${cell(reason)}`)
      : ["- No gate conditions were triggered."]),
    "",
    "## Scores",
    "",
    ...table(
      [
        "Score",
        "Revision",
        "Threshold",
        "Baseline mean",
        "Candidate mean",
        "Mean Δ",
        "Mean Δ 95% CI",
        "Baseline pass rate",
        "Candidate pass rate",
        "Pass rate Δ",
      ],
      result.definitions.map((definition) => [
        cell(definition.name),
        String(definition.revision),
        score(definition.threshold),
        score(definition.baseline.mean),
        score(definition.candidate.mean),
        signedScore(definition.meanDelta),
        definition.meanDeltaInterval95
          ? `[${signedScore(definition.meanDeltaInterval95.lower)}, ${signedScore(definition.meanDeltaInterval95.upper)}]`
          : EMPTY,
        percent(definition.baseline.passRate),
        percent(definition.candidate.passRate),
        signedPercent(definition.passRateDelta),
      ]),
    ),
    "",
    "## Latency, tokens, and cost",
    "",
    ...table(
      ["Metric", "Baseline", "Candidate", "Δ"],
      [
        [
          "p50 latency",
          count(result.latency.baseline.p50, " ms"),
          count(result.latency.candidate.p50, " ms"),
          signedCount(result.latency.p50DeltaMs, " ms"),
        ],
        [
          "p95 latency",
          count(result.latency.baseline.p95, " ms"),
          count(result.latency.candidate.p95, " ms"),
          signedCount(result.latency.p95DeltaMs, " ms"),
        ],
        ...usageRows("tokens", result.tokens, count, signedCount),
        ...usageRows("cost", result.costUsdMicros, usd, signedUsd),
      ],
    ),
    "",
    "## Evaluator errors and missing evidence",
    "",
    ...table(
      ["Score", "Baseline errors", "Candidate errors", "Baseline missing", "Candidate missing"],
      [
        ...result.definitions.map((definition) => [
          cell(definition.name),
          String(definition.baseline.errors),
          String(definition.candidate.errors),
          String(definition.baseline.missing),
          String(definition.candidate.missing),
        ]),
        [
          "All scores",
          String(result.evaluatorErrors.baseline),
          String(result.evaluatorErrors.candidate),
          `${result.missingEvidence.baseline} cases`,
          `${result.missingEvidence.candidate} cases`,
        ],
      ],
    ),
    "",
    "## Regressions",
    "",
  ];

  const names = new Map(
    result.definitions.map((definition) => [definition.scoreDefinitionId, definition.name]),
  );
  const regressions = result.cases.flatMap((entry) =>
    entry.regressions.map((scoreDefinitionId) => {
      const comparison = entry.scores.find(
        (candidate) => candidate.scoreDefinitionId === scoreDefinitionId,
      );
      return [
        cell(entry.caseKey),
        cell(names.get(scoreDefinitionId) ?? scoreDefinitionId),
        score(comparison?.baselineValue),
        score(comparison?.candidateValue),
        signedScore(comparison?.delta),
      ];
    }),
  );
  if (regressions.length === 0) lines.push("No case scores went from passing to failing.");
  else {
    lines.push(
      ...table(
        ["Case", "Score", "Baseline", "Candidate", "Δ"],
        regressions.slice(0, MAX_REPORT_REGRESSION_ROWS),
      ),
    );
    if (regressions.length > MAX_REPORT_REGRESSION_ROWS)
      lines.push(
        "",
        `Showing the first ${MAX_REPORT_REGRESSION_ROWS} of ${regressions.length} regressions.`,
      );
  }
  return `${lines.join("\n")}\n`;
}
