import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { oneOf } from "../observability/range.ts";
import { scopeKey, type EnvironmentScope } from "../scope.ts";
import {
  loadDelivery,
  loadDeliveryPage,
  loadEndpointOptions,
  loadEndpointPage,
  loadWebhook,
} from "../server/webhook-data.ts";
import { requireAccessToken } from "../server/session.ts";
import {
  ENDPOINT_VIEWS,
  isDeliveryInFlight,
  parseDeliveryFilters,
  type DeliveryFilters,
  type EndpointView,
} from "../webhooks/webhook-state.ts";
import { failedDeliveriesQuery } from "./overview-queries.ts";
import { IN_FLIGHT_REFRESH_MS } from "./refresh.ts";
import {
  fields,
  pageInput,
  scopedInput,
  type PageInput,
  type ScopedInput,
} from "./server-input.ts";

const fetchEndpointPage = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly offset: number; readonly view: EndpointView }) => {
    const { offset, view } = fields(input);
    const known = oneOf(ENDPOINT_VIEWS, view);
    if (known === undefined) {
      throw new TypeError(`view must be one of ${ENDPOINT_VIEWS.join(", ")}.`);
    }
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError("offset must be a non-negative integer.");
    }
    return { ...scopedInput(input), offset, view: known };
  })
  .handler(async ({ data }) =>
    loadEndpointPage(await requireAccessToken(), data.scope, data.view, data.offset),
  );

const fetchEndpointOptions = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly webhookId: string | undefined }) => ({
    ...scopedInput(input),
    webhookId: parseDeliveryFilters(fields(input)).webhookId,
  }))
  .handler(async ({ data }) =>
    loadEndpointOptions(await requireAccessToken(), data.scope, data.webhookId),
  );

const fetchWebhook = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly webhookId: string }) =>
    scopedInput(input, ["webhookId"]),
  )
  .handler(async ({ data }) => loadWebhook(await requireAccessToken(), data.scope, data.webhookId));

const fetchDeliveryPage = createServerFn({ method: "GET" })
  .validator((input: PageInput & { readonly filters: DeliveryFilters }) => ({
    ...pageInput(input),
    filters: parseDeliveryFilters(fields(fields(input).filters)),
  }))
  .handler(async ({ data }) =>
    loadDeliveryPage(await requireAccessToken(), data.scope, data.filters, data.cursor),
  );

const fetchDelivery = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly deliveryId: string }) =>
    scopedInput(input, ["deliveryId"]),
  )
  .handler(async ({ data }) =>
    loadDelivery(await requireAccessToken(), data.scope, data.deliveryId),
  );

const webhooksKey = (scope: EnvironmentScope) => ["webhooks", ...scopeKey(scope)] as const;

export function invalidateWebhooks(queryClient: QueryClient, scope: EnvironmentScope) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: webhooksKey(scope) }),
    queryClient.invalidateQueries({ queryKey: failedDeliveriesQuery(scope).queryKey }),
  ]);
}

export const endpointPagesQuery = (scope: EnvironmentScope, view: EndpointView) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) => fetchEndpointPage({ data: { offset: pageParam, scope, view } }),
    getNextPageParam: (page) => page.nextOffset,
    initialPageParam: 0,
    queryKey: [...webhooksKey(scope), "endpoints", view],
  });

export const endpointOptionsQuery = (scope: EnvironmentScope, webhookId: string | undefined) =>
  queryOptions({
    queryFn: () => fetchEndpointOptions({ data: { scope, webhookId } }),
    queryKey: [...webhooksKey(scope), "endpoint-options", webhookId],
  });

export const webhookQuery = (scope: EnvironmentScope, webhookId: string) =>
  queryOptions({
    queryFn: () => fetchWebhook({ data: { scope, webhookId } }),
    queryKey: [...webhooksKey(scope), "endpoint", webhookId],
  });

export const deliveryPagesQuery = (scope: EnvironmentScope, filters: DeliveryFilters) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchDeliveryPage({
        data: { filters, scope, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...webhooksKey(scope), "deliveries", filters],
  });

export const deliveryQuery = (scope: EnvironmentScope, deliveryId: string) =>
  queryOptions({
    queryFn: () => fetchDelivery({ data: { deliveryId, scope } }),
    queryKey: [...webhooksKey(scope), "delivery", deliveryId],
    refetchInterval: (query) =>
      query.state.data && isDeliveryInFlight(query.state.data.delivery.status)
        ? IN_FLIGHT_REFRESH_MS
        : false,
  });
