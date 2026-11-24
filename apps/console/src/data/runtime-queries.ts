import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import {
  parseApprovalFilters,
  parseRunFeedFilters,
  type ApprovalFilters,
  type RunFeedFilters,
} from "../runs/filters.ts";
import { isRunInFlight } from "../runs/run-state.ts";
import { scopeKey, type EnvironmentScope } from "../scope.ts";
import {
  loadApprovalPage,
  loadAutomationLabel,
  loadRunDetail,
  loadRunFeedPage,
  loadRunOutput,
  loadRunPage,
  loadThread,
  loadTranscriptPage,
  lookupRuntimeId,
  type AutomationRef,
  type Run,
} from "../server/runtime-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { pendingApprovalsQuery } from "./overview-queries.ts";
import { IN_FLIGHT_REFRESH_MS, STATUS_REFRESH_MS } from "./refresh.ts";
import {
  fields,
  pageInput,
  scopedInput,
  type PageInput,
  type ScopedInput,
} from "./server-input.ts";

const fetchRunFeedPage = createServerFn({ method: "GET" })
  .validator((input: PageInput & { readonly filters: RunFeedFilters }) => ({
    ...pageInput(input),
    filters: parseRunFeedFilters(fields(fields(input).filters)),
  }))
  .handler(async ({ data }) =>
    loadRunFeedPage(await requireAccessToken(), data.scope, data.filters, data.cursor),
  );

const fetchThreadRunPage = createServerFn({ method: "GET" })
  .validator((input: PageInput & { readonly threadId: string }) => pageInput(input, ["threadId"]))
  .handler(async ({ data }) =>
    loadRunPage(await requireAccessToken(), data.scope, { threadId: data.threadId }, data.cursor),
  );

const fetchRunDetail = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly runId: string }) => scopedInput(input, ["runId"]))
  .handler(async ({ data }) => loadRunDetail(await requireAccessToken(), data.scope, data.runId));

const fetchRunOutput = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly runId: string; readonly threadId: string }) =>
    scopedInput(input, ["runId", "threadId"]),
  )
  .handler(async ({ data }) =>
    loadRunOutput(await requireAccessToken(), data.scope, data.threadId, data.runId),
  );

const fetchAutomationLabel = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & AutomationRef): ScopedInput & AutomationRef => {
    const { kind } = fields(input);
    if (kind !== "heartbeat" && kind !== "schedule") {
      throw new TypeError("kind must be heartbeat or schedule.");
    }
    return { ...scopedInput(input, ["id"]), kind };
  })
  .handler(async ({ data }) =>
    loadAutomationLabel(await requireAccessToken(), data.scope, { id: data.id, kind: data.kind }),
  );

const fetchApprovalPage = createServerFn({ method: "GET" })
  .validator((input: PageInput & { readonly filters: ApprovalFilters }) => ({
    ...pageInput(input),
    filters: parseApprovalFilters(fields(fields(input).filters)),
  }))
  .handler(async ({ data }) =>
    loadApprovalPage(await requireAccessToken(), data.scope, data.filters, data.cursor),
  );

const fetchThread = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly threadId: string }) =>
    scopedInput(input, ["threadId"]),
  )
  .handler(async ({ data }) => loadThread(await requireAccessToken(), data.scope, data.threadId));

const fetchTranscriptPage = createServerFn({ method: "GET" })
  .validator((input: PageInput & { readonly threadId: string }) => pageInput(input, ["threadId"]))
  .handler(async ({ data }) =>
    loadTranscriptPage(await requireAccessToken(), data.scope, data.threadId, data.cursor),
  );

const fetchRuntimeLookup = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly id: string }) => scopedInput(input, ["id"]))
  .handler(async ({ data }) => lookupRuntimeId(await requireAccessToken(), data.scope, data.id));

const runtimeKey = (scope: EnvironmentScope) => ["runtime", ...scopeKey(scope)] as const;

export function invalidateRuntime(queryClient: QueryClient, scope: EnvironmentScope) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: runtimeKey(scope) }),
    queryClient.invalidateQueries({ queryKey: pendingApprovalsQuery(scope).queryKey }),
  ]);
}

const cursorField = (cursor: string | undefined) => (cursor === undefined ? {} : { cursor });

export const runFeedPagesQuery = (scope: EnvironmentScope, filters: RunFeedFilters) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchRunFeedPage({ data: { filters, scope, ...cursorField(pageParam) } }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...runtimeKey(scope), "runs", filters],
  });

/** The thread page's runs. Its table shows the plain trigger, so no automation labels are read. */
export const threadRunPagesQuery = (scope: EnvironmentScope, threadId: string) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchThreadRunPage({ data: { scope, threadId, ...cursorField(pageParam) } }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...runtimeKey(scope), "thread", threadId, "runs"],
  });

export const runDetailQuery = (scope: EnvironmentScope, runId: string) =>
  queryOptions({
    queryFn: () => fetchRunDetail({ data: { runId, scope } }),
    queryKey: [...runtimeKey(scope), "run", runId],
    refetchInterval: (query) =>
      query.state.data && isRunInFlight(query.state.data.run.status) ? IN_FLIGHT_REFRESH_MS : false,
  });

/** A completed run's final message; `null` while the API cannot serve one. */
export const runOutputQuery = (scope: EnvironmentScope, run: Pick<Run, "id" | "threadId">) =>
  queryOptions({
    queryFn: () => fetchRunOutput({ data: { runId: run.id, scope, threadId: run.threadId } }),
    queryKey: [...runtimeKey(scope), "run", run.id, "output"],
  });

/** The label of the automation a run came from; `null` when the caller cannot read it. */
export const automationLabelQuery = (scope: EnvironmentScope, automation: AutomationRef) =>
  queryOptions({
    queryFn: () =>
      fetchAutomationLabel({ data: { id: automation.id, kind: automation.kind, scope } }),
    queryKey: [...runtimeKey(scope), "automation-label", automation.kind, automation.id],
  });

export const approvalPagesQuery = (scope: EnvironmentScope, filters: ApprovalFilters) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchApprovalPage({ data: { filters, scope, ...cursorField(pageParam) } }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...runtimeKey(scope), "approvals", filters.status ?? "pending"],
    refetchInterval: filters.status === undefined ? STATUS_REFRESH_MS : false,
  });

export const threadQuery = (scope: EnvironmentScope, threadId: string) =>
  queryOptions({
    queryFn: () => fetchThread({ data: { scope, threadId } }),
    queryKey: [...runtimeKey(scope), "thread", threadId],
  });

export const transcriptPagesQuery = (scope: EnvironmentScope, threadId: string) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchTranscriptPage({ data: { scope, threadId, ...cursorField(pageParam) } }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...runtimeKey(scope), "thread", threadId, "messages"],
  });

export const runtimeLookupQuery = (scope: EnvironmentScope, id: string) =>
  queryOptions({
    queryFn: () => fetchRuntimeLookup({ data: { id, scope } }),
    queryKey: [...runtimeKey(scope), "lookup", id],
  });
