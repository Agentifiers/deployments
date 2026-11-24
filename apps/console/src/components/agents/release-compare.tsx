import { useSuspenseQueries } from "@tanstack/react-query";
import { useState } from "react";
import { DRAFT } from "../../agents/release-selection.ts";
import { agentReleaseQuery } from "../../data/release-queries.ts";
import type { EnvironmentScope } from "../../scope.ts";
import type { AgentDetail } from "../../server/agent-data.ts";
import { Button } from "@/components/ui/button";
import { Field, Label } from "@/components/ui/field";
import { Subheading } from "@/components/ui/heading";
import { NativeSelect } from "@/components/ui/native-select";
import { Text } from "@/components/ui/text";
import { StartReleaseComparisonDialog } from "../evaluations/release-comparison-dialog.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { ManifestDiffView } from "./manifest-diff-view.tsx";
import { ContentHash } from "./release-table.tsx";

export interface ManifestComparisonPair {
  /** Release ID or `draft`. */
  readonly baseline: string;
  /** Release ID or `draft`. */
  readonly candidate: string;
}

function sourceLabel(agent: AgentDetail, source: string) {
  if (source === DRAFT) return "the draft";
  const release = agent.releases.find((candidate) => candidate.id === source);
  return release ? `release #${release.releaseNumber}` : "the release";
}

function SourceSelect({
  agent,
  label,
  onChange,
  value,
}: Readonly<{
  agent: AgentDetail;
  label: string;
  onChange: (source: string) => void;
  value: string;
}>) {
  return (
    <Field className="w-64">
      <Label>{label}</Label>
      <NativeSelect onChange={(event) => onChange(event.target.value)} value={value}>
        <option value={DRAFT}>Saved draft (draft {agent.definition.version})</option>
        {agent.releases.map((release) => (
          <option key={release.id} value={release.id}>
            Release #{release.releaseNumber}
            {release.status === "archived" ? " (archived)" : ""}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}

/** Loads the releases on either side (the draft is already in the agent) and diffs them. */
function ManifestComparison({
  agent,
  pair,
  scope,
}: Readonly<{ agent: AgentDetail; pair: ManifestComparisonPair; scope: EnvironmentScope }>) {
  const releaseIds = [...new Set([pair.baseline, pair.candidate])].filter((id) => id !== DRAFT);
  const releases = useSuspenseQueries({
    queries: releaseIds.map((id) => agentReleaseQuery(scope, agent.definition.id, id)),
  });
  const side = (source: string) => {
    const release = releases.find((result) => result.data.id === source)?.data;
    return {
      label: sourceLabel(agent, source),
      manifest: source === DRAFT ? agent.definition.draft : release?.manifest,
      release,
    };
  };
  const baseline = side(pair.baseline);
  const candidate = side(pair.candidate);
  if (pair.baseline === pair.candidate) {
    return <Text>Choose two different manifests to compare.</Text>;
  }
  if (
    baseline.release &&
    candidate.release &&
    baseline.release.contentHash === candidate.release.contentHash
  ) {
    return (
      <Text>
        {baseline.label} and {candidate.label} have the same content hash (
        <ContentHash value={baseline.release.contentHash} />
        ), so their manifests are identical.
      </Text>
    );
  }
  return (
    <ManifestDiffView
      baseline={baseline.manifest}
      baselineLabel={baseline.label}
      candidate={candidate.manifest}
      candidateLabel={candidate.label}
    />
  );
}

/**
 * Manifest diff between any two releases or a release and the draft, plus the evaluation-backed
 * release comparison for the same pair.
 */
export function ReleaseCompare({
  agent,
  canStartComparison,
  onChange,
  pair,
  scope,
}: Readonly<{
  agent: AgentDetail;
  canStartComparison: boolean;
  onChange: (pair: ManifestComparisonPair) => void;
  pair: ManifestComparisonPair;
  scope: EnvironmentScope;
}>) {
  const [comparing, setComparing] = useState(false);
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <Subheading>Compare manifests</Subheading>
        <div className="ml-auto flex flex-wrap items-end gap-4">
          <SourceSelect
            agent={agent}
            label="Baseline"
            onChange={(baseline) => onChange({ ...pair, baseline })}
            value={pair.baseline}
          />
          <SourceSelect
            agent={agent}
            label="Candidate"
            onChange={(candidate) => onChange({ ...pair, candidate })}
            value={pair.candidate}
          />
          {canStartComparison ? (
            <Button onClick={() => setComparing(true)} variant="outline">
              Start release comparison
            </Button>
          ) : null}
        </div>
      </div>
      <SectionBoundary resetKey={`${pair.baseline}:${pair.candidate}`}>
        <ManifestComparison agent={agent} pair={pair} scope={scope} />
      </SectionBoundary>
      {canStartComparison ? (
        <StartReleaseComparisonDialog
          {...(pair.baseline === DRAFT ? {} : { baselineReleaseId: pair.baseline })}
          {...(pair.candidate === DRAFT ? {} : { candidateReleaseId: pair.candidate })}
          onClose={() => setComparing(false)}
          open={comparing}
          scope={scope}
        />
      ) : null}
    </section>
  );
}
