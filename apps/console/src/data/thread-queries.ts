import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { parseArtifactFilters } from "../artifacts/filters.ts";
import { erasureSettled } from "../runs/erasure-state.ts";
import { parseThreadFilters, type ThreadFilters } from "../runs/thread-filters.ts";
import { scopeKey, type EnvironmentScope } from "../scope.ts";
import { loadArtifact, loadArtifactPage, type ArtifactOwner } from "../server/artifact-data.ts";
import { loadCallbackEvidence } from "../server/callback-evidence-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { loadEndUserErasure, loadThreadErasure, loadThreadPage } from "../server/thread-data.ts";
import { IN_FLIGHT_REFRESH_MS } from "./refresh.ts";
import {
  fields,
  pageInput,
  requireIds,
  scopedInput,
  type PageInput,
  type ScopedInput,
} from "./server-input.ts";

function artifactOwner(input: unknown): ArtifactOwner {
  const owner = fields(fields(input).owner);
  if (owner.kind === "run") return { kind: "run", ...requireIds(owner, ["runId"]) };
  if (owner.kind === "thread") return { kind: "thread", ...requireIds(owner, ["threadId"]) };
  if (owner.kind === "environment") {
    return { filters: parseArtifactFilters(fields(owner.filters)), kind: "environment" };
  }
  throw new TypeError("owner must name a run, a thread, or the environment.");
}

const fetchThreadPage = createServerFn({ method: "GET" })
  .validator((input: PageInput & { readonly filters: ThreadFilters }) => ({
    ...pageInput(input),
    filters: parseThreadFilters(fields(fields(input).filters)),
  }))
  .handler(async ({ data }) =>
    loadThreadPage(await requireAccessToken(), data.scope, data.filters, data.cursor),
  );

const fetchThreadErasure = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly erasureId: string; readonly threadId: string }) =>
    scopedInput(input, ["erasureId", "threadId"]),
  )
  .handler(async ({ data }) =>
    loadThreadErasure(await requireAccessToken(), data.scope, data.threadId, data.erasureId),
  );

const fetchEndUserErasure = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly erasureId: string }) =>
    scopedInput(input, ["erasureId"]),
  )
  .handler(async ({ data }) =>
    loadEndUserErasure(await requireAccessToken(), data.scope, data.erasureId),
  );

const fetchArtifactPage = createServerFn({ method: "GET" })
  .validator((input: PageInput & { readonly owner: ArtifactOwner }) => ({
    ...pageInput(input),
    owner: artifactOwner(input),
  }))
  .handler(async ({ data }) =>
    loadArtifactPage(await requireAccessToken(), data.scope, data.owner, data.cursor),
  );

const fetchArtifact = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly artifactId: string }) =>
    scopedInput(input, ["artifactId"]),
  )
  .handler(async ({ data }) =>
    loadArtifact(await requireAccessToken(), data.scope, data.artifactId),
  );

const fetchCallbackEvidence = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly toolCallId: string }) =>
    scopedInput(input, ["toolCallId"]),
  )
  .handler(async ({ data }) =>
    loadCallbackEvidence(await requireAccessToken(), data.scope, data.toolCallId),
  );

/** Shares the runtime prefix so `invalidateRuntime` refreshes threads, erasures, and artifacts. */
const runtimeKey = (scope: EnvironmentScope) => ["runtime", ...scopeKey(scope)] as const;
const cursorField = (cursor: string | undefined) => (cursor === undefined ? {} : { cursor });

export const threadPagesQuery = (scope: EnvironmentScope, filters: ThreadFilters) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchThreadPage({ data: { filters, scope, ...cursorField(pageParam) } }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...runtimeKey(scope), "threads", filters],
  });

export const threadErasureQuery = (scope: EnvironmentScope, threadId: string, erasureId: string) =>
  queryOptions({
    queryFn: () => fetchThreadErasure({ data: { erasureId, scope, threadId } }),
    queryKey: [...runtimeKey(scope), "thread-erasure", erasureId],
    refetchInterval: (query) =>
      query.state.data && !erasureSettled(query.state.data) ? IN_FLIGHT_REFRESH_MS : false,
  });

export const endUserErasureQuery = (scope: EnvironmentScope, erasureId: string) =>
  queryOptions({
    queryFn: () => fetchEndUserErasure({ data: { erasureId, scope } }),
    queryKey: [...runtimeKey(scope), "end-user-erasure", erasureId],
    refetchInterval: (query) =>
      query.state.data && !erasureSettled(query.state.data) ? IN_FLIGHT_REFRESH_MS : false,
  });

export const artifactPagesQuery = (scope: EnvironmentScope, owner: ArtifactOwner) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchArtifactPage({ data: { owner, scope, ...cursorField(pageParam) } }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...runtimeKey(scope), "artifacts", owner],
  });

/** Always read fresh: the retention form must send the artifact's current version. */
export const artifactQuery = (scope: EnvironmentScope, artifactId: string) =>
  queryOptions({
    gcTime: 0,
    queryFn: () => fetchArtifact({ data: { artifactId, scope } }),
    queryKey: [...runtimeKey(scope), "artifact", artifactId],
    staleTime: 0,
  });

export const callbackEvidenceQuery = (scope: EnvironmentScope, toolCallId: string) =>
  queryOptions({
    queryFn: () => fetchCallbackEvidence({ data: { scope, toolCallId } }),
    queryKey: [...runtimeKey(scope), "callback-evidence", toolCallId],
  });
