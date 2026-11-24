import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  activeScorersQuery,
  datasetDirectoryQuery,
  releaseEntryQuery,
  releaseNamesQuery,
} from "../../data/evaluation-queries.ts";
import { agentDirectoryQuery, releaseFilterQuery } from "../../data/observability-queries.ts";
import { agentLabels } from "../../observability/agent-labels.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Checkbox } from "@/components/ui/checkbox";
import {
  CheckboxField,
  Description,
  ErrorMessage,
  Field,
  Fieldset,
  Label,
  Legend,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Text } from "@/components/ui/text";

/** Score definitions an evaluation run can execute; human and imported scores are recorded. */
const AUTOMATED_SCORER_TYPES: readonly string[] = ["deterministic", "model-judged"];
/** The API accepts at most this many score definitions per run or comparison. */
const MAX_SCORERS = 20;

/**
 * Picks one release as "Agent name #N": the agent first, then that agent's releases, loaded on
 * demand. A prefilled release resolves its agent by ID.
 */
export function ReleasePicker({
  description,
  label,
  onChange,
  scope,
  value,
}: Readonly<{
  description?: string;
  label: string;
  onChange: (releaseId: string) => void;
  scope: EnvironmentScope;
  value: string;
}>) {
  const { data: directory } = useSuspenseQuery(agentDirectoryQuery(scope));
  // A release chosen elsewhere (a prefilled ID) resolves its agent; a failed lookup is reported
  // rather than silently leaving the agent unselected.
  const prefilled = useQuery({ ...releaseEntryQuery(scope, value), enabled: Boolean(value) });
  const [chosenDefinitionId, setChosenDefinitionId] = useState<string>();
  const resolving = chosenDefinitionId === undefined && Boolean(value) && prefilled.isPending;
  const definitionId =
    chosenDefinitionId ?? (prefilled.data?.id === value ? prefilled.data.definitionId : "");
  const releases = useQuery({
    ...releaseFilterQuery(scope, definitionId),
    enabled: Boolean(definitionId),
  });
  const definitions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of directory.definitions) {
      counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
    }
    // Same-named agents (common among test leftovers) need their slug to tell them apart.
    return directory.definitions
      .map((entry) => ({
        id: entry.id,
        label: (counts.get(entry.name) ?? 0) > 1 ? `${entry.name} (${entry.slug})` : entry.name,
      }))
      .toSorted((left, right) => left.label.localeCompare(right.label));
  }, [directory]);
  const agentName = definitions.find((entry) => entry.id === definitionId)?.label ?? "";

  return (
    <Field>
      <Label>{label}</Label>
      {description ? <Description>{description}</Description> : null}
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
        <NativeSelect
          aria-label={`${label}: agent`}
          disabled={resolving}
          onChange={(event) => {
            setChosenDefinitionId(event.target.value);
            onChange("");
          }}
          value={definitionId}
        >
          <option value="">{resolving ? "Loading release…" : "Choose an agent…"}</option>
          {definitions.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label={`${label}: release`}
          disabled={!definitionId || releases.isPending}
          onChange={(event) => onChange(event.target.value)}
          value={value}
        >
          <option value="">
            {definitionId && releases.isPending ? "Loading releases…" : "Choose a release…"}
          </option>
          {(releases.data ?? []).map((release) => (
            <option key={release.id} value={release.id}>
              {agentName} #{release.releaseNumber}
            </option>
          ))}
        </NativeSelect>
      </div>
      {chosenDefinitionId === undefined && prefilled.error ? (
        <ErrorMessage>
          Could not load release {value}: {prefilled.error.message}. Choose the agent and release.
        </ErrorMessage>
      ) : null}
    </Field>
  );
}

/** Active regression datasets, with their case counts. */
export function DatasetSelect({
  onChange,
  scope,
  value,
}: Readonly<{ onChange: (datasetId: string) => void; scope: EnvironmentScope; value: string }>) {
  const { data: datasets } = useSuspenseQuery(datasetDirectoryQuery(scope));
  const active = datasets
    .filter((dataset) => dataset.status === "active")
    .toSorted((left, right) => left.name.localeCompare(right.name));
  return (
    <Field>
      <Label>Dataset</Label>
      {active.length === 0 ? (
        <Description>No active datasets. Create one on the Datasets tab first.</Description>
      ) : null}
      <NativeSelect onChange={(event) => onChange(event.target.value)} value={value}>
        <option value="">Choose a dataset…</option>
        {active.map((dataset) => (
          <option key={dataset.id} value={dataset.id}>
            {dataset.name} · {dataset.caseCount} cases
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}

/** Active automated score definitions; a run evaluates each chosen one's current revision. */
export function ScorerChecklist({
  onChange,
  scope,
  value,
}: Readonly<{
  onChange: (scoreDefinitionIds: readonly string[]) => void;
  scope: EnvironmentScope;
  value: readonly string[];
}>) {
  const { data: scorers } = useSuspenseQuery(activeScorersQuery(scope));
  const automated = scorers
    .filter((scorer) => AUTOMATED_SCORER_TYPES.includes(scorer.type))
    .toSorted((left, right) => left.name.localeCompare(right.name));
  const full = value.length >= MAX_SCORERS;
  return (
    <Fieldset>
      <Legend>Scorers</Legend>
      <Text>
        {automated.length === 0
          ? "No active automated scorers. Create one on the Scorers tab first."
          : `Up to ${MAX_SCORERS}; each runs at its current revision.`}
      </Text>
      <div className="flex max-h-56 flex-col gap-3 overflow-y-auto rounded-lg border border-border p-3">
        {automated.map((scorer) => {
          const checked = value.includes(scorer.id);
          return (
            <CheckboxField disabled={full && !checked} key={scorer.id}>
              <Checkbox
                checked={checked}
                onCheckedChange={(next) =>
                  onChange(next ? [...value, scorer.id] : value.filter((id) => id !== scorer.id))
                }
              />
              <Label>{scorer.name}</Label>
              <Description>
                {scorer.type} · {scorer.revision.evaluator.kind} · revision {scorer.currentRevision}
              </Description>
            </CheckboxField>
          );
        })}
      </div>
    </Fieldset>
  );
}

/**
 * Optional deployment whose runtime configuration (connections, policy) the replay snapshots;
 * offered from the deployments of the chosen releases' agents.
 */
export function RuntimeConfigSelect({
  onChange,
  releaseIds,
  scope,
  value,
}: Readonly<{
  onChange: (agentDeploymentId: string) => void;
  releaseIds: readonly string[];
  scope: EnvironmentScope;
  value: string;
}>) {
  const { data: directory } = useSuspenseQuery(agentDirectoryQuery(scope));
  const chosen = releaseIds.filter(Boolean);
  const releases = useQuery({
    ...releaseNamesQuery(scope, chosen),
    enabled: chosen.length > 0,
  });
  const labels = agentLabels(directory, releases.data ?? []);
  const definitionIds = new Set((releases.data ?? []).map((entry) => entry.definitionId));
  const deployments = directory.deployments.filter((entry) =>
    definitionIds.has(entry.definitionId),
  );
  return (
    <Field>
      <Label>Runtime configuration</Label>
      <Description>
        Optional. Replays use this deployment's connections and policy snapshot.
      </Description>
      <NativeSelect
        disabled={deployments.length === 0}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">None</option>
        {deployments.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {labels.deployment(entry.id)}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}

/** Optional numeric inputs: blank keeps the API default shown as the placeholder. */
export function NumberField({
  description,
  label,
  onChange,
  placeholder,
  value,
}: Readonly<{
  description?: string;
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}>) {
  return (
    <Field>
      <Label>{label}</Label>
      {description ? <Description>{description}</Description> : null}
      <Input
        inputMode="decimal"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
    </Field>
  );
}
