import type { CredentialVaultService } from "@deployments-ai/credential-vault";
import {
  WebhookWriteConflictError,
  type OrganizationHoldReader,
  type Ulid,
  type WebhookPersistence,
} from "@deployments-ai/db";
import { makeSemanticEventRecord } from "@deployments-ai/events";
import { admitConsistently } from "@deployments-ai/organization-admission";
import {
  activeWebhookSigningSecrets,
  applyWebhookDeliveryOutcome,
  claimWebhookDeliveryAttempt,
  deliverWebhookAttempt,
  failWebhookDelivery,
  type WebhookDelivery,
  type WebhookDeliveryFailureReason,
  type WebhookEndpoint,
  type WebhookRequestSender,
} from "@deployments-ai/webhooks";
import { Schema } from "effect";
import { WebhookDeliveryMessage } from "./webhook-runtime.ts";

const MAX_WEBHOOK_DELIVERY_CONCURRENCY = 5;
/** SQS caps a message's visibility timeout at twelve hours. */
const MAX_SQS_VISIBILITY_SECONDS = 43_200;
const MAX_CONFLICT_ROUNDS = 3;

type SecretsManagerSigningSecretReference = Extract<
  WebhookEndpoint["data"]["signingSecretRef"],
  { readonly arn: string }
>;

export interface WebhookDeliveryWorkerDependencies {
  /** Hides the message until its next attempt is due; the queue's redrive policy is a backstop. */
  readonly changeVisibility: (receiptHandle: string, visibilitySeconds: number) => Promise<void>;
  readonly credentialVault: CredentialVaultService;
  readonly emitMetrics?: (
    metrics: Readonly<Record<string, number>>,
    dimensions?: Readonly<Record<string, string>>,
  ) => void;
  readonly generateId: () => Promise<Ulid>;
  readonly now: () => Date;
  readonly persistence: WebhookPersistence;
  readonly random?: () => number;
  readonly readSecretsManagerSigningSecret?: (
    reference: SecretsManagerSigningSecretReference,
  ) => Promise<string>;
  readonly retentionDays: number;
  readonly sender: WebhookRequestSender;
  /** Deliveries of a suspended organization fail as `organization-suspended`. */
  readonly standing: OrganizationHoldReader;
}

export interface WebhookDeliveryQueueEvent {
  readonly Records: readonly {
    readonly body: string;
    readonly messageId: string;
    readonly receiptHandle: string;
  }[];
}

/** `done` deletes the message; `later` keeps it hidden for the given seconds. */
type MessageDisposition =
  | { readonly kind: "done" }
  | { readonly kind: "later"; readonly visibilitySeconds: number };

const DONE: MessageDisposition = { kind: "done" };

function laterAt(dueAt: Date | number, now: Date): MessageDisposition {
  const seconds = Math.ceil((new Date(dueAt).getTime() - now.getTime()) / 1_000);
  return {
    kind: "later",
    visibilitySeconds: Math.min(MAX_SQS_VISIBILITY_SECONDS, Math.max(1, seconds)),
  };
}

async function signingSecretValues(
  dependencies: WebhookDeliveryWorkerDependencies,
  endpoint: WebhookEndpoint,
): Promise<Readonly<Record<string, string>>> {
  const reference = endpoint.data.signingSecretRef;
  if ("store" in reference) {
    const secret = await dependencies.credentialVault.read({
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
    return secret.values;
  }
  if (!dependencies.readSecretsManagerSigningSecret) {
    throw new Error("Secrets Manager webhook signing secret reader is unavailable.");
  }
  return { signingSecret: await dependencies.readSecretsManagerSigningSecret(reference) };
}

/**
 * Counts a terminal delivery against its endpoint. Success resets the consecutive-failure
 * counter; reaching the threshold disables the endpoint and appends `webhook.endpoint.disabled`
 * in the same transaction. Lost races reload and re-apply.
 */
async function recordEndpointHealth(
  dependencies: WebhookDeliveryWorkerDependencies,
  delivery: WebhookDelivery,
  outcome: "delivered" | "failed",
) {
  const scope = {
    environmentId: delivery.data.environmentId,
    organizationId: delivery.data.organizationId,
  };
  for (let round = 0; round < MAX_CONFLICT_ROUNDS; round += 1) {
    const endpoint = await dependencies.persistence.readEndpoint(
      scope,
      delivery.data.webhookEndpointId,
    );
    if (!endpoint) return;
    const now = dependencies.now();
    const change = applyWebhookDeliveryOutcome(endpoint, outcome, now);
    if (change.kind === "unchanged") return;
    const events =
      change.kind === "disabled"
        ? [
            makeSemanticEventRecord({
              aggregateId: endpoint.data.id,
              aggregateType: "webhook-endpoint",
              aggregateVersion: await dependencies.persistence.nextEndpointEventVersion(
                endpoint.data.organizationId,
                endpoint.data.id,
              ),
              environmentId: endpoint.data.environmentId,
              eventId: await dependencies.generateId(),
              eventType: "webhook.endpoint.disabled",
              occurredAt: now,
              organizationId: endpoint.data.organizationId,
              payload: {
                consecutiveFailures: change.record.data.consecutiveFailures ?? 0,
                reason: "consecutive-failures",
                webhookEndpointId: endpoint.data.id,
              },
              projectId: endpoint.data.projectId,
            }),
          ]
        : [];
    try {
      await dependencies.persistence.replaceEndpoint(endpoint, change.record, events);
      if (change.kind === "disabled") dependencies.emitMetrics?.({ EndpointsAutoDisabled: 1 });
      return;
    } catch (cause) {
      if (!(cause instanceof WebhookWriteConflictError)) throw cause;
    }
  }
  throw new Error("Webhook endpoint health did not settle.");
}

async function failDelivery(
  dependencies: WebhookDeliveryWorkerDependencies,
  delivery: WebhookDelivery,
  reason: Exclude<WebhookDeliveryFailureReason, "non-retryable">,
  message: string,
) {
  await dependencies.persistence.replaceDelivery(
    delivery,
    failWebhookDelivery(delivery, reason, message, dependencies.now()),
  );
  dependencies.emitMetrics?.({ DeliveriesFailed: 1 }, { Reason: reason });
}

/** Runs at most one attempt for one queue message and decides the message's fate. */
async function processDeliveryMessage(
  dependencies: WebhookDeliveryWorkerDependencies,
  message: WebhookDeliveryMessage,
): Promise<MessageDisposition> {
  const scope = { environmentId: message.environmentId, organizationId: message.organizationId };
  const { decision: standing } = await admitConsistently({
    activity: "outbound.deliver",
    organizationId: message.organizationId,
    standing: dependencies.standing,
  });
  for (let round = 0; round < MAX_CONFLICT_ROUNDS; round += 1) {
    const delivery = await dependencies.persistence.readDelivery(scope, message.deliveryId);
    // A missing record expired or was erased; terminal records need no further work.
    if (!delivery || delivery.data.status === "delivered" || delivery.data.status === "failed") {
      return DONE;
    }
    const endpoint = await dependencies.persistence.readEndpoint(
      scope,
      delivery.data.webhookEndpointId,
    );
    const claim = claimWebhookDeliveryAttempt({
      claimId: await dependencies.generateId(),
      delivery,
      now: dependencies.now(),
    });
    try {
      // An in-flight attempt keeps its lease; anything else for an inactive endpoint or a
      // suspended organization ends now and can be retried manually once that changes.
      const inFlight = claim.kind === "wait" && delivery.data.status === "sending";
      if (endpoint?.data.status !== "active" && !inFlight) {
        await failDelivery(
          dependencies,
          delivery,
          "endpoint-inactive",
          "Webhook endpoint is not active.",
        );
        return DONE;
      }
      if (standing.kind === "suspended" && !inFlight) {
        await failDelivery(
          dependencies,
          delivery,
          "organization-suspended",
          "The organization is suspended.",
        );
        return DONE;
      }
      if (claim.kind === "wait") return laterAt(claim.dueAt, dependencies.now());
      if (!endpoint) return DONE;
      if (claim.kind === "terminal") {
        await failDelivery(
          dependencies,
          delivery,
          "attempts-exhausted",
          "Webhook delivery exhausted its attempts.",
        );
        return DONE;
      }
      await dependencies.persistence.replaceDelivery(delivery, claim.record, {
        activeEndpoint: endpoint,
      });
    } catch (cause) {
      if (cause instanceof WebhookWriteConflictError) continue;
      throw cause;
    }
    return attemptClaimedDelivery(dependencies, claim.record, endpoint);
  }
  // Every round lost a race to another worker; look again once its lease could have expired.
  return { kind: "later", visibilitySeconds: 60 };
}

async function attemptClaimedDelivery(
  dependencies: WebhookDeliveryWorkerDependencies,
  claimed: WebhookDelivery,
  endpoint: WebhookEndpoint,
): Promise<MessageDisposition> {
  const event = await dependencies.persistence.readSemanticEvent({
    aggregateId: claimed.data.aggregateId,
    aggregateType: claimed.data.aggregateType,
    aggregateVersion: claimed.data.aggregateVersion,
    organizationId: claimed.data.organizationId,
  });
  if (!event || event.data.eventId !== claimed.data.eventId) {
    await failDelivery(
      dependencies,
      claimed,
      "event-unavailable",
      "The semantic event for this delivery is no longer available.",
    );
    return DONE;
  }
  // A secret read failure leaves the claim to expire; the message returns after the queue's
  // visibility timeout and the expired lease is reclaimed without spending another attempt.
  const values = await signingSecretValues(dependencies, endpoint);
  const outcome = await deliverWebhookAttempt({
    claimId: claimed.data.claimId!,
    clock: dependencies.now,
    delivery: claimed,
    endpoint,
    event: event.data,
    ...(dependencies.random ? { random: dependencies.random } : {}),
    retentionDays: dependencies.retentionDays,
    sender: dependencies.sender,
    signingSecrets: activeWebhookSigningSecrets(endpoint, values, dependencies.now()),
  });
  if (outcome.kind === "not-claimed") return laterAt(dependencies.now(), dependencies.now());
  try {
    await dependencies.persistence.replaceDelivery(claimed, outcome.record, {
      attempt: outcome.attempt,
    });
  } catch (cause) {
    // Our lease expired mid-request and another worker reclaimed the same attempt; it owns the
    // outcome now. The receiver may see this event twice, which at-least-once permits.
    if (cause instanceof WebhookWriteConflictError) return DONE;
    throw cause;
  }
  dependencies.emitMetrics?.(
    { DeliveryAttempts: 1, DeliveryLatencyMs: outcome.attempt.data.durationMs },
    { Outcome: outcome.kind },
  );
  if (outcome.kind === "retrying") {
    return laterAt(Date.parse(outcome.record.data.nextAttemptAt!), dependencies.now());
  }
  if (outcome.kind === "failed") {
    dependencies.emitMetrics?.(
      { DeliveriesFailed: 1 },
      { Reason: outcome.record.data.failureReason ?? "non-retryable" },
    );
  }
  try {
    await recordEndpointHealth(dependencies, outcome.record, outcome.kind);
  } catch (cause) {
    // The delivery outcome is durable; a health counter that misses one update self-corrects on
    // the endpoint's next terminal outcome, so it never blocks message completion.
    console.error(
      JSON.stringify({
        deliveryId: claimed.data.id,
        error: cause instanceof Error ? cause.message : String(cause),
        message: "Webhook endpoint health update failed.",
      }),
    );
  }
  return DONE;
}

/**
 * SQS event source handler. Each message is one delivery; failures are reported per item and
 * hidden until their next attempt, so one slow or failing endpoint never delays another.
 */
export async function handleWebhookDeliveryMessages(
  input: WebhookDeliveryQueueEvent,
  dependencies: WebhookDeliveryWorkerDependencies,
) {
  const failures: { itemIdentifier: string }[] = [];
  let next = 0;
  async function worker() {
    for (;;) {
      const record = input.Records[next];
      next += 1;
      if (!record) return;
      let disposition: MessageDisposition | undefined;
      try {
        disposition = await processDeliveryMessage(
          dependencies,
          Schema.decodeUnknownSync(WebhookDeliveryMessage)(JSON.parse(record.body) as unknown),
        );
      } catch (cause) {
        console.error(
          JSON.stringify({
            error: cause instanceof Error ? cause.message : String(cause),
            message: "Webhook delivery message failed.",
            messageId: record.messageId,
          }),
        );
      }
      if (disposition?.kind === "done") continue;
      failures.push({ itemIdentifier: record.messageId });
      if (disposition?.kind === "later") {
        await dependencies
          .changeVisibility(record.receiptHandle, disposition.visibilitySeconds)
          .catch(() => undefined);
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(MAX_WEBHOOK_DELIVERY_CONCURRENCY, input.Records.length) },
      worker,
    ),
  );
  return { batchItemFailures: failures };
}
