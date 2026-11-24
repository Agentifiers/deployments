import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  RotateWebhookSecretRequest,
  RUNTIME_API_ROUTES,
  RUNTIME_API_SCHEMAS,
  UpdateWebhookRequest,
  WebhookDeliveryResponse,
  WebhookResponse,
} from "./runtime.ts";

const route = (name: string) => RUNTIME_API_ROUTES.find((candidate) => candidate.name === name);

describe("webhook API contract", () => {
  test("registers every webhook operation with its path, method, and scope", () => {
    const expected = [
      ["listWebhooks", "GET", "/v1/webhooks", "webhooks:read"],
      ["createWebhook", "POST", "/v1/webhooks", "webhooks:write"],
      ["getWebhook", "GET", "/v1/webhooks/:webhookId", "webhooks:read"],
      ["updateWebhook", "PATCH", "/v1/webhooks/:webhookId", "webhooks:write"],
      ["archiveWebhook", "POST", "/v1/webhooks/:webhookId/archive", "webhooks:write"],
      ["disableWebhook", "POST", "/v1/webhooks/:webhookId/disable", "webhooks:write"],
      ["enableWebhook", "POST", "/v1/webhooks/:webhookId/enable", "webhooks:write"],
      ["rotateWebhookSecret", "POST", "/v1/webhooks/:webhookId/rotate-secret", "webhooks:write"],
      ["testWebhook", "POST", "/v1/webhooks/:webhookId/test", "webhooks:write"],
      ["listWebhookDeliveries", "GET", "/v1/webhook-deliveries", "webhooks:read"],
      ["getWebhookDelivery", "GET", "/v1/webhook-deliveries/:deliveryId", "webhooks:read"],
      [
        "listWebhookDeliveryAttempts",
        "GET",
        "/v1/webhook-deliveries/:deliveryId/attempts",
        "webhooks:read",
      ],
      [
        "retryWebhookDelivery",
        "POST",
        "/v1/webhook-deliveries/:deliveryId/retry",
        "webhooks:write",
      ],
    ] as const;
    for (const [name, method, path, scope] of expected) {
      expect(route(name)).toMatchObject({
        idempotency: "none",
        method,
        path,
        requiredAuthorization: scope,
        requiredScope: scope,
      });
    }
    for (const candidate of RUNTIME_API_ROUTES.filter((entry) => /webhook/iu.test(entry.name))) {
      expect(RUNTIME_API_SCHEMAS).toHaveProperty(candidate.responseBody);
      if ("requestBody" in candidate && candidate.requestBody) {
        expect(RUNTIME_API_SCHEMAS).toHaveProperty(candidate.requestBody);
      }
    }
    expect(route("rotateWebhookSecret")).toMatchObject({ requestBodyRequired: false });
    const deliveryList = route("listWebhookDeliveries");
    expect(
      deliveryList && "queryParameters" in deliveryList ? deliveryList.queryParameters : [],
    ).toContainEqual(expect.objectContaining({ name: "status" }));
  });

  test("requires at least one field to update and accepts null to clear filters", () => {
    const decode = Schema.decodeUnknownSync(UpdateWebhookRequest);
    expect(() => decode({})).toThrow("at least one field");
    expect(decode({ resourceFilters: null })).toEqual({ resourceFilters: null });
    expect(decode({ eventTypes: ["run.completed"], url: "https://hooks.example.com" })).toEqual({
      eventTypes: ["run.completed"],
      url: "https://hooks.example.com",
    });
    expect(() => decode({ eventTypes: [] })).toThrow();
    expect(() => decode({ name: " padded " })).toThrow();
  });

  test("bounds the previous secret overlap to seven days", () => {
    const decode = Schema.decodeUnknownSync(RotateWebhookSecretRequest);
    expect(decode({})).toEqual({});
    expect(decode({ previousSecretExpiresInSeconds: 0 })).toEqual({
      previousSecretExpiresInSeconds: 0,
    });
    expect(decode({ previousSecretExpiresInSeconds: 604_800 })).toEqual({
      previousSecretExpiresInSeconds: 604_800,
    });
    expect(() => decode({ previousSecretExpiresInSeconds: 604_801 })).toThrow();
    expect(() => decode({ previousSecretExpiresInSeconds: -1 })).toThrow();
    expect(() => decode({ previousSecretExpiresInSeconds: 1.5 })).toThrow();
  });

  test("projects endpoint health and delivery retention without internal fields", () => {
    expect(Object.keys(WebhookResponse.fields)).toEqual(
      expect.arrayContaining([
        "consecutiveFailures",
        "disabledAt",
        "disabledReason",
        "previousSigningSecretExpiresAt",
        "signingSecretRotatedAt",
      ]),
    );
    expect(Object.keys(WebhookResponse.fields)).not.toContain("signingSecretRef");
    expect(Object.keys(WebhookResponse.fields)).not.toContain("quotaSlot");
    expect(Object.keys(WebhookDeliveryResponse.fields)).toEqual(
      expect.arrayContaining(["eventType", "maxAttempts", "retentionExpiresAt"]),
    );
    expect(Object.keys(WebhookDeliveryResponse.fields)).not.toContain("claimId");
  });
});
