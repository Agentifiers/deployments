import type { TransactionOperation } from "@deployments-ai/db";

import {
  queueMessagePayload,
  type PartialBatchFailureResponse,
  type QueueEventLike,
} from "./runtime.ts";
import {
  agentStreamFallbackKind,
  agentStreamFallbackReservation,
  agentStreamVersionCondition,
  loadAgentStream,
  type AgentStream,
} from "./delivery-agent-streams.ts";
import type {
  ChannelDeliveryDependencies,
  Delivery,
  DeliveryMessage,
} from "./delivery-contract.ts";
import {
  fallbackReservationRelease,
  loadDelivery,
  nextDelivery,
  persistProviderRetry,
  persistProviderSuccess,
  transition,
} from "./delivery-persistence.ts";
import {
  deliveryCommand,
  deliveryErrorMessage,
  prepareProviderDelivery,
  safeToReplayProviderFailure,
  sendProviderDelivery,
  sendSlackDelivery,
} from "./delivery-providers.ts";
import { cachedChannelDeliveryRuntimeDependencies } from "./delivery-runtime.ts";
import type { ExternalResponsePublication } from "./external-response-publication.ts";
const SENDING_STALE_AFTER_MS = 5 * 60_000;
const MAX_DELIVERY_RECEIVE_COUNT = 5;
const TERMINALIZE_AT_RECEIVE_COUNT = MAX_DELIVERY_RECEIVE_COUNT - 1;

function externalPublication(
  delivery: Delivery,
  dependencies: ChannelDeliveryDependencies,
): ExternalResponsePublication | undefined {
  if (delivery.data.responsePublication !== "external") return undefined;
  if (!dependencies.externalPublication) {
    throw new Error("External response publication is not configured for channel delivery.");
  }
  return dependencies.externalPublication;
}

function externalDispatchBoundary(delivery: Delivery) {
  if (
    !delivery.data.bindingId ||
    !delivery.data.routeId ||
    delivery.data.throughSequence === undefined
  ) {
    throw new Error("External channel delivery is missing its durable ingress boundary.");
  }
  return {
    bindingId: delivery.data.bindingId,
    environmentId: delivery.data.environmentId,
    organizationId: delivery.data.organizationId,
    projectId: delivery.data.projectId,
    routeId: delivery.data.routeId,
    throughSequence: delivery.data.throughSequence,
  };
}

async function releaseExternalPublication(
  delivery: Delivery,
  publication: ExternalResponsePublication | undefined,
) {
  if (publication) await publication.release(delivery);
}

async function terminalizeSupersededDelivery(
  message: DeliveryMessage,
  delivery: Delivery,
  publication: ExternalResponsePublication | undefined,
  dependencies: ChannelDeliveryDependencies,
) {
  const current = await loadDelivery(message, dependencies);
  if (current.data.status !== "queued") {
    if (current.data.status === "failed") {
      await releaseExternalPublication(current, publication);
    }
    return current;
  }
  const failedAt = (dependencies.now?.() ?? new Date()).toISOString();
  const failed = await transition(
    current,
    nextDelivery(
      current,
      {
        failedAt,
        lastError: "Provisional response was superseded by newer channel input.",
        status: "failed",
      },
      new Date(failedAt),
    ),
    "channel.delivery.failed",
    dependencies,
  );
  await releaseExternalPublication(failed, publication);
  return failed;
}

async function assessExternalDispatch(
  delivery: Delivery,
  publication: ExternalResponsePublication | undefined,
  dependencies: ChannelDeliveryDependencies,
) {
  if (!publication) return undefined;
  if (!dependencies.ingressDispatch) {
    throw new Error("Channel ingress dispatch fencing is not configured.");
  }
  return dependencies.ingressDispatch.assess(externalDispatchBoundary(delivery));
}

async function failDelivery(
  delivery: Delivery,
  lastError: string,
  publication: ExternalResponsePublication | undefined,
  dependencies: ChannelDeliveryDependencies,
  conditions: readonly TransactionOperation[] = [],
) {
  const failedAt = (dependencies.now?.() ?? new Date()).toISOString();
  const failed = await transition(
    delivery,
    nextDelivery(delivery, { failedAt, lastError, status: "failed" }, new Date(failedAt)),
    "channel.delivery.failed",
    dependencies,
    conditions,
  );
  await releaseExternalPublication(failed, publication);
  return failed;
}

/**
 * A stopped stream of the delivery's run generation already showed the final response in the
 * provider. Its stream receipt (Slack `ts`, Teams stream id) is the provider message id: the
 * delivery is recorded as sent without another post, and an externally published response then
 * passes through the same ingress fence and confirmed-delivery publication as a posted fallback.
 */
async function recordStreamedDelivery(
  message: DeliveryMessage,
  initial: Delivery,
  stream: AgentStream,
  publication: ExternalResponsePublication | undefined,
  dependencies: ChannelDeliveryDependencies,
) {
  let sending = initial;
  if (initial.data.status !== "sending") {
    const dispatch = await assessExternalDispatch(initial, publication, dependencies);
    if (dispatch?.kind === "superseded") {
      return terminalizeSupersededDelivery(message, initial, publication, dependencies);
    }
    sending = await transition(
      initial,
      nextDelivery(
        initial,
        { attempts: initial.data.attempts + 1, status: "sending" },
        dependencies.now?.() ?? new Date(),
      ),
      "channel.delivery.sending",
      dependencies,
      [
        ...(dispatch?.kind === "current" ? [dispatch.condition] : []),
        {
          conditionExpression:
            "#data.#status = :stopped AND #data.#runClaimedAt = :runClaimedAt AND #data.#version = :version",
          expressionAttributeNames: {
            "#data": "data",
            "#runClaimedAt": "runClaimedAt",
            "#status": "status",
            "#version": "version",
          },
          expressionAttributeValues: {
            ":runClaimedAt": stream.data.runClaimedAt,
            ":stopped": "stopped",
            ":version": stream.data.version,
          },
          key: { pk: stream.pk, sk: stream.sk },
          kind: "condition-check",
          table: "execution",
        },
      ],
    );
  }
  const sent = await persistProviderSuccess(
    message,
    sending,
    stream.itemType === "slack-agent-stream" ? stream.data.streamTs : stream.data.streamId,
    dependencies,
  );
  if (publication) await publication.publish(sent);
  return sent;
}

async function deliver(
  message: DeliveryMessage,
  finalReceive: boolean,
  dependencies: ChannelDeliveryDependencies,
) {
  const initial = await loadDelivery(message, dependencies);
  const publication = externalPublication(initial, dependencies);
  let fallbackStream: AgentStream | undefined;
  let streamedDelivery: AgentStream | undefined;
  if (initial.data.status === "sent") {
    if (publication) await publication.publish(initial);
    return initial;
  }
  if (initial.data.status === "failed") {
    await releaseExternalPublication(initial, publication);
    return initial;
  }
  // Stream evidence is resolved before any publication reservation, so a delivery that waits for an
  // unresolved stream never holds the conversation's publication barrier.
  const streamKind = agentStreamFallbackKind(initial);
  if (streamKind) {
    const label = streamKind.label;
    const stream = await loadAgentStream(initial, streamKind, dependencies);
    if (!stream) {
      if (!finalReceive) {
        throw new Error(
          `${label} agent stream evidence is unavailable; fallback delivery will retry.`,
        );
      }
      return failDelivery(
        initial,
        `${label} agent stream evidence is unavailable; fallback was suppressed.`,
        publication,
        dependencies,
      );
    }
    const currentGeneration = streamKind.deliveryRunClaimedAt(initial) === stream.data.runClaimedAt;
    if (stream.data.status === "stopped") {
      if (!currentGeneration) {
        return failDelivery(
          initial,
          `${label} fallback delivery belongs to an obsolete stream generation.`,
          publication,
          dependencies,
          [agentStreamVersionCondition(stream)],
        );
      }
      streamedDelivery = stream;
    } else if (stream.data.status === "failed" && stream.data.fallbackAllowed) {
      if (
        !currentGeneration ||
        (stream.data.fallbackDeliveryId && stream.data.fallbackDeliveryId !== initial.data.id)
      ) {
        if (finalReceive && !currentGeneration) {
          return failDelivery(
            initial,
            `${label} fallback delivery belongs to an obsolete failed generation.`,
            publication,
            dependencies,
            [agentStreamVersionCondition(stream)],
          );
        }
        throw new Error(
          `${label} fallback delivery does not match the eligible stream generation.`,
        );
      }
      fallbackStream = stream;
    } else {
      // starting, streaming, paused, or failed without a safe fallback: the outcome is unresolved.
      if (!finalReceive) {
        throw new Error(`${label} agent stream is still active; fallback delivery will retry.`);
      }
      return failDelivery(
        initial,
        `${label} agent stream outcome is unknown; fallback delivery was suppressed.`,
        publication,
        dependencies,
        [agentStreamVersionCondition(stream)],
      );
    }
  }
  if (publication) {
    const reservation = await publication.reserve(initial);
    if (reservation === "superseded") {
      return terminalizeSupersededDelivery(message, initial, undefined, dependencies);
    }
  }
  if (streamedDelivery) {
    return recordStreamedDelivery(message, initial, streamedDelivery, publication, dependencies);
  }
  if (initial.data.status === "sending") {
    const observedAt = dependencies.now?.() ?? new Date();
    if (
      !finalReceive &&
      observedAt.getTime() - Date.parse(initial.data.updatedAt) < SENDING_STALE_AFTER_MS
    ) {
      throw new Error("Channel delivery is already being sent by another invocation.");
    }
    const failedAt = observedAt.toISOString();
    const release = await fallbackReservationRelease(initial, failedAt, dependencies);
    const failed = await transition(
      initial,
      nextDelivery(
        initial,
        {
          failedAt,
          lastError: "Provider delivery outcome is unknown; automatic resend was suppressed.",
          status: "failed",
        },
        new Date(failedAt),
      ),
      "channel.delivery.failed",
      dependencies,
      release ? [release] : [],
    );
    await releaseExternalPublication(failed, publication);
    return failed;
  }
  const command = deliveryCommand(message, initial);
  let prepared: Awaited<ReturnType<typeof prepareProviderDelivery>>;
  try {
    prepared = await prepareProviderDelivery(command, dependencies);
  } catch (cause) {
    if (!finalReceive) throw cause;
    const failedAt = (dependencies.now?.() ?? new Date()).toISOString();
    const failed = await transition(
      initial,
      nextDelivery(
        initial,
        { failedAt, lastError: deliveryErrorMessage(cause), status: "failed" },
        new Date(failedAt),
      ),
      "channel.delivery.failed",
      dependencies,
    );
    await releaseExternalPublication(failed, publication);
    return failed;
  }
  const now = dependencies.now?.() ?? new Date();
  const dispatch = await assessExternalDispatch(initial, publication, dependencies);
  if (dispatch?.kind === "superseded") {
    return terminalizeSupersededDelivery(message, initial, publication, dependencies);
  }
  const transitionConditions: TransactionOperation[] = [
    ...(dispatch?.kind === "current" ? [dispatch.condition] : []),
    ...(fallbackStream
      ? [agentStreamFallbackReservation(fallbackStream, initial.data.id, now.toISOString())]
      : []),
  ];
  let sending: Delivery;
  try {
    sending = await transition(
      initial,
      nextDelivery(
        initial,
        { attempts: initial.data.attempts + 1, lastError: undefined, status: "sending" },
        now,
      ),
      "channel.delivery.sending",
      dependencies,
      transitionConditions,
    );
  } catch (cause) {
    if (publication && dependencies.ingressDispatch) {
      const latest = await loadDelivery(message, dependencies);
      if (latest.data.status === "sent") {
        await publication.publish(latest);
        return latest;
      }
      if (latest.data.status !== "queued") return latest;
      const reassessed = await dependencies.ingressDispatch.assess(
        externalDispatchBoundary(latest),
      );
      if (reassessed.kind === "superseded") {
        return terminalizeSupersededDelivery(message, latest, publication, dependencies);
      }
    }
    throw cause;
  }
  let providerMessageId: string | undefined;
  try {
    const result = await sendProviderDelivery(command, prepared, dependencies);
    providerMessageId = result.providerMessageId;
  } catch (cause) {
    const failedAt = (dependencies.now?.() ?? new Date()).toISOString();
    const lastError = deliveryErrorMessage(cause);
    if (safeToReplayProviderFailure(cause, command.provider) && !finalReceive) {
      await persistProviderRetry(message, sending, lastError, dependencies);
      throw cause;
    }
    const release = await fallbackReservationRelease(sending, failedAt, dependencies);
    const failed = await transition(
      sending,
      nextDelivery(sending, { failedAt, lastError, status: "failed" }, new Date(failedAt)),
      "channel.delivery.failed",
      dependencies,
      release ? [release] : [],
    );
    await releaseExternalPublication(failed, publication);
    return undefined;
  }
  const sent = await persistProviderSuccess(message, sending, providerMessageId, dependencies);
  if (publication) await publication.publish(sent);
  return sent;
}

export async function handleChannelDelivery(
  event: QueueEventLike,
  dependencies?: ChannelDeliveryDependencies,
): Promise<PartialBatchFailureResponse> {
  const resolvedDependencies =
    dependencies &&
    typeof dependencies === "object" &&
    "database" in dependencies &&
    typeof (dependencies as ChannelDeliveryDependencies).database?.getRecord === "function"
      ? (dependencies as ChannelDeliveryDependencies)
      : await cachedChannelDeliveryRuntimeDependencies();
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      const message = queueMessagePayload(record.body) as DeliveryMessage;
      const receiveCount = Number(record.attributes?.ApproximateReceiveCount ?? "1");
      await deliver(
        message,
        Number.isSafeInteger(receiveCount) && receiveCount >= TERMINALIZE_AT_RECEIVE_COUNT,
        resolvedDependencies,
      );
    } catch (cause) {
      console.error("Channel delivery failed before a terminal delivery state was persisted.", {
        errorType: cause instanceof Error ? cause.name : "UnknownError",
        messageId: record.messageId,
      });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}

export const handler = handleChannelDelivery;
export { sendSlackDelivery };
export type { ChannelDeliveryDependencies } from "./delivery-contract.ts";
