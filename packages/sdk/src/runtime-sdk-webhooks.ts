import type {
  CreateWebhookResponse,
  ListWebhookDeliveriesResponse,
  ListWebhookDeliveryAttemptsResponse,
  ListWebhooksResponse,
  RotateWebhookSecretRequest,
  RotateWebhookSecretResponse,
  TestWebhookResponse,
  UpdateWebhookRequest,
  WebhookDeliveryResponse,
  WebhookResponse,
} from "@deployments-ai/api-contract/runtime";
import type { PlatformResponse, PlatformSdk } from "./index.ts";
import { type RuntimeListOptions, segment } from "./runtime-sdk-client.ts";

export interface CreateWebhookSubscriptionInput {
  readonly eventTypes: readonly string[];
  readonly name: string;
  readonly resourceFilters?: {
    readonly aggregateIds?: readonly string[];
    readonly aggregateTypes?: readonly string[];
    readonly environmentIds?: readonly string[];
    readonly projectIds?: readonly string[];
  };
  readonly url: string;
}
export type UpdateWebhookInput = typeof UpdateWebhookRequest.Encoded;
export type RotateWebhookSecretInput = typeof RotateWebhookSecretRequest.Encoded;
export interface RuntimeWebhookDeliveryListOptions extends RuntimeListOptions {
  readonly status?: "delivered" | "failed" | "pending" | "retrying" | "sending";
  readonly webhookId?: string;
}

export interface RuntimeWebhooksSdk {
  list(options?: RuntimeListOptions): Promise<PlatformResponse<ListWebhooksResponse>>;
  create(input: CreateWebhookSubscriptionInput): Promise<PlatformResponse<CreateWebhookResponse>>;
  get(webhookId: string): Promise<PlatformResponse<WebhookResponse>>;
  update(webhookId: string, input: UpdateWebhookInput): Promise<PlatformResponse<WebhookResponse>>;
  archive(webhookId: string): Promise<PlatformResponse<WebhookResponse>>;
  disable(webhookId: string): Promise<PlatformResponse<WebhookResponse>>;
  enable(webhookId: string): Promise<PlatformResponse<WebhookResponse>>;
  rotateSecret(
    webhookId: string,
    input?: RotateWebhookSecretInput,
  ): Promise<PlatformResponse<RotateWebhookSecretResponse>>;
  test(webhookId: string): Promise<PlatformResponse<TestWebhookResponse>>;
}

export interface RuntimeWebhookDeliveriesSdk {
  list(
    options?: RuntimeWebhookDeliveryListOptions,
  ): Promise<PlatformResponse<ListWebhookDeliveriesResponse>>;
  get(deliveryId: string): Promise<PlatformResponse<WebhookDeliveryResponse>>;
  listAttempts(
    deliveryId: string,
    options?: RuntimeListOptions,
  ): Promise<PlatformResponse<ListWebhookDeliveryAttemptsResponse>>;
  retry(deliveryId: string): Promise<PlatformResponse<WebhookDeliveryResponse>>;
}

type RuntimeRequest = <T>(
  input: Parameters<PlatformSdk["request"]>[0],
) => Promise<PlatformResponse<T>>;

export function createRuntimeWebhooksSdk(request: RuntimeRequest): RuntimeWebhooksSdk {
  const webhookPath = (webhookId: string, action?: string) =>
    `/v1/webhooks/${segment(webhookId)}${action ? `/${action}` : ""}`;
  return {
    list: (options = {}) =>
      request({
        method: "GET",
        path: "/v1/webhooks",
        query: { cursor: options.cursor, limit: options.limit },
      }),
    create: (body) => request({ method: "POST", path: "/v1/webhooks", body }),
    get: (webhookId) => request({ method: "GET", path: webhookPath(webhookId) }),
    update: (webhookId, body) => request({ method: "PATCH", path: webhookPath(webhookId), body }),
    archive: (webhookId) => request({ method: "POST", path: webhookPath(webhookId, "archive") }),
    disable: (webhookId) => request({ method: "POST", path: webhookPath(webhookId, "disable") }),
    enable: (webhookId) => request({ method: "POST", path: webhookPath(webhookId, "enable") }),
    rotateSecret: (webhookId, body = {}) =>
      request({ method: "POST", path: webhookPath(webhookId, "rotate-secret"), body }),
    test: (webhookId) => request({ method: "POST", path: webhookPath(webhookId, "test") }),
  };
}

export function createRuntimeWebhookDeliveriesSdk(
  request: RuntimeRequest,
): RuntimeWebhookDeliveriesSdk {
  return {
    list: (options = {}) =>
      request({
        method: "GET",
        path: "/v1/webhook-deliveries",
        query: {
          cursor: options.cursor,
          limit: options.limit,
          status: options.status,
          webhookId: options.webhookId,
        },
      }),
    get: (deliveryId) =>
      request({ method: "GET", path: `/v1/webhook-deliveries/${segment(deliveryId)}` }),
    listAttempts: (deliveryId, options = {}) =>
      request({
        method: "GET",
        path: `/v1/webhook-deliveries/${segment(deliveryId)}/attempts`,
        query: { cursor: options.cursor, limit: options.limit },
      }),
    retry: (deliveryId) =>
      request({ method: "POST", path: `/v1/webhook-deliveries/${segment(deliveryId)}/retry` }),
  };
}
