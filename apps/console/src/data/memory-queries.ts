import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import {
  GRANT_FILTERS,
  MEMORY_STATUSES,
  QUALITY_WINDOWS,
  type GrantFilter,
  type MemoryStatus,
  type QualityWindow,
} from "../memory/model.ts";
import { oneOf } from "../observability/range.ts";
import { scopeKey, type EnvironmentScope } from "../scope.ts";
import {
  getQuality,
  getSpace,
  listActiveSpaces,
  listGrants,
  listPolicies,
  listReviewQueue,
  listSpaceMemories,
  listSpaces,
} from "../server/memory-data.ts";
import { requireAccessToken } from "../server/session.ts";
import {
  fields,
  pageInput,
  scopedInput,
  type PageInput,
  type ScopedInput,
} from "./server-input.ts";

const fetchSpacePage = createServerFn({ method: "GET" })
  .validator((input: PageInput) => pageInput(input))
  .handler(async ({ data }) => listSpaces(await requireAccessToken(), data.scope, data.cursor));

const fetchActiveSpaces = createServerFn({ method: "GET" })
  .validator((input: ScopedInput) => scopedInput(input))
  .handler(async ({ data }) => listActiveSpaces(await requireAccessToken(), data.scope));

const fetchSpace = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly memorySpaceId: string }) =>
    scopedInput(input, ["memorySpaceId"]),
  )
  .handler(async ({ data }) =>
    getSpace(await requireAccessToken(), data.scope, data.memorySpaceId),
  );

const fetchPolicies = createServerFn({ method: "GET" })
  .validator((input: ScopedInput) => scopedInput(input))
  .handler(async ({ data }) => listPolicies(await requireAccessToken(), data.scope));

const fetchGrantPage = createServerFn({ method: "GET" })
  .validator(
    (input: PageInput & { readonly memorySpaceId: string; readonly status: GrantFilter }) => {
      const status = oneOf(GRANT_FILTERS, fields(input).status);
      if (status === undefined)
        throw new TypeError(`status must be one of ${GRANT_FILTERS.join(", ")}.`);
      return { ...pageInput(input, ["memorySpaceId"]), status };
    },
  )
  .handler(async ({ data }) =>
    listGrants(
      await requireAccessToken(),
      data.scope,
      { memorySpaceId: data.memorySpaceId, status: data.status },
      data.cursor,
    ),
  );

const memoryKey = (scope: EnvironmentScope) => ["memory", ...scopeKey(scope)] as const;

export function invalidateMemory(queryClient: QueryClient, scope: EnvironmentScope) {
  return queryClient.invalidateQueries({ queryKey: memoryKey(scope) });
}

export const spacePagesQuery = (scope: EnvironmentScope) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchSpacePage({
        data: { scope, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...memoryKey(scope), "spaces"],
  });

export const activeSpacesQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchActiveSpaces({ data: { scope } }),
    queryKey: [...memoryKey(scope), "active-spaces"],
  });

export const spaceQuery = (scope: EnvironmentScope, memorySpaceId: string) =>
  queryOptions({
    queryFn: () => fetchSpace({ data: { memorySpaceId, scope } }),
    queryKey: [...memoryKey(scope), "space", memorySpaceId],
  });

export const policiesQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchPolicies({ data: { scope } }),
    queryKey: [...memoryKey(scope), "policies"],
  });

export const grantPagesQuery = (
  scope: EnvironmentScope,
  memorySpaceId: string,
  status: GrantFilter,
) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchGrantPage({
        data: {
          memorySpaceId,
          scope,
          status,
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...memoryKey(scope), "grants", memorySpaceId, status],
  });

const fetchMemoryPage = createServerFn({ method: "GET" })
  .validator(
    (input: PageInput & { readonly memorySpaceId: string; readonly status: MemoryStatus }) => {
      const status = oneOf(MEMORY_STATUSES, fields(input).status);
      if (status === undefined)
        throw new TypeError(`status must be one of ${MEMORY_STATUSES.join(", ")}.`);
      return { ...pageInput(input, ["memorySpaceId"]), status };
    },
  )
  .handler(async ({ data }) =>
    listSpaceMemories(
      await requireAccessToken(),
      data.scope,
      { memorySpaceId: data.memorySpaceId, status: data.status },
      data.cursor,
    ),
  );

const fetchReviewPage = createServerFn({ method: "GET" })
  .validator((input: PageInput) => pageInput(input))
  .handler(async ({ data }) =>
    listReviewQueue(await requireAccessToken(), data.scope, data.cursor),
  );

const fetchQuality = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly days: QualityWindow }) => {
    const days = QUALITY_WINDOWS.find((window) => window === fields(input).days);
    if (days === undefined)
      throw new TypeError(`days must be one of ${QUALITY_WINDOWS.join(", ")}.`);
    return { ...scopedInput(input), days };
  })
  .handler(async ({ data }) => getQuality(await requireAccessToken(), data.scope, data.days));

export const memoryPagesQuery = (
  scope: EnvironmentScope,
  memorySpaceId: string,
  status: MemoryStatus,
) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchMemoryPage({
        data: {
          memorySpaceId,
          scope,
          status,
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...memoryKey(scope), "memories", memorySpaceId, status],
  });

export const reviewPagesQuery = (scope: EnvironmentScope) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchReviewPage({
        data: { scope, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...memoryKey(scope), "review"],
  });

export const qualityQuery = (scope: EnvironmentScope, days: QualityWindow) =>
  queryOptions({
    queryFn: () => fetchQuality({ data: { days, scope } }),
    queryKey: [...memoryKey(scope), "quality", days],
  });
