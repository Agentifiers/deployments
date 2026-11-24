import { BlockList, isIP } from "node:net";
import {
  ALERT_FIRED_EVENT,
  ALERT_RENOTIFIED_EVENT,
  ALERT_RESOLVED_EVENT,
  BUDGET_THRESHOLD_CROSSED_EVENT,
  MONITOR_TEST_EVENT,
  OPERATOR_FUNDED_SPEND_EXHAUSTED_EVENT,
  WebhookEndpointRecord,
  withCanonicalRecordKeys,
  type Ulid,
} from "@deployments-ai/db";
import type { SemanticEvent } from "@deployments-ai/events";
import { Schema } from "effect";

export type WebhookEndpoint = typeof WebhookEndpointRecord.Type;
export type WebhookEndpointStatus = WebhookEndpoint["data"]["status"];
export type WebhookEndpointDisabledReason = NonNullable<WebhookEndpoint["data"]["disabledReason"]>;

export interface WebhookResourceFilters {
  readonly aggregateIds?: readonly string[];
  readonly aggregateTypes?: readonly string[];
  readonly environmentIds?: readonly string[];
  readonly projectIds?: readonly string[];
}

export interface CreateWebhookEndpointOptions {
  readonly environmentId: Ulid;
  readonly eventTypes: readonly string[];
  readonly id: Ulid;
  readonly name: string;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly quotaSlot?: number;
  readonly resourceFilters?: WebhookResourceFilters;
  readonly signingSecretRef: WebhookEndpoint["data"]["signingSecretRef"];
  readonly url: string;
  readonly now?: Date;
}

/**
 * Full-record endpoint replacement. `null` clears an optional field; `undefined` keeps it.
 */
export interface WebhookEndpointUpdate {
  readonly consecutiveFailures?: number | null;
  readonly disabled?: { readonly at: Date; readonly reason: WebhookEndpointDisabledReason } | null;
  readonly eventTypes?: readonly string[];
  readonly name?: string;
  readonly previousSigningSecretExpiresAt?: Date | null;
  readonly resourceFilters?: WebhookResourceFilters | null;
  readonly signingSecretRef?: WebhookEndpoint["data"]["signingSecretRef"];
  readonly signingSecretRotatedAt?: Date;
  readonly status?: WebhookEndpointStatus;
  readonly url?: string;
  readonly now?: Date;
}

const GLOBAL_UNICAST_IPV6_ADDRESSES = new BlockList();
const SPECIAL_PURPOSE_IPV6_ADDRESSES = new BlockList();

GLOBAL_UNICAST_IPV6_ADDRESSES.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["::ffff:0:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:2::", 48],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  SPECIAL_PURPOSE_IPV6_ADDRESSES.addSubnet(address, prefix, "ipv6");
}

function isPublicWebhookHostname(hostname: string) {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, "$1")
    .replace(/\.$/u, "");
  if (!normalized || normalized === "localhost" || normalized.endsWith(".localhost")) return false;
  if (normalized === "metadata.google.internal") return false;
  const ipFamily = isIP(normalized);
  if (ipFamily === 6) {
    return (
      GLOBAL_UNICAST_IPV6_ADDRESSES.check(normalized, "ipv6") &&
      !SPECIAL_PURPOSE_IPV6_ADDRESSES.check(normalized, "ipv6")
    );
  }
  if (normalized.includes(":")) return false;
  const parts = normalized.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d+$/u.test(part))) return true;
  const octets = parts.map(Number);
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first = 0, second = 0, third = 0] = octets;
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && ((second === 0 && third === 0) || second === 168)) return false;
  if (first === 192 && second === 88 && third === 99) return false;
  if (first === 198 && (second === 18 || second === 19)) return false;
  if (first === 198 && second === 51 && third === 100) return false;
  if (first === 203 && second === 0 && third === 113) return false;
  return true;
}

export function normalizeWebhookUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Webhook URL must be a valid absolute URL.");
  }
  if (url.protocol !== "https:") throw new Error("Webhook URL must use https.");
  if (url.username || url.password) throw new Error("Webhook URL must not include credentials.");
  if (!isPublicWebhookHostname(url.hostname)) throw new Error("Webhook URL host must be public.");
  return url.toString();
}

export function normalizeWebhookEventTypes(eventTypes: readonly string[]) {
  const normalized = [...new Set(eventTypes.map((value) => value.trim()).filter(Boolean))];
  if (normalized.length === 0) throw new Error("At least one webhook event type is required.");
  return normalized.includes("*") ? ["*"] : normalized.toSorted();
}

const WEBHOOK_RESOURCE_FILTER_KEYS: Readonly<Record<string, true>> = {
  aggregateIds: true,
  aggregateTypes: true,
  environmentIds: true,
  projectIds: true,
};

export function normalizeWebhookResourceFilters(filters: WebhookResourceFilters) {
  const normalized: Record<string, readonly string[]> = {};
  for (const [name, values] of Object.entries(filters)) {
    if (!WEBHOOK_RESOURCE_FILTER_KEYS[name] || !Array.isArray(values)) {
      throw new Error(`Unsupported webhook resource filter: ${name}.`);
    }
    const entries = [
      ...new Set(values.map((value: string) => value.trim()).filter(Boolean)),
    ].toSorted();
    if (entries.length === 0) throw new Error(`Webhook resource filter ${name} must not be empty.`);
    normalized[name] = entries;
  }
  if (Object.keys(normalized).length === 0) {
    throw new Error("Webhook resource filters must contain at least one supported filter.");
  }
  return normalized as WebhookResourceFilters;
}

export function makeWebhookEndpointRecord(options: CreateWebhookEndpointOptions): WebhookEndpoint {
  if (
    options.quotaSlot !== undefined &&
    (!Number.isSafeInteger(options.quotaSlot) || options.quotaSlot < 0 || options.quotaSlot >= 100)
  ) {
    throw new Error("Webhook quota slot must be an integer from 0 to 99.");
  }
  const now = (options.now ?? new Date()).toISOString();
  return Schema.decodeUnknownSync(WebhookEndpointRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: now,
        environmentId: options.environmentId,
        eventTypes: normalizeWebhookEventTypes(options.eventTypes),
        id: options.id,
        name: options.name.trim(),
        organizationId: options.organizationId,
        projectId: options.projectId,
        ...(options.quotaSlot !== undefined ? { quotaSlot: options.quotaSlot } : {}),
        ...(options.resourceFilters
          ? { resourceFilters: normalizeWebhookResourceFilters(options.resourceFilters) }
          : {}),
        signingSecretRef: options.signingSecretRef,
        status: "active",
        updatedAt: now,
        url: normalizeWebhookUrl(options.url),
        version: 0,
      },
      itemType: "webhook-endpoint",
    }),
  );
}

export function replaceWebhookEndpointRecord(
  endpoint: WebhookEndpoint,
  update: WebhookEndpointUpdate,
): WebhookEndpoint {
  const {
    consecutiveFailures,
    disabledAt,
    disabledReason,
    previousSigningSecretExpiresAt,
    resourceFilters,
    ...retained
  } = endpoint.data;
  const nextResourceFilters =
    update.resourceFilters === undefined
      ? resourceFilters
      : update.resourceFilters === null
        ? undefined
        : normalizeWebhookResourceFilters(update.resourceFilters);
  const nextConsecutiveFailures =
    update.consecutiveFailures === undefined
      ? consecutiveFailures
      : (update.consecutiveFailures ?? undefined);
  const disabled =
    update.disabled === undefined
      ? disabledAt && disabledReason
        ? { at: disabledAt, reason: disabledReason }
        : undefined
      : update.disabled === null
        ? undefined
        : { at: update.disabled.at.toISOString(), reason: update.disabled.reason };
  const previousExpiresAt =
    update.previousSigningSecretExpiresAt === undefined
      ? previousSigningSecretExpiresAt
      : update.previousSigningSecretExpiresAt?.toISOString();
  return Schema.decodeUnknownSync(WebhookEndpointRecord)(
    withCanonicalRecordKeys({
      ...endpoint,
      data: {
        ...retained,
        ...(nextConsecutiveFailures ? { consecutiveFailures: nextConsecutiveFailures } : {}),
        ...(disabled ? { disabledAt: disabled.at, disabledReason: disabled.reason } : {}),
        ...(update.eventTypes ? { eventTypes: normalizeWebhookEventTypes(update.eventTypes) } : {}),
        ...(update.name !== undefined ? { name: update.name.trim() } : {}),
        ...(previousExpiresAt ? { previousSigningSecretExpiresAt: previousExpiresAt } : {}),
        ...(nextResourceFilters ? { resourceFilters: nextResourceFilters } : {}),
        ...(update.signingSecretRef ? { signingSecretRef: update.signingSecretRef } : {}),
        ...(update.signingSecretRotatedAt
          ? { signingSecretRotatedAt: update.signingSecretRotatedAt.toISOString() }
          : {}),
        ...(update.status ? { status: update.status } : {}),
        ...(update.url ? { url: normalizeWebhookUrl(update.url) } : {}),
        updatedAt: (update.now ?? new Date()).toISOString(),
        version: endpoint.data.version + 1,
      },
    }),
  );
}

function resourceFilterMatches(endpoint: WebhookEndpoint, event: SemanticEvent) {
  const filters = endpoint.data.resourceFilters;
  if (!filters) return true;
  let normalized: WebhookResourceFilters;
  try {
    normalized = normalizeWebhookResourceFilters(filters as WebhookResourceFilters);
  } catch {
    return false;
  }
  const values: Readonly<Record<keyof WebhookResourceFilters, string | undefined>> = {
    aggregateIds: event.aggregateId,
    aggregateTypes: event.aggregateType,
    environmentIds: event.environmentId,
    projectIds: event.projectId,
  };
  return Object.entries(normalized).every(([name, accepted]) => {
    const value = values[name as keyof WebhookResourceFilters];
    return value !== undefined && accepted?.includes(value) === true;
  });
}

/**
 * Billing alerts and organization-wide monitor alerts that belong to an organization or a project
 * rather than one environment. Every environment's endpoints may receive them, but only by naming
 * the type; `*` stays the environment's own events.
 */
export const ORGANIZATION_WEBHOOK_EVENT_TYPES: readonly string[] = [
  BUDGET_THRESHOLD_CROSSED_EVENT,
  OPERATOR_FUNDED_SPEND_EXHAUSTED_EVENT,
  ALERT_FIRED_EVENT,
  ALERT_RENOTIFIED_EVENT,
  ALERT_RESOLVED_EVENT,
  MONITOR_TEST_EVENT,
];

const ALERT_WEBHOOK_EVENT_TYPES: readonly string[] = [
  ALERT_FIRED_EVENT,
  ALERT_RENOTIFIED_EVENT,
  ALERT_RESOLVED_EVENT,
  MONITOR_TEST_EVENT,
];

/** An alert whose monitor does not notify webhooks, or was muted when it changed, reaches none. */
function alertWithheldFromWebhooks(event: SemanticEvent) {
  return (
    ALERT_WEBHOOK_EVENT_TYPES.includes(event.eventType) && event.payload.deliverWebhooks !== true
  );
}

/**
 * Whether an event's tenancy reaches an endpoint: an environment event reaches only its own
 * environment, and an organization or project billing alert reaches every environment of that
 * organization or project.
 */
export function webhookEventReachesEndpoint(endpoint: WebhookEndpoint, event: SemanticEvent) {
  if (endpoint.data.organizationId !== event.organizationId) return false;
  if (event.environmentId !== undefined) {
    return (
      endpoint.data.projectId === event.projectId &&
      endpoint.data.environmentId === event.environmentId
    );
  }
  return (
    ORGANIZATION_WEBHOOK_EVENT_TYPES.includes(event.eventType) &&
    (event.projectId === undefined || endpoint.data.projectId === event.projectId)
  );
}

export function webhookEndpointReceivesEvent(endpoint: WebhookEndpoint, event: SemanticEvent) {
  const types = endpoint.data.eventTypes;
  return (
    endpoint.data.status === "active" &&
    !alertWithheldFromWebhooks(event) &&
    webhookEventReachesEndpoint(endpoint, event) &&
    (types.includes(event.eventType) ||
      (event.environmentId !== undefined && types.includes("*"))) &&
    resourceFilterMatches(endpoint, event)
  );
}
