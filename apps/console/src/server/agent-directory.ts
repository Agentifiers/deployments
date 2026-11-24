import "@tanstack/react-start/server-only";
import type { AgentDirectory, AgentReleaseEntry } from "../observability/agent-labels.ts";
import type { EnvironmentScope } from "../scope.ts";
import { UnauthenticatedError } from "../errors.ts";
import { fanOut } from "./fan-out.ts";
import { callRoute, collectPages } from "./platform-api.ts";

const PAGE_LIMIT = 100;

/** The environment's agent definitions and deployments. */
export async function loadAgentDirectory(
  accessToken: string,
  scope: EnvironmentScope,
): Promise<AgentDirectory> {
  const [definitions, deployments] = await Promise.all([
    collectPages((cursor) =>
      callRoute(
        "listAgentDefinitions",
        { query: { cursor, limit: PAGE_LIMIT }, scope },
        accessToken,
      ),
    ),
    collectPages((cursor) =>
      callRoute(
        "listAgentDeployments",
        { query: { cursor, limit: PAGE_LIMIT }, scope },
        accessToken,
      ),
    ),
  ]);
  return {
    definitions: definitions.map(({ id, name, slug }) => ({ id, name, slug })),
    deployments: deployments.map(({ agentDefinitionId, id }) => ({
      definitionId: agentDefinitionId,
      id,
    })),
  };
}

/**
 * Names the releases that observability data refers to. Releases are looked up by ID rather than
 * listed per definition, so the cost follows the rows on screen, not the environment's size.
 * Throttled lookups are retried; a release that still cannot be read (archived, erased, or
 * failing) is omitted and renders as its ID.
 */
export async function loadReleaseEntries(
  accessToken: string,
  scope: EnvironmentScope,
  releaseIds: Iterable<string | undefined>,
): Promise<AgentReleaseEntry[]> {
  const ids = [...new Set([...releaseIds].filter((id): id is string => Boolean(id)))];
  const releases = await fanOut(ids, async (id): Promise<AgentReleaseEntry | undefined> => {
    try {
      const release = await callRoute("getAgentRelease", { path: { id }, scope }, accessToken);
      return {
        definitionId: release.agentDefinitionId,
        id: release.id,
        releaseNumber: release.releaseNumber,
      };
    } catch (error) {
      if (error instanceof UnauthenticatedError) throw error;
      return undefined;
    }
  });
  return releases.filter((release): release is AgentReleaseEntry => release !== undefined);
}

/** Every release of one definition, newest first, for the trace list's release filter. */
export async function loadDefinitionReleases(
  accessToken: string,
  scope: EnvironmentScope,
  definitionId: string,
): Promise<AgentReleaseEntry[]> {
  const releases = await collectPages((cursor) =>
    callRoute(
      "listAgentReleases",
      { path: { id: definitionId }, query: { cursor, limit: PAGE_LIMIT }, scope },
      accessToken,
    ),
  );
  return releases
    .map((release) => ({
      definitionId: release.agentDefinitionId,
      id: release.id,
      releaseNumber: release.releaseNumber,
    }))
    .toSorted((left, right) => right.releaseNumber - left.releaseNumber);
}
