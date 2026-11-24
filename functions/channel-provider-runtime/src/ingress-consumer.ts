import {
  channelProviderRequiresExternalWorkspacePin,
  type ChannelAttachmentReference,
} from "@deployments-ai/channel-adapters";
import {
  ConversationError,
  RUN_REFUSAL_CODES,
  channelEndUserId,
  ingressAttachmentsEnabled,
  type EndUserKeyDeriver,
  type SubmitConversationTurnInput,
  type SubmitConversationTurnResult,
} from "@deployments-ai/conversations";
import {
  type ChannelIngressBurstPersistence,
  type ChannelIngressBurstPreparation,
  type PlatformRecord,
  type Ulid,
  channelIngressBurstRouteId,
} from "@deployments-ai/db";
import type { IngressAttachments, IngressAttachmentsResult } from "@deployments-ai/ingress-media";
import { createHash } from "node:crypto";
import { channelAttachmentCandidates } from "./ingress-attachments.ts";
import {
  CHANNEL_INGRESS_QUIET_WINDOW_MAX_RESCHEDULES,
  channelIngressBurstStageInput,
  channelIngressMessageMetadata,
  channelIngressQueueRoute,
  decodeChannelIngressQueueMessage,
  type ChannelIngressFlushQueueMessageV1,
  type ChannelIngressFlushSchedule,
  type ChannelIngressQueueMessageV1,
  type DecodedChannelIngressQueueMessageV1,
} from "./ingress-message.ts";
import { record, text, ulid } from "./ingress-payload-fields.ts";

export { decodeChannelIngressQueueMessage } from "./ingress-message.ts";

const UNRETRYABLE_BURST_CODES: ReadonlySet<string> = new Set([
  ...RUN_REFUSAL_CODES,
  "end_user_mismatch",
]);

type ChannelBindingRecordValue = Extract<PlatformRecord, { readonly itemType: "channel-binding" }>;
type AgentDeploymentRecordValue = Extract<
  PlatformRecord,
  { readonly itemType: "agent-deployment" }
>;
type AgentReleaseRecordValue = Extract<PlatformRecord, { readonly itemType: "agent-release" }>;

export interface ChannelIngressConsumerDependencies {
  readonly endUserSubjects: EndUserKeyDeriver;
  readonly ingressAttachments: IngressAttachments<ChannelAttachmentReference>;
  readonly loadBinding: (
    message: ChannelIngressQueueMessageV1,
  ) => Promise<ChannelBindingRecordValue | undefined>;
  readonly loadDeployment: (
    message: ChannelIngressQueueMessageV1,
    deploymentId: Ulid,
  ) => Promise<AgentDeploymentRecordValue | undefined>;
  readonly loadRelease: (
    message: ChannelIngressQueueMessageV1,
    releaseId: Ulid,
  ) => Promise<AgentReleaseRecordValue | undefined>;
  readonly resolveThreadId: (input: {
    readonly agentDeploymentId: Ulid;
    readonly externalThreadKey: string;
    readonly message: ChannelIngressQueueMessageV1;
    readonly sourceId: Ulid;
  }) => Promise<Ulid>;
  readonly submitTurn: (
    input: SubmitConversationTurnInput,
  ) => Promise<SubmitConversationTurnResult>;
}

export interface ChannelIngressQueueConsumerDependencies extends ChannelIngressConsumerDependencies {
  readonly burstPersistence: ChannelIngressBurstPersistence;
  readonly enqueueFlush: (flush: ChannelIngressFlushSchedule) => Promise<void>;
}

export interface ChannelIngressSubmission {
  readonly omittedAttachments: IngressAttachmentsResult["omitted"];
  readonly result: SubmitConversationTurnResult;
  readonly skippedAttachments: IngressAttachmentsResult["skipped"];
}

export type ChannelIngressQueueOutcome =
  | { readonly kind: "duplicate" | "staged" }
  | Exclude<ChannelIngressBurstPreparation, { readonly kind: "ready" }>
  | { readonly code: string; readonly detail: string; readonly kind: "refused" }
  | (ChannelIngressSubmission & { readonly kind: "submitted" });

export function channelIngressIdempotencyKey(message: ChannelIngressQueueMessageV1) {
  return channelIngressBurstIdempotencyKey(message, [message.ingress.externalMessageId]);
}

function channelIngressBurstIdempotencyKey(
  message: ChannelIngressQueueMessageV1,
  sourceMessageIds: readonly string[],
) {
  const routeId = channelIngressBurstRouteId(channelIngressQueueRoute(message));
  const digest = createHash("sha256")
    .update(JSON.stringify(["channel-ingress-turn-v2", routeId, ...sourceMessageIds]))
    .digest("hex");
  return `channel-ingress-turn:v2:${digest}`;
}

export async function processChannelIngress(
  value: unknown,
  dependencies: ChannelIngressConsumerDependencies,
) {
  return processDecodedChannelIngressBurst(
    [decodeChannelIngressQueueMessage(value)],
    undefined,
    undefined,
    dependencies,
  );
}

function sameBurstRoute(
  first: ChannelIngressQueueMessageV1,
  candidate: ChannelIngressQueueMessageV1,
) {
  return (
    candidate.bindingId === first.bindingId &&
    candidate.environmentId === first.environmentId &&
    candidate.organizationId === first.organizationId &&
    candidate.projectId === first.projectId &&
    candidate.ingress.provider === first.ingress.provider &&
    candidate.ingress.channel === first.ingress.channel &&
    candidate.ingress.executor === first.ingress.executor &&
    candidate.ingress.externalAccountId === first.ingress.externalAccountId &&
    candidate.ingress.externalWorkspaceId === first.ingress.externalWorkspaceId &&
    candidate.ingress.externalChannelId === first.ingress.externalChannelId &&
    candidate.ingress.externalThreadKey === first.ingress.externalThreadKey &&
    candidate.ingress.sender.id === first.ingress.sender.id
  );
}

function mergedBurstMessage(messages: readonly ChannelIngressQueueMessageV1[]) {
  const first = messages[0];
  if (!first) throw new Error("Channel ingress burst must contain at least one source message.");
  if (!messages.every((candidate) => sameBurstRoute(first, candidate))) {
    throw new Error("Channel ingress burst contains messages from different routes or senders.");
  }
  if (messages.length === 1) return first;
  const primary = messages.at(-1)!;
  const sourceMessageIds = messages.map(({ ingress }) => ingress.externalMessageId);
  const attachments = messages.flatMap(({ ingress }) => ingress.attachments ?? []);
  return {
    ...primary,
    ingress: {
      ...primary.ingress,
      ...(attachments.length > 0 ? { attachments } : {}),
      content: messages.map(({ ingress }) => ingress.content).join("\n"),
      externalMessageId: `burst:${createHash("sha256")
        .update(JSON.stringify(sourceMessageIds))
        .digest("hex")}`,
    },
  } satisfies ChannelIngressQueueMessageV1;
}

async function runnableIngressContext(
  message: ChannelIngressQueueMessageV1,
  dependencies: ChannelIngressConsumerDependencies,
) {
  const binding = await dependencies.loadBinding(message);
  if (
    !binding ||
    binding.data.id !== message.bindingId ||
    binding.data.organizationId !== message.organizationId ||
    binding.data.projectId !== message.projectId ||
    binding.data.environmentId !== message.environmentId ||
    binding.data.status !== "active"
  ) {
    throw new Error("Channel ingress binding is unavailable or does not match queue scope.");
  }
  if (
    binding.data.channel !== message.ingress.channel ||
    binding.data.provider !== message.ingress.provider ||
    (channelProviderRequiresExternalWorkspacePin(binding.data.provider) &&
      binding.data.externalWorkspaceId === undefined) ||
    (binding.data.externalAccountId !== undefined &&
      binding.data.externalAccountId !== message.ingress.externalAccountId) ||
    (binding.data.externalChannelId !== undefined &&
      binding.data.externalChannelId !== message.ingress.externalChannelId) ||
    (binding.data.externalThreadKey !== undefined &&
      binding.data.externalThreadKey !== message.ingress.externalThreadKey) ||
    (binding.data.externalWorkspaceId !== undefined &&
      binding.data.externalWorkspaceId !== message.ingress.externalWorkspaceId)
  ) {
    throw new Error("Channel ingress request does not match the current binding.");
  }
  if (!binding.data.agentDeploymentId) {
    throw new Error("Channel binding does not pin an agent deployment.");
  }
  const deployment = await dependencies.loadDeployment(message, binding.data.agentDeploymentId);
  if (
    !deployment ||
    deployment.data.id !== binding.data.agentDeploymentId ||
    deployment.data.agentDefinitionId !== binding.data.agentDefinitionId ||
    deployment.data.organizationId !== message.organizationId ||
    deployment.data.projectId !== message.projectId ||
    deployment.data.environmentId !== message.environmentId ||
    deployment.data.currentState !== "ready" ||
    deployment.data.desiredState !== "running"
  ) {
    throw new Error("Channel binding agent deployment is not runnable.");
  }
  return { binding, deployment };
}

async function processDecodedChannelIngressBurst(
  messages: readonly DecodedChannelIngressQueueMessageV1[],
  expectedSourceMessageIds: readonly string[] | undefined,
  burst: { readonly routeId: string; readonly throughSequence: number } | undefined,
  dependencies: ChannelIngressConsumerDependencies,
): Promise<ChannelIngressSubmission> {
  const sourceMessageIds = messages.map(({ ingress }) => ingress.externalMessageId);
  if (
    expectedSourceMessageIds &&
    (expectedSourceMessageIds.length !== sourceMessageIds.length ||
      expectedSourceMessageIds.some((id, index) => id !== sourceMessageIds[index]))
  ) {
    throw new Error("Prepared channel ingress source identities do not match their payloads.");
  }
  const message = mergedBurstMessage(messages);
  const { binding, deployment } = await runnableIngressContext(message, dependencies);
  const threadId = await dependencies.resolveThreadId({
    agentDeploymentId: deployment.data.id,
    externalThreadKey: message.ingress.externalThreadKey,
    message,
    sourceId: binding.data.id,
  });
  const owner = {
    sourceId: binding.data.id,
    sourceKind: "channel-binding",
    type: "ingress",
  } as const;
  const candidates = channelAttachmentCandidates(messages);
  const attachments =
    candidates.length === 0
      ? { offeredArtifactIds: [], omitted: [], skipped: [] }
      : await dependencies.ingressAttachments.prepare({
          candidates,
          capture: await ingressAttachmentsEnabled(deployment, (releaseId) =>
            dependencies.loadRelease(message, releaseId),
          ),
          owner,
          scope: message,
          threadId,
        });
  const endUserId = channelEndUserId({
    channel: message.ingress.channel,
    externalChannelId: message.ingress.externalChannelId,
    externalThreadKey: message.ingress.externalThreadKey,
    externalWorkspaceId: message.ingress.externalWorkspaceId,
    metadata: message.ingress.metadata,
    provider: message.ingress.provider,
    senderId: message.ingress.sender.id,
  });
  const result = await dependencies.submitTurn({
    actor: { type: "system" },
    agentDeploymentId: deployment.data.id,
    channel: message.ingress.channel,
    content: message.ingress.content,
    createThreadIfMissing: true,
    ...(endUserId
      ? { endUserKey: dependencies.endUserSubjects(message.organizationId, endUserId) }
      : {}),
    environmentId: message.environmentId,
    executor: message.ingress.executor ?? "hosted",
    externalThreadKey: message.ingress.externalThreadKey,
    idempotencyKey: channelIngressBurstIdempotencyKey(message, sourceMessageIds),
    initiatingCaller: owner,
    ...(attachments.offeredArtifactIds.length > 0
      ? { inputArtifacts: attachments.offeredArtifactIds }
      : {}),
    messageMetadata: channelIngressMessageMetadata(message, sourceMessageIds, burst),
    organizationId: message.organizationId,
    projectId: message.projectId,
    responsePublication: "external",
    threadId,
    ...(attachments.skipped.length > 0 ? { skippedInputFiles: attachments.skipped } : {}),
    trigger: "chat",
    ...(binding.data.workspaceId ? { workspaceId: binding.data.workspaceId } : {}),
  });
  return {
    omittedAttachments: attachments.omitted,
    result,
    skippedAttachments: attachments.skipped,
  };
}

function decodeChannelIngressFlushQueueMessage(value: unknown): ChannelIngressFlushQueueMessageV1 {
  const message = record(value, "Channel ingress flush queue message");
  if (message.type !== "channel.ingress.flush" || message.version !== 1) {
    throw new Error("Channel ingress flush queue message version is unsupported.");
  }
  const dueAt = text(message, "dueAt", "Channel ingress flush queue message");
  if (!Number.isFinite(Date.parse(dueAt)) || new Date(Date.parse(dueAt)).toISOString() !== dueAt) {
    throw new Error("Channel ingress flush dueAt must be a canonical UTC timestamp.");
  }
  const hash = (field: "burstId" | "routeId") => {
    const value = text(message, field, "Channel ingress flush queue message");
    if (!/^[a-f0-9]{64}$/u.test(value)) {
      throw new Error(`Channel ingress flush ${field} must be a SHA-256 digest.`);
    }
    return value;
  };
  const rescheduleCount = message.rescheduleCount ?? 0;
  if (
    typeof rescheduleCount !== "number" ||
    !Number.isSafeInteger(rescheduleCount) ||
    rescheduleCount < 0
  ) {
    throw new Error("Channel ingress flush rescheduleCount must be a non-negative safe integer.");
  }
  return {
    bindingId: ulid(message.bindingId, "Channel ingress flush bindingId"),
    burstId: hash("burstId"),
    dueAt,
    environmentId: ulid(message.environmentId, "Channel ingress flush environmentId"),
    organizationId: ulid(message.organizationId, "Channel ingress flush organizationId"),
    projectId: ulid(message.projectId, "Channel ingress flush projectId"),
    rescheduleCount,
    routeId: hash("routeId"),
    type: "channel.ingress.flush",
    version: 1,
  };
}

export async function processChannelIngressQueueCommand(
  value: unknown,
  dependencies: ChannelIngressQueueConsumerDependencies,
): Promise<ChannelIngressQueueOutcome> {
  const command = record(value, "Channel ingress queue command");
  if (command.type === "channel.ingress") {
    const message = decodeChannelIngressQueueMessage(command);
    await runnableIngressContext(message, dependencies);
    const staged = await dependencies.burstPersistence.stage(
      channelIngressBurstStageInput(message),
    );
    for (const flush of staged.flushes) await dependencies.enqueueFlush(flush);
    return { kind: staged.duplicate ? ("duplicate" as const) : ("staged" as const) };
  }
  if (command.type !== "channel.ingress.flush") {
    throw new Error("Channel ingress queue command type is unsupported.");
  }
  const flush = decodeChannelIngressFlushQueueMessage(command);
  const preparation = await dependencies.burstPersistence.prepare(flush);
  // Every accepted source schedules a flush for the quiet window it established. A waiting command
  // retains an independent trigger for either an extended window or an earlier conversation burst.
  // Quiet-window churn is bounded defensively. A valid predecessor wait is not: dropping its final
  // trigger would permanently strand this route behind the predecessor.
  if (preparation.kind === "waiting") {
    if (
      preparation.waitFor === "quiet-window" &&
      flush.rescheduleCount >= CHANNEL_INGRESS_QUIET_WINDOW_MAX_RESCHEDULES
    ) {
      throw new Error("Channel ingress quiet-window flush exhausted its reschedule budget.");
    }
    await dependencies.enqueueFlush({
      ...flush,
      dueAt: preparation.dueAt,
      rescheduleCount:
        preparation.waitFor === "quiet-window" ? flush.rescheduleCount + 1 : flush.rescheduleCount,
    });
    return preparation;
  }
  if (preparation.kind === "superseded") return preparation;
  const messages = preparation.payloads.map(decodeChannelIngressQueueMessage);
  let submission: ChannelIngressSubmission;
  try {
    submission = await processDecodedChannelIngressBurst(
      messages,
      preparation.sourceMessageIds,
      { routeId: preparation.routeId, throughSequence: preparation.throughSequence },
      dependencies,
    );
  } catch (cause) {
    if (!(cause instanceof ConversationError && UNRETRYABLE_BURST_CODES.has(cause.code))) {
      throw cause;
    }
    await dependencies.burstPersistence.complete(flush);
    return { code: cause.code, detail: cause.message, kind: "refused" };
  }
  await dependencies.burstPersistence.complete(flush);
  return { ...submission, kind: "submitted" };
}
