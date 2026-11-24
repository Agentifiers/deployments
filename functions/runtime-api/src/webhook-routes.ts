import {
  webhookSecretRotationRequest,
  webhookSubscriptionRequest,
  webhookUpdateRequest,
} from "./request-validation.ts";
import type { RuntimeRouteContext } from "./runtime-handler.ts";
import { id, requireScope, response, type HttpApiResult } from "./runtime-support.ts";
import {
  getWebhookDelivery,
  listWebhookDeliveries,
  listWebhookDeliveryAttempts,
  retryWebhookDelivery,
} from "./webhook-delivery-operations.ts";
import { disableWebhook, enableWebhook, updateWebhook } from "./webhook-endpoint-mutations.ts";
import {
  archiveWebhook,
  createWebhook,
  getWebhook,
  listWebhooks,
  requestedResourceFilters,
} from "./webhook-operations.ts";
import { rotateWebhookSecret, testWebhook } from "./webhook-secret-operations.ts";

const WEBHOOK_ACTION_PATH =
  /^\/v1\/webhooks\/([^/]+)\/(archive|disable|enable|rotate-secret|test)$/u;
const WEBHOOK_PATH = /^\/v1\/webhooks\/([^/]+)$/u;
const WEBHOOK_DELIVERY_PATH = /^\/v1\/webhook-deliveries\/([^/]+)$/u;
const WEBHOOK_DELIVERY_ACTION_PATH = /^\/v1\/webhook-deliveries\/([^/]+)\/(attempts|retry)$/u;

export async function handleWebhookRoutes(
  context: RuntimeRouteContext,
): Promise<HttpApiResult | undefined> {
  const { body, dependencies, event, method, path, principal } = context;
  const query = event.queryStringParameters ?? {};
  let match: RegExpExecArray | null;

  if (path === "/v1/webhooks") {
    if (method === "GET") {
      requireScope(principal, "webhooks:read");
      return response(200, await listWebhooks(dependencies, principal, query));
    }
    if (method === "POST") {
      requireScope(principal, "webhooks:write");
      const input = webhookSubscriptionRequest(body);
      return response(
        201,
        await createWebhook(dependencies, principal, {
          eventTypes: input.eventTypes,
          name: input.name,
          ...(input.resourceFilters
            ? { resourceFilters: requestedResourceFilters(input.resourceFilters) }
            : {}),
          url: input.url,
        }),
      );
    }
  }
  if ((match = WEBHOOK_PATH.exec(path))) {
    const webhookId = id(match[1], "webhookId");
    if (method === "GET") {
      requireScope(principal, "webhooks:read");
      return response(200, await getWebhook(dependencies, principal, webhookId));
    }
    if (method === "PATCH") {
      requireScope(principal, "webhooks:write");
      const input = webhookUpdateRequest(body);
      return response(200, await updateWebhook(dependencies, principal, webhookId, input));
    }
  }
  if (method === "POST" && (match = WEBHOOK_ACTION_PATH.exec(path))) {
    requireScope(principal, "webhooks:write");
    const webhookId = id(match[1], "webhookId");
    switch (match[2]) {
      case "archive":
        return response(200, await archiveWebhook(dependencies, principal, webhookId));
      case "disable":
        return response(200, await disableWebhook(dependencies, principal, webhookId));
      case "enable":
        return response(200, await enableWebhook(dependencies, principal, webhookId));
      case "rotate-secret":
        return response(
          200,
          await rotateWebhookSecret(
            dependencies,
            principal,
            webhookId,
            webhookSecretRotationRequest(body),
          ),
        );
      default:
        return response(200, await testWebhook(dependencies, principal, webhookId));
    }
  }
  if (method === "GET" && path === "/v1/webhook-deliveries") {
    requireScope(principal, "webhooks:read");
    return response(200, await listWebhookDeliveries(dependencies, principal, query));
  }
  if (method === "GET" && (match = WEBHOOK_DELIVERY_PATH.exec(path))) {
    requireScope(principal, "webhooks:read");
    return response(
      200,
      await getWebhookDelivery(dependencies, principal, id(match[1], "deliveryId")),
    );
  }
  if ((match = WEBHOOK_DELIVERY_ACTION_PATH.exec(path))) {
    const deliveryId = id(match[1], "deliveryId");
    if (method === "GET" && match[2] === "attempts") {
      requireScope(principal, "webhooks:read");
      return response(
        200,
        await listWebhookDeliveryAttempts(dependencies, principal, deliveryId, query),
      );
    }
    if (method === "POST" && match[2] === "retry") {
      requireScope(principal, "webhooks:write");
      return response(200, await retryWebhookDelivery(dependencies, principal, deliveryId));
    }
  }
  return undefined;
}
