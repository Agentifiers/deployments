import {
  key,
  makeWebhookPersistence,
  webhookDeliveryAttemptPartition,
  WebhookWriteConflictError,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { rearmWebhookDeliveryForManualRetry } from "@deployments-ai/webhooks";
import { projectItems, queryRecords } from "./runtime-cursors.ts";
import {
  RuntimeApiError,
  id,
  publicRecord,
  scoped,
  type RuntimeApiDependencies,
  type RuntimeApiPrincipal,
} from "./runtime-support.ts";

type WebhookDelivery = Extract<PlatformRecord, { readonly itemType: "webhook-delivery" }>;

const WEBHOOK_DELIVERY_STATUSES: Readonly<Record<string, true>> = {
  delivered: true,
  failed: true,
  pending: true,
  retrying: true,
  sending: true,
};

/** Public delivery projection; worker lease fields stay internal. */
function publicWebhookDelivery(delivery: WebhookDelivery) {
  const { claimExpiresAt: _claimExpiresAt, claimId: _claimId, ...data } = delivery.data;
  return { ...data, object: delivery.itemType };
}

/** Reads a retained delivery in the caller's environment; expired retention reads as missing. */
async function loadWebhookDelivery(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  deliveryId: Ulid,
  now: Date,
) {
  const delivery = await makeWebhookPersistence(dependencies.database).readDelivery(
    principal.scope,
    deliveryId,
  );
  if (!delivery || Date.parse(delivery.data.retentionExpiresAt) <= now.getTime()) {
    throw new RuntimeApiError(404, "not_found", "Webhook delivery was not found.");
  }
  return scoped(delivery, principal);
}

export async function listWebhookDeliveries(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  query: Readonly<Record<string, string | undefined>>,
) {
  const webhookId = query.webhookId ? id(query.webhookId, "webhookId") : undefined;
  const status = query.status;
  if (status !== undefined && !WEBHOOK_DELIVERY_STATUSES[status]) {
    throw new RuntimeApiError(
      400,
      "invalid_webhook_delivery_status",
      "status must be delivered, failed, pending, retrying, or sending.",
    );
  }
  const now = (dependencies.now?.() ?? new Date()).getTime();
  // One endpoint's history reads its own index partition so busy sibling endpoints in the
  // environment cannot push its deliveries past the filtered-scan page budget.
  const page = await queryRecords(
    dependencies.database,
    "events",
    dependencies.sessionTokenSecret,
    {
      cursor: query.cursor,
      cursorContext: {
        organizationId: principal.scope.organizationId,
        projectId: principal.scope.projectId,
        status: status ?? null,
        webhookId: webhookId ?? null,
      },
      ...(webhookId === undefined
        ? {
            expressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
            expressionAttributeValues: {
              ":pk": key(
                "ORG",
                principal.scope.organizationId,
                "ENV",
                principal.scope.environmentId,
              ),
              ":prefix": "WEBHOOK-DELIVERY#",
            },
          }
        : {
            expressionAttributeNames: { "#pk": "gsi1pk", "#sk": "gsi1sk" },
            expressionAttributeValues: {
              ":pk": key("WEBHOOK-ENDPOINT", webhookId, "DELIVERIES"),
              ":prefix": "WEBHOOK-DELIVERY#",
            },
            indexName: "gsi1" as const,
          }),
      keyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
      limit: query.limit,
      filter: (record) =>
        record.itemType === "webhook-delivery" &&
        record.data.organizationId === principal.scope.organizationId &&
        record.data.projectId === principal.scope.projectId &&
        record.data.environmentId === principal.scope.environmentId &&
        Date.parse(record.data.retentionExpiresAt) > now &&
        (webhookId === undefined || record.data.webhookEndpointId === webhookId) &&
        (status === undefined || record.data.status === status),
    },
  );
  return {
    deliveries: projectItems(page.items, "webhook-delivery", principal).map(publicWebhookDelivery),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

export async function getWebhookDelivery(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  deliveryId: Ulid,
) {
  return publicWebhookDelivery(
    await loadWebhookDelivery(
      dependencies,
      principal,
      deliveryId,
      dependencies.now?.() ?? new Date(),
    ),
  );
}

/** Attempts of one delivery in attempt order: a bounded query of the delivery's own partition. */
export async function listWebhookDeliveryAttempts(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  deliveryId: Ulid,
  query: Readonly<Record<string, string | undefined>>,
) {
  const now = dependencies.now?.() ?? new Date();
  await loadWebhookDelivery(dependencies, principal, deliveryId, now);
  const partition = webhookDeliveryAttemptPartition(principal.scope.organizationId, deliveryId);
  const page = await queryRecords(
    dependencies.database,
    "events",
    dependencies.sessionTokenSecret,
    {
      cursor: query.cursor,
      cursorContext: {
        environmentId: principal.scope.environmentId,
        projectId: principal.scope.projectId,
      },
      expressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      expressionAttributeValues: { ":pk": partition.pk, ":prefix": partition.skPrefix },
      keyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
      limit: query.limit,
      scanIndexForward: true,
      filter: (record) =>
        record.itemType === "webhook-delivery-attempt" &&
        record.data.webhookDeliveryId === deliveryId &&
        Date.parse(record.data.retentionExpiresAt) > now.getTime(),
    },
  );
  return {
    attempts: projectItems(page.items, "webhook-delivery-attempt", principal).map(publicRecord),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

function webhookDeliveryQueue(dependencies: RuntimeApiDependencies) {
  if (!dependencies.webhookDeliveryQueue) {
    throw new RuntimeApiError(
      503,
      "webhook_delivery_queue_unavailable",
      "Webhook delivery scheduling is unavailable.",
    );
  }
  return dependencies.webhookDeliveryQueue;
}

/**
 * Re-arms a delivered or failed delivery for one more attempt to its active endpoint and queues
 * it. A pending manual retry is queued again, so a retry whose enqueue failed can be recovered.
 */
export async function retryWebhookDelivery(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  deliveryId: Ulid,
) {
  const queue = webhookDeliveryQueue(dependencies);
  const now = dependencies.now?.() ?? new Date();
  const previous = await loadWebhookDelivery(dependencies, principal, deliveryId, now);
  const persistence = makeWebhookPersistence(dependencies.database);
  const endpoint = await persistence.readEndpoint(principal.scope, previous.data.webhookEndpointId);
  if (endpoint?.data.status !== "active" || endpoint.data.projectId !== principal.scope.projectId) {
    throw new RuntimeApiError(
      409,
      "webhook_endpoint_inactive",
      "Only deliveries to an active webhook subscription can be retried.",
    );
  }
  let delivery = previous;
  if (previous.data.status === "delivered" || previous.data.status === "failed") {
    try {
      delivery = await persistence.replaceDelivery(
        previous,
        rearmWebhookDeliveryForManualRetry(previous, now),
        { activeEndpoint: endpoint },
      );
    } catch (cause) {
      if (cause instanceof WebhookWriteConflictError) {
        throw new RuntimeApiError(
          409,
          "webhook_delivery_conflict",
          "The webhook delivery or its subscription changed concurrently; reload and retry.",
        );
      }
      throw cause;
    }
  } else if (previous.data.status !== "pending" || !previous.data.manualRetryRequestedAt) {
    throw new RuntimeApiError(
      409,
      "webhook_delivery_in_progress",
      "The webhook delivery is still being attempted.",
    );
  }
  await queue.enqueue([
    {
      deliveryId,
      environmentId: principal.scope.environmentId,
      organizationId: principal.scope.organizationId,
      version: 1,
    },
  ]);
  return publicWebhookDelivery(delivery);
}
