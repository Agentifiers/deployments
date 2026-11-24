import {
  infiniteQueryOptions,
  queryOptions,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import {
  keptLastFires,
  LIST_PAGE_SIZE,
  loadedRows,
  threadRefreshDelay,
  viewWindow,
  type AutomationPage,
  type AutomationView,
} from "../automations/automation-listing.ts";
import {
  automationRow,
  parseAutomationFilters,
  type LastFire,
} from "../automations/automation-state.ts";
import { scopeKey, type EnvironmentScope } from "../scope.ts";
import {
  loadAutomation,
  loadAutomationListing,
  loadFirePage,
  loadLastFires,
  type AutomationRef,
} from "../server/automation-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { STATUS_REFRESH_MS } from "./refresh.ts";
import {
  fields,
  pageInput,
  requireIds,
  scopedInput,
  type PageInput,
  type ScopedInput,
} from "./server-input.ts";

/** The automation an input names; the kind parses like the list's `kind` filter. */
export function automationRefInput(input: unknown): AutomationRef {
  const { kind } = parseAutomationFilters({ kind: fields(input).kind });
  if (kind === undefined) throw new TypeError("kind must be heartbeat or schedule.");
  return { kind, ...requireIds(input, ["id"]) };
}

const fetchAutomationListing = createServerFn({ method: "GET" })
  .validator((input: ScopedInput) => scopedInput(input))
  .handler(async ({ data }) => loadAutomationListing(await requireAccessToken(), data.scope));

const fetchLastFires = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly refs: readonly AutomationRef[] }) => {
    const { refs } = fields(input);
    if (!Array.isArray(refs) || refs.length === 0 || refs.length > LIST_PAGE_SIZE) {
      throw new TypeError(`refs must list 1 to ${LIST_PAGE_SIZE} automations.`);
    }
    return { ...scopedInput(input), refs: refs.map(automationRefInput) };
  })
  .handler(async ({ data }) => loadLastFires(await requireAccessToken(), data.scope, data.refs));

const fetchAutomation = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & AutomationRef) => ({
    ...scopedInput(input),
    ref: automationRefInput(input),
  }))
  .handler(async ({ data }) => loadAutomation(await requireAccessToken(), data.scope, data.ref));

const fetchFirePage = createServerFn({ method: "GET" })
  .validator((input: PageInput & AutomationRef) => ({
    ...pageInput(input),
    ref: automationRefInput(input),
  }))
  .handler(async ({ data }) =>
    loadFirePage(await requireAccessToken(), data.scope, data.ref, data.cursor),
  );

export const automationsKey = (scope: EnvironmentScope) =>
  ["automations", ...scopeKey(scope)] as const;

export function invalidateAutomations(queryClient: QueryClient, scope: EnvironmentScope) {
  return queryClient.invalidateQueries({ queryKey: automationsKey(scope) });
}

/** Under the 30 s refresh, so each refresh lists again, and long enough that views opened together share one listing. */
const LISTING_REUSE_MS = 20_000;

/**
 * No observers: only view pages read it. Kept out of SSR's dehydrated state, so the HTML does not
 * grow with the environment.
 */
const automationListingQuery = (scope: EnvironmentScope) =>
  queryOptions({
    meta: { dehydrate: false },
    queryFn: () => fetchAutomationListing({ data: { scope } }),
    queryKey: [...automationsKey(scope), "listing"],
  });

/**
 * One view of the environment's shared listing. Page 0 reuses a listing younger than
 * `LISTING_REUSE_MS`, and later pages page the listing page 0 used. Each page reads last fires only
 * for its own rows, keeping those a refresh cannot have changed.
 */
export const automationViewPagesQuery = (scope: EnvironmentScope, view: AutomationView) =>
  infiniteQueryOptions({
    queryFn: async ({ client, pageParam, queryKey }): Promise<AutomationPage> => {
      const previous = client.getQueryData<InfiniteData<AutomationPage, number>>(queryKey)?.pages;
      const listingQuery = automationListingQuery(scope);
      const listing = await (pageParam > 0
        ? client.ensureQueryData(listingQuery)
        : client.fetchQuery({ ...listingQuery, staleTime: LISTING_REUSE_MS }));
      const { hidden, nextOffset, records } = viewWindow(listing, view, pageParam);
      const kept = keptLastFires(loadedRows(previous ?? []), records);
      const unread = records.filter((record) => !kept.has(record.id));
      const read: Readonly<Record<string, LastFire>> =
        unread.length === 0
          ? {}
          : await fetchLastFires({
              data: { refs: unread.map(({ id, kind }) => ({ id, kind })), scope },
            });
      const listedAt = new Date(listing.listedAt);
      return {
        hidden,
        rows: records.map((record) =>
          automationRow(
            record,
            kept.get(record.id) ?? read[record.id] ?? { kind: "unavailable" },
            listedAt,
          ),
        ),
        ...(nextOffset === undefined ? {} : { nextOffset }),
      };
    },
    getNextPageParam: (page) => page.nextOffset,
    initialPageParam: 0,
    queryKey: [...automationsKey(scope), "view", view],
    refetchInterval:
      view.kind === "list"
        ? STATUS_REFRESH_MS
        : (query) => threadRefreshDelay(loadedRows(query.state.data?.pages ?? []), new Date()),
  });

export const automationQuery = (scope: EnvironmentScope, { id, kind }: AutomationRef) =>
  queryOptions({
    queryFn: () => fetchAutomation({ data: { id, kind, scope } }),
    queryKey: [...automationsKey(scope), kind, id],
    refetchInterval: STATUS_REFRESH_MS,
  });

/** The fire table sets its own `refetchInterval`, since polling depends on the automation too. */
export const firePagesQuery = (scope: EnvironmentScope, { id, kind }: AutomationRef) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchFirePage({
        data: { id, kind, scope, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...automationsKey(scope), kind, id, "fires"],
  });
