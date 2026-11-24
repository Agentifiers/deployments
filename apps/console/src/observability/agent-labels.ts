import type { MetricGroupBy } from "./range.ts";
import type { LabeledTrace, TraceSummary } from "./traces.ts";

interface AgentDefinitionEntry {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

interface AgentDeploymentEntry {
  readonly definitionId: string;
  readonly id: string;
}

export interface AgentReleaseEntry {
  readonly definitionId: string;
  readonly id: string;
  readonly releaseNumber: number;
}

/** The environment's agents, used to name observability groups, trace columns, and filters. */
export interface AgentDirectory {
  readonly definitions: readonly AgentDefinitionEntry[];
  readonly deployments: readonly AgentDeploymentEntry[];
}

export interface AgentLabels {
  readonly definition: (id: string) => string;
  readonly deployment: (id: string) => string;
  /** The release with its agent's name, for lists of releases across agents. */
  readonly release: (id: string) => string;
  /** Just the release number, for rows that already name the agent. */
  readonly releaseNumber: (id: string) => string;
}

/** Facts that lack the grouped dimension, such as traces finalized before agent attribution. */
export const UNATTRIBUTED = "Unattributed";

/**
 * Names agents, deployments, and releases. `releaseEntries` holds only the releases on screen
 * (they are looked up by ID). IDs missing from either (archived or deleted since the fact was
 * recorded) render as a truncated ID so they stay recognizable.
 */
export function agentLabels(
  directory: AgentDirectory,
  releaseEntries: readonly AgentReleaseEntry[] = [],
): AgentLabels {
  const definitions = new Map(directory.definitions.map((entry) => [entry.id, entry.name]));
  const deployments = new Map(directory.deployments.map((entry) => [entry.id, entry.definitionId]));
  const releases = new Map(releaseEntries.map((entry) => [entry.id, entry]));
  const deploymentsPerDefinition = new Map<string, number>();
  for (const entry of directory.deployments) {
    deploymentsPerDefinition.set(
      entry.definitionId,
      (deploymentsPerDefinition.get(entry.definitionId) ?? 0) + 1,
    );
  }
  const definition = (id: string) => definitions.get(id) ?? `${id.slice(0, 10)}…`;
  return {
    definition,
    deployment(id) {
      const definitionId = deployments.get(id);
      if (definitionId === undefined) return `${id.slice(0, 10)}…`;
      // Several deployments of one agent need their ID suffix to tell them apart.
      return (deploymentsPerDefinition.get(definitionId) ?? 0) > 1
        ? `${definition(definitionId)} · ${id.slice(-6)}`
        : definition(definitionId);
    },
    release(id) {
      const release = releases.get(id);
      return release
        ? `${definition(release.definitionId)} #${release.releaseNumber}`
        : `${id.slice(0, 10)}…`;
    },
    releaseNumber(id) {
      const release = releases.get(id);
      return release ? `#${release.releaseNumber}` : `${id.slice(0, 10)}…`;
    },
  };
}

/** Group names for a grouped metrics series; model and provider values name themselves. */
export function groupLabel(groupBy: MetricGroupBy, labels: AgentLabels | undefined) {
  return (groupValue: string | null) => {
    if (groupValue === null) return UNATTRIBUTED;
    if (!labels) return groupValue;
    if (groupBy === "agentDefinitionId") return labels.definition(groupValue);
    if (groupBy === "agentDeploymentId") return labels.deployment(groupValue);
    if (groupBy === "agentReleaseId") return labels.release(groupValue);
    return groupValue;
  };
}

/** Names a trace's agent (its deployment, else its definition) and release when attributed. */
export function labelTrace(trace: TraceSummary, labels: AgentLabels): LabeledTrace {
  const agentLabel = trace.agent_deployment_id
    ? labels.deployment(trace.agent_deployment_id)
    : trace.agent_definition_id
      ? labels.definition(trace.agent_definition_id)
      : undefined;
  return {
    ...trace,
    ...(agentLabel === undefined ? {} : { agentLabel }),
    ...(trace.agent_release_id
      ? { releaseLabel: labels.releaseNumber(trace.agent_release_id) }
      : {}),
  };
}
