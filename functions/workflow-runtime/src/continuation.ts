import { WorkflowDefinitionDocumentV1 } from "@deployments-ai/api-contract";
import { planWorkflowStep, recordWorkflowStepOutput } from "@deployments-ai/workflows";
import { Schema } from "effect";
import {
  completedAttempt,
  executionContext,
  nextExecutionRecord,
  workflowStepOutputsFit,
} from "./record-builders.ts";
import type { WorkflowProcessorDependencies, WorkflowStepResult } from "./types.ts";

function resultTarget(
  action: ReturnType<typeof planWorkflowStep>,
  outcome: WorkflowStepResult["outcome"],
) {
  if (action.kind === "request-approval") {
    if (outcome === "approved") return action.onApproved;
    if (outcome === "rejected") return action.onRejected;
    if (outcome === "expired") return action.onExpired;
    return undefined;
  }
  if (
    action.kind === "dispatch-agent" ||
    action.kind === "dispatch-tool" ||
    action.kind === "send-notification" ||
    action.kind === "emit-escalation"
  ) {
    return outcome === "succeeded" || outcome === "delivered" ? action.onSuccess : action.onFailure;
  }
  return undefined;
}

export async function continueWorkflowExecution(
  result: WorkflowStepResult,
  dependencies: WorkflowProcessorDependencies,
) {
  const previous = await dependencies.persistence.get(
    result.execution.organizationId,
    result.execution.executionId,
  );
  const attempt = await dependencies.persistence.getStepAttempt(
    result.execution.organizationId,
    result.execution.executionId,
    result.stepAttemptId,
  );
  if (
    previous.data.organizationId !== result.execution.organizationId ||
    previous.data.projectId !== result.execution.projectId ||
    previous.data.environmentId !== result.execution.environmentId
  ) {
    throw new Error("Workflow continuation does not match the execution scope.");
  }
  if (
    attempt.data.status === "succeeded" ||
    attempt.data.status === "failed" ||
    attempt.data.status === "canceled"
  ) {
    return { action: "skipped" as const, reason: "step-attempt-terminal" };
  }
  if (previous.data.activeStepAttemptId !== attempt.data.id) {
    throw new Error("Workflow continuation does not match the active step attempt.");
  }
  const requiresApprovalId =
    attempt.data.stepType === "approval" &&
    (result.outcome === "approved" ||
      result.outcome === "rejected" ||
      result.outcome === "expired");
  if (
    (requiresApprovalId && (!result.approvalId || attempt.data.approvalId !== result.approvalId)) ||
    (result.approvalId &&
      (attempt.data.stepType !== "approval" || attempt.data.approvalId !== result.approvalId))
  ) {
    throw new Error("Workflow approval continuation does not match the durable approval attempt.");
  }
  const release = await dependencies.loadRelease(previous);
  if (
    release.id !== previous.data.workflowReleaseId ||
    release.contentHash !== previous.data.workflowContentHash
  ) {
    throw new Error("Workflow continuation release does not match its immutable pin.");
  }
  const definition = Schema.decodeUnknownSync(WorkflowDefinitionDocumentV1)(release.definition);
  const context = executionContext(previous);
  const action = planWorkflowStep(definition, attempt.data.stepId, previous.data.input, context);
  const timestamp = (dependencies.now?.() ?? new Date()).toISOString();

  if (previous.data.status === "canceling") {
    const canceledAttempt = completedAttempt(
      attempt,
      timestamp,
      "canceled",
      result.output,
      result.error,
    );
    const canceled = nextExecutionRecord(
      previous,
      { completedAt: timestamp, status: "canceled" },
      timestamp,
      { clearActiveStep: true, clearCurrentStep: true },
    );
    await dependencies.persistence.commitTransition({
      eventType: "workflow-execution.canceled",
      nextExecution: canceled,
      previousExecution: previous,
      previousStepAttempt: attempt,
      stepAttempt: canceledAttempt,
    });
    return {
      action: "canceled" as const,
      execution: canceled,
      stepAttempt: canceledAttempt,
    };
  }

  const target = resultTarget(action, result.outcome);
  const successful =
    result.outcome === "succeeded" ||
    result.outcome === "delivered" ||
    result.outcome === "approved" ||
    result.outcome === "rejected" ||
    result.outcome === "expired";
  const nextAttempt = completedAttempt(
    attempt,
    timestamp,
    successful ? "succeeded" : "failed",
    result.output,
    result.error,
  );
  if (!target) {
    const failed = nextExecutionRecord(
      previous,
      {
        completedAt: timestamp,
        error: result.error ?? {
          code: "workflow_step_failed",
          message: `Workflow step ${attempt.data.stepId} failed without a failure target.`,
        },
        status: "failed",
      },
      timestamp,
      { clearActiveStep: true, clearCurrentStep: true },
    );
    await dependencies.persistence.commitTransition({
      eventType: "workflow-execution.failed",
      nextExecution: failed,
      previousExecution: previous,
      previousStepAttempt: attempt,
      stepAttempt: nextAttempt,
    });
    return {
      action: "failed" as const,
      execution: failed,
      stepAttempt: nextAttempt,
    };
  }

  const output = result.output ?? { outcome: result.outcome };
  const stepOutputs = recordWorkflowStepOutput(context, attempt.data.stepId, output).stepOutputs;
  if (!workflowStepOutputsFit(stepOutputs)) {
    const error = {
      code: "workflow_context_too_large",
      message: "Workflow step outputs exceeded the durable execution context budget.",
    };
    const failedAttempt = completedAttempt(attempt, timestamp, "failed", undefined, error);
    const failed = nextExecutionRecord(
      previous,
      { completedAt: timestamp, error, status: "failed" },
      timestamp,
      { clearActiveStep: true, clearCurrentStep: true },
    );
    await dependencies.persistence.commitTransition({
      eventType: "workflow-execution.failed",
      nextExecution: failed,
      previousExecution: previous,
      previousStepAttempt: attempt,
      stepAttempt: failedAttempt,
    });
    return {
      action: "failed" as const,
      execution: failed,
      stepAttempt: failedAttempt,
    };
  }
  const previousApprovalEvidence = previous.data.context.approvalEvidenceByStep;
  const previousApprovalEvidenceByStep = isPlainRecord(previousApprovalEvidence)
    ? previousApprovalEvidence
    : {};
  const advanced = nextExecutionRecord(
    previous,
    {
      context: {
        ...previous.data.context,
        ...(result.approvalId
          ? {
              approvalEvidenceByStep: {
                ...previousApprovalEvidenceByStep,
                [attempt.data.stepId]: result.approvalId,
              },
            }
          : {}),
        stepOutputs,
      },
      currentStepAttempt: 0,
      currentStepId: target,
      status: "queued",
    },
    timestamp,
    { clearActiveStep: true, clearCurrentStep: true },
  );
  await dependencies.persistence.commitTransition({
    eventType: "workflow-execution.advance-requested",
    nextExecution: advanced,
    payload: { completedStepId: attempt.data.stepId },
    previousExecution: previous,
    previousStepAttempt: attempt,
    stepAttempt: nextAttempt,
  });
  return {
    action: "advanced" as const,
    execution: advanced,
    stepAttempt: nextAttempt,
  };
}

function isPlainRecord<T>(value: T): value is Exclude<Extract<T, object>, readonly unknown[]> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
