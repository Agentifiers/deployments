import "@tanstack/react-start/server-only";
import type { EnvironmentScope } from "../scope.ts";
import {
  endpointOptions,
  endpointPage,
  headerList,
  type AttemptView,
  type DeliveryDetail,
  type DeliveryFilters,
  type DeliveryRow,
  type DeliveryView,
  type EndpointOption,
  type EndpointPage,
  type EndpointView,
  type WebhookEndpoint,
} from "../webhooks/webhook-state.ts";
import { API_PAGE_LIMIT, fillPage, PAGE_SIZE, type Page } from "./list-pages.ts";
import { callRoute, collectPages, type RouteResponse } from "./platform-api.ts";

const ENDPOINT_PAGE_SIZE = 25;

export function deliveryView(delivery: RouteResponse<"getWebhookDelivery">): DeliveryView {
  return { ...delivery, responseHeaders: headerList(delivery.responseHeaders) };
}

function attemptView(
  attempt: RouteResponse<"listWebhookDeliveryAttempts">["attempts"][number],
): AttemptView {
  return { ...attempt, responseHeaders: headerList(attempt.responseHeaders) };
}

function listEndpoints(accessToken: string, scope: EnvironmentScope): Promise<WebhookEndpoint[]> {
  return collectPages(async (cursor) => {
    const page = await callRoute(
      "listWebhooks",
      { query: { cursor, limit: API_PAGE_LIMIT }, scope },
      accessToken,
    );
    return { items: page.webhooks, nextCursor: page.nextCursor };
  });
}

export async function loadEndpointPage(
  accessToken: string,
  scope: EnvironmentScope,
  view: EndpointView,
  offset: number,
): Promise<EndpointPage> {
  return endpointPage(await listEndpoints(accessToken, scope), {
    offset,
    pageSize: ENDPOINT_PAGE_SIZE,
    view,
  });
}

export async function loadEndpointOptions(
  accessToken: string,
  scope: EnvironmentScope,
  selectedId: string | undefined,
): Promise<readonly EndpointOption[]> {
  return endpointOptions(await listEndpoints(accessToken, scope), selectedId);
}

export function loadWebhook(
  accessToken: string,
  scope: EnvironmentScope,
  webhookId: string,
): Promise<WebhookEndpoint> {
  return callRoute("getWebhook", { path: { webhookId }, scope }, accessToken);
}

export async function loadDeliveryPage(
  accessToken: string,
  scope: EnvironmentScope,
  filters: DeliveryFilters,
  cursor: string | undefined,
): Promise<Page<DeliveryRow>> {
  const [page, endpoints] = await Promise.all([
    fillPage(
      async (pageCursor, limit) => {
        const response = await callRoute(
          "listWebhookDeliveries",
          { query: { ...filters, cursor: pageCursor, limit }, scope },
          accessToken,
        );
        return { items: response.deliveries.map(deliveryView), nextCursor: response.nextCursor };
      },
      cursor,
      PAGE_SIZE,
    ),
    filters.webhookId === undefined ? listEndpoints(accessToken, scope) : [],
  ]);
  const names = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint.name]));
  return {
    ...page,
    items: page.items.map((delivery) => ({
      ...delivery,
      endpointName: names.get(delivery.webhookEndpointId),
    })),
  };
}

export async function loadDelivery(
  accessToken: string,
  scope: EnvironmentScope,
  deliveryId: string,
): Promise<DeliveryDetail> {
  const [delivery, attempts] = await Promise.all([
    callRoute("getWebhookDelivery", { path: { deliveryId }, scope }, accessToken),
    collectPages(async (cursor) => {
      const page = await callRoute(
        "listWebhookDeliveryAttempts",
        { path: { deliveryId }, query: { cursor, limit: API_PAGE_LIMIT }, scope },
        accessToken,
      );
      return { items: page.attempts, nextCursor: page.nextCursor };
    }),
  ]);
  return { attempts: attempts.map(attemptView), delivery: deliveryView(delivery) };
}
