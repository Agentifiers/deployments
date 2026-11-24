import { useSuspenseQuery } from "@tanstack/react-query";
import { qualityQuery } from "../../data/memory-queries.ts";
import { attemptBreakdown, strategyLabel } from "../../memory/copy.ts";
import { QUALITY_WINDOWS, USEFULNESS_RATINGS, type QualityWindow } from "../../memory/model.ts";
import { formatDurationMs, formatExact, formatPercent } from "../../observability/format.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Subheading } from "@/components/ui/heading";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Text } from "@/components/ui/text";
import { SingleToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { StatTile } from "../observability/panels.tsx";
import { SectionBoundary } from "../section-boundary.tsx";

const FEEDBACK_LABELS = {
  harmful: "Harmful",
  neutral: "Neutral",
  unreviewed: "Unreviewed",
  useful: "Useful",
} as const;

function latency(value: number | undefined) {
  return value === undefined ? "None" : formatDurationMs(value);
}

export function MemoryQualityView({
  days,
  onDays,
  scope,
}: Readonly<{
  days: QualityWindow;
  onDays: (days: QualityWindow) => void;
  scope: EnvironmentScope;
}>) {
  return (
    <div className="flex flex-col gap-6">
      <SingleToggleGroup
        aria-label="Window"
        onValueChange={(next) => {
          const known = QUALITY_WINDOWS.find((window) => String(window) === next);
          if (known) onDays(known);
        }}
        size="sm"
        value={String(days)}
      >
        {QUALITY_WINDOWS.map((window) => (
          <ToggleGroupItem key={window} value={String(window)}>
            {window === 1 ? "24 hours" : `${window} days`}
          </ToggleGroupItem>
        ))}
      </SingleToggleGroup>
      <SectionBoundary resetKey={String(days)}>
        <QualityStats days={days} scope={scope} />
      </SectionBoundary>
    </div>
  );
}

function QualityStats({ days, scope }: Readonly<{ days: QualityWindow; scope: EnvironmentScope }>) {
  const { data: quality } = useSuspenseQuery(qualityQuery(scope, days));
  return (
    <div className="flex flex-col gap-8">
      <Text>
        Counts cover at most {formatExact(quality.sampleLimit)} recall attempts in the window. An
        attempt is skipped when there was nothing to recall, for example before any memory was
        saved.
      </Text>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          detail={attemptBreakdown(quality)}
          label="Recall attempts"
          value={formatExact(quality.attempts)}
        />
        <StatTile label="Retrievals" value={formatExact(quality.retrievals)} />
        <StatTile
          detail={`p95 ${latency(quality.latencyMs.p95)}, p99 ${latency(quality.latencyMs.p99)}`}
          label="Latency p50"
          value={latency(quality.latencyMs.p50)}
        />
        <StatTile
          detail={`${formatPercent(quality.canonicalDropRate)} of results dropped as outdated or deleted`}
          label="Duplicate rate"
          value={formatPercent(quality.duplicateRate)}
        />
      </div>
      <section className="flex flex-col gap-4">
        <Subheading>Retrieval feedback</Subheading>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[...USEFULNESS_RATINGS, "unreviewed" as const].map((rating) => (
            <StatTile
              key={rating}
              label={FEEDBACK_LABELS[rating]}
              value={formatExact(quality.usefulness[rating])}
            />
          ))}
        </div>
      </section>
      <section className="flex flex-col gap-4">
        <Subheading>By strategy</Subheading>
        {quality.strategies.length === 0 ? (
          <Text>No recall attempts in this window.</Text>
        ) : (
          <Table striped>
            <TableHeader>
              <TableRow>
                <TableHead>Strategy</TableHead>
                <TableHead className="text-right">Attempts</TableHead>
                <TableHead className="text-right">Completed</TableHead>
                <TableHead className="text-right">Failed</TableHead>
                <TableHead className="text-right">Skipped</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {quality.strategies.map((row) => (
                <TableRow key={row.strategy}>
                  <TableCell>{strategyLabel(row.strategy)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatExact(row.attempts)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatExact(row.completed)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatExact(row.failed)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatExact(row.attempts - row.completed - row.failed)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
