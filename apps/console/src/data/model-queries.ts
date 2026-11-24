import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { parseModelSearch, type ModelSearch } from "../models/model-catalog-state.ts";
import type { NextRules } from "../models/model-policy-state.ts";
import { scopeKey, type EnvironmentScope } from "../scope.ts";
import {
  loadActiveModelPolicy,
  loadModelPage,
  loadModelPolicyPage,
  loadModelPolicyPreview,
} from "../server/model-data.ts";
import { requireAccessToken } from "../server/session.ts";
import {
  fields,
  pageInput,
  scopedInput,
  type PageInput,
  type ScopedInput,
} from "./server-input.ts";

const MAX_POLICY_ENTRIES = 256;
const MAX_POLICY_ENTRY_LENGTH = 256;

const fetchModelPage = createServerFn({ method: "GET" })
  .validator((input: PageInput & { readonly search: ModelSearch }) => ({
    ...pageInput(input),
    search: parseModelSearch(fields(fields(input).search)),
  }))
  .handler(async ({ data }) =>
    loadModelPage(await requireAccessToken(), data.scope, data.search, data.cursor),
  );

const fetchActiveModelPolicy = createServerFn({ method: "GET" })
  .validator((input: ScopedInput) => scopedInput(input))
  .handler(async ({ data }) => loadActiveModelPolicy(await requireAccessToken(), data.scope));

const fetchModelPolicyPage = createServerFn({ method: "GET" })
  .validator((input: PageInput) => pageInput(input))
  .handler(async ({ data }) =>
    loadModelPolicyPage(await requireAccessToken(), data.scope, data.cursor),
  );

function requireNextRules(input: unknown): NextRules {
  const { next } = fields(input);
  if (next === null) return null;
  const { includeCuratedModels, models } = fields(next);
  if (typeof includeCuratedModels !== "boolean") {
    throw new TypeError("next.includeCuratedModels must be a boolean.");
  }
  if (
    !Array.isArray(models) ||
    models.length > MAX_POLICY_ENTRIES ||
    !models.every((entry) => typeof entry === "string" && entry.length <= MAX_POLICY_ENTRY_LENGTH)
  ) {
    throw new TypeError("next.models must be at most 256 entries of at most 256 characters.");
  }
  return { includeCuratedModels, models };
}

/** POST because draft rules (256 entries of 256 characters) do not fit a GET's query string. */
const fetchModelPolicyPreview = createServerFn({ method: "POST" })
  .validator((input: ScopedInput & { readonly next: NextRules }) => ({
    ...scopedInput(input),
    next: requireNextRules(input),
  }))
  .handler(async ({ data }) =>
    loadModelPolicyPreview(await requireAccessToken(), data.scope, data.next),
  );

const modelsKey = (scope: EnvironmentScope) => ["models", ...scopeKey(scope)] as const;

export function invalidateModels(queryClient: QueryClient, scope: EnvironmentScope) {
  return queryClient.invalidateQueries({ queryKey: modelsKey(scope) });
}

export const modelPagesQuery = (scope: EnvironmentScope, search: ModelSearch) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchModelPage({
        data: { scope, search, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...modelsKey(scope), "catalog", search],
  });

export const activeModelPolicyQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchActiveModelPolicy({ data: { scope } }),
    queryKey: [...modelsKey(scope), "active-policy"],
  });

export const modelPolicyPagesQuery = (scope: EnvironmentScope) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchModelPolicyPage({
        data: { scope, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...modelsKey(scope), "policies"],
  });

export const modelPolicyPreviewQuery = (scope: EnvironmentScope, next: NextRules) =>
  queryOptions({
    gcTime: 0,
    queryFn: () => fetchModelPolicyPreview({ data: { next, scope } }),
    queryKey: [...modelsKey(scope), "preview", next],
    staleTime: 0,
  });
