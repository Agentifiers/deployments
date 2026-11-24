import {
  SlackAgentStreamRecord,
  TeamsAgentStreamRecord,
  channelProviderPersistence,
  key,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";

import type { ChannelDeliveryDependencies, Delivery } from "./delivery-contract.ts";

export type AgentStream = Extract<
  PlatformRecord,
  { readonly itemType: "slack-agent-stream" | "teams-agent-stream" }
>;

interface AgentStreamFallbackKind {
  /** Provider name used in delivery errors. */
  readonly label: "Slack" | "Teams";
  readonly itemType: AgentStream["itemType"];
  readonly sortKeyPrefix: "SLACK-AGENT-STREAM" | "TEAMS-AGENT-STREAM";
  /** Run claim of the stream generation the delivery was composed for. */
  readonly deliveryRunClaimedAt: (delivery: Delivery) => string | undefined;
}

const STREAM_FALLBACK_KINDS = {
  "slack-stream-fallback": {
    deliveryRunClaimedAt: (delivery) => delivery.data.slackStreamRunClaimedAt,
    itemType: "slack-agent-stream",
    label: "Slack",
    sortKeyPrefix: "SLACK-AGENT-STREAM",
  },
  "teams-stream-fallback": {
    deliveryRunClaimedAt: (delivery) => delivery.data.teamsStreamRunClaimedAt,
    itemType: "teams-agent-stream",
    label: "Teams",
    sortKeyPrefix: "TEAMS-AGENT-STREAM",
  },
} as const satisfies Record<NonNullable<Delivery["data"]["deliveryMode"]>, AgentStreamFallbackKind>;

export function agentStreamFallbackKind(delivery: Delivery): AgentStreamFallbackKind | undefined {
  const mode = delivery.data.deliveryMode;
  return mode ? STREAM_FALLBACK_KINDS[mode] : undefined;
}

/** Loads the provider stream record a stream-fallback delivery depends on. */
export async function loadAgentStream(
  delivery: Delivery,
  kind: AgentStreamFallbackKind,
  dependencies: ChannelDeliveryDependencies,
): Promise<AgentStream | undefined> {
  const value = await channelProviderPersistence.read(
    dependencies.database,
    "execution",
    {
      pk: key("ORG", delivery.data.organizationId, "RUN", delivery.data.runId),
      sk: key(kind.sortKeyPrefix, delivery.data.runId),
    },
    true,
  );
  return (value?.itemType === "slack-agent-stream" || value?.itemType === "teams-agent-stream") &&
    value.itemType === kind.itemType
    ? value
    : undefined;
}

export function agentStreamVersionCondition(stream: AgentStream): TransactionOperation {
  return {
    conditionExpression: "#data.#version = :version",
    expressionAttributeNames: { "#data": "data", "#version": "version" },
    expressionAttributeValues: { ":version": stream.data.version },
    key: { pk: stream.pk, sk: stream.sk },
    kind: "condition-check",
    table: "execution",
  };
}

/** Reserves (`deliveryId`) or releases (`undefined`) the stream's single posted fallback. */
export function agentStreamFallbackReservation(
  stream: AgentStream,
  deliveryId: Ulid | undefined,
  updatedAt: string,
): TransactionOperation {
  const { fallbackDeliveryId: _previous, ...rest } = stream.data;
  const data = {
    ...rest,
    ...(deliveryId ? { fallbackDeliveryId: deliveryId } : {}),
    updatedAt,
    version: stream.data.version + 1,
  };
  return {
    kind: "put",
    previousRecord: stream,
    record:
      stream.itemType === "slack-agent-stream"
        ? Schema.decodeUnknownSync(SlackAgentStreamRecord)(
            withCanonicalRecordKeys({ data, itemType: "slack-agent-stream" as const }),
          )
        : Schema.decodeUnknownSync(TeamsAgentStreamRecord)(
            withCanonicalRecordKeys({ data, itemType: "teams-agent-stream" as const }),
          ),
  };
}
