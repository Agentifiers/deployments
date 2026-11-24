import { oneOf } from "../observability/range.ts";
import { parseEventTypes } from "./event-types.ts";
import type { RouteResponse } from "../server/platform-api.ts";

export type WebhookEndpoint = RouteResponse<"getWebhook">;
export type EndpointStatus = WebhookEndpoint["status"];
export type EndpointAction = "archive" | "disable" | "edit" | "enable" | "rotate" | "test";
export type WebhookTestResult = RouteResponse<"testWebhook">;

export type HeaderList = readonly (readonly [name: string, value: string])[];

type DeliveryResponse = RouteResponse<"getWebhookDelivery">;
type AttemptResponse = RouteResponse<"listWebhookDeliveryAttempts">["attempts"][number];

export interface DeliveryView extends Omit<DeliveryResponse, "responseHeaders"> {
  readonly responseHeaders: HeaderList;
}

export interface AttemptView extends Omit<AttemptResponse, "responseHeaders"> {
  readonly responseHeaders: HeaderList;
}

export interface DeliveryDetail {
  readonly attempts: readonly AttemptView[];
  readonly delivery: DeliveryView;
}

export type DeliveryStatus = DeliveryView["status"];

export interface DeliveryFilters {
  readonly status?: DeliveryStatus;
  readonly webhookId?: string;
}

export interface DeliveryRow extends DeliveryView {
  readonly endpointName: string | undefined;
}

export const ENDPOINT_VIEWS = ["active", "all"] as const;
export type EndpointView = (typeof ENDPOINT_VIEWS)[number];

export interface EndpointSearch {
  readonly show?: "all";
}

export interface EndpointPage {
  readonly endpoints: readonly WebhookEndpoint[];
  readonly hidden: number;
  readonly nextOffset?: number;
}

export type EndpointOption = Pick<WebhookEndpoint, "id" | "name">;

export type EndpointChanges = Partial<Pick<WebhookEndpoint, "eventTypes" | "name" | "url">>;

export const ENDPOINT_ACTIONS: Readonly<Record<EndpointStatus, readonly EndpointAction[]>> = {
  active: ["edit", "test", "disable", "rotate", "archive"],
  archived: [],
  disabled: ["edit", "test", "enable", "rotate", "archive"],
};

export const DELIVERY_STATUSES = [
  "delivered",
  "failed",
  "pending",
  "retrying",
  "sending",
] as const satisfies readonly DeliveryStatus[];

const DELIVERY_IN_FLIGHT: Readonly<Record<DeliveryStatus, boolean>> = {
  delivered: false,
  failed: false,
  pending: true,
  retrying: true,
  sending: true,
};

export function isDeliveryInFlight(status: DeliveryStatus): boolean {
  return DELIVERY_IN_FLIGHT[status];
}

export function canRetryDelivery(
  delivery: Pick<DeliveryView, "status">,
  endpointStatus: EndpointStatus | undefined,
): boolean {
  return !DELIVERY_IN_FLIGHT[delivery.status] && endpointStatus === "active";
}

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

export function parseDeliveryFilters(search: Readonly<Record<string, unknown>>): DeliveryFilters {
  const status = oneOf(DELIVERY_STATUSES, search.status);
  const { webhookId } = search;
  return {
    ...(status ? { status } : {}),
    ...(typeof webhookId === "string" && ULID.test(webhookId) ? { webhookId } : {}),
  };
}

const isArchived = (endpoint: WebhookEndpoint) => endpoint.status === "archived";

const VIEW_ENDPOINTS: Readonly<
  Record<EndpointView, (endpoints: readonly WebhookEndpoint[]) => readonly WebhookEndpoint[]>
> = {
  active: (endpoints) => endpoints.filter((endpoint) => !isArchived(endpoint)),
  all: (endpoints) =>
    endpoints.toSorted((left, right) => Number(isArchived(left)) - Number(isArchived(right))),
};

export function parseEndpointSearch(search: Readonly<Record<string, unknown>>): EndpointSearch {
  return search.show === "all" ? { show: "all" } : {};
}

export function endpointPage(
  endpoints: readonly WebhookEndpoint[],
  {
    offset,
    pageSize,
    view,
  }: { readonly offset: number; readonly pageSize: number; readonly view: EndpointView },
): EndpointPage {
  const shown = VIEW_ENDPOINTS[view](endpoints);
  const end = offset + pageSize;
  return {
    endpoints: shown.slice(offset, end),
    hidden: endpoints.length - shown.length,
    ...(end < shown.length ? { nextOffset: end } : {}),
  };
}

export function endpointOptions(
  endpoints: readonly WebhookEndpoint[],
  selectedId: string | undefined,
): readonly EndpointOption[] {
  return endpoints
    .filter((endpoint) => !isArchived(endpoint) || endpoint.id === selectedId)
    .map(({ id, name }) => ({ id, name }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export function headerList(headers: Readonly<Record<string, unknown>> | undefined): HeaderList {
  return Object.entries(headers ?? {})
    .map(([name, value]): readonly [string, string] => [
      name,
      typeof value === "string" ? value : JSON.stringify(value),
    ])
    .toSorted(([left], [right]) => left.localeCompare(right));
}

export function endpointChanges(
  endpoint: Pick<WebhookEndpoint, "eventTypes" | "name" | "url">,
  draft: Required<EndpointChanges>,
): EndpointChanges {
  const sameEventTypes =
    draft.eventTypes.length === endpoint.eventTypes.length &&
    draft.eventTypes.every((eventType) => endpoint.eventTypes.includes(eventType));
  return {
    ...(sameEventTypes ? {} : { eventTypes: draft.eventTypes }),
    ...(draft.name === endpoint.name ? {} : { name: draft.name }),
    ...(draft.url === endpoint.url ? {} : { url: draft.url }),
  };
}

const MAX_NAME_LENGTH = 120;
const MAX_URL_LENGTH = 2_048;
const HTTPS_URL = /^https:\/\/\S+$/iu;

export interface EndpointDraft {
  readonly all: boolean;
  readonly eventTypes: string;
  readonly name: string;
  readonly url: string;
}

export function readEndpointDraft(draft: EndpointDraft) {
  const name = draft.name.trim();
  const url = draft.url.trim();
  const eventTypes = parseEventTypes(draft.eventTypes, draft.all);
  const nameValid = name.length > 0 && name.length <= MAX_NAME_LENGTH;
  const urlValid = url.length <= MAX_URL_LENGTH && HTTPS_URL.test(url);
  const value: Required<EndpointChanges> | undefined =
    nameValid && urlValid && eventTypes.ok
      ? { eventTypes: eventTypes.value, name, url }
      : undefined;
  return { eventTypes, nameValid, urlValid, value };
}

export const DEFAULT_OVERLAP_HOURS = 24;
export const MAX_OVERLAP_HOURS = 168;

export type ParsedOverlap =
  | { readonly ok: true; readonly seconds: number }
  | { readonly ok: false; readonly message: string };

export function parseOverlapHours(text: string): ParsedOverlap {
  const trimmed = text.trim();
  const hours = Number(trimmed);
  if (!/^\d+$/u.test(trimmed) || hours > MAX_OVERLAP_HOURS) {
    return { message: `Enter whole hours from 0 to ${MAX_OVERLAP_HOURS}.`, ok: false };
  }
  return { ok: true, seconds: hours * 3_600 };
}
