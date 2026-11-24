import {
  TEAMS_DEFAULT_SERVICE_URL,
  awsRcsDeliveryPayload,
  channelProviderRequiresExternalWorkspacePin,
  externalThreadTarget,
  normalizeTeamsAgentIdentity,
  slackMarkdownMessageText,
  slackMessageIdentityPayload,
  teamsDeliveryPayload,
  telegramDeliveryParts,
  telegramDeliveryPayload,
  type SlackMessageIdentityPayload,
  type TeamsAgentIdentity,
} from "@deployments-ai/channel-adapters";
import {
  AuditEventRecord,
  ChannelBindingRecord,
  ChannelDeliveryLookupRecord,
  ChannelDeliveryRecord,
  Ulid,
  key,
  runtimeApiPersistence,
  withCanonicalRecordKeys,
  type TransactionOperation,
} from "@deployments-ai/db";
import { makeChannelSemanticEventRecord, transactWithSemanticEvents } from "@deployments-ai/events";
import { Schema } from "effect";
import { RuntimeApiError } from "./runtime-api-error.ts";
import { loadRun } from "./run-message-read.ts";
import { recordActor } from "./runtime-principal.ts";
import { type RuntimeApiDependencies, type RuntimeApiPrincipal } from "./runtime-support.ts";

import {
  activeWorkspaceCondition,
  assertDeliveryReplay,
  boundedText,
  channel,
  channelBindingMetadataValue,
  compatible,
  deterministicId,
  environmentPartition,
  getRecord,
  loadChannelBinding,
  omitUndefined,
  optional,
  provider,
  requestHash,
  rcsMessageValue,
  requireActiveWorkspace,
  requireDeployment,
  runnableDeploymentCondition,
  semanticValue,
  slackThreadTs,
  ulid,
  type Binding,
} from "./channel-validation.ts";
export async function replaceBinding(
  previous: Binding,
  next: Binding,
  eventType: "channel.binding.deleted" | "channel.binding.updated",
  dependencies: RuntimeApiDependencies,
  conditions: readonly TransactionOperation[] = [],
) {
  const event = makeChannelSemanticEventRecord({
    aggregateId: next.data.id,
    aggregateType: "channel-binding",
    aggregateVersion: next.data.version + 1,
    environmentId: next.data.environmentId,
    eventId: await dependencies.generateId(),
    eventType,
    occurredAt: next.data.updatedAt,
    organizationId: next.data.organizationId,
    payload: { status: next.data.status },
    projectId: next.data.projectId,
  });
  await transactWithSemanticEvents(
    dependencies.database,
    [{ kind: "put", previousRecord: previous, record: next }, ...conditions],
    [event],
  );
  return next;
}

export async function updateChannelBinding(
  principal: RuntimeApiPrincipal,
  bindingId: Ulid,
  input: Readonly<Record<string, unknown>>,
  dependencies: RuntimeApiDependencies,
) {
  const previous = await loadChannelBinding(principal, bindingId, dependencies);
  if (previous.data.status === "archived") {
    throw new RuntimeApiError(409, "binding_archived", "Archived channel bindings cannot change.");
  }
  if ("agentDeploymentId" in input && input.agentDeploymentId !== null) {
    const nextDeployment = ulid(input.agentDeploymentId, "agentDeploymentId");
    await requireDeployment(
      principal,
      dependencies,
      previous.data.agentDefinitionId,
      nextDeployment,
    );
  }
  const now = dependencies.now?.() ?? new Date();
  const routingChanged = [
    "agentDeploymentId",
    "connectionId",
    "externalAccountId",
    "externalChannelId",
    "externalThreadKey",
    "externalWorkspaceId",
  ].some((field) => field in input);
  const providerValue = provider(previous.data.provider);
  const nextMetadata =
    "metadata" in input
      ? channelBindingMetadataValue(providerValue, input.metadata, false)
      : undefined;
  const metadataPatch = "metadata" in input ? { metadata: nextMetadata } : {};
  const slackIdentityChanged =
    "metadata" in input &&
    (providerValue === "slack_edge" || providerValue === "slack_cloudflare_edge") &&
    JSON.stringify(previous.data.metadata?.slackAgentIdentity) !==
      JSON.stringify(nextMetadata?.slackAgentIdentity);
  const requiresReverification = routingChanged || slackIdentityChanged;
  const next = Schema.decodeUnknownSync(ChannelBindingRecord)(
    withCanonicalRecordKeys({
      data: omitUndefined({
        ...previous.data,
        ...optional(input, "agentDeploymentId", (value) => ulid(value, "agentDeploymentId")),
        ...optional(input, "connectionId", (value) => ulid(value, "connectionId")),
        ...optional(input, "externalAccountId", (value) =>
          boundedText(value, "externalAccountId", 512),
        ),
        ...optional(input, "externalChannelId", (value) =>
          boundedText(value, "externalChannelId", 512),
        ),
        ...optional(input, "externalThreadKey", (value) =>
          boundedText(value, "externalThreadKey", 1_024),
        ),
        ...optional(input, "externalWorkspaceId", (value) =>
          boundedText(value, "externalWorkspaceId", 512),
        ),
        ...metadataPatch,
        lastVerifiedAt: requiresReverification ? undefined : previous.data.lastVerifiedAt,
        status:
          requiresReverification || input.status === "disabled"
            ? ("disabled" as const)
            : previous.data.status,
        updatedAt: now.toISOString(),
        version: previous.data.version + 1,
      }),
      itemType: "channel-binding" as const,
    }),
  );
  return replaceBinding(previous, next, "channel.binding.updated", dependencies);
}

export async function archiveChannelBinding(
  principal: RuntimeApiPrincipal,
  bindingId: Ulid,
  dependencies: RuntimeApiDependencies,
) {
  const previous = await loadChannelBinding(principal, bindingId, dependencies);
  if (previous.data.status === "archived") return previous;
  const now = dependencies.now?.() ?? new Date();
  const next = Schema.decodeUnknownSync(ChannelBindingRecord)(
    withCanonicalRecordKeys({
      data: {
        ...previous.data,
        status: "archived" as const,
        updatedAt: now.toISOString(),
        version: previous.data.version + 1,
      },
      itemType: "channel-binding" as const,
    }),
  );
  return replaceBinding(previous, next, "channel.binding.deleted", dependencies);
}

export function deliveryExternalChannelId(
  binding: Binding,
  requestedExternalChannelId: string | undefined,
) {
  if (
    binding.data.provider === "aws_end_user_messaging_rcs" &&
    requestedExternalChannelId !== undefined &&
    requestedExternalChannelId !== binding.data.externalChannelId
  ) {
    throw new RuntimeApiError(
      400,
      "invalid_channel_identity",
      "AWS RCS delivery cannot override the binding-owned origination identity.",
    );
  }
  return requestedExternalChannelId ?? binding.data.externalChannelId;
}

export async function verifyChannelBinding(
  principal: RuntimeApiPrincipal,
  bindingId: Ulid,
  dependencies: RuntimeApiDependencies,
) {
  const previous = await loadChannelBinding(principal, bindingId, dependencies);
  if (previous.data.status === "archived") {
    throw new RuntimeApiError(409, "binding_archived", "Archived channel bindings cannot verify.");
  }
  const providerValue = provider(previous.data.provider);
  compatible(channel(previous.data.channel), providerValue);
  let requiresSlackCustomizeScope = false;
  if (providerValue === "slack_edge" || providerValue === "slack_cloudflare_edge") {
    try {
      const metadata = channelBindingMetadataValue(providerValue, previous.data.metadata, true);
      requiresSlackCustomizeScope = metadata?.slackAgentIdentity !== undefined;
    } catch {
      throw new RuntimeApiError(
        409,
        "binding_identity_invalid",
        "Channel binding has invalid Slack stream identity metadata.",
      );
    }
  }
  if (providerValue === "teams_bot_framework") {
    try {
      channelBindingMetadataValue(providerValue, previous.data.metadata, true);
    } catch {
      throw new RuntimeApiError(
        409,
        "binding_identity_invalid",
        "Channel binding has invalid Teams agent identity metadata.",
      );
    }
  }
  if (
    channelProviderRequiresExternalWorkspacePin(providerValue) &&
    !previous.data.externalWorkspaceId
  ) {
    throw new RuntimeApiError(
      409,
      "binding_incomplete",
      "Channel binding has no external workspace pin.",
    );
  }
  if (providerValue === "aws_end_user_messaging_rcs" && !previous.data.externalChannelId) {
    throw new RuntimeApiError(
      409,
      "binding_incomplete",
      "AWS RCS channel binding has no origination identity.",
    );
  }
  if (!previous.data.agentDeploymentId) {
    throw new RuntimeApiError(
      409,
      "binding_incomplete",
      "Channel binding has no agent deployment.",
    );
  }
  const deployment = await requireDeployment(
    principal,
    dependencies,
    previous.data.agentDefinitionId,
    previous.data.agentDeploymentId,
  );
  const workspace = previous.data.workspaceId
    ? await requireActiveWorkspace(principal, dependencies, previous.data.workspaceId)
    : undefined;
  const credentialRef = previous.data.credentialRef;
  if (!credentialRef || !("store" in credentialRef) || credentialRef.store !== "dynamodb-kms") {
    throw new RuntimeApiError(
      409,
      "binding_incomplete",
      "Channel binding has no attached credential.",
    );
  }
  const credential = await getRecord(
    dependencies,
    "control",
    environmentPartition(principal),
    key("CREDENTIAL-VAULT-ENTRY", credentialRef.credentialId),
  );
  const now = dependencies.now?.() ?? new Date();
  if (
    !credential ||
    credential.itemType !== "credential-vault-entry" ||
    credential.data.ownerId !== previous.data.id ||
    credential.data.ownerType !== "channel-binding" ||
    credential.data.purpose !== "channel-runtime" ||
    credential.data.status !== "active" ||
    credential.data.generation !== credentialRef.generation ||
    (credential.data.expiresAt !== undefined &&
      Date.parse(credential.data.expiresAt) <= now.getTime())
  ) {
    throw new RuntimeApiError(
      409,
      "binding_credential_invalid",
      "The attached channel credential is unavailable or does not match this binding.",
    );
  }
  if (requiresSlackCustomizeScope) {
    if (!dependencies.credentialVault) {
      throw new RuntimeApiError(
        409,
        "binding_credential_invalid",
        "The attached channel credential is unavailable or does not match this binding.",
      );
    }
    let scopes: readonly string[] | undefined;
    try {
      scopes = (
        await dependencies.credentialVault.read({
          environmentId: principal.scope.environmentId,
          expectedIdentity: {
            ownerId: previous.data.id,
            ownerType: "channel-binding",
            projectId: principal.scope.projectId,
            purpose: "channel-runtime",
          },
          organizationId: principal.scope.organizationId,
          reference: credentialRef,
        })
      ).scopes;
    } catch {
      throw new RuntimeApiError(
        409,
        "binding_credential_invalid",
        "The attached channel credential is unavailable or does not match this binding.",
      );
    }
    const audit = Schema.decodeUnknownSync(AuditEventRecord)(
      withCanonicalRecordKeys({
        data: {
          action: "credential.read",
          actor: recordActor(principal),
          environmentId: principal.scope.environmentId,
          eventId: await dependencies.generateId(),
          occurredAt: now.toISOString(),
          organizationId: principal.scope.organizationId,
          projectId: principal.scope.projectId,
          resourceId: credentialRef.credentialId,
          resourceType: "credential-vault-entry",
        },
        itemType: "audit-event" as const,
      }),
    );
    await runtimeApiPersistence.write(
      dependencies.database,
      audit,
      "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    );
    if (!scopes?.includes("chat:write") || !scopes.includes("chat:write.customize")) {
      throw new RuntimeApiError(
        409,
        "binding_credential_capability_missing",
        "Slack stream identity requires the chat:write and chat:write.customize OAuth scopes.",
      );
    }
  }
  const next = Schema.decodeUnknownSync(ChannelBindingRecord)(
    withCanonicalRecordKeys({
      data: {
        ...previous.data,
        lastVerifiedAt: now.toISOString(),
        status: "active" as const,
        updatedAt: now.toISOString(),
        version: previous.data.version + 1,
      },
      itemType: "channel-binding" as const,
    }),
  );
  return replaceBinding(previous, next, "channel.binding.updated", dependencies, [
    runnableDeploymentCondition(deployment),
    ...(workspace ? [activeWorkspaceCondition(workspace)] : []),
  ]);
}

export function deliveryPayload(
  record: Binding,
  content: string,
  externalChannelId: string | undefined,
  externalThreadKey: string,
  rcsMessage?: Readonly<Record<string, unknown>>,
): unknown {
  if (rcsMessage && record.data.provider !== "aws_end_user_messaging_rcs") {
    throw new RuntimeApiError(
      400,
      "invalid_channel_payload",
      "rcsMessage is available only for AWS End User Messaging RCS bindings.",
    );
  }
  if (record.data.provider === "telegram") {
    const payloads = telegramDeliveryParts({ content, hasImage: false }).map((part) =>
      telegramDeliveryPayload({ content: part.content, externalThreadKey }),
    );
    return payloads.length === 1 ? payloads[0]! : payloads;
  }
  if (!externalChannelId) {
    throw new RuntimeApiError(
      409,
      "binding_incomplete",
      "Channel delivery requires an external channel ID.",
    );
  }
  if (record.data.provider === "aws_end_user_messaging_rcs") {
    try {
      return awsRcsDeliveryPayload({
        content,
        destination: externalThreadKey,
        ...(rcsMessage ? { message: rcsMessage } : {}),
        originationIdentity: externalChannelId,
      });
    } catch (cause) {
      if (cause instanceof TypeError) {
        throw new RuntimeApiError(400, "invalid_channel_payload", cause.message);
      }
      throw cause;
    }
  }
  if (record.data.provider === "teams_bot_framework") {
    let identity: TeamsAgentIdentity | undefined;
    try {
      identity = normalizeTeamsAgentIdentity(record.data.metadata?.teamsAgentIdentity);
    } catch {
      throw new RuntimeApiError(
        409,
        "binding_identity_invalid",
        "Channel binding has invalid Teams agent identity metadata.",
      );
    }
    try {
      return teamsDeliveryPayload({
        body: content,
        conversationId: externalThreadKey.startsWith("teams:")
          ? externalThreadTarget(externalThreadKey)
          : externalChannelId,
        ...(identity ? { identity } : {}),
        serviceUrl: TEAMS_DEFAULT_SERVICE_URL,
      });
    } catch (cause) {
      if (cause instanceof TypeError) {
        throw new RuntimeApiError(400, "invalid_channel_payload", cause.message);
      }
      throw cause;
    }
  }
  let slackIdentity: SlackMessageIdentityPayload;
  try {
    slackIdentity = slackMessageIdentityPayload(record.data.metadata?.slackAgentIdentity);
  } catch {
    throw new RuntimeApiError(
      409,
      "binding_identity_invalid",
      "Channel binding has invalid Slack stream identity metadata.",
    );
  }
  return {
    channel: externalChannelId,
    markdown_text: slackMarkdownMessageText(content),
    ...(slackThreadTs(externalThreadKey) ? { thread_ts: slackThreadTs(externalThreadKey) } : {}),
    ...slackIdentity,
  };
}

export async function composeChannelDelivery(
  principal: RuntimeApiPrincipal,
  bindingId: Ulid,
  input: {
    readonly content: string;
    readonly externalChannelId?: string;
    readonly externalThreadKey: string;
    readonly idempotencyKey: string;
    readonly rcsMessage?: Readonly<Record<string, unknown>>;
    readonly runId: Ulid;
    readonly threadId: Ulid;
  },
  dependencies: RuntimeApiDependencies,
) {
  const channelBinding = await loadChannelBinding(principal, bindingId, dependencies);
  const content = boundedText(input.content, "content", 40_000);
  const externalThreadKey = boundedText(input.externalThreadKey, "externalThreadKey", 1_024);
  const rcsMessage = input.rcsMessage ? rcsMessageValue(input.rcsMessage) : undefined;
  const requestedExternalChannelId =
    input.externalChannelId === undefined
      ? undefined
      : boundedText(input.externalChannelId, "externalChannelId", 512);
  const deliveryRequestHash = requestHash({
    bindingId,
    content,
    ...(requestedExternalChannelId ? { externalChannelId: requestedExternalChannelId } : {}),
    externalThreadKey,
    ...(rcsMessage ? { rcsMessage } : {}),
    runId: input.runId,
    threadId: input.threadId,
  });
  const deliveryId = deterministicId(
    "channel-delivery",
    "explicit",
    principal.scope.organizationId,
    input.runId,
    input.idempotencyKey,
  );
  const deliveryPartition = key("ORG", principal.scope.organizationId, "RUN", input.runId);
  const existing = await getRecord(
    dependencies,
    "execution",
    deliveryPartition,
    key("CHANNEL-DELIVERY", input.idempotencyKey),
  );
  if (existing) {
    return {
      delivery: assertDeliveryReplay(existing, principal, deliveryRequestHash),
      duplicate: true,
    };
  }

  const credentialRef = channelBinding.data.credentialRef;
  if (
    channelBinding.data.status !== "active" ||
    !credentialRef ||
    !("store" in credentialRef) ||
    credentialRef.store !== "dynamodb-kms"
  ) {
    throw new RuntimeApiError(
      409,
      "binding_unavailable",
      "Channel binding is not active and credentialed.",
    );
  }
  const bindingWorkspace = channelBinding.data.workspaceId
    ? await requireActiveWorkspace(principal, dependencies, channelBinding.data.workspaceId)
    : undefined;
  const run = await loadRun(dependencies, principal, input.threadId, input.runId);
  if (run.data.status !== "completed") {
    throw new RuntimeApiError(409, "run_not_completed", "Run is not completed.");
  }
  if (
    !channelBinding.data.agentDeploymentId ||
    run.data.agentDeploymentId !== channelBinding.data.agentDeploymentId ||
    (channelBinding.data.workspaceId !== undefined &&
      run.data.workspaceId !== channelBinding.data.workspaceId)
  ) {
    throw new RuntimeApiError(
      409,
      "run_binding_mismatch",
      "Run does not belong to the channel binding's agent deployment and workspace.",
    );
  }
  const externalChannelIdValue = deliveryExternalChannelId(
    channelBinding,
    requestedExternalChannelId,
  );
  const externalChannelId =
    externalChannelIdValue === undefined
      ? undefined
      : boundedText(externalChannelIdValue, "externalChannelId", 512);
  if (channelBinding.data.provider !== "telegram" && !externalChannelId) {
    throw new RuntimeApiError(
      409,
      "binding_incomplete",
      "Channel delivery requires an external channel ID.",
    );
  }
  const providerPayload = semanticValue(
    deliveryPayload(channelBinding, content, externalChannelId, externalThreadKey, rcsMessage),
  );
  const record = Schema.decodeUnknownSync(ChannelDeliveryRecord)(
    withCanonicalRecordKeys({
      data: {
        ...principal.scope,
        attempts: 0,
        bindingId,
        channel: channelBinding.data.channel,
        contentPreview: Array.from(content).slice(0, 500).join(""),
        createdAt: (dependencies.now?.() ?? new Date()).toISOString(),
        credentialRef,
        externalThreadKey,
        id: deliveryId,
        idempotencyKey: input.idempotencyKey,
        provider: channelBinding.data.provider,
        providerPayload,
        requestHash: deliveryRequestHash,
        runId: input.runId,
        status: "queued" as const,
        threadId: input.threadId,
        updatedAt: (dependencies.now?.() ?? new Date()).toISOString(),
        version: 0,
        ...(channelBinding.data.workspaceId
          ? { workspaceId: channelBinding.data.workspaceId }
          : {}),
      },
      itemType: "channel-delivery" as const,
    }),
  );
  const lookup = Schema.decodeUnknownSync(ChannelDeliveryLookupRecord)(
    withCanonicalRecordKeys({
      data: {
        ...principal.scope,
        createdAt: record.data.createdAt,
        deliveryId,
        idempotencyKey: input.idempotencyKey,
        runId: input.runId,
        threadId: input.threadId,
      },
      itemType: "channel-delivery-lookup" as const,
    }),
  );
  const event = makeChannelSemanticEventRecord({
    aggregateId: deliveryId,
    aggregateType: "channel-delivery",
    aggregateVersion: 1,
    environmentId: principal.scope.environmentId,
    eventId: await dependencies.generateId(),
    eventType: "channel.delivery.queued",
    occurredAt: record.data.createdAt,
    organizationId: principal.scope.organizationId,
    payload: {
      channelBindingId: bindingId,
      deliveryId,
      provider: channelBinding.data.provider,
      runId: input.runId,
      status: "queued",
    },
    projectId: principal.scope.projectId,
  });
  try {
    await transactWithSemanticEvents(
      dependencies.database,
      [
        {
          conditionExpression: "#data.#version = :version AND #data.#status = :active",
          expressionAttributeNames: {
            "#data": "data",
            "#status": "status",
            "#version": "version",
          },
          expressionAttributeValues: {
            ":active": "active",
            ":version": channelBinding.data.version,
          },
          key: { pk: channelBinding.pk, sk: channelBinding.sk },
          kind: "condition-check",
          table: "control",
        },
        ...(bindingWorkspace ? [activeWorkspaceCondition(bindingWorkspace)] : []),
        {
          conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          kind: "put",
          record,
        },
        {
          conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          kind: "put",
          record: lookup,
        },
      ],
      [event],
    );
    return { delivery: record, duplicate: false };
  } catch (cause) {
    const replay = await getRecord(dependencies, "execution", record.pk, record.sk);
    if (replay) {
      return {
        delivery: assertDeliveryReplay(replay, principal, deliveryRequestHash),
        duplicate: true,
      };
    }
    throw cause;
  }
}
