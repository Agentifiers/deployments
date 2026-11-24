import type { JsonValue } from "@deployments-ai/api-contract";
import {
  WorkflowExecutionRecord,
  WorkflowStepAttemptRecord,
  withCanonicalRecordKeys,
  type Ulid,
  type WorkflowExecutionRecordValue,
  type WorkflowStepAttemptRecordValue,
} from "@deployments-ai/db";
import type { WorkflowExecutionContext, WorkflowRuntimeAction } from "@deployments-ai/workflows";
import { Schema } from "effect";

export const MAX_WORKFLOW_EXECUTION_CONTEXT_BYTES = 192 * 1024;

export function workflowStepOutputsFit(stepOutputs: Readonly<Record<string, JsonValue>>) {
  return (
    new TextEncoder().encode(JSON.stringify(stepOutputs)).byteLength <=
    MAX_WORKFLOW_EXECUTION_CONTEXT_BYTES
  );
}

export function executionContext(
  execution: WorkflowExecutionRecordValue,
): WorkflowExecutionContext {
  const value = execution.data.context.stepOutputs;
  return value && typeof value === "object" && !Array.isArray(value)
    ? { stepOutputs: value as Readonly<Record<string, JsonValue>> }
    : { stepOutputs: {} };
}

export function actionInput(action: WorkflowRuntimeAction): Readonly<Record<string, JsonValue>> {
  switch (action.kind) {
    case "dispatch-agent":
    case "dispatch-tool":
      return action.input;
    case "request-approval":
      return { prompt: action.prompt };
    case "send-notification":
      return { channel: action.channel, message: action.message, target: action.target };
    case "emit-escalation":
      return { message: action.message, target: action.target };
    case "advance-branch":
      return { conditionResult: action.conditionResult };
    case "complete":
    case "cancel":
      return {};
  }
}

export function workflowStepAttempt(
  execution: WorkflowExecutionRecordValue,
  action: Exclude<WorkflowRuntimeAction, { readonly kind: "cancel" }>,
  id: Ulid,
  timestamp: string,
  status: WorkflowStepAttemptRecordValue["data"]["status"],
  output?: Readonly<Record<string, JsonValue>>,
) {
  const step =
    action.kind === "complete"
      ? "end"
      : action.kind === "advance-branch"
        ? "branch"
        : action.kind === "dispatch-agent"
          ? "agent"
          : action.kind === "dispatch-tool"
            ? "tool"
            : action.kind === "request-approval"
              ? "approval"
              : action.kind === "send-notification"
                ? "notification"
                : "escalation";
  return Schema.decodeUnknownSync(WorkflowStepAttemptRecord)(
    withCanonicalRecordKeys({
      data: {
        attempt: execution.data.currentStepAttempt ?? 0,
        ...(["canceled", "failed", "succeeded"].includes(status) ? { completedAt: timestamp } : {}),
        createdAt: timestamp,
        environmentId: execution.data.environmentId,
        id,
        input: actionInput(action),
        organizationId: execution.data.organizationId,
        ...(output ? { output } : {}),
        projectId: execution.data.projectId,
        startedAt: timestamp,
        status,
        stepId: action.stepId,
        stepType: step,
        updatedAt: timestamp,
        version: 0,
        workflowExecutionId: execution.data.id,
      },
      itemType: "workflow-step-attempt" as const,
    }),
  );
}

export function nextExecutionRecord(
  previous: WorkflowExecutionRecordValue,
  changes: Partial<WorkflowExecutionRecordValue["data"]>,
  timestamp: string,
  options: { readonly clearActiveStep?: boolean; readonly clearCurrentStep?: boolean } = {},
) {
  const {
    activeStepAttemptId: _activeStepAttemptId,
    currentStepAttempt: _currentStepAttempt,
    currentStepId: _currentStepId,
    ...base
  } = previous.data;
  return Schema.decodeUnknownSync(WorkflowExecutionRecord)(
    withCanonicalRecordKeys({
      ...previous,
      data: {
        ...base,
        ...(!options.clearActiveStep && previous.data.activeStepAttemptId
          ? { activeStepAttemptId: previous.data.activeStepAttemptId }
          : {}),
        ...(!options.clearCurrentStep && previous.data.currentStepId
          ? { currentStepId: previous.data.currentStepId }
          : {}),
        ...(!options.clearCurrentStep && previous.data.currentStepAttempt !== undefined
          ? { currentStepAttempt: previous.data.currentStepAttempt }
          : {}),
        ...changes,
        updatedAt: timestamp,
        version: previous.data.version + 1,
      },
      itemType: "workflow-execution" as const,
    }),
  );
}

export function completedAttempt(
  previous: WorkflowStepAttemptRecordValue,
  timestamp: string,
  status: "succeeded" | "failed" | "canceled",
  output?: Readonly<Record<string, JsonValue>>,
  error?: Readonly<Record<string, JsonValue>>,
) {
  return Schema.decodeUnknownSync(WorkflowStepAttemptRecord)(
    withCanonicalRecordKeys({
      ...previous,
      data: {
        ...previous.data,
        completedAt: timestamp,
        ...(error ? { error } : {}),
        ...(output ? { output } : {}),
        status,
        updatedAt: timestamp,
        version: previous.data.version + 1,
      },
      itemType: "workflow-step-attempt" as const,
    }),
  );
}

export function waitingAttempt(
  previous: WorkflowStepAttemptRecordValue,
  timestamp: string,
  reference: {
    readonly referenceId: Ulid;
    readonly referenceKind: "approval" | "child-run" | "delivery" | "tool-call";
  },
) {
  const referenceField =
    reference.referenceKind === "approval"
      ? { approvalId: reference.referenceId }
      : reference.referenceKind === "child-run"
        ? { childRunId: reference.referenceId }
        : reference.referenceKind === "delivery"
          ? { deliveryId: reference.referenceId }
          : { toolCallId: reference.referenceId };
  return Schema.decodeUnknownSync(WorkflowStepAttemptRecord)(
    withCanonicalRecordKeys({
      ...previous,
      data: {
        ...previous.data,
        ...referenceField,
        status: "waiting" as const,
        updatedAt: timestamp,
        version: previous.data.version + 1,
      },
      itemType: "workflow-step-attempt" as const,
    }),
  );
}
