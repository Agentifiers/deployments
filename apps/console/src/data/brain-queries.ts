import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { erasureInFlight } from "../brains/erasure.ts";
import {
  getBrainDocument,
  getBrainEntity,
  getBrainErasure,
  getBrainView,
  listBrainGrants,
  listBrainIndexHealth,
  listBrainMounts,
  listBrainReviewItems,
  listBrains,
  listBrainSources,
} from "../server/brain-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { IN_FLIGHT_REFRESH_MS } from "./refresh.ts";
import { pageInputAt, requireIds, type PageInputAt } from "./server-input.ts";

interface BrainInput extends PageInputAt<"organization"> {
  readonly brainId: string;
}

const brainInput = (input: BrainInput) => ({
  ...pageInputAt("organization", input),
  ...requireIds(input, ["brainId"]),
});

const fetchBrains = createServerFn({ method: "GET" })
  .validator((input: PageInputAt<"organization">) => pageInputAt("organization", input))
  .handler(async ({ data }) =>
    listBrains(await requireAccessToken(), data.scope.organizationId, data.cursor),
  );

const fetchBrainView = createServerFn({ method: "GET" })
  .validator(brainInput)
  .handler(async ({ data }) =>
    getBrainView(await requireAccessToken(), data.scope.organizationId, data.brainId),
  );

const fetchBrainSources = createServerFn({ method: "GET" })
  .validator(brainInput)
  .handler(async ({ data }) =>
    listBrainSources(
      await requireAccessToken(),
      data.scope.organizationId,
      data.brainId,
      data.cursor,
    ),
  );

const fetchBrainGrants = createServerFn({ method: "GET" })
  .validator(brainInput)
  .handler(async ({ data }) =>
    listBrainGrants(await requireAccessToken(), data.scope.organizationId, data.brainId),
  );

const fetchBrainMounts = createServerFn({ method: "GET" })
  .validator(brainInput)
  .handler(async ({ data }) =>
    listBrainMounts(await requireAccessToken(), data.scope.organizationId, data.brainId),
  );

const fetchBrainIndexHealth = createServerFn({ method: "GET" })
  .validator(brainInput)
  .handler(async ({ data }) =>
    listBrainIndexHealth(
      await requireAccessToken(),
      data.scope.organizationId,
      data.brainId,
      data.cursor,
    ),
  );

const fetchBrainReviewItems = createServerFn({ method: "GET" })
  .validator(brainInput)
  .handler(async ({ data }) =>
    listBrainReviewItems(
      await requireAccessToken(),
      data.scope.organizationId,
      data.brainId,
      data.cursor,
    ),
  );

const fetchBrainDocument = createServerFn({ method: "GET" })
  .validator((input: BrainInput & { readonly documentId: string }) => ({
    ...brainInput(input),
    ...requireIds(input, ["documentId"]),
  }))
  .handler(async ({ data }) =>
    getBrainDocument(
      await requireAccessToken(),
      data.scope.organizationId,
      data.brainId,
      data.documentId,
    ),
  );

const fetchBrainEntity = createServerFn({ method: "GET" })
  .validator((input: BrainInput & { readonly entityId: string }) => ({
    ...brainInput(input),
    ...requireIds(input, ["entityId"]),
  }))
  .handler(async ({ data }) =>
    getBrainEntity(
      await requireAccessToken(),
      data.scope.organizationId,
      data.brainId,
      data.entityId,
    ),
  );

const fetchBrainErasure = createServerFn({ method: "GET" })
  .validator((input: BrainInput & { readonly erasureId: string }) => ({
    ...brainInput(input),
    ...requireIds(input, ["erasureId"]),
  }))
  .handler(async ({ data }) =>
    getBrainErasure(
      await requireAccessToken(),
      data.scope.organizationId,
      data.brainId,
      data.erasureId,
    ),
  );

const brainsKey = (organizationId: string) => ["brains", organizationId] as const;
const brainKey = (organizationId: string, brainId: string) =>
  [...brainsKey(organizationId), "brain", brainId] as const;

export function invalidateBrains(queryClient: QueryClient, organizationId: string) {
  return queryClient.invalidateQueries({ queryKey: brainsKey(organizationId) });
}

export function invalidateBrain(queryClient: QueryClient, organizationId: string, brainId: string) {
  return queryClient.invalidateQueries({ queryKey: brainKey(organizationId, brainId) });
}

/** An archived Brain's reads all fail, so its cached queries are dropped rather than refetched. */
export function forgetArchivedBrain(
  queryClient: QueryClient,
  organizationId: string,
  brainId: string,
) {
  queryClient.removeQueries({ queryKey: brainKey(organizationId, brainId) });
  return invalidateBrains(queryClient, organizationId);
}

export const brainListQuery = (organizationId: string) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchBrains({
        data: {
          scope: { organizationId },
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...brainsKey(organizationId), "list"],
  });

export const brainViewQuery = (organizationId: string, brainId: string) =>
  queryOptions({
    queryFn: () => fetchBrainView({ data: { brainId, scope: { organizationId } } }),
    queryKey: [...brainKey(organizationId, brainId), "view"],
  });

export const brainSourcesQuery = (organizationId: string, brainId: string) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchBrainSources({
        data: {
          brainId,
          scope: { organizationId },
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...brainKey(organizationId, brainId), "sources"],
  });

export const brainGrantsQuery = (organizationId: string, brainId: string) =>
  queryOptions({
    queryFn: () => fetchBrainGrants({ data: { brainId, scope: { organizationId } } }),
    queryKey: [...brainKey(organizationId, brainId), "grants"],
  });

export const brainMountsQuery = (organizationId: string, brainId: string) =>
  queryOptions({
    queryFn: () => fetchBrainMounts({ data: { brainId, scope: { organizationId } } }),
    queryKey: [...brainKey(organizationId, brainId), "mounts"],
  });

export const brainIndexHealthQuery = (organizationId: string, brainId: string) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchBrainIndexHealth({
        data: {
          brainId,
          scope: { organizationId },
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...brainKey(organizationId, brainId), "index-health"],
  });

export const brainReviewQuery = (organizationId: string, brainId: string) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchBrainReviewItems({
        data: {
          brainId,
          scope: { organizationId },
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...brainKey(organizationId, brainId), "review"],
  });

export const brainDocumentQuery = (organizationId: string, brainId: string, documentId: string) =>
  queryOptions({
    queryFn: () => fetchBrainDocument({ data: { brainId, documentId, scope: { organizationId } } }),
    queryKey: [...brainKey(organizationId, brainId), "document", documentId],
  });

export const brainEntityQuery = (organizationId: string, brainId: string, entityId: string) =>
  queryOptions({
    queryFn: () => fetchBrainEntity({ data: { brainId, entityId, scope: { organizationId } } }),
    queryKey: [...brainKey(organizationId, brainId), "entity", entityId],
  });

export const brainErasureQuery = (organizationId: string, brainId: string, erasureId: string) =>
  queryOptions({
    queryFn: () => fetchBrainErasure({ data: { brainId, erasureId, scope: { organizationId } } }),
    queryKey: [...brainsKey(organizationId), "erasure", brainId, erasureId],
    refetchInterval: (query) => (erasureInFlight(query.state.data) ? IN_FLIGHT_REFRESH_MS : false),
  });
