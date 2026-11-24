import "@tanstack/react-start/server-only";
import type {
  ComparisonFilters,
  ResourceStatus,
  EvaluationRunFilters,
} from "../evaluations/filters.ts";
import type { AgentReleaseEntry } from "../observability/agent-labels.ts";
import type { EnvironmentScope } from "../scope.ts";
import { loadReleaseEntries } from "./agent-directory.ts";
import { FAN_OUT_CONCURRENCY, fanOut } from "./fan-out.ts";
import { API_PAGE_LIMIT, fillPage, PAGE_SIZE, type LabeledPage, type Page } from "./list-pages.ts";
import { callRoute, collectPages, type RouteResponse } from "./platform-api.ts";

export type RegressionDataset = RouteResponse<"getRegressionDataset">;
export type DatasetCase = RouteResponse<"listDatasetCases">["items"][number];
type ScoreDefinitionResponse = RouteResponse<"getScoreDefinition">;
type ScoreRevisionResponse = ScoreDefinitionResponse["revision"];
export type EvaluationRun = RouteResponse<"getEvaluationRun">;
export type EvaluationCaseResult = RouteResponse<"listEvaluationRunResults">["items"][number];
export type ReleaseComparison = RouteResponse<"getReleaseComparison">;

/**
 * A score definition as the console shows it. Evaluator configurations carry free-form JSON
 * (JSON schemas), which server functions cannot type as serializable, so the configuration
 * crosses the boundary as its kind plus formatted JSON text: exactly what the detail view shows
 * and the revise form edits.
 */
export interface ScoreDefinition extends Omit<ScoreDefinitionResponse, "revision"> {
  readonly revision: Omit<ScoreRevisionResponse, "evaluator"> & {
    readonly evaluator: {
      readonly json: string;
      readonly kind: ScoreRevisionResponse["evaluator"]["kind"];
    };
  };
}

export function scoreDefinitionView(definition: ScoreDefinitionResponse): ScoreDefinition {
  const { evaluator, ...revision } = definition.revision;
  return {
    ...definition,
    revision: {
      ...revision,
      evaluator: { json: JSON.stringify(evaluator, null, 2), kind: evaluator.kind },
    },
  };
}

/** The agent tab reads a bounded number of runs or comparisons per release. */
const AGENT_TAB_ITEMS_PER_QUERY = 25;

export async function loadDatasetPage(
  accessToken: string,
  scope: EnvironmentScope,
  status: ResourceStatus | undefined,
  cursor: string | undefined,
): Promise<Page<RegressionDataset>> {
  return fillPage(
    (pageCursor, limit) =>
      callRoute(
        "listRegressionDatasets",
        { query: { cursor: pageCursor, limit, status }, scope },
        accessToken,
      ),
    cursor,
    PAGE_SIZE,
  );
}

/** Every dataset (active and archived): names datasets in run rows and filters. */
export async function loadDatasetDirectory(
  accessToken: string,
  scope: EnvironmentScope,
): Promise<RegressionDataset[]> {
  return collectPages((cursor) =>
    callRoute(
      "listRegressionDatasets",
      { query: { cursor, limit: API_PAGE_LIMIT }, scope },
      accessToken,
    ),
  );
}

export async function loadDataset(
  accessToken: string,
  scope: EnvironmentScope,
  datasetId: string,
): Promise<RegressionDataset> {
  return callRoute("getRegressionDataset", { path: { datasetId }, scope }, accessToken);
}

export async function loadDatasetCasePage(
  accessToken: string,
  scope: EnvironmentScope,
  datasetId: string,
  cursor: string | undefined,
): Promise<Page<DatasetCase>> {
  return fillPage(
    (pageCursor, limit) =>
      callRoute(
        "listDatasetCases",
        { path: { datasetId }, query: { cursor: pageCursor, limit }, scope },
        accessToken,
      ),
    cursor,
    PAGE_SIZE,
  );
}

export async function loadScorerPage(
  accessToken: string,
  scope: EnvironmentScope,
  status: ResourceStatus | undefined,
  cursor: string | undefined,
): Promise<Page<ScoreDefinition>> {
  const page = await fillPage(
    (pageCursor, limit) =>
      callRoute(
        "listScoreDefinitions",
        { query: { cursor: pageCursor, limit, status }, scope },
        accessToken,
      ),
    cursor,
    PAGE_SIZE,
  );
  return { ...page, items: page.items.map(scoreDefinitionView) };
}

/** Active score definitions, for the scorer pickers of runs and comparisons. */
export async function loadActiveScorers(
  accessToken: string,
  scope: EnvironmentScope,
): Promise<ScoreDefinition[]> {
  const definitions = await collectPages((cursor) =>
    callRoute(
      "listScoreDefinitions",
      { query: { cursor, limit: API_PAGE_LIMIT, status: "active" }, scope },
      accessToken,
    ),
  );
  return definitions.map(scoreDefinitionView);
}

export async function loadScorer(
  accessToken: string,
  scope: EnvironmentScope,
  scoreDefinitionId: string,
): Promise<ScoreDefinition> {
  return scoreDefinitionView(
    await callRoute("getScoreDefinition", { path: { scoreDefinitionId }, scope }, accessToken),
  );
}

export async function loadRunPage(
  accessToken: string,
  scope: EnvironmentScope,
  filters: EvaluationRunFilters,
  cursor: string | undefined,
): Promise<LabeledPage<EvaluationRun>> {
  const page = await fillPage(
    (pageCursor, limit) =>
      callRoute(
        "listEvaluationRuns",
        {
          query: {
            agentReleaseId: filters.agentReleaseId,
            cursor: pageCursor,
            datasetId: filters.datasetId,
            limit,
            status: filters.status,
          },
          scope,
        },
        accessToken,
      ),
    cursor,
    PAGE_SIZE,
  );
  const releases = await loadReleaseEntries(accessToken, scope, [
    ...page.items.map((run) => run.target?.agentReleaseId),
    filters.agentReleaseId,
  ]);
  return { ...page, releases };
}

export interface RunDetail {
  readonly releases: readonly AgentReleaseEntry[];
  readonly run: EvaluationRun;
}

export async function loadRunDetail(
  accessToken: string,
  scope: EnvironmentScope,
  evaluationRunId: string,
): Promise<RunDetail> {
  const run = await callRoute(
    "getEvaluationRun",
    { path: { evaluationRunId }, scope },
    accessToken,
  );
  return {
    releases: await loadReleaseEntries(accessToken, scope, [run.target?.agentReleaseId]),
    run,
  };
}

export async function loadRunResultPage(
  accessToken: string,
  scope: EnvironmentScope,
  evaluationRunId: string,
  cursor: string | undefined,
): Promise<Page<EvaluationCaseResult>> {
  return fillPage(
    (pageCursor, limit) =>
      callRoute(
        "listEvaluationRunResults",
        { path: { evaluationRunId }, query: { cursor: pageCursor, limit }, scope },
        accessToken,
      ),
    cursor,
    PAGE_SIZE,
  );
}

export async function loadComparisonPage(
  accessToken: string,
  scope: EnvironmentScope,
  filters: ComparisonFilters,
  cursor: string | undefined,
): Promise<LabeledPage<ReleaseComparison>> {
  const page = await fillPage(
    (pageCursor, limit) =>
      callRoute(
        "listReleaseComparisons",
        {
          query: {
            baselineReleaseId: filters.baselineReleaseId,
            candidateReleaseId: filters.candidateReleaseId,
            cursor: pageCursor,
            limit,
            status: filters.status,
          },
          scope,
        },
        accessToken,
      ),
    cursor,
    PAGE_SIZE,
  );
  const releases = await loadReleaseEntries(accessToken, scope, [
    ...page.items.flatMap((item) => [item.baseline.agentReleaseId, item.candidate.agentReleaseId]),
    filters.baselineReleaseId,
    filters.candidateReleaseId,
  ]);
  return { ...page, releases };
}

export interface ComparisonDetail {
  readonly comparison: ReleaseComparison;
  readonly releases: readonly AgentReleaseEntry[];
}

export async function loadComparisonDetail(
  accessToken: string,
  scope: EnvironmentScope,
  releaseComparisonId: string,
): Promise<ComparisonDetail> {
  const comparison = await callRoute(
    "getReleaseComparison",
    { path: { releaseComparisonId }, scope },
    accessToken,
  );
  return {
    comparison,
    releases: await loadReleaseEntries(accessToken, scope, [
      comparison.baseline.agentReleaseId,
      comparison.candidate.agentReleaseId,
    ]),
  };
}

/**
 * One release with its agent, for a picker prefilled by release ID. Unlike the bulk name lookup,
 * a failure surfaces, so the picker can say why it could not preselect the release.
 */
export async function loadReleaseEntry(
  accessToken: string,
  scope: EnvironmentScope,
  releaseId: string,
): Promise<AgentReleaseEntry> {
  const release = await callRoute(
    "getAgentRelease",
    { path: { id: releaseId }, scope },
    accessToken,
  );
  return {
    definitionId: release.agentDefinitionId,
    id: release.id,
    releaseNumber: release.releaseNumber,
  };
}

export interface AgentEvaluations {
  readonly comparisons: readonly ReleaseComparison[];
  /** Releases of other agents that the comparisons compare against. */
  readonly releases: readonly AgentReleaseEntry[];
  readonly runs: readonly EvaluationRun[];
}

function newestUnique<Item extends { readonly createdAt: string; readonly id: string }>(
  lists: readonly (readonly Item[])[],
): Item[] {
  const byId = new Map<string, Item>();
  for (const item of lists.flat()) byId.set(item.id, item);
  return [...byId.values()].toSorted((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

/**
 * Evaluation runs and release comparisons that involve one agent's releases. The API filters by
 * release only, so each of the newest releases is queried (runs by target, comparisons by
 * baseline and by candidate), a bounded page each, and the results are merged newest first.
 */
export async function loadAgentEvaluations(
  accessToken: string,
  scope: EnvironmentScope,
  releaseIds: readonly string[],
): Promise<AgentEvaluations> {
  const page = <Item>(
    fetchPage: (cursor: string | undefined, limit: number) => Promise<Page<Item>>,
  ) => fillPage(fetchPage, undefined, AGENT_TAB_ITEMS_PER_QUERY).then((result) => result.items);
  const comparisonQueries = releaseIds.flatMap((releaseId) => [
    { baselineReleaseId: releaseId },
    { candidateReleaseId: releaseId },
  ]);
  // Runs and comparisons split one fan-out budget; throttled reads retry in callRoute.
  const [runs, comparisons] = await Promise.all([
    fanOut(
      releaseIds,
      (agentReleaseId) =>
        page((cursor, limit) =>
          callRoute(
            "listEvaluationRuns",
            { query: { agentReleaseId, cursor, limit }, scope },
            accessToken,
          ),
        ),
      FAN_OUT_CONCURRENCY / 2,
    ),
    fanOut(
      comparisonQueries,
      (filter) =>
        page((cursor, limit) =>
          callRoute(
            "listReleaseComparisons",
            { query: { ...filter, cursor, limit }, scope },
            accessToken,
          ),
        ),
      FAN_OUT_CONCURRENCY / 2,
    ),
  ]);
  const merged = newestUnique(comparisons);
  const own = new Set(releaseIds);
  const releases = await loadReleaseEntries(
    accessToken,
    scope,
    merged
      .flatMap((comparison) => [
        comparison.baseline.agentReleaseId,
        comparison.candidate.agentReleaseId,
      ])
      .filter((id) => !own.has(id)),
  );
  return { comparisons: merged, releases, runs: newestUnique(runs) };
}
