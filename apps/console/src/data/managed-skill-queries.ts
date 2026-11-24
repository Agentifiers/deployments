import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { scopeKey, type EnvironmentScope } from "../scope.ts";
import {
  loadAgentTargets,
  loadReleaseCatalog,
  loadSkillContent,
  loadSkillInstallations,
  loadSkillSources,
  loadSourceCatalog,
} from "../server/managed-skill-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { requireIds, scopedInput, type ScopedInput } from "./server-input.ts";

const fetchSkillInstallations = createServerFn({ method: "GET" })
  .validator((input: ScopedInput) => scopedInput(input))
  .handler(async ({ data }) => loadSkillInstallations(await requireAccessToken(), data.scope));

const fetchAgentTargets = createServerFn({ method: "GET" })
  .validator((input: ScopedInput) => scopedInput(input))
  .handler(async ({ data }) => loadAgentTargets(await requireAccessToken(), data.scope));

const fetchSkillSources = createServerFn({ method: "GET" }).handler(async () =>
  loadSkillSources(await requireAccessToken()),
);

const fetchSourceCatalog = createServerFn({ method: "GET" })
  .validator((input: { readonly sourceId: string }) => requireIds(input, ["sourceId"]))
  .handler(async ({ data }) => loadSourceCatalog(await requireAccessToken(), data.sourceId));

const fetchReleaseCatalog = createServerFn({ method: "GET" })
  .validator((input: { readonly releaseId: string }) => requireIds(input, ["releaseId"]))
  .handler(async ({ data }) => loadReleaseCatalog(await requireAccessToken(), data.releaseId));

const fetchSkillContent = createServerFn({ method: "GET" })
  .validator((input: { readonly skillId: string }) => requireIds(input, ["skillId"]))
  .handler(async ({ data }) => loadSkillContent(await requireAccessToken(), data.skillId));

const installationsKey = (scope: EnvironmentScope) => ["skills", ...scopeKey(scope)] as const;

const CATALOG_KEY = ["skill-catalog"] as const;

export function invalidateSkillInstallations(queryClient: QueryClient, scope: EnvironmentScope) {
  return queryClient.invalidateQueries({ queryKey: installationsKey(scope) });
}

export const skillInstallationsQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchSkillInstallations({ data: { scope } }),
    queryKey: [...installationsKey(scope), "installations"],
  });

/** Install targets; under the `agents` prefix so every agent mutation refreshes them. */
export const agentTargetsQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchAgentTargets({ data: { scope } }),
    queryKey: ["agents", ...scopeKey(scope), "skill-targets"],
  });

export const skillSourcesQuery = () =>
  queryOptions({
    queryFn: () => fetchSkillSources(),
    queryKey: [...CATALOG_KEY, "sources"],
  });

export const sourceCatalogQuery = (sourceId: string) =>
  queryOptions({
    queryFn: () => fetchSourceCatalog({ data: { sourceId } }),
    queryKey: [...CATALOG_KEY, "source", sourceId],
  });

export const releaseCatalogQuery = (releaseId: string) =>
  queryOptions({
    queryFn: () => fetchReleaseCatalog({ data: { releaseId } }),
    queryKey: [...CATALOG_KEY, "release", releaseId],
  });

export const skillContentQuery = (skillId: string) =>
  queryOptions({
    meta: { dehydrate: false },
    queryFn: () => fetchSkillContent({ data: { skillId } }),
    queryKey: [...CATALOG_KEY, "content", skillId],
    staleTime: Number.POSITIVE_INFINITY,
  });
