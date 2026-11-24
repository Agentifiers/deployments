import { infiniteQueryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { parseRunLogFilters, type RunLogFilters } from "../runs/run-logs.ts";
import { scopeKey, type EnvironmentScope } from "../scope.ts";
import { loadRunLogPage } from "../server/runtime-log-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { fields, pageInput, type PageInput } from "./server-input.ts";

export const fetchRunLogPageFn = createServerFn({ method: "GET" })
  .validator((input: PageInput & { readonly filters: RunLogFilters; readonly runId: string }) => ({
    ...pageInput(input, ["runId"]),
    filters: parseRunLogFilters(fields(fields(input).filters)),
  }))
  .handler(async ({ data }) =>
    loadRunLogPage(await requireAccessToken(), data.scope, data.runId, data.filters, data.cursor),
  );

/**
 * A run's runtime log, page by page. Lines never change once written, so loaded pages are never
 * refetched; `appendNewRunLogLines` adds what the run writes later. The key sits outside the
 * runtime key so run actions, which invalidate runtime reads, do not reread the whole log.
 */
export const runLogPagesQuery = (scope: EnvironmentScope, runId: string, filters: RunLogFilters) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchRunLogPageFn({
        data: { filters, runId, scope, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
      }),
    getNextPageParam: (page) => (page.caughtUp ? undefined : page.nextCursor),
    initialPageParam: undefined as string | undefined,
    queryKey: ["run-logs", ...scopeKey(scope), runId, filters],
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });

/**
 * Reads the lines written after the newest loaded one and appends them as a page. A read that
 * found nothing new is dropped, so following an idle run does not grow the page list.
 */
export async function appendNewRunLogLines(
  queryClient: QueryClient,
  scope: EnvironmentScope,
  runId: string,
  filters: RunLogFilters,
) {
  const { queryKey } = runLogPagesQuery(scope, runId, filters);
  const cursor = queryClient.getQueryData(queryKey)?.pages.at(-1)?.nextCursor;
  if (cursor === undefined) return;
  const page = await fetchRunLogPageFn({ data: { cursor, filters, runId, scope } });
  if (page.logs.length === 0 && page.caughtUp) return;
  queryClient.setQueryData(queryKey, (data) =>
    data && data.pages.at(-1)?.nextCursor === cursor
      ? { pageParams: [...data.pageParams, cursor], pages: [...data.pages, page] }
      : data,
  );
}
