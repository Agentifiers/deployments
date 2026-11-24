import {
  ChannelDeliveryRecord,
  channelProviderPersistence,
  key,
  withCanonicalRecordKeys,
  type TransactionOperation,
} from "@deployments-ai/db";
import { makeChannelSemanticEventRecord, transactWithSemanticEvents } from "@deployments-ai/events";
import { Schema } from "effect";

import {
  agentStreamFallbackKind,
  agentStreamFallbackReservation,
  loadAgentStream,
} from "./delivery-agent-streams.ts";
import type {
  ChannelDeliveryDependencies,
  Delivery,
  DeliveryMessage,
} from "./delivery-contract.ts";

export async function loadDelivery(
  message: DeliveryMessage,
  dependencies: ChannelDeliveryDependencies,
) {
  const partitionKey = key("ORG", message.organizationId, "RUN", message.runId);
  const lookup = await channelProviderPersistence.read(
    dependencies.database,
    "execution",
    {
      pk: partitionKey,
      sk: key("CHANNEL-DELIVERY-LOOKUP", message.deliveryId),
    },
    true,
  );
  if (
    !lookup ||
    lookup.itemType !== "channel-delivery-lookup" ||
    lookup.data.deliveryId !== message.deliveryId ||
    lookup.data.runId !== message.runId ||
    lookup.data.organizationId !== message.organizationId ||
    lookup.data.projectId !== message.projectId ||
    lookup.data.environmentId !== message.environmentId
  ) {
    throw new Error("Channel delivery lookup was not found or did not match queue scope.");
  }
  const value = await channelProviderPersistence.read(
    dependencies.database,
    "execution",
    {
      pk: partitionKey,
      sk: key("CHANNEL-DELIVERY", lookup.data.idempotencyKey),
    },
    true,
  );
  if (
    !value ||
    value.itemType !== "channel-delivery" ||
    value.data.id !== message.deliveryId ||
    value.data.organizationId !== message.organizationId ||
    value.data.projectId !== message.projectId ||
    value.data.environmentId !== message.environmentId
  ) {
    throw new Error("Channel delivery record was not found or did not match queue scope.");
  }
  return value;
}

export function nextDelivery(previous: Delivery, patch: Partial<Delivery["data"]>, now: Date) {
  return Schema.decodeUnknownSync(ChannelDeliveryRecord)(
    withCanonicalRecordKeys({
      data: Object.fromEntries(
        Object.entries({
          ...previous.data,
          ...patch,
          updatedAt: now.toISOString(),
          version: previous.data.version + 1,
        }).filter(([, value]) => value !== undefined),
      ),
      itemType: "channel-delivery" as const,
    }),
  );
}

export async function transition(
  previous: Delivery,
  next: Delivery,
  eventType:
    | "channel.delivery.failed"
    | "channel.delivery.retrying"
    | "channel.delivery.sending"
    | "channel.delivery.sent",
  dependencies: ChannelDeliveryDependencies,
  conditions: readonly TransactionOperation[] = [],
) {
  const event = makeChannelSemanticEventRecord({
    aggregateId: next.data.id,
    aggregateType: "channel-delivery",
    aggregateVersion: next.data.version + 1,
    environmentId: next.data.environmentId,
    eventId: await dependencies.generateId(),
    eventType,
    occurredAt: next.data.updatedAt,
    organizationId: next.data.organizationId,
    payload: {
      attempts: next.data.attempts,
      deliveryId: next.data.id,
      runId: next.data.runId,
      status: next.data.status,
    },
    projectId: next.data.projectId,
  });
  const transaction = () =>
    transactWithSemanticEvents(
      dependencies.database,
      [...conditions, { kind: "put", previousRecord: previous, record: next }],
      [event],
      event.data.eventId,
    );
  try {
    await transaction();
    return next;
  } catch (cause) {
    try {
      await transaction();
      return next;
    } catch {
      const [delivery, persistedEvent] = await Promise.all([
        channelProviderPersistence.read(
          dependencies.database,
          "execution",
          { pk: next.pk, sk: next.sk },
          true,
        ),
        channelProviderPersistence.read(
          dependencies.database,
          "events",
          { pk: event.pk, sk: event.sk },
          true,
        ),
      ]);
      if (
        delivery?.itemType === "channel-delivery" &&
        delivery.data.id === next.data.id &&
        delivery.data.version === next.data.version &&
        persistedEvent?.itemType === "semantic-event" &&
        persistedEvent.data.eventId === event.data.eventId
      ) {
        return delivery;
      }
      throw cause;
    }
  }
}

export async function fallbackReservationRelease(
  delivery: Delivery,
  updatedAt: string,
  dependencies: ChannelDeliveryDependencies,
): Promise<TransactionOperation | undefined> {
  const kind = agentStreamFallbackKind(delivery);
  if (!kind) return undefined;
  const stream = await loadAgentStream(delivery, kind, dependencies);
  if (stream?.data.fallbackDeliveryId !== delivery.data.id) return undefined;
  return agentStreamFallbackReservation(stream, undefined, updatedAt);
}

export async function persistProviderSuccess(
  message: DeliveryMessage,
  sending: Delivery,
  providerMessageId: string | undefined,
  dependencies: ChannelDeliveryDependencies,
) {
  let previous = sending;
  let lastCause: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const sentAt = (dependencies.now?.() ?? new Date()).toISOString();
    try {
      const release = await fallbackReservationRelease(previous, sentAt, dependencies);
      return await transition(
        previous,
        nextDelivery(
          previous,
          {
            ...(providerMessageId ? { providerMessageId } : {}),
            sentAt,
            status: "sent",
          },
          new Date(sentAt),
        ),
        "channel.delivery.sent",
        dependencies,
        release ? [release] : [],
      );
    } catch (cause) {
      lastCause = cause;
      const current = await loadDelivery(message, dependencies);
      if (current.data.status === "sent") return current;
      if (current.data.status !== "sending" || current.data.version !== previous.data.version) {
        throw cause;
      }
      previous = current;
    }
  }
  throw lastCause;
}

export async function persistProviderRetry(
  message: DeliveryMessage,
  sending: Delivery,
  lastError: string,
  dependencies: ChannelDeliveryDependencies,
) {
  let previous = sending;
  let lastCause: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const retriedAt = dependencies.now?.() ?? new Date();
    try {
      const release = await fallbackReservationRelease(
        previous,
        retriedAt.toISOString(),
        dependencies,
      );
      return await transition(
        previous,
        nextDelivery(previous, { lastError, status: "queued" }, retriedAt),
        "channel.delivery.retrying",
        dependencies,
        release ? [release] : [],
      );
    } catch (cause) {
      lastCause = cause;
      const current = await loadDelivery(message, dependencies);
      if (current.data.status === "queued" && current.data.version > sending.data.version) {
        return current;
      }
      if (current.data.status !== "sending" || current.data.version !== previous.data.version) {
        throw cause;
      }
      previous = current;
    }
  }
  throw lastCause;
}
