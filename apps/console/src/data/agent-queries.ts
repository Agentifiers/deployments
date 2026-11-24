import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { METRIC_RANGES, oneOf, type MetricRange } from "../observability/range.ts";
import { SCOPE_FIELDS, scopeKey, type EnvironmentScope } from "../scope.ts";
import { loadAgentDetail, loadAgentList } from "../server/agent-data.ts";
import { loadAgentListMetrics, loadAgentOverview } from "../server/agent-metrics.ts";
import { requireAccessToken } from "../server/session.ts";
import { IN_FLIGHT_REFRESH_MS } from "./refresh.ts";
import { fields, requireIds } from "./server-input.ts";

/** Primary and candidate releases of the canaries on one agent overview; bounds the input. */
const MAX_CANARY_RELEASES = 32;

function requireRange(value: unknown): MetricRange {
  const range = oneOf(METRIC_RANGES, value);
  if (!range) throw new TypeError(`range must be one of ${METRIC_RANGES.join(", ")}.`);
  return range;
}

const fetchAgentDetail = createServerFn({ method: "GET" })
  .validator((input: { readonly definitionId: string; readonly scope: EnvironmentScope }) => {
    const record = input as { readonly scope?: unknown };
    return {
      ...requireIds(input, ["definitionId"]),
      scope: requireIds(record.scope, SCOPE_FIELDS),
    };
  })
  .handler(async ({ data }) =>
    loadAgentDetail(await requireAccessToken(), data.scope, data.definitionId),
  );

const fetchAgentList = createServerFn({ method: "GET" })
  .validator((input: { readonly includeArchived: boolean; readonly scope: EnvironmentScope }) => {
    const value = fields(input);
    return {
      includeArchived: value.includeArchived === true,
      scope: requireIds(value.scope, SCOPE_FIELDS),
    };
  })
  .handler(async ({ data }) =>
    loadAgentList(await requireAccessToken(), data.scope, data.includeArchived),
  );

const fetchAgentListMetrics = createServerFn({ method: "GET" })
  .validator((input: { readonly range: MetricRange; readonly scope: EnvironmentScope }) => {
    const value = fields(input);
    return { range: requireRange(value.range), scope: requireIds(value.scope, SCOPE_FIELDS) };
  })
  .handler(async ({ data }) =>
    loadAgentListMetrics(await requireAccessToken(), data.scope, data.range),
  );

const fetchAgentOverview = createServerFn({ method: "GET" })
  .validator(
    (input: {
      readonly canaryReleaseIds: readonly string[];
      readonly definitionId: string;
      readonly range: MetricRange;
      readonly scope: EnvironmentScope;
    }) => {
      const value = fields(input);
      const releases = Array.isArray(value.canaryReleaseIds) ? value.canaryReleaseIds : [];
      if (releases.length > MAX_CANARY_RELEASES) {
        throw new TypeError(`canaryReleaseIds must hold at most ${MAX_CANARY_RELEASES} IDs.`);
      }
      return {
        canaryReleaseIds: releases.map((id) => requireIds({ id }, ["id"]).id),
        definitionId: requireIds(value, ["definitionId"]).definitionId,
        range: requireRange(value.range),
        scope: requireIds(value.scope, SCOPE_FIELDS),
      };
    },
  )
  .handler(async ({ data }) =>
    loadAgentOverview(
      await requireAccessToken(),
      data.scope,
      data.definitionId,
      data.range,
      data.canaryReleaseIds,
    ),
  );

/** Query-key prefix of everything the console caches about one agent. */
export const agentKey = (scope: EnvironmentScope, definitionId: string) =>
  ["agent", ...scopeKey(scope), definitionId] as const;

/**
 * The definition, its deployments, and its releases; shared by the header and every tab. It
 * polls while a deployment is deploying so operational actions settle on screen.
 */
export const agentDetailQuery = (scope: EnvironmentScope, definitionId: string) =>
  queryOptions({
    queryFn: () => fetchAgentDetail({ data: { definitionId, scope } }),
    refetchInterval: (query) =>
      query.state.data?.deployments.some((deployment) => deployment.currentState === "deploying")
        ? IN_FLIGHT_REFRESH_MS
        : false,
    queryKey: [...agentKey(scope, definitionId), "detail"],
  });

/** The agents list: one row per definition, active only unless `includeArchived`. */
export const agentListQuery = (scope: EnvironmentScope, includeArchived: boolean) =>
  queryOptions({
    queryFn: () => fetchAgentList({ data: { includeArchived, scope } }),
    queryKey: ["agents", ...scopeKey(scope), "list", includeArchived],
  });

/**
 * Runs, errors, and cost per agent over the range. Kept outside the `agents` prefix so agent
 * mutations do not re-run hot-plane queries whose figures they cannot change.
 */
export const agentListMetricsQuery = (scope: EnvironmentScope, range: MetricRange) =>
  queryOptions({
    queryFn: () => fetchAgentListMetrics({ data: { range, scope } }),
    queryKey: ["agent-metrics", ...scopeKey(scope), range],
  });

/** The agent overview's KPIs, canary comparison, and recent traces over the range. */
export const agentOverviewQuery = (
  scope: EnvironmentScope,
  definitionId: string,
  range: MetricRange,
  canaryReleaseIds: readonly string[],
) =>
  queryOptions({
    queryFn: () => fetchAgentOverview({ data: { canaryReleaseIds, definitionId, range, scope } }),
    queryKey: ["agent-overview", ...scopeKey(scope), definitionId, range, ...canaryReleaseIds],
  });

/**
 * After an agent mutation: refetch the agent, the agents list, and the cached agent directory
 * that names agents across observability screens.
 */
export function invalidateAgent(
  queryClient: QueryClient,
  scope: EnvironmentScope,
  definitionId: string,
) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: agentKey(scope, definitionId) }),
    queryClient.invalidateQueries({ queryKey: ["agents", ...scopeKey(scope)] }),
    queryClient.invalidateQueries({ queryKey: ["agent-directory", ...scopeKey(scope)] }),
  ]);
}
