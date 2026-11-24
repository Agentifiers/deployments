import {
  ChannelDeliveryRecord,
  ChannelDeliveryLookupRecord,
  DynamoValue as DynamoValueSchema,
  Ulid,
  key,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type TransactionOperation,
  type DynamoValue,
  workerPersistence,
} from "@deployments-ai/db";
import { makeChannelSemanticEventRecord, transactWithSemanticEvents } from "@deployments-ai/events";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import type { AgentRunWorkerDependencies, MessageRecordValue, RunRecordValue } from "./types.ts";
import {
  channelResponseProviderPayload,
  MAX_AUTOMATIC_CHANNEL_RESPONSE_CHARACTERS,
  streamFallbackBody,
} from "./channel-response-payload.ts";
import { slackMetadata } from "./slack-agent-stream-metadata.ts";

type Workspace = Extract<PlatformRecord, { readonly itemType: "workspace" }>;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const EMPTY_CHANNEL_RESPONSE_ERROR = "Automatic channel response is empty.";
const OVERSIZED_CHANNEL_RESPONSE_ERROR =
  "Automatic channel response exceeds the 40,000-character delivery limit.";

export function automaticChannelResponseError(content: string) {
  if (!content.trim()) return EMPTY_CHANNEL_RESPONSE_ERROR;
  if (Array.from(content).length > MAX_AUTOMATIC_CHANNEL_RESPONSE_CHARACTERS) {
    return OVERSIZED_CHANNEL_RESPONSE_ERROR;
  }
  return undefined;
}

function deterministicId(...parts: readonly string[]) {
  const bytes = createHash("sha256").update(JSON.stringify(parts)).digest().subarray(0, 16);
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return Schema.decodeUnknownSync(Ulid)(encoded);
}

function metadataString(metadata: Readonly<Record<string, unknown>>, field: string) {
  const value = metadata[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function metadataSequence(metadata: Readonly<Record<string, unknown>>, field: string) {
  const value = metadata[field];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function slackRouteRequiresApproval(externalThreadKey: string) {
  const parts = externalThreadKey.split(":");
  return parts[0] === "slack" && parts[2] === "shared" && parts[3] === "thread";
}

function semanticValue(value: unknown): DynamoValue {
  return Schema.decodeUnknownSync(DynamoValueSchema)(value);
}

async function getRecord(
  dependencies: AgentRunWorkerDependencies,
  table: "control" | "execution",
  pk: string,
  sk: string,
) {
  return await workerPersistence.read(dependencies.database, table, { pk, sk }, true);
}

async function triggerMessage(run: RunRecordValue, dependencies: AgentRunWorkerDependencies) {
  if (!run.data.userMessageId || run.data.userMessageSequence === undefined) return undefined;
  const value = await getRecord(
    dependencies,
    "execution",
    key("ORG", run.data.organizationId, "THREAD", run.data.threadId),
    key("MESSAGE", String(run.data.userMessageSequence).padStart(16, "0"), run.data.userMessageId),
  );
  return value?.itemType === "message" ? value : undefined;
}

async function channelBinding(
  run: RunRecordValue,
  message: MessageRecordValue,
  dependencies: AgentRunWorkerDependencies,
) {
  const metadata = message.data.metadata;
  if (!metadata || metadata.source !== "channel-ingress") return undefined;
  const bindingIdValue = metadataString(metadata, "bindingId");
  if (!bindingIdValue) return undefined;
  let bindingId: Ulid;
  try {
    bindingId = Schema.decodeUnknownSync(Ulid)(bindingIdValue);
  } catch {
    return undefined;
  }
  const value = await getRecord(
    dependencies,
    "control",
    key("ORG", run.data.organizationId, "ENV", run.data.environmentId),
    key("CHANNEL-BINDING", bindingId),
  );
  if (
    !value ||
    value.itemType !== "channel-binding" ||
    value.data.organizationId !== run.data.organizationId ||
    value.data.projectId !== run.data.projectId ||
    value.data.environmentId !== run.data.environmentId ||
    value.data.agentDeploymentId !== run.data.agentDeploymentId ||
    (value.data.workspaceId !== undefined && value.data.workspaceId !== run.data.workspaceId) ||
    value.data.status !== "active" ||
    !value.data.credentialRef ||
    !("store" in value.data.credentialRef) ||
    value.data.credentialRef.store !== "dynamodb-kms"
  ) {
    return undefined;
  }
  return value;
}

async function activeWorkspace(
  run: RunRecordValue,
  workspaceId: Ulid,
  dependencies: AgentRunWorkerDependencies,
) {
  const value = await getRecord(
    dependencies,
    "control",
    key("ORG", run.data.organizationId, "ENV", run.data.environmentId),
    key("WORKSPACE", workspaceId),
  );
  if (
    !value ||
    value.itemType !== "workspace" ||
    value.data.organizationId !== run.data.organizationId ||
    value.data.projectId !== run.data.projectId ||
    value.data.environmentId !== run.data.environmentId ||
    value.data.status !== "active"
  ) {
    return undefined;
  }
  return value;
}

/**
 * The stream-fallback mode of a run whose channel streams its replies: the delivery worker
 * reconciles the delivery against the provider stream of the same run claim.
 */
async function streamFallbackDelivery(
  run: RunRecordValue,
  channel: string,
  dependencies: AgentRunWorkerDependencies,
) {
  if (channel !== "slack" && channel !== "teams") return undefined;
  const value = await getRecord(
    dependencies,
    "execution",
    key("ORG", run.data.organizationId, "RUN", run.data.id),
    key(channel === "slack" ? "SLACK-AGENT-STREAM" : "TEAMS-AGENT-STREAM", run.data.id),
  );
  if (value?.itemType === "slack-agent-stream") {
    return {
      channel: "slack" as const,
      fields: {
        deliveryMode: "slack-stream-fallback" as const,
        slackStreamRunClaimedAt: value.data.runClaimedAt,
      },
    };
  }
  if (value?.itemType === "teams-agent-stream") {
    return {
      channel: "teams" as const,
      fields: {
        deliveryMode: "teams-stream-fallback" as const,
        teamsStreamRunClaimedAt: value.data.runClaimedAt,
      },
    };
  }
  return undefined;
}

function activeWorkspaceCondition(workspace: Workspace): TransactionOperation {
  return {
    conditionExpression: "#data.#version = :version AND #data.#status = :active",
    expressionAttributeNames: {
      "#data": "data",
      "#status": "status",
      "#version": "version",
    },
    expressionAttributeValues: {
      ":active": "active",
      ":version": workspace.data.version,
    },
    key: { pk: workspace.pk, sk: workspace.sk },
    kind: "condition-check",
    table: "control",
  };
}

export async function channelResponsePersistence(input: {
  readonly body: string;
  readonly dependencies: AgentRunWorkerDependencies;
  readonly deliveryGeneration?: string;
  readonly run: RunRecordValue;
  readonly sourceMessageId?: Ulid;
  readonly sourceMessageSequence?: number;
  readonly timestamp: Date;
}): Promise<{
  readonly events: readonly ReturnType<typeof makeChannelSemanticEventRecord>[];
  readonly operations: readonly TransactionOperation[];
}> {
  // Preview and evaluation runs never deliver to channels, whatever their trigger.
  if (input.run.data.trigger !== "chat" || input.run.data.executionBindingId !== undefined) {
    return { events: [], operations: [] };
  }
  const message = await triggerMessage(input.run, input.dependencies);
  if (!message?.data.metadata) return { events: [], operations: [] };
  const binding = await channelBinding(input.run, message, input.dependencies);
  if (!binding?.data.credentialRef) return { events: [], operations: [] };
  const workspace = binding.data.workspaceId
    ? await activeWorkspace(input.run, binding.data.workspaceId, input.dependencies)
    : undefined;
  if (binding.data.workspaceId && !workspace) return { events: [], operations: [] };
  const externalThreadKey =
    metadataString(message.data.metadata, "externalThreadKey") ?? binding.data.externalThreadKey;
  const externalChannelId =
    metadataString(message.data.metadata, "externalChannelId") ?? binding.data.externalChannelId;
  if (
    !externalThreadKey ||
    (binding.data.provider !== "telegram" &&
      binding.data.provider !== "teams_bot_framework" &&
      !externalChannelId)
  ) {
    return { events: [], operations: [] };
  }
  if (binding.data.channel === "slack" && slackRouteRequiresApproval(externalThreadKey)) {
    return { events: [], operations: [] };
  }
  const idempotencyKey = [
    "channel-response:v1",
    input.run.data.id,
    binding.data.id,
    ...(input.deliveryGeneration ? [input.deliveryGeneration] : []),
  ].join(":");
  const deliveryId = deterministicId(
    "channel-delivery",
    "automatic",
    input.run.data.organizationId,
    input.run.data.id,
    binding.data.id,
    ...(input.deliveryGeneration ? [input.deliveryGeneration] : []),
  );
  const streamFallback = await streamFallbackDelivery(
    input.run,
    binding.data.channel,
    input.dependencies,
  );
  const deliveryBody = streamFallback
    ? streamFallbackBody(streamFallback.channel, input.body)
    : input.body;
  const bodyError = automaticChannelResponseError(deliveryBody);
  const provider = bodyError
    ? undefined
    : channelResponseProviderPayload(binding, deliveryBody, {
        externalChannelId,
        externalThreadKey,
        teamsServiceUrl: metadataString(
          slackMetadata(message.data.metadata.providerMetadata),
          "teamsServiceUrl",
        ),
      });
  const terminalError = bodyError ?? (provider && "error" in provider ? provider.error : undefined);
  // Only a completed run has a provisional assistant message to publish. A terminal failure notice
  // for an externally published run (a stream fallback) is delivered without history publication.
  const publishesResponse =
    input.run.data.responsePublication === "external" && input.run.data.status === "completed";
  if (publishesResponse && (!input.sourceMessageId || input.sourceMessageSequence === undefined)) {
    throw new Error("External channel response publication requires its provisional message.");
  }
  const routeId = metadataString(message.data.metadata, "routeId");
  const throughSequence = metadataSequence(message.data.metadata, "throughSequence");
  if ((routeId === undefined) !== (throughSequence === undefined)) {
    throw new Error("Channel ingress delivery boundary is incomplete.");
  }
  const timestamp = input.timestamp.toISOString();
  const deliveryCommand =
    terminalError || !provider || !("payload" in provider)
      ? undefined
      : {
          credentialRef: binding.data.credentialRef,
          ...streamFallback?.fields,
          providerPayload: semanticValue(provider.payload),
        };
  const delivery = Schema.decodeUnknownSync(ChannelDeliveryRecord)(
    withCanonicalRecordKeys({
      data: {
        attempts: 0,
        bindingId: binding.data.id,
        channel: binding.data.channel,
        contentPreview: Array.from(deliveryBody).slice(0, 500).join(""),
        createdAt: timestamp,
        ...deliveryCommand,
        environmentId: input.run.data.environmentId,
        externalThreadKey,
        ...(terminalError ? { failedAt: timestamp, lastError: terminalError } : {}),
        id: deliveryId,
        idempotencyKey,
        organizationId: input.run.data.organizationId,
        projectId: input.run.data.projectId,
        provider: binding.data.provider,
        ...(publishesResponse
          ? {
              publicationContent: deliveryBody,
              responsePublication: "external" as const,
              sourceMessageId: input.sourceMessageId!,
              sourceMessageSequence: input.sourceMessageSequence!,
            }
          : {}),
        ...(routeId && throughSequence !== undefined ? { routeId, throughSequence } : {}),
        runId: input.run.data.id,
        status: terminalError ? ("failed" as const) : ("queued" as const),
        threadId: input.run.data.threadId,
        updatedAt: timestamp,
        version: 0,
        ...(input.run.data.workspaceId ? { workspaceId: input.run.data.workspaceId } : {}),
      },
      itemType: "channel-delivery" as const,
    }),
  );
  const deliveryLookup = Schema.decodeUnknownSync(ChannelDeliveryLookupRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: timestamp,
        deliveryId,
        environmentId: input.run.data.environmentId,
        idempotencyKey,
        organizationId: input.run.data.organizationId,
        projectId: input.run.data.projectId,
        runId: input.run.data.id,
        threadId: input.run.data.threadId,
      },
      itemType: "channel-delivery-lookup" as const,
    }),
  );
  const event = makeChannelSemanticEventRecord({
    aggregateId: deliveryId,
    aggregateType: "channel-delivery",
    aggregateVersion: 1,
    environmentId: input.run.data.environmentId,
    eventId: deterministicId("channel-delivery-event", deliveryId),
    eventType: terminalError ? "channel.delivery.failed" : "channel.delivery.queued",
    occurredAt: input.timestamp,
    organizationId: input.run.data.organizationId,
    payload: terminalError
      ? {
          attempts: 0,
          deliveryId,
          error: terminalError,
          runId: input.run.data.id,
          status: "failed",
        }
      : {
          channelBindingId: binding.data.id,
          deliveryId,
          provider: binding.data.provider,
          runId: input.run.data.id,
          status: "queued",
        },
    projectId: input.run.data.projectId,
  });
  return {
    events: [event],
    operations: [
      {
        conditionExpression: "#data.#version = :version AND #data.#status = :active",
        expressionAttributeNames: {
          "#data": "data",
          "#status": "status",
          "#version": "version",
        },
        expressionAttributeValues: {
          ":active": "active",
          ":version": binding.data.version,
        },
        key: { pk: binding.pk, sk: binding.sk },
        kind: "condition-check",
        table: "control",
      },
      ...(workspace ? [activeWorkspaceCondition(workspace)] : []),
      {
        conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        kind: "put",
        record: delivery,
      },
      {
        conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        kind: "put",
        record: deliveryLookup,
      },
    ],
  };
}

export async function persistChannelResponse(input: {
  readonly body: string;
  readonly dependencies: AgentRunWorkerDependencies;
  readonly deliveryGeneration?: string;
  readonly run: RunRecordValue;
  readonly sourceMessageId?: Ulid;
  readonly sourceMessageSequence?: number;
  readonly timestamp: Date;
}): Promise<void> {
  const persistence = await channelResponsePersistence(input);
  const planned = persistence.operations.find(
    (operation) => operation.kind === "put" && operation.record.itemType === "channel-delivery",
  );
  if (!planned || planned.kind !== "put" || planned.record.itemType !== "channel-delivery") return;
  const delivery = planned.record;
  const alreadyPersisted = async () => {
    const current = await getRecord(input.dependencies, "execution", delivery.pk, delivery.sk);
    return (
      current?.itemType === "channel-delivery" &&
      current.data.id === delivery.data.id &&
      current.data.idempotencyKey === delivery.data.idempotencyKey &&
      current.data.runId === delivery.data.runId
    );
  };
  if (await alreadyPersisted()) return;
  try {
    await transactWithSemanticEvents(
      input.dependencies.database,
      persistence.operations,
      persistence.events,
      delivery.data.id,
    );
  } catch (cause) {
    if (await alreadyPersisted()) return;
    throw cause;
  }
}
