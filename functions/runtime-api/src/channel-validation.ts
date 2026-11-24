import {
  channelProviderSupports,
  normalizeSlackStreamIdentity,
  normalizeTeamsAgentIdentity,
  type ChannelProvider,
  type ExternalAgentChannel,
} from "@deployments-ai/channel-adapters";
import { AwsRcsMessage } from "@deployments-ai/api-contract/runtime";
import {
  ChannelBindingRecord,
  DynamoValue as DynamoValueSchema,
  Metadata,
  Ulid,
  key,
  withCanonicalRecordKeys,
  type DynamoValue,
  type PlatformRecord,
  runtimeApiPersistence,
} from "@deployments-ai/db";
import { makeChannelSemanticEventRecord, transactWithSemanticEvents } from "@deployments-ai/events";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import { RuntimeApiError } from "./runtime-api-error.ts";
import {
  scoped,
  type RuntimeApiDependencies,
  type RuntimeApiPrincipal,
} from "./runtime-support.ts";

export type Binding = Extract<PlatformRecord, { readonly itemType: "channel-binding" }>;
export type Delivery = Extract<PlatformRecord, { readonly itemType: "channel-delivery" }>;
export type Deployment = Extract<PlatformRecord, { readonly itemType: "agent-deployment" }>;
export type Workspace = Extract<PlatformRecord, { readonly itemType: "workspace" }>;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_CHANNEL_BINDING_METADATA_BYTES = 32 * 1_024;
const MAX_RCS_MESSAGE_BYTES = 128 * 1_024;

export function deterministicId(...parts: readonly string[]) {
  const bytes = createHash("sha256").update(JSON.stringify(parts)).digest().subarray(0, 16);
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return Schema.decodeUnknownSync(Ulid)(encoded);
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, entry]) => [name, canonicalJsonValue(entry)]),
  );
}

export function requestHash(value: Readonly<Record<string, unknown>>) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJsonValue(value)))
    .digest("hex");
}

function metadataValue(value: unknown, optional: boolean) {
  if ((optional && value === undefined) || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeApiError(400, "invalid_request", "metadata must be an object or null.");
  }
  try {
    const metadata = Schema.decodeUnknownSync(Metadata)(value);
    if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > MAX_CHANNEL_BINDING_METADATA_BYTES) {
      throw new RuntimeApiError(
        400,
        "invalid_request",
        `metadata must not exceed ${MAX_CHANNEL_BINDING_METADATA_BYTES} serialized bytes.`,
      );
    }
    return metadata;
  } catch (cause) {
    if (cause instanceof RuntimeApiError) throw cause;
    throw new RuntimeApiError(400, "invalid_request", "metadata must contain valid JSON values.");
  }
}

export function channelBindingMetadataValue(
  providerValue: ChannelProvider,
  value: unknown,
  optional: boolean,
) {
  const metadata = metadataValue(value, optional);
  if (!metadata) return metadata;
  if (providerValue === "teams_bot_framework") {
    let identity;
    try {
      identity = normalizeTeamsAgentIdentity(metadata.teamsAgentIdentity);
    } catch {
      throw new RuntimeApiError(
        400,
        "invalid_request",
        "metadata.teamsAgentIdentity must be a valid Teams agent identity.",
      );
    }
    const { teamsAgentIdentity: _teamsAgentIdentity, ...rest } = metadata;
    return metadataValue(identity ? { ...rest, teamsAgentIdentity: identity } : rest, false)!;
  }
  if (providerValue !== "slack_edge" && providerValue !== "slack_cloudflare_edge") {
    return metadata;
  }
  let identity;
  try {
    identity = normalizeSlackStreamIdentity(metadata.slackAgentIdentity);
  } catch {
    throw new RuntimeApiError(
      400,
      "invalid_request",
      "metadata.slackAgentIdentity must be a valid Slack stream identity.",
    );
  }
  const { slackAgentIdentity: _slackAgentIdentity, ...rest } = metadata;
  return metadataValue(identity ? { ...rest, slackAgentIdentity: identity } : rest, false)!;
}

export function rcsMessageValue(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeApiError(400, "invalid_request", "rcsMessage must be an object.");
  }
  try {
    const message = Schema.decodeUnknownSync(AwsRcsMessage, { onExcessProperty: "error" })(value);
    if (Buffer.byteLength(JSON.stringify(message), "utf8") > MAX_RCS_MESSAGE_BYTES) {
      throw new RuntimeApiError(
        400,
        "invalid_request",
        `rcsMessage must not exceed ${MAX_RCS_MESSAGE_BYTES} serialized bytes.`,
      );
    }
    return message;
  } catch (cause) {
    if (cause instanceof RuntimeApiError) throw cause;
    throw new RuntimeApiError(400, "invalid_request", "rcsMessage must contain valid JSON values.");
  }
}

function bindingCreationInput(input: {
  readonly agentDefinitionId: Ulid;
  readonly agentDeploymentId?: Ulid | undefined;
  readonly channel: string;
  readonly connectionId?: Ulid | undefined;
  readonly externalAccountId?: string | undefined;
  readonly externalChannelId?: string | undefined;
  readonly externalThreadKey?: string | undefined;
  readonly externalWorkspaceId?: string | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  readonly provider: string;
  readonly workspaceId?: Ulid | undefined;
}) {
  return Object.fromEntries(
    Object.entries({
      agentDefinitionId: input.agentDefinitionId,
      agentDeploymentId: input.agentDeploymentId,
      channel: input.channel,
      connectionId: input.connectionId,
      externalAccountId: input.externalAccountId,
      externalChannelId: input.externalChannelId,
      externalThreadKey: input.externalThreadKey,
      externalWorkspaceId: input.externalWorkspaceId,
      metadata: input.metadata,
      provider: input.provider,
      workspaceId: input.workspaceId,
    }).filter(([, entry]) => entry !== undefined),
  );
}

function assertCreationReplay(
  value: PlatformRecord,
  principal: RuntimeApiPrincipal,
  creationHash: string,
) {
  const existing = binding(value, principal);
  const persistedHash =
    existing.data.creationHash ?? requestHash(bindingCreationInput(existing.data));
  if (persistedHash !== creationHash) {
    throw new RuntimeApiError(
      409,
      "idempotency_conflict",
      "Idempotency key belongs to another channel binding creation request.",
    );
  }
  return existing;
}

export function environmentPartition(principal: RuntimeApiPrincipal) {
  return key("ORG", principal.scope.organizationId, "ENV", principal.scope.environmentId);
}

export async function getRecord(
  dependencies: RuntimeApiDependencies,
  table: "control" | "execution",
  pk: string,
  sk: string,
) {
  return await runtimeApiPersistence.read(dependencies.database, table, { pk, sk }, true);
}

function binding(value: PlatformRecord | undefined, principal: RuntimeApiPrincipal) {
  if (!value || value.itemType !== "channel-binding") {
    throw new RuntimeApiError(404, "not_found", "Channel binding was not found.");
  }
  return scoped(value, principal);
}

export function channel(value: unknown): ExternalAgentChannel {
  if (
    value === "imessage" ||
    value === "rcs" ||
    value === "slack" ||
    value === "sms" ||
    value === "teams" ||
    value === "telegram"
  ) {
    return value;
  }
  throw new RuntimeApiError(400, "invalid_channel", "Channel is unsupported.");
}

export function provider(value: unknown): ChannelProvider {
  if (
    value === "aws_end_user_messaging_rcs" ||
    value === "slack_cloudflare_edge" ||
    value === "slack_edge" ||
    value === "teams_bot_framework" ||
    value === "telegram"
  ) {
    return value;
  }
  throw new RuntimeApiError(400, "invalid_provider", "Channel provider is unsupported.");
}

export function compatible(channelValue: ExternalAgentChannel, providerValue: ChannelProvider) {
  if (!channelProviderSupports(channelValue, providerValue)) {
    throw new RuntimeApiError(
      400,
      "invalid_channel_provider",
      `${providerValue} does not support ${channelValue}.`,
    );
  }
}

export async function requireDeployment(
  principal: RuntimeApiPrincipal,
  dependencies: RuntimeApiDependencies,
  agentDefinitionId: Ulid,
  agentDeploymentId: Ulid,
) {
  const value = await getRecord(
    dependencies,
    "control",
    environmentPartition(principal),
    key("AGENT-DEPLOYMENT", agentDeploymentId),
  );
  if (!value || value.itemType !== "agent-deployment") {
    throw new RuntimeApiError(404, "not_found", "Agent deployment was not found.");
  }
  const deployment = scoped(value, principal);
  if (
    deployment.data.agentDefinitionId !== agentDefinitionId ||
    deployment.data.currentState !== "ready" ||
    deployment.data.desiredState !== "running"
  ) {
    throw new RuntimeApiError(
      409,
      "deployment_unavailable",
      "The channel binding deployment is not runnable or does not match the agent definition.",
    );
  }
  return deployment;
}

export async function requireActiveWorkspace(
  principal: RuntimeApiPrincipal,
  dependencies: RuntimeApiDependencies,
  workspaceId: Ulid,
) {
  const value = await getRecord(
    dependencies,
    "control",
    environmentPartition(principal),
    key("WORKSPACE", workspaceId),
  );
  if (!value || value.itemType !== "workspace") {
    throw new RuntimeApiError(404, "not_found", "Workspace was not found.");
  }
  const workspace = scoped(value, principal);
  if (workspace.data.status !== "active") {
    throw new RuntimeApiError(409, "workspace_unavailable", "Workspace is not active.");
  }
  return workspace;
}

export function activeWorkspaceCondition(workspace: Workspace) {
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
    kind: "condition-check" as const,
    table: "control" as const,
  };
}

export function runnableDeploymentCondition(deployment: Deployment) {
  return {
    conditionExpression:
      "#data.#version = :version AND #data.#currentState = :ready AND #data.#desiredState = :running",
    expressionAttributeNames: {
      "#currentState": "currentState",
      "#data": "data",
      "#desiredState": "desiredState",
      "#version": "version",
    },
    expressionAttributeValues: {
      ":ready": "ready",
      ":running": "running",
      ":version": deployment.data.version,
    },
    key: { pk: deployment.pk, sk: deployment.sk },
    kind: "condition-check" as const,
    table: "control" as const,
  };
}

export function publicBinding(record: Binding) {
  const { creationHash: _creationHash, credentialRef, ...data } = record.data;
  return {
    ...data,
    credentialAttached: credentialRef !== undefined,
    object: record.itemType,
  };
}

export function publicDelivery(record: Delivery) {
  const {
    credentialRef: _credentialRef,
    idempotencyKey: _idempotencyKey,
    providerPayload: _providerPayload,
    requestHash: _requestHash,
    ...data
  } = record.data as Delivery["data"] & { readonly requestHash?: string };
  return { ...data, object: record.itemType };
}

export function assertDeliveryReplay(
  value: PlatformRecord,
  principal: RuntimeApiPrincipal,
  requestHashValue: string,
) {
  if (value.itemType !== "channel-delivery") {
    throw new RuntimeApiError(409, "idempotency_conflict", "Delivery idempotency key is occupied.");
  }
  const existing = scoped(value, principal);
  const existingRequestHash = (
    existing.data as Delivery["data"] & { readonly requestHash?: string }
  ).requestHash;
  if (existingRequestHash !== requestHashValue) {
    throw new RuntimeApiError(
      409,
      "idempotency_conflict",
      "Idempotency key belongs to another channel delivery request.",
    );
  }
  return existing;
}

export async function loadChannelDelivery(
  principal: RuntimeApiPrincipal,
  runId: Ulid,
  deliveryId: Ulid,
  dependencies: RuntimeApiDependencies,
) {
  const partitionKey = key("ORG", principal.scope.organizationId, "RUN", runId);
  const lookup = await getRecord(
    dependencies,
    "execution",
    partitionKey,
    key("CHANNEL-DELIVERY-LOOKUP", deliveryId),
  );
  if (
    !lookup ||
    lookup.itemType !== "channel-delivery-lookup" ||
    lookup.data.deliveryId !== deliveryId ||
    lookup.data.runId !== runId
  ) {
    throw new RuntimeApiError(404, "not_found", "Channel delivery was not found.");
  }
  scoped(lookup, principal);
  const value = await getRecord(
    dependencies,
    "execution",
    partitionKey,
    key("CHANNEL-DELIVERY", lookup.data.idempotencyKey),
  );
  if (
    value?.itemType === "channel-delivery" &&
    value.data.id === deliveryId &&
    value.data.runId === runId
  ) {
    return scoped(value, principal);
  }
  throw new RuntimeApiError(404, "not_found", "Channel delivery was not found.");
}

export async function loadChannelBinding(
  principal: RuntimeApiPrincipal,
  bindingId: Ulid,
  dependencies: RuntimeApiDependencies,
) {
  return binding(
    await getRecord(
      dependencies,
      "control",
      environmentPartition(principal),
      key("CHANNEL-BINDING", bindingId),
    ),
    principal,
  );
}

export async function createChannelBinding(
  principal: RuntimeApiPrincipal,
  input: {
    readonly agentDefinitionId: Ulid;
    readonly agentDeploymentId: Ulid;
    readonly channel: unknown;
    readonly connectionId?: Ulid;
    readonly externalAccountId?: string;
    readonly externalChannelId?: string;
    readonly externalThreadKey?: string;
    readonly externalWorkspaceId?: string;
    readonly idempotencyKey: string;
    readonly metadata?: unknown;
    readonly provider: unknown;
    readonly workspaceId?: Ulid;
  },
  dependencies: RuntimeApiDependencies,
) {
  const channelValue = channel(input.channel);
  const providerValue = provider(input.provider);
  compatible(channelValue, providerValue);
  const externalAccountId =
    input.externalAccountId === undefined
      ? undefined
      : boundedText(input.externalAccountId, "externalAccountId", 512);
  const externalChannelId =
    input.externalChannelId === undefined
      ? undefined
      : boundedText(input.externalChannelId, "externalChannelId", 512);
  const externalThreadKey =
    input.externalThreadKey === undefined
      ? undefined
      : boundedText(input.externalThreadKey, "externalThreadKey", 1_024);
  const externalWorkspaceId =
    input.externalWorkspaceId === undefined
      ? undefined
      : boundedText(input.externalWorkspaceId, "externalWorkspaceId", 512);
  const metadata = channelBindingMetadataValue(providerValue, input.metadata, true);
  const creationHash = requestHash(
    bindingCreationInput({
      agentDefinitionId: input.agentDefinitionId,
      agentDeploymentId: input.agentDeploymentId,
      channel: channelValue,
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      ...(externalAccountId ? { externalAccountId } : {}),
      ...(externalChannelId ? { externalChannelId } : {}),
      ...(externalThreadKey ? { externalThreadKey } : {}),
      ...(externalWorkspaceId ? { externalWorkspaceId } : {}),
      ...(metadata ? { metadata } : {}),
      provider: providerValue,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    }),
  );
  const id = deterministicId(
    "channel-binding",
    principal.scope.organizationId,
    principal.scope.projectId,
    principal.scope.environmentId,
    input.idempotencyKey,
  );
  const existing = await getRecord(
    dependencies,
    "control",
    environmentPartition(principal),
    key("CHANNEL-BINDING", id),
  );
  if (existing) return assertCreationReplay(existing, principal, creationHash);
  const deployment = await requireDeployment(
    principal,
    dependencies,
    input.agentDefinitionId,
    input.agentDeploymentId,
  );
  const workspace = input.workspaceId
    ? await requireActiveWorkspace(principal, dependencies, input.workspaceId)
    : undefined;
  const now = dependencies.now?.() ?? new Date();
  const record = Schema.decodeUnknownSync(ChannelBindingRecord)(
    withCanonicalRecordKeys({
      data: {
        ...principal.scope,
        agentDefinitionId: input.agentDefinitionId,
        agentDeploymentId: input.agentDeploymentId,
        channel: channelValue,
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        creationHash,
        createdAt: now.toISOString(),
        ...(externalAccountId ? { externalAccountId } : {}),
        ...(externalChannelId ? { externalChannelId } : {}),
        ...(externalThreadKey ? { externalThreadKey } : {}),
        ...(externalWorkspaceId ? { externalWorkspaceId } : {}),
        id,
        ...(metadata ? { metadata } : {}),
        provider: providerValue,
        status: "disabled" as const,
        updatedAt: now.toISOString(),
        version: 0,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      },
      itemType: "channel-binding" as const,
    }),
  );
  const event = makeChannelSemanticEventRecord({
    aggregateId: id,
    aggregateType: "channel-binding",
    aggregateVersion: 1,
    environmentId: principal.scope.environmentId,
    eventId: await dependencies.generateId(),
    eventType: "channel.binding.created",
    occurredAt: now,
    organizationId: principal.scope.organizationId,
    payload: { channel: channelValue, provider: providerValue, status: "disabled" },
    projectId: principal.scope.projectId,
  });
  try {
    await transactWithSemanticEvents(
      dependencies.database,
      [
        runnableDeploymentCondition(deployment),
        ...(workspace ? [activeWorkspaceCondition(workspace)] : []),
        {
          conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          kind: "put",
          record,
        },
      ],
      [event],
    );
    return record;
  } catch (cause) {
    const replay = await getRecord(dependencies, "control", record.pk, record.sk);
    if (replay) return assertCreationReplay(replay, principal, creationHash);
    throw cause;
  }
}

export function optional<T>(
  input: Readonly<Record<string, unknown>>,
  field: string,
  decode: (value: unknown) => T,
) {
  if (!(field in input)) return {};
  const value = input[field];
  return { [field]: value === null ? undefined : decode(value) };
}

export function omitUndefined<T extends Readonly<Record<string, unknown>>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

export function semanticValue(value: unknown): DynamoValue {
  return Schema.decodeUnknownSync(DynamoValueSchema)(value);
}

export function slackThreadTs(externalThreadKey: string) {
  const parts = externalThreadKey.split(":");
  if (parts[0] !== "slack") return undefined;
  if (parts[2] === "thread" && parts.length === 5) return parts[4];
  if (parts[2] === "shared" && parts[3] === "thread" && parts.length === 6) return parts[5];
  return undefined;
}

export function boundedText(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new RuntimeApiError(400, "invalid_request", `${label} must be non-empty and trimmed.`);
  }
  if (Array.from(value).length > maximum) {
    throw new RuntimeApiError(400, "invalid_request", `${label} is too long.`);
  }
  return value;
}

export function ulid(value: unknown, label: string) {
  try {
    return Schema.decodeUnknownSync(Ulid)(value);
  } catch {
    throw new RuntimeApiError(400, "invalid_id", `${label} must be a canonical ULID.`);
  }
}
