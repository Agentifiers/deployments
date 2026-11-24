import { DEFAULT_WEBHOOK_PREVIOUS_SECRET_EXPIRES_IN_SECONDS } from "@deployments-ai/api-contract/runtime";
import type { CredentialVaultReference, Ulid } from "@deployments-ai/db";
import { normalizePublicHttpsUrl } from "@deployments-ai/net-security";
import {
  activeWebhookSigningSecrets,
  replaceWebhookEndpointRecord,
  rotateWebhookSigningSecretValues,
  webhookRequestHeaders,
} from "@deployments-ai/webhooks";
import { createPinnedWebhookSender } from "./webhook-runtime.ts";
import {
  assertWebhookNotArchived,
  commitWebhookMutation,
  credentialVault,
  loadWebhook,
  publicWebhook,
  webhookEndpointEvent,
  type WebhookEndpoint,
} from "./webhook-operations.ts";
import {
  RuntimeApiError,
  type RuntimeApiDependencies,
  type RuntimeApiPrincipal,
} from "./runtime-support.ts";

const WEBHOOK_TEST_TIMEOUT_MS = 10_000;

/** Webhook signing secrets the API manages; Secrets Manager references are operator-owned. */
function vaultSigningSecretRef(endpoint: WebhookEndpoint): CredentialVaultReference {
  const reference = endpoint.data.signingSecretRef;
  if (!("store" in reference)) {
    throw new RuntimeApiError(
      409,
      "webhook_secret_externally_managed",
      "This webhook subscription's signing secret is managed outside the platform.",
    );
  }
  return reference;
}

async function readSigningSecretValues(
  dependencies: RuntimeApiDependencies,
  endpoint: WebhookEndpoint,
  reference: CredentialVaultReference,
) {
  return credentialVault(dependencies).read({
    environmentId: endpoint.data.environmentId,
    expectedIdentity: {
      ownerId: endpoint.data.id,
      ownerType: "webhook-endpoint",
      projectId: endpoint.data.projectId,
      purpose: "webhook-signing",
    },
    organizationId: endpoint.data.organizationId,
    reference,
  });
}

/**
 * Replaces the signing secret. The outgoing secret keeps signing (as a second signature) until
 * `previousSecretExpiresInSeconds` elapses; zero revokes it immediately. The vault generation,
 * endpoint reference, and semantic event commit in one transaction.
 */
export async function rotateWebhookSecret(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  webhookId: Ulid,
  input: { readonly previousSecretExpiresInSeconds?: number | undefined },
) {
  const previous = await loadWebhook(dependencies, principal, webhookId);
  assertWebhookNotArchived(previous);
  const reference = vaultSigningSecretRef(previous);
  const vault = credentialVault(dependencies);
  const current = await readSigningSecretValues(dependencies, previous, reference);
  const overlapSeconds =
    input.previousSecretExpiresInSeconds ?? DEFAULT_WEBHOOK_PREVIOUS_SECRET_EXPIRES_IN_SECONDS;
  const values = rotateWebhookSigningSecretValues(current.values, overlapSeconds * 1_000);
  const prepared = await vault.prepareWrite({
    expectedGeneration: reference.generation,
    identity: {
      credentialId: reference.credentialId,
      environmentId: previous.data.environmentId,
      organizationId: previous.data.organizationId,
      ownerId: previous.data.id,
      ownerType: "webhook-endpoint",
      projectId: previous.data.projectId,
      purpose: "webhook-signing",
    },
    secret: { values: { ...values } },
  });
  const now = dependencies.now?.() ?? new Date();
  const previousSecretExpiresAt =
    overlapSeconds > 0 ? new Date(now.getTime() + overlapSeconds * 1_000) : null;
  const replacement = replaceWebhookEndpointRecord(previous, {
    now,
    previousSigningSecretExpiresAt: previousSecretExpiresAt,
    signingSecretRef: prepared.reference,
    signingSecretRotatedAt: now,
  });
  const event = await webhookEndpointEvent(dependencies, principal, {
    eventType: "webhook.endpoint.secret-rotated",
    now,
    payload: {
      ...(previousSecretExpiresAt
        ? { previousSecretExpiresAt: previousSecretExpiresAt.toISOString() }
        : {}),
      webhookEndpointId: webhookId,
    },
    webhookId,
  });
  await commitWebhookMutation(
    dependencies,
    [prepared.operation, { kind: "put", previousRecord: previous, record: replacement }],
    [event],
  );
  return { ...publicWebhook(replacement), signingSecret: values.signingSecret };
}

/**
 * Sends one signed synthetic `webhook.test` envelope synchronously through the pinned, SSRF-safe
 * sender. Nothing is persisted; destination refusals and failures report `delivered: false`.
 */
export async function testWebhook(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  webhookId: Ulid,
) {
  const endpoint = await loadWebhook(dependencies, principal, webhookId);
  assertWebhookNotArchived(endpoint);
  const secret = await readSigningSecretValues(
    dependencies,
    endpoint,
    vaultSigningSecretRef(endpoint),
  );
  const [eventId, deliveryId] = await Promise.all([
    dependencies.generateId(),
    dependencies.generateId(),
  ]);
  const now = dependencies.now?.() ?? new Date();
  const body = JSON.stringify({
    aggregateId: webhookId,
    aggregateType: "webhook-endpoint",
    aggregateVersion: 1,
    deliveryId,
    endpointId: webhookId,
    eventId,
    eventType: "webhook.test",
    occurredAt: now.toISOString(),
    organizationId: endpoint.data.organizationId,
    payload: { test: true, webhookEndpointId: webhookId },
    source: "deployments-ai.platform",
    version: 1,
  });
  const headers = webhookRequestHeaders({
    body,
    deliveryId,
    eventId,
    eventType: "webhook.test",
    signingSecrets: activeWebhookSigningSecrets(endpoint, secret.values, now),
    timestampMs: now.getTime(),
  });
  const sender = dependencies.webhookSender ?? createPinnedWebhookSender();
  const startedAt = performance.now();
  const durationMs = () => Math.max(0, Math.round(performance.now() - startedAt));
  try {
    const response = await sender.send({
      body,
      headers,
      timeoutMs: WEBHOOK_TEST_TIMEOUT_MS,
      url: normalizePublicHttpsUrl(endpoint.data.url),
    });
    await response.body?.cancel().catch(() => undefined);
    const delivered = response.status >= 200 && response.status < 300;
    return {
      delivered,
      durationMs: durationMs(),
      eventId,
      responseStatus: response.status,
      ...(delivered ? {} : { error: `The endpoint responded with HTTP ${response.status}.` }),
    };
  } catch (cause) {
    return {
      delivered: false,
      durationMs: durationMs(),
      error: cause instanceof Error ? cause.message : "The test delivery failed.",
      eventId,
    };
  }
}
