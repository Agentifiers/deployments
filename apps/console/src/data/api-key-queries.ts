import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { DIRECTORY_VIEWS, type DirectoryView } from "../api-keys/directory.ts";
import { METRIC_RANGES, oneOf, type MetricRange } from "../observability/range.ts";
import { scopeKey, type EnvironmentScope } from "../scope.ts";
import { loadApiKey, loadApiKeyDirectoryPage, loadKeyUsage } from "../server/api-key-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { fields, scopedInput, type ScopedInput } from "./server-input.ts";

const fetchApiKeyDirectoryPage = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly offset: number; readonly view: DirectoryView }) => {
    const { offset, view } = fields(input);
    const known = oneOf(DIRECTORY_VIEWS, view);
    if (known === undefined) {
      throw new TypeError(`view must be one of ${DIRECTORY_VIEWS.join(", ")}.`);
    }
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError("offset must be a non-negative integer.");
    }
    return { ...scopedInput(input), offset, view: known };
  })
  .handler(async ({ data }) =>
    loadApiKeyDirectoryPage(await requireAccessToken(), data.scope, data.view, data.offset),
  );

const fetchApiKey = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly apiCredentialId: string }) =>
    scopedInput(input, ["apiCredentialId"]),
  )
  .handler(async ({ data }) =>
    loadApiKey(await requireAccessToken(), data.scope, data.apiCredentialId),
  );

const fetchKeyUsage = createServerFn({ method: "GET" })
  .validator(
    (input: ScopedInput & { readonly apiCredentialId: string; readonly window: MetricRange }) => {
      const window = oneOf(METRIC_RANGES, fields(input).window);
      if (window === undefined) {
        throw new TypeError(`window must be one of ${METRIC_RANGES.join(", ")}.`);
      }
      return { ...scopedInput(input, ["apiCredentialId"]), window };
    },
  )
  .handler(async ({ data }) =>
    loadKeyUsage(await requireAccessToken(), data.scope, data.apiCredentialId, data.window),
  );

const apiKeysKey = (scope: EnvironmentScope) => ["api-keys", ...scopeKey(scope)] as const;

export function invalidateApiKeys(queryClient: QueryClient, scope: EnvironmentScope) {
  return queryClient.invalidateQueries({ queryKey: apiKeysKey(scope) });
}

export const apiKeyDirectoryPagesQuery = (scope: EnvironmentScope, view: DirectoryView) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchApiKeyDirectoryPage({ data: { offset: pageParam, scope, view } }),
    getNextPageParam: (page) => page.nextOffset,
    initialPageParam: 0,
    queryKey: [...apiKeysKey(scope), "directory", view],
  });

export const apiKeyQuery = (scope: EnvironmentScope, apiCredentialId: string) =>
  queryOptions({
    queryFn: () => fetchApiKey({ data: { apiCredentialId, scope } }),
    queryKey: [...apiKeysKey(scope), "key", apiCredentialId],
  });

export const keyUsageQuery = (
  scope: EnvironmentScope,
  apiCredentialId: string,
  window: MetricRange,
) =>
  queryOptions({
    queryFn: () => fetchKeyUsage({ data: { apiCredentialId, scope, window } }),
    queryKey: [...apiKeysKey(scope), "usage", apiCredentialId, window],
  });
