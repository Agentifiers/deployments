import { WorkflowDefinitionDocumentV1 } from "@deployments-ai/api-contract";
import { workflowStepCorrelation, type Ulid } from "@deployments-ai/db";
import { planWorkflowStep } from "@deployments-ai/workflows";
import { Schema } from "effect";
import { continueWorkflowExecution } from "./continuation.ts";
import { executionContext, nextExecutionRecord, waitingAttempt } from "./record-builders.ts";
import type { WorkflowDispatchDependencies, WorkflowExecutionMessage } from "./types.ts";

function waitingStatus(kind: ReturnType<typeof planWorkflowStep>["kind"]) {
  switch (kind) {
    case "dispatch-agent":
      return "waiting-for-agent" as const;
    case "dispatch-tool":
      return "waiting-for-tool" as const;
    case "request-approval":
      return "waiting-for-approval" as const;
    case "send-notification":
    case "emit-escalation":
      return "waiting-for-delivery" as const;
    case "advance-branch":
    case "complete":
    case "cancel":
      throw new Error(`Workflow action ${kind} cannot be externally dispatched.`);
  }
}

export async function dispatchWorkflowStep(
  message: WorkflowExecutionMessage & { readonly stepAttemptId: Ulid },
  dependencies: WorkflowDispatchDependencies,
) {
  const execution = await dependencies.persistence.get(message.organizationId, message.executionId);
  const attempt = await dependencies.persistence.getStepAttempt(
    message.organizationId,
    message.executionId,
    message.stepAttemptId,
  );
  if (
    execution.data.organizationId !== message.organizationId ||
    execution.data.projectId !== message.projectId ||
    execution.data.environmentId !== message.environmentId
  ) {
    throw new Error("Workflow dispatch message does not match the execution scope.");
  }
  if (["canceling", "canceled", "completed", "failed"].includes(execution.data.status)) {
    return { action: "skipped" as const, reason: "execution-not-dispatchable" };
  }
  if (attempt.data.status !== "queued") {
    return { action: "skipped" as const, reason: "step-attempt-not-queued" };
  }
  if (
    execution.data.activeStepAttemptId !== attempt.data.id ||
    execution.data.status !== "running"
  ) {
    throw new Error("Workflow dispatch does not match the active execution step.");
  }
  const release = await dependencies.loadRelease(execution);
  if (
    release.id !== execution.data.workflowReleaseId ||
    release.contentHash !== execution.data.workflowContentHash
  ) {
    throw new Error("Workflow dispatch release does not match its immutable pin.");
  }
  const definition = Schema.decodeUnknownSync(WorkflowDefinitionDocumentV1)(release.definition);
  const action = planWorkflowStep(
    definition,
    attempt.data.stepId,
    execution.data.input,
    executionContext(execution),
  );
  if (action.kind === "advance-branch" || action.kind === "complete" || action.kind === "cancel") {
    throw new Error(`Workflow action ${action.kind} was incorrectly queued for dispatch.`);
  }
  const result = await dependencies.dispatchStep({
    action,
    execution,
    idempotencyKey: `workflow:${execution.data.id}:${attempt.data.stepId}:${attempt.data.attempt}`,
    stepAttempt: attempt,
  });
  if (result.state === "failed") {
    return continueWorkflowExecution(
      {
        error: result.error,
        execution: message,
        outcome: "failed",
        stepAttemptId: attempt.data.id,
      },
      dependencies,
    );
  }
  if (result.state === "succeeded") {
    return continueWorkflowExecution(
      {
        execution: message,
        outcome: "succeeded",
        ...(result.output ? { output: result.output } : {}),
        stepAttemptId: attempt.data.id,
      },
      dependencies,
    );
  }
  const timestamp = (dependencies.now?.() ?? new Date()).toISOString();
  const waitingStep = waitingAttempt(attempt, timestamp, result);
  const correlation = workflowStepCorrelation({
    createdAt: timestamp,
    environmentId: execution.data.environmentId,
    externalId: result.referenceId,
    externalKind: result.referenceKind,
    organizationId: execution.data.organizationId,
    projectId: execution.data.projectId,
    stepAttemptId: attempt.data.id,
    workflowExecutionId: execution.data.id,
  });
  const waitingExecution = nextExecutionRecord(
    execution,
    { status: waitingStatus(action.kind) },
    timestamp,
  );
  await dependencies.persistence.commitTransition({
    correlation,
    eventType: "workflow-step.waiting",
    nextExecution: waitingExecution,
    payload: {
      referenceId: result.referenceId,
      referenceKind: result.referenceKind,
      stepAttemptId: attempt.data.id,
      stepId: attempt.data.stepId,
    },
    previousExecution: execution,
    previousStepAttempt: attempt,
    stepAttempt: waitingStep,
  });
  return {
    action: "waiting" as const,
    execution: waitingExecution,
    stepAttempt: waitingStep,
  };
}
