import type {
  CreateWebhookSubscriptionRequest,
  RotateWebhookSecretRequest,
} from "@deployments-ai/api-contract/runtime";
import { createServerFn } from "@tanstack/react-start";
import { requireAccessToken } from "../server/session.ts";
import {
  archiveWebhook,
  createWebhook,
  disableWebhook,
  enableWebhook,
  retryDelivery,
  rotateWebhookSecret,
  testWebhook,
  updateWebhook,
} from "../server/webhook-actions.ts";
import type { EndpointChanges } from "../webhooks/webhook-state.ts";
import { requireBody, scopedInput, type ScopedInput } from "./server-input.ts";

interface EndpointInput extends ScopedInput {
  readonly webhookId: string;
}

function endpointBodyInput(input: unknown) {
  return { ...scopedInput(input, ["webhookId"]), body: requireBody(input) };
}

export const createWebhookFn = createServerFn({ method: "POST" })
  .validator(
    (input: ScopedInput & { readonly body: typeof CreateWebhookSubscriptionRequest.Encoded }) => ({
      ...scopedInput(input),
      body: requireBody(input),
    }),
  )
  .handler(async ({ data }) => createWebhook({ ...data, accessToken: await requireAccessToken() }));

export const updateWebhookFn = createServerFn({ method: "POST" })
  .validator((input: EndpointInput & { readonly body: EndpointChanges }) =>
    endpointBodyInput(input),
  )
  .handler(async ({ data }) => updateWebhook({ ...data, accessToken: await requireAccessToken() }));

export const rotateWebhookSecretFn = createServerFn({ method: "POST" })
  .validator(
    (input: EndpointInput & { readonly body: typeof RotateWebhookSecretRequest.Encoded }) =>
      endpointBodyInput(input),
  )
  .handler(async ({ data }) =>
    rotateWebhookSecret({ ...data, accessToken: await requireAccessToken() }),
  );

export const disableWebhookFn = createServerFn({ method: "POST" })
  .validator((input: EndpointInput) => scopedInput(input, ["webhookId"]))
  .handler(async ({ data }) =>
    disableWebhook({ ...data, accessToken: await requireAccessToken() }),
  );

export const enableWebhookFn = createServerFn({ method: "POST" })
  .validator((input: EndpointInput) => scopedInput(input, ["webhookId"]))
  .handler(async ({ data }) => enableWebhook({ ...data, accessToken: await requireAccessToken() }));

export const testWebhookFn = createServerFn({ method: "POST" })
  .validator((input: EndpointInput) => scopedInput(input, ["webhookId"]))
  .handler(async ({ data }) => testWebhook({ ...data, accessToken: await requireAccessToken() }));

export const archiveWebhookFn = createServerFn({ method: "POST" })
  .validator((input: EndpointInput) => scopedInput(input, ["webhookId"]))
  .handler(async ({ data }) =>
    archiveWebhook({ ...data, accessToken: await requireAccessToken() }),
  );

export const retryDeliveryFn = createServerFn({ method: "POST" })
  .validator((input: ScopedInput & { readonly deliveryId: string }) =>
    scopedInput(input, ["deliveryId"]),
  )
  .handler(async ({ data }) => retryDelivery({ ...data, accessToken: await requireAccessToken() }));
