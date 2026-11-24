import type { UpdateWebhookRequest } from "@deployments-ai/api-contract/runtime";
import type { Ulid } from "@deployments-ai/db";
import { replaceWebhookEndpointRecord, type WebhookEndpointUpdate } from "@deployments-ai/webhooks";
import {
  assertWebhookNotArchived,
  commitWebhookMutation,
  loadWebhook,
  normalizedWebhookUrl,
  publicWebhook,
  requestedResourceFilters,
  webhookEndpointEvent,
  type WebhookEndpoint,
} from "./webhook-operations.ts";
import {
  RuntimeApiError,
  type RuntimeApiDependencies,
  type RuntimeApiPrincipal,
} from "./runtime-support.ts";

async function replaceWebhook(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  previous: WebhookEndpoint,
  update: WebhookEndpointUpdate & { readonly now: Date },
  event: { readonly eventType: string; readonly payload: Readonly<Record<string, unknown>> },
) {
  let replacement: WebhookEndpoint;
  try {
    replacement = replaceWebhookEndpointRecord(previous, update);
  } catch (cause) {
    throw new RuntimeApiError(
      400,
      "invalid_webhook_subscription",
      cause instanceof Error ? cause.message : "Webhook subscription is invalid.",
    );
  }
  const semanticEvent = await webhookEndpointEvent(dependencies, principal, {
    ...event,
    now: update.now,
    webhookId: previous.data.id,
  });
  await commitWebhookMutation(
    dependencies,
    [{ kind: "put", previousRecord: previous, record: replacement }],
    [semanticEvent],
  );
  return publicWebhook(replacement);
}

export async function updateWebhook(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  webhookId: Ulid,
  input: UpdateWebhookRequest,
) {
  const previous = await loadWebhook(dependencies, principal, webhookId);
  assertWebhookNotArchived(previous);
  return replaceWebhook(
    dependencies,
    principal,
    previous,
    {
      ...(input.eventTypes ? { eventTypes: input.eventTypes } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.resourceFilters !== undefined
        ? {
            resourceFilters:
              input.resourceFilters === null
                ? null
                : requestedResourceFilters(input.resourceFilters),
          }
        : {}),
      ...(input.url !== undefined ? { url: normalizedWebhookUrl(input.url) } : {}),
      now: dependencies.now?.() ?? new Date(),
    },
    {
      eventType: "webhook.endpoint.updated",
      payload: { changedFields: Object.keys(input).toSorted(), webhookEndpointId: webhookId },
    },
  );
}

/** Manual pause; the endpoint keeps its quota slot and secret. Disabling twice is a no-op. */
export async function disableWebhook(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  webhookId: Ulid,
) {
  const previous = await loadWebhook(dependencies, principal, webhookId);
  assertWebhookNotArchived(previous);
  if (previous.data.status === "disabled") return publicWebhook(previous);
  const now = dependencies.now?.() ?? new Date();
  return replaceWebhook(
    dependencies,
    principal,
    previous,
    { disabled: { at: now, reason: "manual" }, now, status: "disabled" },
    {
      eventType: "webhook.endpoint.disabled",
      payload: { reason: "manual", webhookEndpointId: webhookId },
    },
  );
}

/** Resumes deliveries and resets the failure streak, whatever disabled the endpoint. */
export async function enableWebhook(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  webhookId: Ulid,
) {
  const previous = await loadWebhook(dependencies, principal, webhookId);
  assertWebhookNotArchived(previous);
  if (previous.data.status === "active") return publicWebhook(previous);
  return replaceWebhook(
    dependencies,
    principal,
    previous,
    {
      consecutiveFailures: null,
      disabled: null,
      now: dependencies.now?.() ?? new Date(),
      status: "active",
    },
    { eventType: "webhook.endpoint.enabled", payload: { webhookEndpointId: webhookId } },
  );
}
