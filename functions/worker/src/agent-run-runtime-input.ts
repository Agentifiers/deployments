import { ATTACHMENT_READ_TOOL } from "@deployments-ai/agent-manifest";
import type { AgentRunInput, RuntimeApprovedToolCall } from "@deployments-ai/agent-runtime";
import { loadRunApproval, loadRunToolCall, AgentRunWorkerRecordError } from "./records.ts";
import type {
  AgentRunWorkerDependencies,
  ConversationCheckpointRecordValue,
  MessageRecordValue,
  RunRecordValue,
} from "./types.ts";
import type { RunExecutionProfile } from "./agent-run-execution-target.ts";
import { runToolContinuation, runtimeCompletedToolCall } from "./continuation.ts";
import { hydratedModelContinuation } from "./generation-reasoning.ts";
import {
  runtimeInstructionsForTrigger,
  runtimeModelToolNamesForTrigger,
  runtimeResponseDepthPolicyForTrigger,
} from "./run-trigger-runtime.ts";
import { boundedRecentMessages, now } from "./agent-run-input.ts";
import { compileAgentManifestRuntime } from "./agent-manifest-runtime.ts";
import type { AgentRunModelAdmission } from "./agent-run-model-admission.ts";
import { admitRunInputMedia, earlierAttachmentIndex } from "./agent-run-input-media.ts";

export async function runtimeInput(input: {
  readonly dependencies: AgentRunWorkerDependencies;
  readonly checkpoint?: ConversationCheckpointRecordValue;
  readonly conversationTimingAnchor?: AgentRunInput["conversationTimingAnchor"];
  readonly messages: readonly MessageRecordValue[];
  readonly modelAdmission: AgentRunModelAdmission;
  readonly profile: RunExecutionProfile;
  readonly prompt: string;
  readonly run: RunRecordValue;
  readonly signal?: AbortSignal;
  readonly userMessage: MessageRecordValue;
}): Promise<AgentRunInput> {
  const manifest = compileAgentManifestRuntime(input.profile.manifest);
  const { modelCatalog } = input.modelAdmission;
  // Active Brain retrieval injects Brain evidence whose answer must go through private Brain
  // publication, which preview and evaluation runs never perform; they read Brains only through
  // explicit Brain read tools authorized by the preview's source deployment.
  const bound = input.profile.pins.executionBindingId !== undefined;
  const responseDepthPolicy = runtimeResponseDepthPolicyForTrigger(
    manifest.responseDepthPolicy,
    input.run.data.trigger,
  );
  const continuation = runToolContinuation(input.run);
  const claimedAt = now(input.dependencies);
  const media = await admitRunInputMedia(
    input.dependencies.database,
    input.run,
    manifest,
    input.modelAdmission.imageInput,
    claimedAt,
  );
  const inputOmissions = [
    ...(input.userMessage.data.inputOmissions ?? []),
    ...media.inputOmissions,
  ];
  const modelToolNames = runtimeModelToolNamesForTrigger(
    manifest.modelToolNames,
    input.run.data.trigger,
  );
  const [completedToolCalls, modelContinuation] = await Promise.all([
    Promise.all(
      continuation.completedToolCallIds.map(async (toolCallId) => {
        const toolCall = await loadRunToolCall(input.dependencies.database, input.run, toolCallId);
        if (!toolCall) {
          throw new AgentRunWorkerRecordError(
            "invalid_tool_continuation",
            `Completed tool continuation ${toolCallId} is missing its canonical tool call.`,
          );
        }
        return runtimeCompletedToolCall(toolCall);
      }),
    ),
    continuation.modelContinuation &&
      hydratedModelContinuation({
        database: input.dependencies.database,
        record: continuation.modelContinuation,
        run: input.run,
        ...(input.signal ? { signal: input.signal } : {}),
      }),
  ]);
  const approvedToolCalls: RuntimeApprovedToolCall[] = [];
  if (continuation.pendingAction?.kind === "tool") {
    throw new AgentRunWorkerRecordError(
      "invalid_tool_continuation",
      "A queued run cannot retain an unresolved asynchronous tool continuation.",
    );
  }
  if (continuation.pendingAction?.kind === "approval") {
    const pending = continuation.pendingAction;
    const toolCall = await loadRunToolCall(
      input.dependencies.database,
      input.run,
      pending.toolCallId,
    );
    if (!toolCall?.data.approvalId || !toolCall.data.idempotencyKey) {
      throw new AgentRunWorkerRecordError(
        "invalid_tool_continuation",
        "Approved tool continuation is missing canonical tool state.",
      );
    }
    const approvalId = toolCall.data.approvalId;
    const approval = await loadRunApproval(input.dependencies.database, input.run, approvalId);
    if (
      !approval ||
      toolCall.data.status !== "pending" ||
      toolCall.data.approvalId !== approvalId ||
      approval.data.status !== "approved" ||
      approval.data.toolCallId !== pending.toolCallId
    ) {
      throw new AgentRunWorkerRecordError(
        "invalid_tool_continuation",
        "Approved tool continuation does not match canonical approval state.",
      );
    }
    approvedToolCalls.push({
      approvalId,
      effect: toolCall.data.effect,
      ...(toolCall.data.connectionId &&
      toolCall.data.authorizationFingerprint &&
      toolCall.data.externalAccountId
        ? {
            executionBinding: {
              authorizationFingerprint: toolCall.data.authorizationFingerprint,
              connectionId: toolCall.data.connectionId,
              ...(toolCall.data.destinationsHash
                ? { destinationsHash: toolCall.data.destinationsHash }
                : {}),
              externalAccountId: toolCall.data.externalAccountId,
              ...(toolCall.data.inputHash ? { inputHash: toolCall.data.inputHash } : {}),
              ...(toolCall.data.toolAdapterId
                ? { toolAdapterId: toolCall.data.toolAdapterId }
                : {}),
              ...(toolCall.data.toolPlanFingerprint
                ? { toolPlanFingerprint: toolCall.data.toolPlanFingerprint }
                : {}),
            },
          }
        : {}),
      idempotencyKey: toolCall.data.idempotencyKey,
      ...(toolCall.data.input ? { input: toolCall.data.input } : {}),
      inputSummary: toolCall.data.inputSummary,
      policyReason: toolCall.data.policyReason ?? "Tool approval was granted.",
      requiredScopes: toolCall.data.requiredScopes,
      toolCallId: pending.toolCallId,
      toolName: toolCall.data.toolName,
    });
  }
  // A rolling checkpoint is a lossy summary of older continuity, not a replacement for the exact
  // recent conversation. Checkpoints can advance through the immediately preceding assistant
  // turn, so excluding every covered message can leave the model with no verbatim history at all.
  // Always retain the bounded newest tail even when the checkpoint also summarizes those turns.
  const recentMessageCandidates = input.messages;
  const checkpointBoundary = input.checkpoint
    ? {
        threadId: input.checkpoint.data.threadId,
        ...(input.checkpoint.data.throughMessageCharacterOffset !== undefined
          ? {
              throughMessageCharacterOffset: input.checkpoint.data.throughMessageCharacterOffset,
            }
          : {}),
        throughSequence: input.checkpoint.data.throughSequence,
      }
    : undefined;
  const recentMessages = await boundedRecentMessages(
    recentMessageCandidates,
    manifest.recentMessageCharacterBudget,
    input.dependencies,
    input.signal,
    checkpointBoundary,
  );
  const attachmentIndex = await earlierAttachmentIndex(
    input.dependencies.database,
    input.run,
    recentMessages,
    claimedAt,
  );
  const hostDrain = input.dependencies.hostDrain;
  return {
    ...input.profile.pins,
    agentManifestHash: input.profile.agentManifestHash,
    brainRetrievalMode: bound ? "off" : (input.profile.runtimeConfig?.brainRetrievalMode ?? "off"),
    captureMode: input.run.data.captureMode,
    // A draining host asks the run to checkpoint at its next tool-batch boundary.
    ...(hostDrain ? { checkpointRequested: () => hostDrain.deadline() !== undefined } : {}),
    ...(input.checkpoint
      ? {
          conversationCheckpoint: {
            ...(input.checkpoint.data.fromMessageCreatedAt
              ? { fromMessageCreatedAt: input.checkpoint.data.fromMessageCreatedAt }
              : {}),
            fromSequence: input.checkpoint.data.fromSequence,
            sourceMessageCount: input.checkpoint.data.sourceMessageCount,
            summary: input.checkpoint.data.summary,
            ...(input.checkpoint.data.throughMessageCharacterOffset !== undefined
              ? {
                  throughMessageCharacterOffset:
                    input.checkpoint.data.throughMessageCharacterOffset,
                }
              : {}),
            ...(input.checkpoint.data.throughMessageCreatedAt
              ? { throughMessageCreatedAt: input.checkpoint.data.throughMessageCreatedAt }
              : {}),
            throughSequence: input.checkpoint.data.throughSequence,
          },
        }
      : {}),
    ...(input.conversationTimingAnchor
      ? { conversationTimingAnchor: input.conversationTimingAnchor }
      : {}),
    ...(input.run.data.runContext ? { runContext: input.run.data.runContext } : {}),
    ...(input.run.data.responseFormat ? { responseFormat: input.run.data.responseFormat } : {}),
    ...(media.inputMedia ? { inputMedia: media.inputMedia } : {}),
    ...(input.userMessage.data.unlistedInputOmissions
      ? { unlistedInputOmissions: input.userMessage.data.unlistedInputOmissions }
      : {}),
    ...(inputOmissions.length > 0 ? { inputOmissions } : {}),
    ...(attachmentIndex.length > 0 ? { attachmentIndex } : {}),
    ...(approvedToolCalls.length > 0 ? { approvedToolCalls } : {}),
    ...(continuation.artifactContinuation
      ? { artifactContinuation: continuation.artifactContinuation }
      : {}),
    ...(completedToolCalls.length > 0 ? { completedToolCalls } : {}),
    environmentId: input.run.data.environmentId,
    instructions: runtimeInstructionsForTrigger(manifest.instructions, input.run.data.trigger),
    historySelection: {
      availableMessages: recentMessageCandidates.length,
      characterBudget: manifest.recentMessageCharacterBudget,
      selectedMessages: recentMessages.length,
    },
    // A run outside any workspace has no workspace memories to recall. Customer runs cannot reach
    // here without one (submission refuses them), but previews of a workspace-memory draft can.
    memoryMode:
      input.profile.memoryRecall &&
      !(manifest.memoryMode === "workspace" && !input.run.data.workspaceId)
        ? manifest.memoryMode
        : "off",
    ...(manifest.maxModelGenerations !== undefined
      ? { maxModelGenerations: manifest.maxModelGenerations }
      : {}),
    ...(manifest.maxToolCalls !== undefined ? { maxToolCalls: manifest.maxToolCalls } : {}),
    ...(modelCatalog ? { modelCatalog } : {}),
    modelFallbackIds: media.modelFallbackIds,
    ...(modelContinuation ? { modelContinuation } : {}),
    modelId: manifest.modelId,
    ...(manifest.modelInputTokenBudget !== undefined
      ? { modelInputTokenBudget: manifest.modelInputTokenBudget }
      : {}),
    ...(manifest.modelOptions !== undefined ? { modelOptions: manifest.modelOptions } : {}),
    ...(manifest.modelOutputTokenReserve !== undefined
      ? { modelOutputTokenReserve: manifest.modelOutputTokenReserve }
      : {}),
    ...(manifest.modelToolProtocol !== undefined
      ? { modelToolProtocol: manifest.modelToolProtocol }
      : {}),
    modelToolNames:
      media.readableDocuments || attachmentIndex.length > 0
        ? [...modelToolNames, ATTACHMENT_READ_TOOL]
        : modelToolNames,
    organizationId: input.run.data.organizationId,
    projectId: input.run.data.projectId,
    prompt: input.prompt,
    promptCreatedAt: input.run.data.createdAt,
    recentMessages,
    ...(responseDepthPolicy !== undefined ? { responseDepthPolicy } : {}),
    ...(continuation.retriedToolCall ? { retriedToolCall: continuation.retriedToolCall } : {}),
    runId: input.run.data.id,
    runAttempt: input.run.data.attempt,
    runExecutionVersion: input.run.data.version,
    sandboxPolicy: manifest.sandboxPolicy,
    spanId: input.run.data.spanId,
    ...(input.signal ? { signal: input.signal } : {}),
    skills: manifest.skills,
    threadId: input.run.data.threadId,
    traceId: input.run.data.traceId,
    ...(input.run.data.parentSpanId ? { parentSpanId: input.run.data.parentSpanId } : {}),
    toolRequests: manifest.toolRequests,
    ...(manifest.toolResultImages !== undefined
      ? { toolResultImages: manifest.toolResultImages }
      : {}),
    ...(input.run.data.workspaceId ? { workspaceId: input.run.data.workspaceId } : {}),
  };
}
