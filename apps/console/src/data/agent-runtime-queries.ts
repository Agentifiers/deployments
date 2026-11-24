import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import {
  absorbPages,
  drainRuns,
  initialRunMerge,
  isMergeDone,
  pendingRequests,
  RUN_PAGE_SIZE,
  type RunMergeState,
  type RunStreamRequest,
} from "../components/agents/runtime/run-merge.ts";
import { parseRunFilters, type RunFilters } from "../runs/filters.ts";
import { SCOPE_FIELDS, scopeKey, type EnvironmentScope } from "../scope.ts";
import {
  loadAgentChannels,
  loadAgentEmailRoutes,
  loadChannelDelivery,
  loadConnectionGrants,
  loadRunPages,
  loadToolEvaluations,
} from "../server/agent-runtime-data.ts";
import type { Run } from "../server/runtime-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { agentKey } from "./agent-queries.ts";
import { IN_FLIGHT_REFRESH_MS } from "./refresh.ts";
import { fields, requireIds } from "./server-input.ts";

/** More deployment IDs than any agent has; bounds the fan-out one call can request. */
const MAX_DEPLOYMENTS = 500;
const MAX_CURSOR_LENGTH = 4_096;
/** Page reads per "Load more"; filtered deployments can return many short pages. */
const MAX_RUN_ROUNDS = 5;
const ENVIRONMENT_LIST_STALE_MS = 60_000;

function deploymentIdList(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > MAX_DEPLOYMENTS) {
    throw new TypeError(`deploymentIds must be an array of at most ${MAX_DEPLOYMENTS} ULIDs.`);
  }
  return input.map((value) => requireIds({ value }, ["value"]).value);
}

function runRequests(input: unknown): RunStreamRequest[] {
  if (!Array.isArray(input) || input.length > MAX_DEPLOYMENTS) {
    throw new TypeError(`requests must be an array of at most ${MAX_DEPLOYMENTS} entries.`);
  }
  return input.map((entry) => {
    const { cursor } = fields(entry);
    if (
      cursor !== undefined &&
      (typeof cursor !== "string" || cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH)
    ) {
      throw new TypeError("cursor must be a non-empty string of at most 4096 characters.");
    }
    return { cursor, deploymentId: requireIds(entry, ["deploymentId"]).deploymentId };
  });
}

/**
 * POST despite being a read: the payload carries one opaque cursor per deployment, which can
 * outgrow a query string for agents with many deployments.
 */
const fetchRunPages = createServerFn({ method: "POST" })
  .validator(
    (input: {
      readonly filters: RunFilters;
      readonly requests: readonly RunStreamRequest[];
      readonly scope: EnvironmentScope;
    }) => {
      const value = fields(input);
      return {
        filters: parseRunFilters(fields(value.filters)),
        requests: runRequests(value.requests),
        scope: requireIds(value.scope, SCOPE_FIELDS),
      };
    },
  )
  .handler(async ({ data }) =>
    loadRunPages(await requireAccessToken(), data.scope, data.requests, data.filters),
  );

const deploymentsInput = (input: unknown) => {
  const value = fields(input);
  return {
    deploymentIds: deploymentIdList(value.deploymentIds),
    scope: requireIds(value.scope, SCOPE_FIELDS),
  };
};

const fetchToolEvaluations = createServerFn({ method: "GET" })
  .validator(
    (input: { readonly deploymentIds: readonly string[]; readonly scope: EnvironmentScope }) =>
      deploymentsInput(input),
  )
  .handler(async ({ data }) =>
    loadToolEvaluations(await requireAccessToken(), data.scope, data.deploymentIds),
  );

const fetchConnectionGrants = createServerFn({ method: "GET" })
  .validator((input: EnvironmentScope) => requireIds(input, SCOPE_FIELDS))
  .handler(async ({ data }) => loadConnectionGrants(await requireAccessToken(), data));

const fetchChannelBindings = createServerFn({ method: "GET" })
  .validator(
    (input: {
      readonly definitionId: string;
      readonly deploymentIds: readonly string[];
      readonly scope: EnvironmentScope;
    }) => ({ ...deploymentsInput(input), ...requireIds(input, ["definitionId"]) }),
  )
  .handler(async ({ data }) =>
    loadAgentChannels(
      await requireAccessToken(),
      data.scope,
      data.definitionId,
      data.deploymentIds,
    ),
  );

const fetchChannelDelivery = createServerFn({ method: "GET" })
  .validator(
    (input: {
      readonly deliveryId: string;
      readonly runId: string;
      readonly scope: EnvironmentScope;
    }) => ({
      ...requireIds(input, ["deliveryId", "runId"]),
      scope: requireIds(fields(input).scope, SCOPE_FIELDS),
    }),
  )
  .handler(async ({ data }) =>
    loadChannelDelivery(await requireAccessToken(), data.scope, data.runId, data.deliveryId),
  );

const fetchEmailRoutes = createServerFn({ method: "GET" })
  .validator(
    (input: { readonly deploymentIds: readonly string[]; readonly scope: EnvironmentScope }) =>
      deploymentsInput(input),
  )
  .handler(async ({ data }) =>
    loadAgentEmailRoutes(await requireAccessToken(), data.scope, data.deploymentIds),
  );

/**
 * The agent's runs: every deployment's `GET /v1/runs` stream merged in index order (see
 * `run-merge.ts`). The merge state, including runs read but not yet shown, is the next page's
 * parameter. Cursors are not refetched page by page, so the list never refetches on its own;
 * refreshing resets it.
 */
export const agentRunPagesQuery = (
  scope: EnvironmentScope,
  definitionId: string,
  deploymentIds: readonly string[],
  filters: RunFilters,
) =>
  infiniteQueryOptions({
    // `queryFn` precedes `getNextPageParam` so the page type is inferred from it.
    queryFn: async ({ pageParam }) => {
      let state: RunMergeState<Run> = pageParam;
      const runs: Run[] = [];
      for (let round = 0; ; round += 1) {
        const drained = drainRuns(state, RUN_PAGE_SIZE - runs.length);
        runs.push(...drained.runs);
        state = drained.state;
        if (runs.length >= RUN_PAGE_SIZE || isMergeDone(state) || round === MAX_RUN_ROUNDS) break;
        const pages = await fetchRunPages({
          data: { filters, requests: pendingRequests(state), scope },
        });
        state = absorbPages(state, pages);
      }
      return { next: isMergeDone(state) ? undefined : state, runs };
    },
    getNextPageParam: (page) => page.next,
    initialPageParam: initialRunMerge<Run>(deploymentIds),
    queryKey: [...agentKey(scope, definitionId), "runs", deploymentIds, filters],
    staleTime: Number.POSITIVE_INFINITY,
  });

export const toolEvaluationsQuery = (
  scope: EnvironmentScope,
  definitionId: string,
  deploymentIds: readonly string[],
) =>
  queryOptions({
    queryFn: () => fetchToolEvaluations({ data: { deploymentIds, scope } }),
    queryKey: [...agentKey(scope, definitionId), "tool-evaluations", deploymentIds],
  });

export const connectionGrantsQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchConnectionGrants({ data: scope }),
    queryKey: ["connection-grants", ...scopeKey(scope)],
    staleTime: ENVIRONMENT_LIST_STALE_MS,
  });

export const agentChannelsQuery = (
  scope: EnvironmentScope,
  definitionId: string,
  deploymentIds: readonly string[],
) =>
  queryOptions({
    queryFn: () => fetchChannelBindings({ data: { definitionId, deploymentIds, scope } }),
    queryKey: [...agentKey(scope, definitionId), "channels", deploymentIds],
  });

/** A delivery's current attempts and error; refreshes while the provider has not answered. */
export const channelDeliveryQuery = (scope: EnvironmentScope, runId: string, deliveryId: string) =>
  queryOptions({
    queryFn: () => fetchChannelDelivery({ data: { deliveryId, runId, scope } }),
    queryKey: ["channel-delivery", ...scopeKey(scope), runId, deliveryId],
    refetchInterval: (query) =>
      query.state.data?.status === "queued" || query.state.data?.status === "sending"
        ? IN_FLIGHT_REFRESH_MS
        : false,
  });

export const agentEmailRoutesQuery = (
  scope: EnvironmentScope,
  definitionId: string,
  deploymentIds: readonly string[],
) =>
  queryOptions({
    queryFn: () => fetchEmailRoutes({ data: { deploymentIds, scope } }),
    queryKey: [...agentKey(scope, definitionId), "email-routes", deploymentIds],
  });
