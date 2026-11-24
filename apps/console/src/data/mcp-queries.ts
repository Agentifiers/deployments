import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { SERVER_VIEWS, type ServerView } from "../mcp/mcp-state.ts";
import { oneOf } from "../observability/range.ts";
import { SCOPE_FIELDS, scopeKey, type EnvironmentScope } from "../scope.ts";
import {
  loadCappedDeployments,
  loadCappedGrants,
  loadMcpServer,
  loadMcpServerRows,
} from "../server/mcp-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { fields, requireIds, scopedInput, type ScopedInput } from "./server-input.ts";
import { mcpDirectoryQuery } from "./tool-directory-queries.ts";

const fetchServerRows = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly view: ServerView }) => {
    const view = oneOf(SERVER_VIEWS, fields(input).view);
    if (view === undefined) throw new TypeError(`view must be one of ${SERVER_VIEWS.join(", ")}.`);
    return { ...scopedInput(input), view };
  })
  .handler(async ({ data }) =>
    loadMcpServerRows(await requireAccessToken(), data.scope, data.view),
  );

const fetchServer = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly serverId: string }) =>
    scopedInput(input, ["serverId"]),
  )
  .handler(async ({ data }) =>
    loadMcpServer(await requireAccessToken(), data.scope, data.serverId),
  );

const fetchCappedGrants = createServerFn({ method: "GET" })
  .validator((input: EnvironmentScope) => requireIds(input, SCOPE_FIELDS))
  .handler(async ({ data }) => loadCappedGrants(await requireAccessToken(), data));

const fetchCappedDeployments = createServerFn({ method: "GET" })
  .validator((input: EnvironmentScope) => requireIds(input, SCOPE_FIELDS))
  .handler(async ({ data }) => loadCappedDeployments(await requireAccessToken(), data));

const mcpKey = (scope: EnvironmentScope) => ["mcp-servers", ...scopeKey(scope)] as const;

export function invalidateMcpServers(queryClient: QueryClient, scope: EnvironmentScope) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: mcpKey(scope) }),
    queryClient.invalidateQueries({ queryKey: mcpDirectoryQuery(scope).queryKey }),
  ]);
}

export const mcpServerRowsQuery = (scope: EnvironmentScope, view: ServerView) =>
  queryOptions({
    queryFn: () => fetchServerRows({ data: { scope, view } }),
    queryKey: [...mcpKey(scope), "rows", view],
  });

export const mcpServerQuery = (scope: EnvironmentScope, serverId: string) =>
  queryOptions({
    queryFn: () => fetchServer({ data: { scope, serverId } }),
    queryKey: [...mcpKey(scope), "server", serverId],
  });

/** Under the `connection-grants` prefix, so connection and grant mutations refresh it. */
export const cappedGrantsQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchCappedGrants({ data: scope }),
    queryKey: ["connection-grants", ...scopeKey(scope), "capped"],
  });

/** Under the `agents` prefix, so agent and deployment mutations refresh it. */
export const cappedDeploymentsQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchCappedDeployments({ data: scope }),
    queryKey: ["agents", ...scopeKey(scope), "capped-pinning-deployments"],
  });
