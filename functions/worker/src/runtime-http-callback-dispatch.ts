import { agentRunExecutionPins } from "@deployments-ai/agent-runtime";
import {
  CallbackDispatchEvidenceError,
  WorkflowExecutionPersistenceError,
  makeCallbackDispatchEvidencePersistence,
  makeWorkflowApprovalPersistence,
  makeWorkflowExecutionPersistence,
  type CallbackChannelOrigin,
  type CallbackDispatchApprovalSnapshot,
  type CallbackDispatchAuthorizationSnapshot,
  type CallbackDispatchControlAuthorizationSnapshot,
  type CallbackDispatchEvidenceInput,
  type DynamoDatabaseService,
  type Ulid,
} from "@deployments-ai/db";
import type { ToolAdapterHttpCallbackExecution } from "@deployments-ai/tools";
import {
  AgentRunWorkerRecordError,
  loadRunApproval,
  loadThreadRunById,
  loadTriggerMessage,
} from "./record-readers.ts";
import { channelOriginOf } from "./runtime-callback-origin.ts";
import type { AuthorizedRuntimeToolBindingRequest } from "./runtime-tool-planning.ts";

export interface RuntimeHttpCallbackDispatch {
  readonly evidenceId: Ulid;
  readonly origin?: CallbackChannelOrigin;
}

/** Throws when the request carrying `origin` cannot be sent. Runs before any evidence write. */
export type AssertHttpCallbackSendable = (origin: CallbackChannelOrigin | undefined) => void;

export class RuntimeHttpCallbackDispatchPermanentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeHttpCallbackDispatchPermanentError";
  }
}

function approvedAtDispatch(
  expiresAt: string | undefined,
  status: string,
  now: Date,
): status is "approved" {
  return (
    status === "approved" &&
    (!expiresAt ||
      (Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) > now.getTime()))
  );
}

/** Persist exact, immutable authorization evidence before any callback request leaves the worker. */
export function createRuntimeHttpCallbackDispatchPersistence(options: {
  readonly database: DynamoDatabaseService;
  readonly generateId: () => Promise<Ulid>;
  readonly now?: () => Date;
}) {
  const evidence = makeCallbackDispatchEvidencePersistence({
    database: options.database,
    generateId: options.generateId,
    ...(options.now ? { now: options.now } : {}),
  });
  const workflows = makeWorkflowExecutionPersistence({
    database: options.database,
    generateId: options.generateId,
  });
  const workflowApprovals = makeWorkflowApprovalPersistence({
    database: options.database,
    generateId: options.generateId,
    ...(options.now ? { now: options.now } : {}),
  });

  const persist = async (
    request: AuthorizedRuntimeToolBindingRequest,
    effectiveInput: Readonly<Record<string, unknown>>,
    control: CallbackDispatchControlAuthorizationSnapshot | undefined,
    runContext: ToolAdapterHttpCallbackExecution["runContext"],
    assertSendable: AssertHttpCallbackSendable,
  ): Promise<RuntimeHttpCallbackDispatch> => {
    if (
      !request.policyAction ||
      !control ||
      !request.decision.executionBinding.inputHash ||
      Boolean(request.approvalId) !== (request.policyAction === "require-approval")
    ) {
      throw new RuntimeHttpCallbackDispatchPermanentError(
        "HTTP callback dispatch is missing policy or input provenance.",
      );
    }

    const executionKind = request.executionKind ?? "agent-run";
    let execution: CallbackDispatchAuthorizationSnapshot["execution"];
    let approvalRecord: CallbackDispatchApprovalSnapshot | undefined;
    let approval: CallbackDispatchEvidenceInput["approval"];
    let origin: CallbackChannelOrigin | undefined;

    if (executionKind === "workflow") {
      execution = await workflows.get(request.organizationId, request.runId);
      if (
        execution.data.status !== "running" ||
        execution.data.activeStepAttemptId !== request.threadId ||
        execution.data.projectId !== request.projectId ||
        execution.data.environmentId !== request.environmentId ||
        execution.data.workspaceId !== request.workspaceId
      ) {
        throw new RuntimeHttpCallbackDispatchPermanentError(
          "HTTP callback dispatch requires its active canonical workflow step.",
        );
      }
      if (request.approvalId) {
        approvalRecord = await workflowApprovals.get(
          request.organizationId,
          request.runId,
          request.approvalId,
        );
      }
    } else {
      const run = await loadThreadRunById(options.database, request, request.runId);
      if (
        !run ||
        run.data.status !== "running" ||
        run.data.agentDeploymentId !== request.agentDeploymentId ||
        run.data.executionBindingId !== request.executionBindingId ||
        run.data.workspaceId !== request.workspaceId
      ) {
        throw new RuntimeHttpCallbackDispatchPermanentError(
          "HTTP callback dispatch requires its active canonical agent run.",
        );
      }
      execution = run;
      if (runContext?.includes("origin")) {
        const { userMessageId, userMessageSequence } = run.data;
        origin = channelOriginOf(
          run,
          userMessageId === undefined || userMessageSequence === undefined
            ? undefined
            : await loadTriggerMessage(options.database, {
                environmentId: request.environmentId,
                organizationId: request.organizationId,
                projectId: request.projectId,
                threadId: request.threadId,
                userMessageId,
                userMessageSequence,
              }),
        );
      }
      if (request.approvalId) {
        approvalRecord = await loadRunApproval(options.database, run, request.approvalId);
        if (!approvalRecord) {
          throw new RuntimeHttpCallbackDispatchPermanentError(
            "HTTP callback dispatch requires a current approved agent approval.",
          );
        }
      }
    }

    const now = options.now?.() ?? new Date();
    if (approvalRecord?.itemType === "workflow-approval") {
      if (!approvedAtDispatch(approvalRecord.data.expiresAt, approvalRecord.data.status, now)) {
        throw new RuntimeHttpCallbackDispatchPermanentError(
          "HTTP callback dispatch requires a current approved workflow approval.",
        );
      }
      approval = {
        ...(approvalRecord.data.expiresAt ? { expiresAt: approvalRecord.data.expiresAt } : {}),
        id: approvalRecord.data.id,
        kind: "workflow",
        ...(approvalRecord.data.resolvedBy ? { resolvedBy: approvalRecord.data.resolvedBy } : {}),
        status: "approved",
      };
    } else if (approvalRecord?.itemType === "approval") {
      if (
        !approvedAtDispatch(approvalRecord.data.expiresAt, approvalRecord.data.status, now) ||
        approvalRecord.data.toolCallId !== request.decision.toolCallId ||
        approvalRecord.data.requestedByAgentDeploymentId !== request.agentDeploymentId ||
        approvalRecord.data.executionBindingId !== request.executionBindingId
      ) {
        throw new RuntimeHttpCallbackDispatchPermanentError(
          "HTTP callback dispatch requires a current approved agent approval.",
        );
      }
      approval = {
        ...(approvalRecord.data.expiresAt ? { expiresAt: approvalRecord.data.expiresAt } : {}),
        id: approvalRecord.data.id,
        kind: "agent-run",
        ...(approvalRecord.data.resolvedByPrincipalId
          ? {
              resolvedBy: {
                id: approvalRecord.data.resolvedByPrincipalId,
                type: "principal" as const,
              },
            }
          : {}),
        status: "approved",
      };
    }

    const binding = request.decision.executionBinding;
    const inputHash = binding.inputHash;
    if (!inputHash) {
      throw new RuntimeHttpCallbackDispatchPermanentError(
        "HTTP callback dispatch input hash was lost.",
      );
    }
    assertSendable(origin);
    const record = await evidence.create(
      {
        ...agentRunExecutionPins(request),
        ...(approval ? { approval } : {}),
        authorizationFingerprint: binding.authorizationFingerprint,
        connectionId: binding.connectionId,
        effect: request.effect,
        environmentId: request.environmentId,
        executionKind,
        externalAccountId: binding.externalAccountId,
        id: request.decision.toolCallId,
        idempotencyKey: request.idempotencyKey,
        input: effectiveInput as CallbackDispatchEvidenceInput["input"],
        inputHash,
        inputSummary: request.inputSummary,
        ...(origin ? { origin } : {}),
        organizationId: request.organizationId,
        policyAction: request.policyAction,
        policyReason: request.decision.reason,
        projectId: request.projectId,
        requiredScopes: [...(request.requiredScopes ?? [])],
        runId: request.runId,
        threadId: request.threadId,
        ...(binding.toolAdapterId ? { toolAdapterId: binding.toolAdapterId } : {}),
        toolCallId: request.decision.toolCallId,
        toolName: request.toolName,
        ...(binding.toolPlanFingerprint
          ? { toolPlanFingerprint: binding.toolPlanFingerprint }
          : {}),
        ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
      },
      {
        ...(approvalRecord ? { approval: approvalRecord } : {}),
        control,
        execution,
      },
    );
    const { id: evidenceId, origin: recordedOrigin } = record.data;
    return { evidenceId, ...(recordedOrigin ? { origin: recordedOrigin } : {}) };
  };

  return async (
    request: AuthorizedRuntimeToolBindingRequest,
    effectiveInput: Readonly<Record<string, unknown>>,
    control: CallbackDispatchControlAuthorizationSnapshot | undefined,
    runContext: ToolAdapterHttpCallbackExecution["runContext"],
    assertSendable: AssertHttpCallbackSendable,
  ): Promise<RuntimeHttpCallbackDispatch> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await persist(request, effectiveInput, control, runContext, assertSendable);
      } catch (cause) {
        if (cause instanceof RuntimeHttpCallbackDispatchPermanentError) throw cause;
        if (
          cause instanceof CallbackDispatchEvidenceError &&
          cause.code === "authorization_conflict"
        ) {
          if (attempt < 2) continue;
          throw cause;
        }
        if (
          cause instanceof CallbackDispatchEvidenceError ||
          cause instanceof WorkflowExecutionPersistenceError ||
          cause instanceof AgentRunWorkerRecordError
        ) {
          throw new RuntimeHttpCallbackDispatchPermanentError(
            "HTTP callback dispatch provenance is invalid.",
            { cause },
          );
        }
        throw cause;
      }
    }
    throw new Error("HTTP callback dispatch authorization retry loop exhausted unexpectedly.");
  };
}
