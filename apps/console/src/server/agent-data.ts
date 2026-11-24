import "@tanstack/react-start/server-only";
import type { AgentReleaseEntry } from "../observability/agent-labels.ts";
import type { EnvironmentScope } from "../scope.ts";
import { loadReleaseEntries } from "./agent-directory.ts";
import { requirePublicIds } from "./console-data.ts";
import { callRoute, collectPages, type RouteResponse } from "./platform-api.ts";

const PAGE_LIMIT = 100;

type AgentDefinition = RouteResponse<"getAgentDefinition">;
type AgentDefinitionSummary = RouteResponse<"listAgentDefinitions">["items"][number];
export type AgentDeployment = RouteResponse<"getAgentDeployment">;
export type AgentReleaseSummary = RouteResponse<"listAgentReleases">["items"][number];

/**
 * Everything the agent detail header and tabs share: the definition with its draft manifest,
 * its deployments (live ones first, then most recently changed), and its releases newest first.
 */
export interface AgentDetail {
  readonly definition: AgentDefinition;
  readonly deployments: readonly AgentDeployment[];
  readonly releases: readonly AgentReleaseSummary[];
}

/** One agents-list row: the definition with its deployments that are not stopped. */
interface AgentListRow {
  readonly definition: AgentDefinitionSummary;
  /** Deployments that serve or can resume traffic, most recently changed first. */
  readonly deployments: readonly AgentDeployment[];
  /** Latest state transition across every deployment, stopped ones included. */
  readonly lastTransitionAt?: string;
  readonly stoppedDeployments: number;
}

/** The agents list; `releases` names the releases its live deployments pin or canary. */
export interface AgentList {
  /** Archived definitions left out of `rows` because the list shows active ones only. */
  readonly hiddenArchived: number;
  readonly releases: readonly AgentReleaseEntry[];
  readonly rows: readonly AgentListRow[];
}

/** Deployments that still serve or can serve traffic sort before stopped ones. */
function deploymentOrder(left: AgentDeployment, right: AgentDeployment) {
  const stopped =
    Number(left.currentState === "stopped") - Number(right.currentState === "stopped");
  return stopped !== 0 ? stopped : right.updatedAt.localeCompare(left.updatedAt);
}

function listDeployments(accessToken: string, scope: EnvironmentScope) {
  return collectPages((cursor) =>
    callRoute("listAgentDeployments", { query: { cursor, limit: PAGE_LIMIT }, scope }, accessToken),
  );
}

/**
 * Loads one agent. The deployment list has no definition filter, so the environment's
 * deployments are paged and filtered here.
 */
export async function loadAgentDetail(
  accessToken: string,
  scope: EnvironmentScope,
  definitionId: string,
): Promise<AgentDetail> {
  const [definition, deployments, releases] = await Promise.all([
    callRoute("getAgentDefinition", { path: { id: definitionId }, scope }, accessToken),
    listDeployments(accessToken, scope),
    collectPages((cursor) =>
      callRoute(
        "listAgentReleases",
        { path: { id: definitionId }, query: { cursor, limit: PAGE_LIMIT }, scope },
        accessToken,
      ),
    ),
  ]);
  return {
    definition,
    deployments: deployments
      .filter((deployment) => deployment.agentDefinitionId === definitionId)
      .toSorted(deploymentOrder),
    releases: releases.toSorted((left, right) => right.releaseNumber - left.releaseNumber),
  };
}

function latest(values: Iterable<string | undefined>) {
  let result: string | undefined;
  for (const value of values) if (value && (!result || value > result)) result = value;
  return result;
}

/**
 * Joins the environment's definitions and deployments into one row per definition (active
 * first, then by name). Neither list filters server-side, so both are paged in full; releases are
 * named by ID for the live deployments on screen only.
 */
export async function loadAgentList(
  accessToken: string,
  scope: EnvironmentScope,
  includeArchived: boolean,
): Promise<AgentList> {
  requirePublicIds({ ...scope });
  const [definitions, deployments] = await Promise.all([
    collectPages((cursor) =>
      callRoute(
        "listAgentDefinitions",
        { query: { cursor, limit: PAGE_LIMIT }, scope },
        accessToken,
      ),
    ),
    listDeployments(accessToken, scope),
  ]);
  const byDefinition = Map.groupBy(deployments, (deployment) => deployment.agentDefinitionId);
  const shown = definitions.filter(
    (definition) => includeArchived || definition.status === "active",
  );
  const rows = shown
    .map((definition): AgentListRow => {
      const all = byDefinition.get(definition.id) ?? [];
      const live = all.filter((deployment) => deployment.currentState !== "stopped");
      const lastTransitionAt = latest(
        all.map((deployment) => deployment.lastTransitionAt ?? deployment.updatedAt),
      );
      return {
        definition,
        deployments: live.toSorted(deploymentOrder),
        stoppedDeployments: all.length - live.length,
        ...(lastTransitionAt ? { lastTransitionAt } : {}),
      };
    })
    .toSorted(
      (left, right) =>
        Number(left.definition.status === "archived") -
          Number(right.definition.status === "archived") ||
        left.definition.name.localeCompare(right.definition.name) ||
        left.definition.slug.localeCompare(right.definition.slug),
    );
  return {
    hiddenArchived: definitions.length - shown.length,
    releases: await loadReleaseEntries(
      accessToken,
      scope,
      rows.flatMap((row) =>
        row.deployments.flatMap((deployment) => [
          deployment.agentReleaseId,
          deployment.candidateAgentReleaseId,
        ]),
      ),
    ),
    rows,
  };
}
