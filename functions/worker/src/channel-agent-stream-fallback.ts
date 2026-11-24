import {
  ChannelDeliveryRecord,
  key,
  withCanonicalRecordKeys,
  workerPersistence,
  type PlatformRecord,
} from "@deployments-ai/db";
import { makeChannelSemanticEventRecord, transactWithSemanticEvents } from "@deployments-ai/events";
import { Schema } from "effect";
import { persistChannelResponse } from "./channel-response.ts";
import type { AgentRunWorkerDependencies, RunRecordValue } from "./types.ts";

type ChannelDelivery = Extract<PlatformRecord, { readonly itemType: "channel-delivery" }>;

/** The stream fields that decide whether a provider stream's fallback delivery may proceed. */
export interface ChannelAgentStreamFallbackState {
  readonly data: {
    readonly bindingId: string;
    readonly fallbackAllowed: boolean;
    readonly organizationId: string;
    readonly runExecutionVersion: number;
    readonly runId: string;
    readonly status: "failed" | "paused" | "starting" | "stopped" | "streaming";
  };
}

/** Provider-specific delivery mode and the delivery-worker errors exchanged for it. */
export interface ChannelAgentStreamFallbackMode {
  readonly deliveryMode: NonNullable<ChannelDelivery["data"]["deliveryMode"]>;
  readonly requeuedError: string;
  readonly suppressedError: string;
}

/**
 * Requeues the run's stream-fallback delivery when the delivery worker suppressed it because the
 * stream outcome was still unknown and the stream has since resolved (stopped, or failed with
 * fallback allowed).
 */
export async function requeueSuppressedStreamFallback(
  dependencies: AgentRunWorkerDependencies,
  stream: ChannelAgentStreamFallbackState,
  mode: ChannelAgentStreamFallbackMode,
) {
  if (
    stream.data.status !== "stopped" &&
    !(stream.data.status === "failed" && stream.data.fallbackAllowed)
  ) {
    return;
  }
  const idempotencyKey = `channel-response:v1:${stream.data.runId}:${stream.data.bindingId}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const value = await workerPersistence.read(
      dependencies.database,
      "execution",
      {
        pk: key("ORG", stream.data.organizationId, "RUN", stream.data.runId),
        sk: key("CHANNEL-DELIVERY", idempotencyKey),
      },
      true,
    );
    if (
      !value ||
      value.itemType !== "channel-delivery" ||
      value.data.deliveryMode !== mode.deliveryMode ||
      value.data.bindingId !== stream.data.bindingId ||
      value.data.status !== "failed" ||
      value.data.lastError !== mode.suppressedError
    ) {
      return;
    }
    const previous: ChannelDelivery = value;
    const timestamp = dependencies.now?.() ?? new Date();
    const delivery = Schema.decodeUnknownSync(ChannelDeliveryRecord)(
      withCanonicalRecordKeys({
        data: Object.fromEntries(
          Object.entries({
            ...previous.data,
            failedAt: undefined,
            lastError: mode.requeuedError,
            status: "queued" as const,
            updatedAt: timestamp.toISOString(),
            version: previous.data.version + 1,
          }).filter(([, field]) => field !== undefined),
        ),
        itemType: "channel-delivery" as const,
      }),
    );
    const event = makeChannelSemanticEventRecord({
      aggregateId: delivery.data.id,
      aggregateType: "channel-delivery",
      aggregateVersion: delivery.data.version + 1,
      environmentId: delivery.data.environmentId,
      eventId: await dependencies.generateId(),
      eventType: "channel.delivery.queued",
      occurredAt: timestamp,
      organizationId: delivery.data.organizationId,
      payload: {
        ...(delivery.data.bindingId ? { channelBindingId: delivery.data.bindingId } : {}),
        deliveryId: delivery.data.id,
        provider: delivery.data.provider,
        runId: delivery.data.runId,
        status: delivery.data.status,
      },
      projectId: delivery.data.projectId,
    });
    try {
      await transactWithSemanticEvents(
        dependencies.database,
        [{ kind: "put", previousRecord: previous, record: delivery }],
        [event],
        event.data.eventId,
      );
      return;
    } catch (cause) {
      if (attempt === 2) throw cause;
    }
  }
}

/**
 * Queues the terminal notice of a failed or canceled run whose stream failed with fallback
 * allowed. The notice is delivered without history publication.
 */
export async function persistStreamTerminalFallback(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
  stream: ChannelAgentStreamFallbackState,
  body: string,
) {
  if (
    stream.data.status !== "failed" ||
    !stream.data.fallbackAllowed ||
    (run.data.status !== "failed" && run.data.status !== "canceled")
  ) {
    return;
  }
  if (!body) return;
  await persistChannelResponse({
    body,
    dependencies,
    deliveryGeneration: `terminal-${stream.data.runExecutionVersion}`,
    run,
    timestamp: new Date(run.data.completedAt ?? run.data.updatedAt),
  });
}
