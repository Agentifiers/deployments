import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { SCOPE_FIELDS, scopeKey, type EnvironmentScope } from "../scope.ts";
import { requireAccessToken } from "../server/session.ts";
import { loadExtensionDirectory, loadMcpDirectory } from "../server/tool-directory.ts";
import { requireIds } from "./server-input.ts";

const DIRECTORY_STALE_MS = 60_000;

const fetchMcpDirectory = createServerFn({ method: "GET" })
  .validator((input: EnvironmentScope) => requireIds(input, SCOPE_FIELDS))
  .handler(async ({ data }) => loadMcpDirectory(await requireAccessToken(), data));

const fetchExtensionDirectory = createServerFn({ method: "GET" })
  .validator((input: EnvironmentScope) => requireIds(input, SCOPE_FIELDS))
  .handler(async ({ data }) => loadExtensionDirectory(await requireAccessToken(), data));

export const mcpDirectoryQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchMcpDirectory({ data: scope }),
    queryKey: ["mcp-directory", ...scopeKey(scope)],
    staleTime: DIRECTORY_STALE_MS,
  });

export const extensionDirectoryQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchExtensionDirectory({ data: scope }),
    queryKey: ["extension-directory", ...scopeKey(scope)],
    staleTime: DIRECTORY_STALE_MS,
  });
