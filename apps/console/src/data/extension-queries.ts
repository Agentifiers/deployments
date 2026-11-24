import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import {
  parseExtensionLocator,
  parseExtensionSearch,
  type ExtensionLocator,
  type ExtensionSearch,
} from "../extensions/extension-state.ts";
import { scopeKey, type EnvironmentScope } from "../scope.ts";
import {
  loadExtensionDetail,
  loadExtensionPage,
  loadHostedCodeArtifact,
  loadMcpServerOption,
} from "../server/extension-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { fields, requireIds, scopedInput, type ScopedInput } from "./server-input.ts";
import { extensionDirectoryQuery } from "./tool-directory-queries.ts";

const CONTENT_HASH = /^sha256:[a-f0-9]{64}$/u;

const fetchExtensionPage = createServerFn({ method: "GET" })
  .validator(
    (input: ScopedInput & { readonly offset: number; readonly search: ExtensionSearch }) => {
      const { offset, search } = fields(input);
      if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
        throw new TypeError("offset must be a non-negative integer.");
      }
      return { ...scopedInput(input), offset, search: parseExtensionSearch(fields(search)) };
    },
  )
  .handler(async ({ data }) =>
    loadExtensionPage(await requireAccessToken(), data.scope, data.search, data.offset),
  );

const fetchExtensionDetail = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & ExtensionLocator) => ({
    ...scopedInput(input, ["extensionId"]),
    ...parseExtensionLocator(fields(input)),
  }))
  .handler(async ({ data: { scope, ...locator } }) =>
    loadExtensionDetail(await requireAccessToken(), scope, locator),
  );

const fetchHostedCodeArtifact = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly contentHash: string }) => {
    const { contentHash } = fields(input);
    if (typeof contentHash !== "string" || !CONTENT_HASH.test(contentHash)) {
      throw new TypeError("contentHash must be a sha256 content hash.");
    }
    return { ...scopedInput(input), contentHash };
  })
  .handler(async ({ data }) =>
    loadHostedCodeArtifact(await requireAccessToken(), data.scope, data.contentHash),
  );

const fetchMcpServerOption = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly serverId: string }) => ({
    ...scopedInput(input),
    ...requireIds(input, ["serverId"]),
  }))
  .handler(async ({ data }) =>
    loadMcpServerOption(await requireAccessToken(), data.scope, data.serverId),
  );

const extensionsKey = (scope: EnvironmentScope) => ["extensions", ...scopeKey(scope)] as const;

export function invalidateExtensions(queryClient: QueryClient, scope: EnvironmentScope) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: extensionsKey(scope) }),
    queryClient.invalidateQueries({ queryKey: extensionDirectoryQuery(scope).queryKey }),
  ]);
}

export const extensionPagesQuery = (scope: EnvironmentScope, search: ExtensionSearch) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) => fetchExtensionPage({ data: { offset: pageParam, scope, search } }),
    getNextPageParam: (page) => page.nextOffset,
    initialPageParam: 0,
    queryKey: [...extensionsKey(scope), "list", search],
  });

export const extensionQuery = (scope: EnvironmentScope, locator: ExtensionLocator) =>
  queryOptions({
    queryFn: () => fetchExtensionDetail({ data: { ...locator, scope } }),
    queryKey: [...extensionsKey(scope), "detail", locator.extensionId, locator.name],
  });

/** Artifacts are immutable, so one read lasts the session. */
export const hostedCodeArtifactQuery = (scope: EnvironmentScope, contentHash: string) =>
  queryOptions({
    queryFn: () => fetchHostedCodeArtifact({ data: { contentHash, scope } }),
    queryKey: ["hosted-code-artifact", ...scopeKey(scope), contentHash],
    staleTime: Number.POSITIVE_INFINITY,
  });

export const mcpServerOptionQuery = (scope: EnvironmentScope, serverId: string) =>
  queryOptions({
    queryFn: () => fetchMcpServerOption({ data: { scope, serverId } }),
    queryKey: [...extensionsKey(scope), "mcp-server", serverId],
  });
