import { WorkflowDefinitionDocumentV1 } from "@deployments-ai/api-contract";
import {
  WorkflowExecutionPersistenceError,
  canceledWorkflowApproval,
  type WorkflowApprovalRecordValue,
  type WorkflowExecutionRecordValue,
} from "@deployments-ai/db";
import { planWorkflowStep, recordWorkflowStepOutput } from "@deployments-ai/workflows";
import { Schema } from "effect";
import {
  completedAttempt,
  executionContext,
  actionInput,
  nextExecutionRecord,
  workflowStepAttempt,
  workflowStepOutputsFit,
} from "./record-builders.ts";
import type {
  ProcessWorkflowExecutionResult,
  WorkflowExecutionMessage,
  WorkflowProcessorDependencies,
} from "./types.ts";

const TERMINAL_STATUSES = new Set(["canceled", "completed", "failed"]);
const WAITING_STATUSES = new Set([
  "waiting-for-agent",
  "waiting-for-tool",
  "waiting-for-approval",
  "waiting-for-delivery",
]);
export const MAX_WORKFLOW_STEP_TRANSITIONS = 1_000;

function assertMessageScope(
  execution: WorkflowExecutionRecordValue,
  message: WorkflowExecutionMessage,
) {
  if (
    execution.data.organizationId !== message.organizationId ||
    execution.data.projectId !== message.projectId ||
    execution.data.environmentId !== message.environmentId ||
    execution.data.id !== message.executionId
  ) {
    throw new Error("Workflow execution queue message does not match the stored execution scope.");
  }
}

async function pinnedDefinition(
  execution: WorkflowExecutionRecordValue,
  dependencies: WorkflowProcessorDependencies,
) {
  const release = await dependencies.loadRelease(execution);
  if (
    release.id !== execution.data.workflowReleaseId ||
    release.contentHash !== execution.data.workflowContentHash
  ) {
    throw new Error("Workflow execution release snapshot does not match its immutable pin.");
  }
  return Schema.decodeUnknownSync(WorkflowDefinitionDocumentV1)(release.definition);
}

export async function processWorkflowExecution(
  message: WorkflowExecutionMessage,
  dependencies: WorkflowProcessorDependencies,
): Promise<ProcessWorkflowExecutionResult> {
  const previous = await dependencies.persistence.get(message.organizationId, message.executionId);
  assertMessageScope(previous, message);
  if (TERMINAL_STATUSES.has(previous.data.status)) {
    return { action: "skipped", reason: "execution-terminal" };
  }
  const timestamp = (dependencies.now?.() ?? new Date()).toISOString();
  if (previous.data.status === "canceling") {
    const previousAttempt = previous.data.activeStepAttemptId
      ? await dependencies.persistence.getStepAttempt(
          previous.data.organizationId,
          previous.data.id,
          previous.data.activeStepAttemptId,
        )
      : undefined;
    const canceledAttempt =
      previousAttempt && !["canceled", "failed", "succeeded"].includes(previousAttempt.data.status)
        ? completedAttempt(previousAttempt, timestamp, "canceled")
        : undefined;
    const approvalId =
      previousAttempt?.data.stepType === "approval"
        ? (previousAttempt.data.approvalId ?? previousAttempt.data.id)
        : undefined;
    let previousApproval: WorkflowApprovalRecordValue | undefined;
    if (approvalId && dependencies.persistence.getApproval) {
      try {
        previousApproval = await dependencies.persistence.getApproval(
          previous.data.organizationId,
          previous.data.id,
          approvalId,
        );
      } catch (cause) {
        if (!(cause instanceof WorkflowExecutionPersistenceError && cause.code === "not_found")) {
          throw cause;
        }
      }
    }
    const canceledApproval = previousApproval
      ? canceledWorkflowApproval(previousApproval, timestamp)
      : undefined;
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
      ...(canceledAttempt && previousAttempt
        ? { previousStepAttempt: previousAttempt, stepAttempt: canceledAttempt }
        : {}),
      ...(canceledApproval && previousApproval && canceledApproval !== previousApproval
        ? { approval: canceledApproval, previousApproval }
        : {}),
    });
    return {
      action: "canceled",
      execution: canceled,
      ...(canceledAttempt ? { stepAttempt: canceledAttempt } : {}),
    };
  }
  if (WAITING_STATUSES.has(previous.data.status) || previous.data.activeStepAttemptId) {
    return { action: "skipped", reason: "execution-waiting" };
  }
  if (previous.data.stepTransitionCount >= MAX_WORKFLOW_STEP_TRANSITIONS) {
    const failed = nextExecutionRecord(
      previous,
      {
        completedAt: timestamp,
        error: { code: "step_limit_exceeded", message: "Workflow step limit was exceeded." },
        status: "failed",
      },
      timestamp,
      { clearActiveStep: true, clearCurrentStep: true },
    );
    await dependencies.persistence.commitTransition({
      eventType: "workflow-execution.failed",
      nextExecution: failed,
      previousExecution: previous,
    });
    return { action: "failed", execution: failed };
  }
  if (!previous.data.currentStepId)
    throw new Error("Active workflow execution has no current step.");
  const definition = await pinnedDefinition(previous, dependencies);
  const context = executionContext(previous);
  const action = planWorkflowStep(
    definition,
    previous.data.currentStepId,
    previous.data.input,
    context,
  );
  if (action.kind === "cancel") throw new Error("Unexpected cancellation plan.");
  const attemptId = await dependencies.generateId();

  if (action.kind === "complete") {
    const attempt = workflowStepAttempt(
      previous,
      action,
      attemptId,
      timestamp,
      "succeeded",
      action.output,
    );
    const completed = nextExecutionRecord(
      previous,
      {
        completedAt: timestamp,
        context: previous.data.context,
        output: action.output,
        status: "completed",
        stepTransitionCount: previous.data.stepTransitionCount + 1,
      },
      timestamp,
      { clearActiveStep: true, clearCurrentStep: true },
    );
    await dependencies.persistence.commitTransition({
      eventType: "workflow-execution.completed",
      nextExecution: completed,
      previousExecution: previous,
      stepAttempt: attempt,
    });
    return { action: "completed", execution: completed, stepAttempt: attempt };
  }

  if (action.kind === "advance-branch") {
    const output = { conditionResult: action.conditionResult };
    const stepOutputs = recordWorkflowStepOutput(context, action.stepId, output).stepOutputs;
    if (!workflowStepOutputsFit(stepOutputs)) {
      const error = {
        code: "workflow_context_too_large",
        message: "Workflow step outputs exceeded the durable execution context budget.",
      };
      const attempt = workflowStepAttempt(previous, action, attemptId, timestamp, "failed");
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
        stepAttempt: attempt,
      });
      return { action: "failed", execution: failed, stepAttempt: attempt };
    }
    const attempt = workflowStepAttempt(
      previous,
      action,
      attemptId,
      timestamp,
      "succeeded",
      output,
    );
    const advanced = nextExecutionRecord(
      previous,
      {
        context: { ...previous.data.context, stepOutputs },
        currentStepAttempt: 0,
        currentStepId: action.nextStepId,
        status: "queued",
        stepTransitionCount: previous.data.stepTransitionCount + 1,
        ...(!previous.data.startedAt ? { startedAt: timestamp } : {}),
      },
      timestamp,
      { clearActiveStep: true, clearCurrentStep: true },
    );
    await dependencies.persistence.commitTransition({
      eventType: "workflow-execution.advance-requested",
      nextExecution: advanced,
      payload: { completedStepId: action.stepId },
      previousExecution: previous,
      stepAttempt: attempt,
    });
    return { action: "advanced", execution: advanced, stepAttempt: attempt };
  }

  const attempt = workflowStepAttempt(previous, action, attemptId, timestamp, "queued");
  const dispatching = nextExecutionRecord(
    previous,
    {
      activeStepAttemptId: attemptId,
      status: "running",
      stepTransitionCount: previous.data.stepTransitionCount + 1,
      ...(!previous.data.startedAt ? { startedAt: timestamp } : {}),
    },
    timestamp,
  );
  await dependencies.persistence.commitTransition({
    eventType:
      action.kind === "send-notification"
        ? "workflow-notification.requested"
        : action.kind === "emit-escalation"
          ? "workflow-escalation.requested"
          : "workflow-step.dispatch-requested",
    nextExecution: dispatching,
    payload: { input: actionInput(action), stepAttemptId: attemptId, stepId: action.stepId },
    previousExecution: previous,
    stepAttempt: attempt,
  });
  return { action: "dispatch-requested", execution: dispatching, stepAttempt: attempt };
}
