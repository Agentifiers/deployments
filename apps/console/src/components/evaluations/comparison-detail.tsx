import { useSuspenseQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import { comparisonDetailQuery } from "../../data/evaluation-queries.ts";
import { agentDirectoryQuery } from "../../data/observability-queries.ts";
import { formatDelta, formatScore } from "../../evaluations/format.ts";
import { GATE_POLICY_FIELDS, type GatePolicyField } from "../../evaluations/requests.ts";
import { agentLabels, type AgentLabels } from "../../observability/agent-labels.ts";
import {
  formatDurationMs,
  formatExact,
  formatPercent,
  formatUsdMicros,
} from "../../observability/format.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import type { ReleaseComparison } from "../../server/evaluation-data.ts";
import { Badge } from "@/components/ui/badge";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading, Subheading } from "@/components/ui/heading";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { Code, Text, TextLink } from "@/components/ui/text";
import { SourceNote, StatTile, Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { VerdictBadge } from "./comparisons.tsx";
import { useDatasetNames } from "./list-controls.tsx";
import { StatusBadge } from "@/components/status-badge";

type Summary = NonNullable<ReleaseComparison["summary"]>;

const optionalDuration = (value: number | undefined) =>
  value === undefined ? "—" : formatDurationMs(value);

function Arm({
  arm,
  basePath,
  label,
  labels,
}: Readonly<{
  arm: ReleaseComparison["baseline"];
  basePath: string;
  label: string;
  labels: AgentLabels;
}>) {
  return (
    <>
      <DescriptionTerm>{label}</DescriptionTerm>
      <DescriptionDetails>
        <span className="flex flex-wrap items-center gap-x-3">
          <span>{labels.release(arm.agentReleaseId)}</span>
          <TextLink href={`${basePath}/evaluations/runs/${arm.evaluationRunId}`}>
            Evaluation run
          </TextLink>
        </span>
      </DescriptionDetails>
    </>
  );
}

/** One release comparison: arms, verdict and its reasons, summary deltas, and the report. */
export function ComparisonDetail({
  releaseComparisonId,
  scope,
}: Readonly<{ releaseComparisonId: string; scope: EnvironmentScope }>) {
  const { data: directory } = useSuspenseQuery(agentDirectoryQuery(scope));
  const { data } = useSuspenseQuery(comparisonDetailQuery(scope, releaseComparisonId));
  const datasetNames = useDatasetNames(scope);
  const { comparison } = data;
  const labels = agentLabels(directory, data.releases);
  const basePath = environmentPath(scope);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading level={2}>Release comparison</Heading>
        <PublicId value={comparison.id} />
        <StatusBadge status={comparison.status} />
        <VerdictBadge verdict={comparison.verdict} />
        <Badge color="zinc">{comparison.gateMode}</Badge>
      </div>
      {comparison.error ? (
        <Callout variant="destructive">
          <CalloutTitle>{comparison.error.code}</CalloutTitle>
          <CalloutDescription>{comparison.error.message}</CalloutDescription>
        </Callout>
      ) : null}
      <DescriptionList>
        <Arm arm={comparison.baseline} basePath={basePath} label="Baseline" labels={labels} />
        <Arm arm={comparison.candidate} basePath={basePath} label="Candidate" labels={labels} />
        <DescriptionTerm>Dataset</DescriptionTerm>
        <DescriptionDetails>
          <TextLink href={`${basePath}/evaluations/datasets/${comparison.datasetId}`}>
            {datasetNames.get(comparison.datasetId) ?? comparison.datasetId}
          </TextLink>
        </DescriptionDetails>
        {comparison.runtimeConfigFromAgentDeploymentId ? (
          <>
            <DescriptionTerm>Runtime configuration</DescriptionTerm>
            <DescriptionDetails>
              {labels.deployment(comparison.runtimeConfigFromAgentDeploymentId)}
            </DescriptionDetails>
          </>
        ) : null}
        <DescriptionTerm>Created</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={comparison.createdAt} />
        </DescriptionDetails>
        {comparison.completedAt ? (
          <>
            <DescriptionTerm>Completed</DescriptionTerm>
            <DescriptionDetails>
              <Timestamp value={comparison.completedAt} />
            </DescriptionDetails>
          </>
        ) : null}
        {comparison.report ? (
          <>
            <DescriptionTerm>Report</DescriptionTerm>
            <DescriptionDetails>
              <span className="flex gap-4">
                <a className="underline" href={comparison.report.markdown.downloadUrl}>
                  Markdown
                </a>
                <a className="underline" href={comparison.report.json.downloadUrl}>
                  JSON
                </a>
                <span className="text-muted-foreground">
                  links expire <Timestamp value={comparison.report.json.downloadUrlExpiresAt} />
                </span>
              </span>
            </DescriptionDetails>
          </>
        ) : null}
      </DescriptionList>

      {comparison.reasons.length > 0 ? (
        <section className="flex flex-col gap-2">
          <Subheading>Verdict reasons</Subheading>
          <ul className="list-disc pl-5 text-sm/6">
            {comparison.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {comparison.summary ? <SummarySection summary={comparison.summary} /> : null}

      <section className="flex flex-col gap-4">
        <Subheading>Gate policy</Subheading>
        <Text>Advisory thresholds; a failing verdict never blocks a promotion.</Text>
        <DescriptionList>
          {Object.entries(GATE_POLICY_FIELDS).map(([key, label]) => {
            const value = comparison.gatePolicy[key as GatePolicyField];
            return (
              <Fragment key={key}>
                <DescriptionTerm>{label}</DescriptionTerm>
                <DescriptionDetails>
                  {key === "maxNewFailures" || key === "minComparableCases"
                    ? formatExact(value)
                    : key === "maxMeanDecrease"
                      ? formatScore(value)
                      : formatPercent(value)}
                </DescriptionDetails>
              </Fragment>
            );
          })}
        </DescriptionList>
      </section>
    </div>
  );
}

function SummarySection({ summary }: Readonly<{ summary: Summary }>) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Subheading>Summary</Subheading>
        <SourceNote source="analytics" />
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label="Comparable cases"
          value={`${formatExact(summary.comparableCases)} / ${formatExact(summary.totalCases)}`}
        />
        <StatTile label="Regressions" value={formatExact(summary.regressions)} />
        <StatTile
          detail={`baseline ${formatExact(summary.evaluatorErrors.baseline)}`}
          label="Evaluator errors (candidate)"
          value={formatExact(summary.evaluatorErrors.candidate)}
        />
        <StatTile
          detail={`baseline ${formatExact(summary.missingEvidence.baseline)}`}
          label="Missing evidence (candidate)"
          value={formatExact(summary.missingEvidence.candidate)}
        />
      </div>
      <Table dense striped>
        <TableHeader>
          <TableRow>
            <TableHead>Scorer</TableHead>
            <TableHead className="text-right">Baseline pass rate</TableHead>
            <TableHead className="text-right">Candidate pass rate</TableHead>
            <TableHead className="text-right">Δ</TableHead>
            <TableHead className="text-right">Baseline mean</TableHead>
            <TableHead className="text-right">Candidate mean</TableHead>
            <TableHead className="text-right">Δ</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {summary.definitions.map((definition) => (
            <TableRow key={definition.scoreDefinitionId}>
              <TableCell>
                <Code>{definition.name}</Code>{" "}
                <span className="text-muted-foreground">rev {definition.revision}</span>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {definition.baselinePassRate === undefined
                  ? "—"
                  : formatPercent(definition.baselinePassRate)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {definition.candidatePassRate === undefined
                  ? "—"
                  : formatPercent(definition.candidatePassRate)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatDelta(definition.passRateDelta, "points")}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatScore(definition.baselineMean)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatScore(definition.candidateMean)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatDelta(definition.meanDelta, "score")}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Table dense striped>
        <TableHeader>
          <TableRow>
            <TableHead>Measure</TableHead>
            <TableHead className="text-right">Baseline</TableHead>
            <TableHead className="text-right">Candidate</TableHead>
            <TableHead className="text-right">Δ</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Cost</TableCell>
            <TableCell className="text-right tabular-nums">
              {formatUsdMicros(summary.costUsdMicros.baselineTotal)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatUsdMicros(summary.costUsdMicros.candidateTotal)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatDelta(summary.costUsdMicros.delta, "usd")}
            </TableCell>
          </TableRow>
          <TableRow>
            <TableCell>Tokens</TableCell>
            <TableCell className="text-right tabular-nums">
              {formatExact(summary.tokens.baselineTotal)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatExact(summary.tokens.candidateTotal)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatDelta(summary.tokens.delta, "count")}
            </TableCell>
          </TableRow>
          <TableRow>
            <TableCell>Latency p50</TableCell>
            <TableCell className="text-right tabular-nums">
              {optionalDuration(summary.latency.baselineP50Ms)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {optionalDuration(summary.latency.candidateP50Ms)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatDelta(summary.latency.p50DeltaMs, "duration")}
            </TableCell>
          </TableRow>
          <TableRow>
            <TableCell>Latency p95</TableCell>
            <TableCell className="text-right tabular-nums">
              {optionalDuration(summary.latency.baselineP95Ms)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {optionalDuration(summary.latency.candidateP95Ms)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatDelta(summary.latency.p95DeltaMs, "duration")}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </section>
  );
}
