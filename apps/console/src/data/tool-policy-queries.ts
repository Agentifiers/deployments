import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { oneOf } from "../observability/range.ts";
import { scopeKey, type EnvironmentScope } from "../scope.ts";
import { requireAccessToken } from "../server/session.ts";
import { loadTool, loadToolPage } from "../server/tool-catalog-data.ts";
import {
  loadPolicy,
  loadPolicyOptions,
  loadPolicyPage,
  loadPolicyPins,
  loadSimulation,
} from "../server/tool-policy-data.ts";
import {
  catalogFilters,
  parseCatalogSearch,
  type CatalogSearch,
} from "../tool-policies/catalog-state.ts";
import { POLICY_VIEWS, type PolicyView } from "../tool-policies/policy-state.ts";
import {
  parseSimulationSearch,
  simulationInput,
  type SimulationSearch,
} from "../tool-policies/simulator-state.ts";
import {
  fields,
  pageInput,
  scopedInput,
  type PageInput,
  type ScopedInput,
} from "./server-input.ts";

const MAX_TOOL_NAME_LENGTH = 128;

const fetchPolicyPage = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly offset: number; readonly view: PolicyView }) => {
    const { offset, view } = fields(input);
    const known = oneOf(POLICY_VIEWS, view);
    if (known === undefined) throw new TypeError(`view must be one of ${POLICY_VIEWS.join(", ")}.`);
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError("offset must be a non-negative integer.");
    }
    return { ...scopedInput(input), offset, view: known };
  })
  .handler(async ({ data }) =>
    loadPolicyPage(await requireAccessToken(), data.scope, data.view, data.offset),
  );

const fetchPolicyOptions = createServerFn({ method: "GET" })
  .validator((input: ScopedInput) => scopedInput(input))
  .handler(async ({ data }) => loadPolicyOptions(await requireAccessToken(), data.scope));

const fetchPolicy = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly policyId: string }) =>
    scopedInput(input, ["policyId"]),
  )
  .handler(async ({ data }) => loadPolicy(await requireAccessToken(), data.scope, data.policyId));

const fetchPolicyPins = createServerFn({ method: "GET" })
  .validator((input: ScopedInput) => scopedInput(input))
  .handler(async ({ data }) => loadPolicyPins(await requireAccessToken(), data.scope));

/** POST despite being a read: up to 100 tool names can outgrow a query string. */
const fetchSimulation = createServerFn({ method: "POST" })
  .validator((input: ScopedInput & { readonly search: SimulationSearch }) => {
    const simulation = simulationInput(parseSimulationSearch(fields(fields(input).search)));
    if (simulation === undefined) {
      throw new TypeError("search must name a policy and tools, or a deployment.");
    }
    return { ...scopedInput(input), simulation };
  })
  .handler(async ({ data }) =>
    loadSimulation(await requireAccessToken(), data.scope, data.simulation),
  );

const fetchToolPage = createServerFn({ method: "GET" })
  .validator((input: PageInput & { readonly search: CatalogSearch }) => ({
    ...pageInput(input),
    filters: catalogFilters(parseCatalogSearch(fields(fields(input).search))),
  }))
  .handler(async ({ data }) =>
    loadToolPage(await requireAccessToken(), data.scope, data.filters, data.cursor),
  );

const fetchTool = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly toolName: string }) => {
    const { toolName } = fields(input);
    if (
      typeof toolName !== "string" ||
      toolName.length === 0 ||
      toolName.length > MAX_TOOL_NAME_LENGTH
    ) {
      throw new TypeError("toolName must be a non-empty string of at most 128 characters.");
    }
    return { ...scopedInput(input), toolName };
  })
  .handler(async ({ data }) => loadTool(await requireAccessToken(), data.scope, data.toolName));

const toolPoliciesKey = (scope: EnvironmentScope) => ["tool-policies", ...scopeKey(scope)] as const;

export function invalidateToolPolicies(queryClient: QueryClient, scope: EnvironmentScope) {
  return queryClient.invalidateQueries({ queryKey: toolPoliciesKey(scope) });
}

export const policyPagesQuery = (scope: EnvironmentScope, view: PolicyView) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) => fetchPolicyPage({ data: { offset: pageParam, scope, view } }),
    getNextPageParam: (page) => page.nextOffset,
    initialPageParam: 0,
    queryKey: [...toolPoliciesKey(scope), "list", view],
  });

export const policyOptionsQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchPolicyOptions({ data: { scope } }),
    queryKey: [...toolPoliciesKey(scope), "options"],
  });

export const policyQuery = (scope: EnvironmentScope, policyId: string) =>
  queryOptions({
    queryFn: () => fetchPolicy({ data: { policyId, scope } }),
    queryKey: [...toolPoliciesKey(scope), "policy", policyId],
  });

/** Keyed under the `agents` prefix, which agent mutations invalidate. */
export const policyPinsQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchPolicyPins({ data: { scope } }),
    queryKey: ["agents", ...scopeKey(scope), "tool-policy-pins"],
  });

export const simulationQuery = (scope: EnvironmentScope, search: SimulationSearch) =>
  queryOptions({
    queryFn: () => fetchSimulation({ data: { scope, search } }),
    queryKey: [...toolPoliciesKey(scope), "simulation", search],
  });

export const toolPagesQuery = (
  scope: EnvironmentScope,
  { tool: _tool, ...search }: CatalogSearch,
) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchToolPage({
        data: { scope, search, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: ["tool-catalog", ...scopeKey(scope), "list", search],
  });

export const toolQuery = (scope: EnvironmentScope, toolName: string) =>
  queryOptions({
    meta: { dehydrate: false },
    queryFn: () => fetchTool({ data: { scope, toolName } }),
    queryKey: ["tool-catalog", ...scopeKey(scope), "tool", toolName],
  });
