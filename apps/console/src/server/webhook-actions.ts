import "@tanstack/react-start/server-only";
import type { EnvironmentScope } from "../scope.ts";
import type { ShownOnce } from "../shown-once.ts";
import type { DeliveryView, WebhookEndpoint } from "../webhooks/webhook-state.ts";
import { callRoute } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";
import { deliveryView } from "./webhook-data.ts";

export interface WebhookMutation {
  readonly accessToken: string;
  readonly scope: EnvironmentScope;
}

export interface EndpointMutation extends WebhookMutation {
  readonly webhookId: string;
}

export function shownOnce({
  signingSecret,
  ...view
}: WebhookEndpoint & { readonly signingSecret: string }): ShownOnce<WebhookEndpoint> {
  return { secret: signingSecret, view };
}

export async function createWebhook({
  accessToken,
  body,
  scope,
}: WebhookMutation & { readonly body: unknown }): Promise<ShownOnce<WebhookEndpoint>> {
  return shownOnce(
    await callRoute(
      "createWebhook",
      {
        body: decodeRequestBody("createWebhook", "CreateWebhookSubscriptionRequest", body),
        scope,
      },
      accessToken,
    ),
  );
}

export async function rotateWebhookSecret({
  accessToken,
  body,
  scope,
  webhookId,
}: EndpointMutation & { readonly body: unknown }): Promise<ShownOnce<WebhookEndpoint>> {
  return shownOnce(
    await callRoute(
      "rotateWebhookSecret",
      {
        body: decodeRequestBody("rotateWebhookSecret", "RotateWebhookSecretRequest", body),
        path: { webhookId },
        scope,
      },
      accessToken,
    ),
  );
}

export function updateWebhook({
  accessToken,
  body,
  scope,
  webhookId,
}: EndpointMutation & { readonly body: unknown }) {
  return callRoute(
    "updateWebhook",
    {
      body: decodeRequestBody("updateWebhook", "UpdateWebhookRequest", body),
      path: { webhookId },
      scope,
    },
    accessToken,
  );
}

export function disableWebhook({ accessToken, scope, webhookId }: EndpointMutation) {
  return callRoute("disableWebhook", { path: { webhookId }, scope }, accessToken);
}

export function enableWebhook({ accessToken, scope, webhookId }: EndpointMutation) {
  return callRoute("enableWebhook", { path: { webhookId }, scope }, accessToken);
}

export function testWebhook({ accessToken, scope, webhookId }: EndpointMutation) {
  return callRoute("testWebhook", { path: { webhookId }, scope }, accessToken);
}

export function archiveWebhook({ accessToken, scope, webhookId }: EndpointMutation) {
  return callRoute("archiveWebhook", { path: { webhookId }, scope }, accessToken);
}

export async function retryDelivery({
  accessToken,
  deliveryId,
  scope,
}: WebhookMutation & { readonly deliveryId: string }): Promise<DeliveryView> {
  return deliveryView(
    await callRoute("retryWebhookDelivery", { path: { deliveryId }, scope }, accessToken),
  );
}
