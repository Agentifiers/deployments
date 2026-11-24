import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { oneOf } from "../observability/range.ts";
import { scopeKey, type EnvironmentScope } from "../scope.ts";
import {
  exportUsage,
  loadDomain,
  loadDomainPage,
  loadEmailSetup,
  loadPlacements,
  loadPolicyState,
  loadSuppressionPage,
  loadUsageSummary,
  loadVerifiedDomains,
} from "../server/agent-email-setup-data.ts";
import { requireAccessToken } from "../server/session.ts";
import {
  parseUsageSearch,
  USAGE_BUCKETS,
  USAGE_FORMATS,
  type UsageBucket,
  type UsageFormat,
  type UsageRange,
} from "../email/usage-state.ts";
import {
  fields,
  pageInput,
  scopedInput,
  type PageInput,
  type ScopedInput,
} from "./server-input.ts";

interface UsageInput extends ScopedInput {
  readonly inboxId: string | undefined;
  readonly range: UsageRange;
}

function usageInput(input: unknown) {
  const { inbox, range } = parseUsageSearch({
    inbox: fields(input).inboxId,
    range: fields(input).range,
  });
  return { ...scopedInput(input), inboxId: inbox, range: range ?? "30d" };
}

function required<const Values extends readonly string[]>(
  values: Values,
  value: unknown,
  name: string,
) {
  const known = oneOf(values, value);
  if (known === undefined) throw new TypeError(`${name} must be one of ${values.join(", ")}.`);
  return known;
}

const fetchEmailSetup = createServerFn({ method: "GET" })
  .validator((input: ScopedInput) => scopedInput(input))
  .handler(async ({ data }) => loadEmailSetup(await requireAccessToken(), data.scope));

const fetchVerifiedDomains = createServerFn({ method: "GET" })
  .validator((input: ScopedInput) => scopedInput(input))
  .handler(async ({ data }) => loadVerifiedDomains(await requireAccessToken(), data.scope));

const fetchDomainPage = createServerFn({ method: "GET" })
  .validator((input: PageInput) => pageInput(input))
  .handler(async ({ data }) => loadDomainPage(await requireAccessToken(), data.scope, data.cursor));

const fetchDomain = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly domainId: string }) =>
    scopedInput(input, ["domainId"]),
  )
  .handler(async ({ data }) => loadDomain(await requireAccessToken(), data.scope, data.domainId));

const fetchPlacements = createServerFn({ method: "GET" })
  .validator((input: ScopedInput) => scopedInput(input))
  .handler(async ({ data }) => loadPlacements(await requireAccessToken(), data.scope));

const fetchPolicy = createServerFn({ method: "GET" })
  .validator((input: ScopedInput) => scopedInput(input))
  .handler(async ({ data }) => loadPolicyState(await requireAccessToken(), data.scope));

const fetchSuppressionPage = createServerFn({ method: "GET" })
  .validator((input: PageInput) => pageInput(input))
  .handler(async ({ data }) =>
    loadSuppressionPage(await requireAccessToken(), data.scope, data.cursor),
  );

const fetchUsageSummary = createServerFn({ method: "GET" })
  .validator((input: UsageInput) => usageInput(input))
  .handler(async ({ data }) => loadUsageSummary(await requireAccessToken(), data.scope, data));

export const exportUsageFn = createServerFn({ method: "POST" })
  .validator(
    (input: UsageInput & { readonly bucket: UsageBucket; readonly format: UsageFormat }) => ({
      ...usageInput(input),
      bucket: required(USAGE_BUCKETS, fields(input).bucket, "bucket"),
      format: required(USAGE_FORMATS, fields(input).format, "format"),
    }),
  )
  .handler(async ({ data }) => exportUsage(await requireAccessToken(), data.scope, data));

export const agentEmailKey = (scope: EnvironmentScope) =>
  ["agent-email", ...scopeKey(scope)] as const;

export function invalidateAgentEmail(queryClient: QueryClient, scope: EnvironmentScope) {
  return queryClient.invalidateQueries({ queryKey: agentEmailKey(scope) });
}

export const emailSetupQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchEmailSetup({ data: { scope } }),
    queryKey: [...agentEmailKey(scope), "setup"],
  });

export const verifiedDomainsQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchVerifiedDomains({ data: { scope } }),
    queryKey: [...agentEmailKey(scope), "verified-domains"],
  });

export const domainPagesQuery = (scope: EnvironmentScope) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchDomainPage({
        data: { scope, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...agentEmailKey(scope), "domains"],
  });

export const domainQuery = (scope: EnvironmentScope, domainId: string) =>
  queryOptions({
    queryFn: () => fetchDomain({ data: { domainId, scope } }),
    queryKey: [...agentEmailKey(scope), "domain", domainId],
  });

export const placementsQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchPlacements({ data: { scope } }),
    queryKey: [...agentEmailKey(scope), "placements"],
  });

export const policyQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchPolicy({ data: { scope } }),
    queryKey: [...agentEmailKey(scope), "policy"],
  });

export const suppressionPagesQuery = (scope: EnvironmentScope) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchSuppressionPage({
        data: { scope, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...agentEmailKey(scope), "suppressions"],
  });

export const usageSummaryQuery = (
  scope: EnvironmentScope,
  range: UsageRange,
  inboxId: string | undefined,
) =>
  queryOptions({
    queryFn: () => fetchUsageSummary({ data: { inboxId, range, scope } }),
    queryKey: [...agentEmailKey(scope), "usage", range, inboxId],
  });
