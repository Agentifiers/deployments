import type { CredentialVaultService } from "@deployments-ai/credential-vault";
import {
  acquireUniqueClaim,
  isDatabaseWriteConflict,
  key,
  makeUniqueClaimRecord,
  releaseUniqueClaim,
  uniqueClaimRequirements,
  webhookEndpointKey,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
  runtimeApiPersistence,
} from "@deployments-ai/db";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "@deployments-ai/events";
import { normalizePublicHttpsUrl } from "@deployments-ai/net-security";
import {
  generateWebhookSigningSecret,
  makeWebhookEndpointRecord,
  replaceWebhookEndpointRecord,
  type WebhookResourceFilters,
} from "@deployments-ai/webhooks";
import {
  MAX_ACTIVE_WEBHOOK_SUBSCRIPTIONS,
  nextAggregateEventVersion,
  projectItems,
  queryRecords,
} from "./runtime-cursors.ts";
import { recordActor } from "./runtime-principal.ts";
import {
  RuntimeApiError,
  assertRecord,
  getRecord,
  scoped,
  type RuntimeApiDependencies,
  type RuntimeApiPrincipal,
} from "./runtime-support.ts";

export type WebhookEndpoint = Extract<PlatformRecord, { readonly itemType: "webhook-endpoint" }>;

export function credentialVault(dependencies: RuntimeApiDependencies): CredentialVaultService {
  if (!dependencies.credentialVault) {
    throw new RuntimeApiError(
      503,
      "webhook_subscriptions_unavailable",
      "Webhook subscription secret storage is unavailable.",
    );
  }
  return dependencies.credentialVault;
}

/** Public endpoint projection; the secret reference and quota slot never leave the API. */
export function publicWebhook(endpoint: WebhookEndpoint) {
  const {
    consecutiveFailures,
    quotaSlot: _quotaSlot,
    signingSecretRef: _signingSecretRef,
    ...data
  } = endpoint.data;
  return { ...data, consecutiveFailures: consecutiveFailures ?? 0, object: endpoint.itemType };
}

function webhookQuotaNamespace(environmentId: Ulid) {
  return `environment:${environmentId}:webhook-subscription-slot`;
}

export function normalizedWebhookUrl(url: string) {
  try {
    return normalizePublicHttpsUrl(url);
  } catch (cause) {
    throw new RuntimeApiError(
      400,
      "invalid_webhook_subscription",
      cause instanceof Error ? cause.message : "Webhook subscription is invalid.",
    );
  }
}

/** Drops absent filter families from a decoded request so only provided filters persist. */
export function requestedResourceFilters(filters: {
  readonly [name: string]: readonly string[] | undefined;
}): WebhookResourceFilters {
  return Object.fromEntries(
    Object.entries(filters).filter(([, values]) => values !== undefined),
  ) as WebhookResourceFilters;
}

export async function loadWebhook(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  webhookId: Ulid,
) {
  return scoped(
    assertRecord(
      await getRecord(
        dependencies.database,
        "control",
        webhookEndpointKey(principal.scope, webhookId),
      ),
      "webhook-endpoint",
      "Webhook subscription",
    ),
    principal,
  );
}

export function assertWebhookNotArchived(endpoint: WebhookEndpoint) {
  if (endpoint.data.status === "archived") {
    throw new RuntimeApiError(
      409,
      "webhook_archived",
      "Archived webhook subscriptions cannot be changed.",
    );
  }
}

/** Semantic event for an endpoint lifecycle transition, versioned on the endpoint aggregate. */
export async function webhookEndpointEvent(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  input: {
    readonly eventType: string;
    readonly now: Date;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly webhookId: Ulid;
  },
) {
  return makeSemanticEventRecord({
    actor: recordActor(principal),
    aggregateId: input.webhookId,
    aggregateType: "webhook-endpoint",
    aggregateVersion: await nextAggregateEventVersion(
      dependencies,
      principal.scope.organizationId,
      "webhook-endpoint",
      input.webhookId,
    ),
    environmentId: principal.scope.environmentId,
    eventId: await dependencies.generateId(),
    eventType: input.eventType,
    occurredAt: input.now,
    organizationId: principal.scope.organizationId,
    payload: input.payload as never,
    projectId: principal.scope.projectId,
  });
}

/** Commits endpoint mutations with their events; a lost conditional race is a 409. */
export async function commitWebhookMutation(
  dependencies: RuntimeApiDependencies,
  operations: readonly TransactionOperation[],
  events: Parameters<typeof transactWithSemanticEvents>[2],
) {
  try {
    await transactWithSemanticEvents(dependencies.database, operations, events);
  } catch (cause) {
    if (isDatabaseWriteConflict(cause)) {
      throw new RuntimeApiError(
        409,
        "webhook_write_conflict",
        "The webhook subscription changed concurrently; reload and retry.",
      );
    }
    throw cause;
  }
}

/**
 * Endpoints that hold a subscription slot: active and disabled endpoints keep their slot until
 * they are archived. Endpoints created before slots existed are counted against free slots.
 */
async function quotaHoldingWebhooks(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
) {
  const holding: WebhookEndpoint[] = [];
  let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
  do {
    const page = await runtimeApiPersistence.find(dependencies.database, "control", {
      ConsistentRead: true,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      ExpressionAttributeNames: {
        "#data": "data",
        "#pk": "pk",
        "#sk": "sk",
        "#status": "status",
      },
      ExpressionAttributeValues: {
        ":active": "active",
        ":disabled": "disabled",
        ":pk": key("ORG", principal.scope.organizationId, "ENV", principal.scope.environmentId),
        ":prefix": "WEBHOOK-ENDPOINT#",
      },
      FilterExpression: "#data.#status IN (:active, :disabled)",
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
      Limit: MAX_ACTIVE_WEBHOOK_SUBSCRIPTIONS,
      ScanIndexForward: false,
    });
    holding.push(
      ...page.items.filter(
        (record): record is WebhookEndpoint =>
          record.itemType === "webhook-endpoint" &&
          record.data.organizationId === principal.scope.organizationId &&
          record.data.projectId === principal.scope.projectId &&
          record.data.environmentId === principal.scope.environmentId &&
          record.data.status !== "archived",
      ),
    );
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (holding.length < MAX_ACTIVE_WEBHOOK_SUBSCRIPTIONS && exclusiveStartKey);
  return holding;
}

export async function listWebhooks(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  query: Readonly<Record<string, string | undefined>>,
) {
  const page = await queryRecords(
    dependencies.database,
    "control",
    dependencies.sessionTokenSecret,
    {
      cursor: query.cursor,
      expressionAttributeNames: { "#pk": "gsi2pk", "#sk": "gsi2sk" },
      expressionAttributeValues: {
        ":pk": key("ENV", principal.scope.environmentId),
        ":prefix": "WEBHOOK-ENDPOINT#",
      },
      indexName: "gsi2",
      keyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
      limit: query.limit,
    },
  );
  return {
    webhooks: projectItems(page.items, "webhook-endpoint", principal).map(publicWebhook),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

export async function getWebhook(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  webhookId: Ulid,
) {
  return publicWebhook(await loadWebhook(dependencies, principal, webhookId));
}

export async function createWebhook(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  input: {
    readonly eventTypes: readonly string[];
    readonly name: string;
    readonly resourceFilters?: WebhookResourceFilters;
    readonly url: string;
  },
) {
  const normalizedUrl = normalizedWebhookUrl(input.url);
  const quotaNamespace = webhookQuotaNamespace(principal.scope.environmentId);
  const [quotaClaims, holdingEndpoints] = await Promise.all([
    queryRecords(dependencies.database, "control", dependencies.sessionTokenSecret, {
      consistentRead: true,
      expressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      expressionAttributeValues: {
        ":pk": key("UNIQUE", quotaNamespace),
        ":prefix": "VALUE#",
      },
      keyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
      limit: String(MAX_ACTIVE_WEBHOOK_SUBSCRIPTIONS),
    }),
    quotaHoldingWebhooks(dependencies, principal),
  ]);
  const occupiedSlots = new Set(
    quotaClaims.items.flatMap((record) => {
      if (record.itemType !== "unique-claim" || record.data.namespace !== quotaNamespace) {
        return [];
      }
      const slot = Number(record.data.value);
      return Number.isSafeInteger(slot) && slot >= 0 && slot < MAX_ACTIVE_WEBHOOK_SUBSCRIPTIONS
        ? [slot]
        : [];
    }),
  );
  let legacyEndpointCount = 0;
  for (const record of holdingEndpoints) {
    const quotaSlot = record.data.quotaSlot;
    if (
      quotaSlot !== undefined &&
      Number.isSafeInteger(quotaSlot) &&
      quotaSlot >= 0 &&
      quotaSlot < MAX_ACTIVE_WEBHOOK_SUBSCRIPTIONS
    ) {
      occupiedSlots.add(quotaSlot);
    } else {
      legacyEndpointCount += 1;
    }
  }
  for (let count = 0; count < legacyEndpointCount; count += 1) {
    const virtualSlot = Array.from(
      { length: MAX_ACTIVE_WEBHOOK_SUBSCRIPTIONS },
      (_, slot) => slot,
    ).find((slot) => !occupiedSlots.has(slot));
    if (virtualSlot === undefined) break;
    occupiedSlots.add(virtualSlot);
  }
  const availableSlots = Array.from(
    { length: MAX_ACTIVE_WEBHOOK_SUBSCRIPTIONS },
    (_, slot) => slot,
  ).filter((slot) => !occupiedSlots.has(slot));
  if (availableSlots.length === 0) {
    throw new RuntimeApiError(
      409,
      "webhook_subscription_limit",
      `An environment may have at most ${MAX_ACTIVE_WEBHOOK_SUBSCRIPTIONS} active webhook subscriptions.`,
    );
  }
  const [webhookId, credentialId, eventId] = await Promise.all([
    dependencies.generateId(),
    dependencies.generateId(),
    dependencies.generateId(),
  ]);
  const signingSecret = generateWebhookSigningSecret();
  const vault = credentialVault(dependencies);
  const prepared = await vault.prepareWrite({
    identity: {
      credentialId,
      environmentId: principal.scope.environmentId,
      organizationId: principal.scope.organizationId,
      ownerId: webhookId,
      ownerType: "webhook-endpoint",
      projectId: principal.scope.projectId,
      purpose: "webhook-signing",
    },
    secret: { values: { signingSecret } },
  });
  const now = dependencies.now?.() ?? new Date();
  for (const quotaSlot of availableSlots) {
    let endpoint: WebhookEndpoint;
    try {
      endpoint = makeWebhookEndpointRecord({
        environmentId: principal.scope.environmentId,
        eventTypes: input.eventTypes,
        id: webhookId,
        name: input.name,
        organizationId: principal.scope.organizationId,
        projectId: principal.scope.projectId,
        quotaSlot,
        ...(input.resourceFilters ? { resourceFilters: input.resourceFilters } : {}),
        signingSecretRef: prepared.reference,
        url: normalizedUrl,
        now,
      });
    } catch (cause) {
      throw new RuntimeApiError(
        400,
        "invalid_webhook_subscription",
        cause instanceof Error ? cause.message : "Webhook subscription is invalid.",
      );
    }
    const requirement = uniqueClaimRequirements(endpoint)[0];
    if (!requirement) {
      throw new RuntimeApiError(
        500,
        "webhook_quota_unavailable",
        "Webhook subscription quota reservation is unavailable.",
      );
    }
    const quotaClaim = makeUniqueClaimRecord(requirement, now.toISOString()) as Extract<
      PlatformRecord,
      { readonly itemType: "unique-claim" }
    >;
    const event = makeSemanticEventRecord({
      actor: recordActor(principal),
      aggregateId: webhookId,
      aggregateType: "webhook-endpoint",
      aggregateVersion: 1,
      environmentId: principal.scope.environmentId,
      eventId,
      eventType: "webhook.endpoint.created",
      occurredAt: now,
      organizationId: principal.scope.organizationId,
      payload: {
        eventTypes: endpoint.data.eventTypes,
        webhookEndpointId: webhookId,
      },
      projectId: principal.scope.projectId,
    });
    try {
      await transactWithSemanticEvents(
        dependencies.database,
        [prepared.operation, acquireUniqueClaim(quotaClaim), { kind: "put", record: endpoint }],
        [event],
      );
      return { ...publicWebhook(endpoint), signingSecret };
    } catch (cause) {
      const [winner, committedEndpoint, committedCredential] = await Promise.all(
        [
          { pk: quotaClaim.pk, sk: quotaClaim.sk },
          { pk: endpoint.pk, sk: endpoint.sk },
          { pk: prepared.operation.record.pk, sk: prepared.operation.record.sk },
        ].map((recordKey) =>
          runtimeApiPersistence.read(dependencies.database, "control", recordKey, true),
        ),
      );
      if (
        winner?.itemType === "unique-claim" &&
        winner.data.ownerId === webhookId &&
        committedEndpoint?.itemType === "webhook-endpoint" &&
        committedEndpoint.data.id === webhookId &&
        committedEndpoint.data.quotaSlot === quotaSlot &&
        "store" in committedEndpoint.data.signingSecretRef &&
        committedEndpoint.data.signingSecretRef.store === "dynamodb-kms" &&
        committedEndpoint.data.signingSecretRef.credentialId === credentialId &&
        committedEndpoint.data.signingSecretRef.generation === prepared.reference.generation &&
        committedCredential?.itemType === "credential-vault-entry" &&
        committedCredential.data.id === credentialId &&
        committedCredential.data.ownerId === webhookId &&
        committedCredential.data.ownerType === "webhook-endpoint" &&
        committedCredential.data.purpose === "webhook-signing" &&
        committedCredential.data.status === "active" &&
        committedCredential.data.generation === prepared.reference.generation
      ) {
        return { ...publicWebhook(scoped(committedEndpoint, principal)), signingSecret };
      }
      if (
        isDatabaseWriteConflict(cause) &&
        winner?.itemType === "unique-claim" &&
        winner.data.ownerId !== webhookId
      ) {
        continue;
      }
      throw cause;
    }
  }
  throw new RuntimeApiError(
    409,
    "webhook_subscription_limit",
    `An environment may have at most ${MAX_ACTIVE_WEBHOOK_SUBSCRIPTIONS} active webhook subscriptions.`,
  );
}

/**
 * Archives an active or disabled endpoint: its vault credential is revoked and its quota slot
 * released in the same transaction. Archiving is idempotent.
 */
export async function archiveWebhook(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  webhookId: Ulid,
) {
  const previous = await loadWebhook(dependencies, principal, webhookId);
  if (previous.data.status === "archived") return publicWebhook(previous);
  const revokeOperation =
    "store" in previous.data.signingSecretRef
      ? (
          await credentialVault(dependencies).prepareRevoke({
            environmentId: principal.scope.environmentId,
            organizationId: principal.scope.organizationId,
            reference: previous.data.signingSecretRef,
          })
        ).operation
      : undefined;
  const now = dependencies.now?.() ?? new Date();
  const replacement = replaceWebhookEndpointRecord(previous, { status: "archived", now });
  const quotaRequirement = uniqueClaimRequirements(previous)[0];
  const quotaClaim = quotaRequirement
    ? (makeUniqueClaimRecord(quotaRequirement, previous.data.createdAt) as Extract<
        PlatformRecord,
        { readonly itemType: "unique-claim" }
      >)
    : undefined;
  const event = await webhookEndpointEvent(dependencies, principal, {
    eventType: "webhook.endpoint.archived",
    now,
    payload: { webhookEndpointId: webhookId },
    webhookId,
  });
  await commitWebhookMutation(
    dependencies,
    [
      ...(revokeOperation ? [revokeOperation] : []),
      ...(quotaClaim ? [releaseUniqueClaim(quotaClaim)] : []),
      { kind: "put", previousRecord: previous, record: replacement },
    ],
    [event],
  );
  return publicWebhook(replacement);
}
