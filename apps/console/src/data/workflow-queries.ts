import type { WorkflowExecutionSummaryResponse } from "@deployments-ai/api-contract";
import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { scopeKey, type EnvironmentScope } from "../scope.ts";
import type { Page } from "../server/list-pages.ts";
import { requireAccessToken } from "../server/session.ts";
import {
  loadApproval,
  loadApprovalQueue,
  loadDefinition,
  loadDefinitionPage,
  loadExecutionDetail,
  loadExecutionPage,
  loadRelatedExecutions,
  loadRelease,
  loadReleasePage,
  type ExecutionDetail,
} from "../server/workflow-data.ts";
import {
  EXECUTION_PHASE,
  parseDefinitionFilters,
  parseExecutionFilters,
  type ApprovalTarget,
  type DefinitionFilters,
  type ExecutionFilters,
} from "../workflows/model.ts";
import { IN_FLIGHT_REFRESH_MS, STATUS_REFRESH_MS } from "./refresh.ts";
import {
  fields,
  pageInput,
  scopedInput,
  type PageInput,
  type ScopedInput,
} from "./server-input.ts";

const fetchDefinitionPage = createServerFn({ method: "GET" })
  .validator((input: PageInput & { readonly filters: DefinitionFilters }) => ({
    ...pageInput(input),
    filters: parseDefinitionFilters(fields(fields(input).filters)),
  }))
  .handler(async ({ data }) =>
    loadDefinitionPage(await requireAccessToken(), data.scope, data.filters, data.cursor),
  );

const fetchDefinition = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly definitionId: string }) =>
    scopedInput(input, ["definitionId"]),
  )
  .handler(async ({ data }) =>
    loadDefinition(await requireAccessToken(), data.scope, data.definitionId),
  );

const fetchReleasePage = createServerFn({ method: "GET" })
  .validator((input: PageInput & { readonly definitionId: string }) =>
    pageInput(input, ["definitionId"]),
  )
  .handler(async ({ data }) =>
    loadReleasePage(await requireAccessToken(), data.scope, data.definitionId, data.cursor),
  );

const fetchRelease = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly releaseId: string }) =>
    scopedInput(input, ["releaseId"]),
  )
  .handler(async ({ data }) => loadRelease(await requireAccessToken(), data.scope, data.releaseId));

const fetchExecutionPage = createServerFn({ method: "GET" })
  .validator((input: PageInput & { readonly filters: ExecutionFilters }) => ({
    ...pageInput(input),
    filters: parseExecutionFilters(fields(fields(input).filters)),
  }))
  .handler(async ({ data }) =>
    loadExecutionPage(await requireAccessToken(), data.scope, data.filters, data.cursor),
  );

const fetchRelatedExecutions = createServerFn({ method: "GET" })
  .validator(
    (input: ScopedInput & ({ readonly definitionId: string } | { readonly releaseId: string })) =>
      "releaseId" in fields(input)
        ? scopedInput(input, ["releaseId"])
        : scopedInput(input, ["definitionId"]),
  )
  .handler(async ({ data }) => {
    const { scope, ...related } = data;
    return loadRelatedExecutions(await requireAccessToken(), scope, related);
  });

const fetchExecutionDetail = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly executionId: string }) =>
    scopedInput(input, ["executionId"]),
  )
  .handler(async ({ data }) =>
    loadExecutionDetail(await requireAccessToken(), data.scope, data.executionId),
  );

const fetchApprovalQueue = createServerFn({ method: "GET" })
  .validator((input: ScopedInput) => scopedInput(input))
  .handler(async ({ data }) => loadApprovalQueue(await requireAccessToken(), data.scope));

const fetchApproval = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & ApprovalTarget) =>
    scopedInput(input, ["approvalId", "executionId"]),
  )
  .handler(async ({ data }) => {
    const { scope, ...target } = data;
    return loadApproval(await requireAccessToken(), scope, target);
  });

const workflowsKey = (scope: EnvironmentScope) => ["workflows", ...scopeKey(scope)] as const;

export function invalidateWorkflows(queryClient: QueryClient, scope: EnvironmentScope) {
  return queryClient.invalidateQueries({ queryKey: workflowsKey(scope) });
}

const APPROVAL_QUEUE = "approval-queue";

export const approvalQueueQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchApprovalQueue({ data: { scope } }),
    queryKey: [...workflowsKey(scope), APPROVAL_QUEUE],
    refetchInterval: STATUS_REFRESH_MS,
  });

export async function settleApproval(
  queryClient: QueryClient,
  scope: EnvironmentScope,
  approvalId: string,
) {
  const { queryKey } = approvalQueueQuery(scope);
  await queryClient.cancelQueries({ exact: true, queryKey });
  queryClient.setQueryData(
    queryKey,
    (queue) =>
      queue && { ...queue, items: queue.items.filter((item) => item.approvalId !== approvalId) },
  );
  return queryClient.invalidateQueries({
    predicate: ({ queryKey: key }) => key.at(-1) !== APPROVAL_QUEUE,
    queryKey: workflowsKey(scope),
  });
}

export const approvalQuery = (scope: EnvironmentScope, approval: ApprovalTarget) =>
  queryOptions({
    gcTime: 0,
    queryFn: () => fetchApproval({ data: { ...approval, scope } }),
    queryKey: ["workflow-approval", ...scopeKey(scope), approval.approvalId],
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 0,
  });

const cursorField = (cursor: string | undefined) => (cursor === undefined ? {} : { cursor });

const unfinished = (execution: { readonly status: WorkflowExecutionSummaryResponse["status"] }) =>
  EXECUTION_PHASE[execution.status] !== "terminal";

export const executionListRefreshMs = (
  pages: readonly Page<WorkflowExecutionSummaryResponse>[] | undefined,
) => (pages?.some((page) => page.items.some(unfinished)) ? STATUS_REFRESH_MS : false);

export const executionDetailRefreshMs = (detail: ExecutionDetail | undefined) =>
  detail && unfinished(detail.execution) ? IN_FLIGHT_REFRESH_MS : false;

export const definitionPagesQuery = (scope: EnvironmentScope, filters: DefinitionFilters) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchDefinitionPage({ data: { filters, scope, ...cursorField(pageParam) } }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...workflowsKey(scope), "definitions", filters.status ?? "active"],
  });

export const definitionQuery = (scope: EnvironmentScope, definitionId: string) =>
  queryOptions({
    queryFn: () => fetchDefinition({ data: { definitionId, scope } }),
    queryKey: [...workflowsKey(scope), "definition", definitionId],
  });

export const releasePagesQuery = (scope: EnvironmentScope, definitionId: string) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchReleasePage({ data: { definitionId, scope, ...cursorField(pageParam) } }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...workflowsKey(scope), "definition", definitionId, "releases"],
  });

export const releaseQuery = (scope: EnvironmentScope, releaseId: string) =>
  queryOptions({
    queryFn: () => fetchRelease({ data: { releaseId, scope } }),
    queryKey: [...workflowsKey(scope), "release", releaseId],
  });

export const executionPagesQuery = (scope: EnvironmentScope, filters: ExecutionFilters) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchExecutionPage({ data: { filters, scope, ...cursorField(pageParam) } }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...workflowsKey(scope), "executions", filters.status ?? "all"],
    refetchInterval: (query) => executionListRefreshMs(query.state.data?.pages),
  });

export const relatedExecutionsQuery = (
  scope: EnvironmentScope,
  related: { readonly definitionId: string } | { readonly releaseId: string },
) =>
  queryOptions({
    queryFn: () => fetchRelatedExecutions({ data: { scope, ...related } }),
    queryKey: [...workflowsKey(scope), "related-executions", related],
  });

export const executionDetailQuery = (scope: EnvironmentScope, executionId: string) =>
  queryOptions({
    queryFn: () => fetchExecutionDetail({ data: { executionId, scope } }),
    queryKey: [...workflowsKey(scope), "execution", executionId],
    refetchInterval: (query) => executionDetailRefreshMs(query.state.data),
  });
