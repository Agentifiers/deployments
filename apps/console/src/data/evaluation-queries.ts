import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import {
  parseComparisonFilters,
  parseResourceFilters,
  parseRunFilters,
  type ComparisonFilters,
  type EvaluationRunFilters,
  type ResourceStatus,
} from "../evaluations/filters.ts";
import { SCOPE_FIELDS, scopeKey, type EnvironmentScope } from "../scope.ts";
import { loadReleaseEntries } from "../server/agent-directory.ts";
import {
  loadActiveScorers,
  loadAgentEvaluations,
  loadComparisonDetail,
  loadComparisonPage,
  loadDataset,
  loadDatasetCasePage,
  loadDatasetDirectory,
  loadDatasetPage,
  loadRunDetail,
  loadRunPage,
  loadReleaseEntry,
  loadRunResultPage,
  loadScorer,
  loadScorerPage,
} from "../server/evaluation-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { IN_FLIGHT_REFRESH_MS } from "./refresh.ts";
import { fields, pageInput, requireIds, type PageInput } from "./server-input.ts";

/** Dataset and scorer names change rarely; pickers and row labels reuse one read for a while. */
const DIRECTORY_STALE_MS = 60_000;
const MAX_RELEASE_NAMES = 20;
/** The agent tab reads the evaluations of this many newest releases. */
export const AGENT_TAB_RELEASES = 10;

function releaseIdsInput(input: unknown, maximum: number) {
  const { releaseIds } = fields(input);
  if (!Array.isArray(releaseIds) || releaseIds.length > maximum) {
    throw new TypeError(`releaseIds must be a list of at most ${maximum} release IDs.`);
  }
  return releaseIds.map((id) => requireIds({ id }, ["id"]).id);
}

const fetchDatasetPage = createServerFn({ method: "GET" })
  .validator((input: PageInput & { readonly status?: ResourceStatus }) => ({
    ...pageInput(input),
    ...parseResourceFilters(fields(input)),
  }))
  .handler(async ({ data }) =>
    loadDatasetPage(await requireAccessToken(), data.scope, data.status, data.cursor),
  );

const fetchDatasetDirectory = createServerFn({ method: "GET" })
  .validator((input: EnvironmentScope) => requireIds(input, SCOPE_FIELDS))
  .handler(async ({ data }) => loadDatasetDirectory(await requireAccessToken(), data));

const fetchDataset = createServerFn({ method: "GET" })
  .validator((input: { readonly datasetId: string; readonly scope: EnvironmentScope }) => ({
    ...requireIds(input, ["datasetId"]),
    scope: requireIds(fields(input).scope, SCOPE_FIELDS),
  }))
  .handler(async ({ data }) => loadDataset(await requireAccessToken(), data.scope, data.datasetId));

const fetchDatasetCasePage = createServerFn({ method: "GET" })
  .validator((input: PageInput & { readonly datasetId: string }) => pageInput(input, ["datasetId"]))
  .handler(async ({ data }) =>
    loadDatasetCasePage(await requireAccessToken(), data.scope, data.datasetId, data.cursor),
  );

const fetchScorerPage = createServerFn({ method: "GET" })
  .validator((input: PageInput & { readonly status?: ResourceStatus }) => ({
    ...pageInput(input),
    ...parseResourceFilters(fields(input)),
  }))
  .handler(async ({ data }) =>
    loadScorerPage(await requireAccessToken(), data.scope, data.status, data.cursor),
  );

const fetchActiveScorers = createServerFn({ method: "GET" })
  .validator((input: EnvironmentScope) => requireIds(input, SCOPE_FIELDS))
  .handler(async ({ data }) => loadActiveScorers(await requireAccessToken(), data));

const fetchScorer = createServerFn({ method: "GET" })
  .validator((input: { readonly scope: EnvironmentScope; readonly scoreDefinitionId: string }) => ({
    ...requireIds(input, ["scoreDefinitionId"]),
    scope: requireIds(fields(input).scope, SCOPE_FIELDS),
  }))
  .handler(async ({ data }) =>
    loadScorer(await requireAccessToken(), data.scope, data.scoreDefinitionId),
  );

const fetchRunPage = createServerFn({ method: "GET" })
  .validator((input: PageInput & { readonly filters: EvaluationRunFilters }) => ({
    ...pageInput(input),
    filters: parseRunFilters(fields(fields(input).filters)),
  }))
  .handler(async ({ data }) =>
    loadRunPage(await requireAccessToken(), data.scope, data.filters, data.cursor),
  );

const fetchRunDetail = createServerFn({ method: "GET" })
  .validator((input: { readonly evaluationRunId: string; readonly scope: EnvironmentScope }) => ({
    ...requireIds(input, ["evaluationRunId"]),
    scope: requireIds(fields(input).scope, SCOPE_FIELDS),
  }))
  .handler(async ({ data }) =>
    loadRunDetail(await requireAccessToken(), data.scope, data.evaluationRunId),
  );

const fetchRunResultPage = createServerFn({ method: "GET" })
  .validator((input: PageInput & { readonly evaluationRunId: string }) =>
    pageInput(input, ["evaluationRunId"]),
  )
  .handler(async ({ data }) =>
    loadRunResultPage(await requireAccessToken(), data.scope, data.evaluationRunId, data.cursor),
  );

const fetchComparisonPage = createServerFn({ method: "GET" })
  .validator((input: PageInput & { readonly filters: ComparisonFilters }) => ({
    ...pageInput(input),
    filters: parseComparisonFilters(fields(fields(input).filters)),
  }))
  .handler(async ({ data }) =>
    loadComparisonPage(await requireAccessToken(), data.scope, data.filters, data.cursor),
  );

const fetchComparisonDetail = createServerFn({ method: "GET" })
  .validator(
    (input: { readonly releaseComparisonId: string; readonly scope: EnvironmentScope }) => ({
      ...requireIds(input, ["releaseComparisonId"]),
      scope: requireIds(fields(input).scope, SCOPE_FIELDS),
    }),
  )
  .handler(async ({ data }) =>
    loadComparisonDetail(await requireAccessToken(), data.scope, data.releaseComparisonId),
  );

const fetchReleaseNames = createServerFn({ method: "GET" })
  .validator(
    (input: { readonly releaseIds: readonly string[]; readonly scope: EnvironmentScope }) => ({
      releaseIds: releaseIdsInput(input, MAX_RELEASE_NAMES),
      scope: requireIds(fields(input).scope, SCOPE_FIELDS),
    }),
  )
  .handler(async ({ data }) =>
    loadReleaseEntries(await requireAccessToken(), data.scope, data.releaseIds),
  );

const fetchReleaseEntry = createServerFn({ method: "GET" })
  .validator((input: { readonly releaseId: string; readonly scope: EnvironmentScope }) => ({
    ...requireIds(input, ["releaseId"]),
    scope: requireIds(fields(input).scope, SCOPE_FIELDS),
  }))
  .handler(async ({ data }) =>
    loadReleaseEntry(await requireAccessToken(), data.scope, data.releaseId),
  );

const fetchAgentEvaluations = createServerFn({ method: "GET" })
  .validator(
    (input: { readonly releaseIds: readonly string[]; readonly scope: EnvironmentScope }) => ({
      releaseIds: releaseIdsInput(input, AGENT_TAB_RELEASES),
      scope: requireIds(fields(input).scope, SCOPE_FIELDS),
    }),
  )
  .handler(async ({ data }) =>
    loadAgentEvaluations(await requireAccessToken(), data.scope, data.releaseIds),
  );

/** Query-key prefix of everything the console caches about one environment's evaluations. */
const evaluationsKey = (scope: EnvironmentScope) => ["evaluations", ...scopeKey(scope)] as const;

/** After an evaluation mutation: refetch every evaluation list, detail, and picker. */
export function invalidateEvaluations(queryClient: QueryClient, scope: EnvironmentScope) {
  return queryClient.invalidateQueries({ queryKey: evaluationsKey(scope) });
}

const IN_FLIGHT_STATUSES: readonly string[] = ["queued", "running"];

const cursorField = (cursor: string | undefined) => (cursor === undefined ? {} : { cursor });

export const datasetPagesQuery = (scope: EnvironmentScope, status: ResourceStatus | undefined) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchDatasetPage({
        data: { scope, ...(status ? { status } : {}), ...cursorField(pageParam) },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...evaluationsKey(scope), "datasets", status ?? null],
  });

/** Every dataset, active and archived, to name datasets in rows, filters, and pickers. */
export const datasetDirectoryQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchDatasetDirectory({ data: scope }),
    queryKey: [...evaluationsKey(scope), "dataset-directory"],
    staleTime: DIRECTORY_STALE_MS,
  });

export const datasetQuery = (scope: EnvironmentScope, datasetId: string) =>
  queryOptions({
    queryFn: () => fetchDataset({ data: { datasetId, scope } }),
    queryKey: [...evaluationsKey(scope), "dataset", datasetId],
  });

export const datasetCasePagesQuery = (scope: EnvironmentScope, datasetId: string) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchDatasetCasePage({ data: { datasetId, scope, ...cursorField(pageParam) } }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...evaluationsKey(scope), "dataset", datasetId, "cases"],
  });

export const scorerPagesQuery = (scope: EnvironmentScope, status: ResourceStatus | undefined) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchScorerPage({
        data: { scope, ...(status ? { status } : {}), ...cursorField(pageParam) },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...evaluationsKey(scope), "scorers", status ?? null],
  });

/** Active score definitions for the run and comparison scorer pickers. */
export const activeScorersQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchActiveScorers({ data: scope }),
    queryKey: [...evaluationsKey(scope), "active-scorers"],
    staleTime: DIRECTORY_STALE_MS,
  });

export const scorerQuery = (scope: EnvironmentScope, scoreDefinitionId: string) =>
  queryOptions({
    queryFn: () => fetchScorer({ data: { scope, scoreDefinitionId } }),
    queryKey: [...evaluationsKey(scope), "scorer", scoreDefinitionId],
  });

export const runPagesQuery = (scope: EnvironmentScope, filters: EvaluationRunFilters) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchRunPage({ data: { filters, scope, ...cursorField(pageParam) } }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...evaluationsKey(scope), "runs", filters],
  });

/** One run; refreshes every five seconds while it is queued or running. */
export const runDetailQuery = (scope: EnvironmentScope, evaluationRunId: string) =>
  queryOptions({
    queryFn: () => fetchRunDetail({ data: { evaluationRunId, scope } }),
    queryKey: [...evaluationsKey(scope), "run", evaluationRunId],
    refetchInterval: (query) =>
      IN_FLIGHT_STATUSES.includes(query.state.data?.run.status ?? "")
        ? IN_FLIGHT_REFRESH_MS
        : false,
  });

export const runResultPagesQuery = (scope: EnvironmentScope, evaluationRunId: string) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchRunResultPage({ data: { evaluationRunId, scope, ...cursorField(pageParam) } }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...evaluationsKey(scope), "run", evaluationRunId, "results"],
  });

export const comparisonPagesQuery = (scope: EnvironmentScope, filters: ComparisonFilters) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchComparisonPage({ data: { filters, scope, ...cursorField(pageParam) } }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...evaluationsKey(scope), "comparisons", filters],
  });

/** One comparison; refreshes every five seconds while it is queued or running. */
export const comparisonDetailQuery = (scope: EnvironmentScope, releaseComparisonId: string) =>
  queryOptions({
    queryFn: () => fetchComparisonDetail({ data: { releaseComparisonId, scope } }),
    queryKey: [...evaluationsKey(scope), "comparison", releaseComparisonId],
    refetchInterval: (query) =>
      IN_FLIGHT_STATUSES.includes(query.state.data?.comparison.status ?? "")
        ? IN_FLIGHT_REFRESH_MS
        : false,
  });

/** Agent names for releases referenced by ID (filter values, prefilled pickers). */
export const releaseNamesQuery = (scope: EnvironmentScope, releaseIds: readonly string[]) =>
  queryOptions({
    queryFn: () => fetchReleaseNames({ data: { releaseIds, scope } }),
    queryKey: ["release-names", ...scopeKey(scope), releaseIds],
    staleTime: DIRECTORY_STALE_MS,
  });

/** One release and its agent, to preselect a release picker. */
export const releaseEntryQuery = (scope: EnvironmentScope, releaseId: string) =>
  queryOptions({
    queryFn: () => fetchReleaseEntry({ data: { releaseId, scope } }),
    queryKey: ["release-entry", ...scopeKey(scope), releaseId],
    staleTime: DIRECTORY_STALE_MS,
  });

/** Runs and comparisons of an agent's newest releases (at most `AGENT_TAB_RELEASES`). */
export const agentEvaluationsQuery = (scope: EnvironmentScope, releaseIds: readonly string[]) =>
  queryOptions({
    queryFn: () => fetchAgentEvaluations({ data: { releaseIds, scope } }),
    queryKey: [...evaluationsKey(scope), "agent", releaseIds],
  });
