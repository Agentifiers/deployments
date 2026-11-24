import {
  infiniteQueryOptions,
  queryOptions,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { CONNECTION_FILTERS, type ConnectionFilter } from "../connections/connection-state.ts";
import type { RebindSearch } from "../connections/rebind.ts";
import { PlatformApiError } from "../errors.ts";
import { oneOf } from "../observability/range.ts";
import { scopeKey, type EnvironmentScope } from "../scope.ts";
import {
  loadConnectionDetail,
  loadConnectionPage,
  loadConnectionVersion,
  loadPinningDeployments,
  loadRebindObservation,
  loadVerification,
  loadWorkspaces,
  type RebindRead,
} from "../server/connection-data.ts";
import { providerCatalog } from "../server/provider-catalog.ts";
import { requireAccessToken } from "../server/session.ts";
import { connectionGrantsQuery } from "./agent-runtime-queries.ts";
import { oauthAppsQuery } from "./oauth-app-queries.ts";
import { connectionProblemsQuery } from "./overview-queries.ts";
import { fields, requireIds, scopedInput, type ScopedInput } from "./server-input.ts";

const fetchConnectionPage = createServerFn({ method: "GET" })
  .validator(
    (input: ScopedInput & { readonly filter: ConnectionFilter; readonly offset: number }) => {
      const { filter, offset } = fields(input);
      const known = oneOf(CONNECTION_FILTERS, filter);
      if (known === undefined) {
        throw new TypeError(`filter must be one of ${CONNECTION_FILTERS.join(", ")}.`);
      }
      if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
        throw new TypeError("offset must be a non-negative integer.");
      }
      return { ...scopedInput(input), filter: known, offset };
    },
  )
  .handler(async ({ data }) =>
    loadConnectionPage(await requireAccessToken(), data.scope, data.filter, data.offset),
  );

const fetchConnectionDetail = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly connectionId: string }) =>
    scopedInput(input, ["connectionId"]),
  )
  .handler(async ({ data }) =>
    loadConnectionDetail(await requireAccessToken(), data.scope, data.connectionId),
  );

/**
 * The API reads a single connection consistently, so this sees every write that answered. The
 * rotate dialog calls it directly: `fetchQuery` could join a fetch in flight from before the refusal.
 */
export const fetchConnectionVersionFn = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly connectionId: string }) =>
    scopedInput(input, ["connectionId"]),
  )
  .handler(async ({ data }) =>
    loadConnectionVersion(await requireAccessToken(), data.scope, data.connectionId),
  );

const fetchVerification = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly verificationId: string }) =>
    scopedInput(input, ["verificationId"]),
  )
  .handler(async ({ data }) =>
    loadVerification(await requireAccessToken(), data.scope, data.verificationId),
  );

const fetchPinningDeployments = createServerFn({ method: "GET" })
  .validator((input: ScopedInput) => scopedInput(input))
  .handler(async ({ data }) => loadPinningDeployments(await requireAccessToken(), data.scope));

const fetchWorkspaces = createServerFn({ method: "GET" })
  .validator((input: ScopedInput) => scopedInput(input))
  .handler(async ({ data }) => loadWorkspaces(await requireAccessToken(), data.scope));

const fetchProviderCatalog = createServerFn({ method: "GET" }).handler(() => providerCatalog());

const REBIND_KINDS = ["rotate", "reauthorize"] as const;

function optionalId<const Field extends string>(input: unknown, name: Field) {
  return fields(input)[name] === undefined ? undefined : requireIds(input, [name])[name];
}

const fetchRebindObservation = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & RebindRead & { readonly connectionId: string }) => {
    const kind = oneOf(REBIND_KINDS, fields(input).kind);
    if (kind === undefined) throw new TypeError(`kind must be one of ${REBIND_KINDS.join(", ")}.`);
    return {
      ...scopedInput(input, ["connectionId"]),
      kind,
      targetId: optionalId(input, "targetId"),
      verificationId: optionalId(input, "verificationId"),
    };
  })
  .handler(async ({ data }) =>
    loadRebindObservation(await requireAccessToken(), data.scope, data.connectionId, data),
  );

const connectionsKey = (scope: EnvironmentScope) => ["connections", ...scopeKey(scope)] as const;

export const workspacesQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchWorkspaces({ data: { scope } }),
    queryKey: ["workspaces", ...scopeKey(scope)],
  });

/** The environment's deployments and their pins; agent mutations invalidate the `agents` prefix. */
export const pinningDeploymentsQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchPinningDeployments({ data: { scope } }),
    queryKey: ["agents", ...scopeKey(scope), "pinning-deployments"],
  });

/** Code-owned provider definitions; they change only with a console release. */
export const providerCatalogQuery = () =>
  queryOptions({
    queryFn: () => fetchProviderCatalog(),
    queryKey: ["provider-catalog"],
    staleTime: Number.POSITIVE_INFINITY,
  });

export const connectionPagesQuery = (scope: EnvironmentScope, filter: ConnectionFilter) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) => fetchConnectionPage({ data: { filter, offset: pageParam, scope } }),
    getNextPageParam: (page) => page.nextOffset,
    initialPageParam: 0,
    queryKey: [...connectionsKey(scope), "pages", filter],
  });

export const connectionDetailQuery = (scope: EnvironmentScope, connectionId: string) =>
  queryOptions({
    queryFn: () => fetchConnectionDetail({ data: { connectionId, scope } }),
    queryKey: [...connectionsKey(scope), "detail", connectionId],
  });

export const verificationQuery = (scope: EnvironmentScope, verificationId: string) =>
  queryOptions({
    queryFn: () => fetchVerification({ data: { scope, verificationId } }),
    queryKey: [...connectionsKey(scope), "verification", verificationId],
  });

/** Read fresh before every plan, so it is never served from cache. */
export const rebindObservationQuery = (
  scope: EnvironmentScope,
  connectionId: string,
  search: RebindSearch,
) => {
  const read: RebindRead = {
    kind: search.kind,
    targetId: search.kind === "reauthorize" ? search.target : undefined,
    verificationId: search.verification,
  };
  return queryOptions({
    queryFn: () => fetchRebindObservation({ data: { ...read, connectionId, scope } }),
    queryKey: [
      ...connectionsKey(scope),
      "rebind",
      connectionId,
      read.kind,
      read.targetId,
      read.verificationId,
    ],
    staleTime: 0,
  });
};

/** After a connection, grant, or workspace mutation: every list and count that shows them. */
export function invalidateConnections(queryClient: QueryClient, scope: EnvironmentScope) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: connectionsKey(scope) }),
    queryClient.invalidateQueries({ queryKey: connectionGrantsQuery(scope).queryKey }),
    queryClient.invalidateQueries({ queryKey: connectionProblemsQuery(scope).queryKey }),
    queryClient.invalidateQueries({ queryKey: oauthAppsQuery(scope).queryKey }),
    queryClient.invalidateQueries({ queryKey: workspacesQuery(scope).queryKey }),
  ]);
}

/**
 * Wraps a keyed mutation of what `queryKey` shows: a 409 means it changed underneath the dialog,
 * so read it again before the next submit sends a stale `expectedVersion`.
 */
export function rereadOnConflict(queryClient: QueryClient, queryKey: QueryKey) {
  return async <Result>(request: Promise<Result>): Promise<Result> => {
    try {
      return await request;
    } catch (error) {
      if (error instanceof PlatformApiError && error.problem.status === 409) {
        void queryClient.invalidateQueries({ queryKey });
      }
      throw error;
    }
  };
}
