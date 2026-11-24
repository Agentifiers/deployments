import type {
  JsonValue,
  WorkflowConditionV1,
  WorkflowDefinitionDocumentV1,
  WorkflowOperandV1,
} from "@deployments-ai/api-contract";
import {
  type WorkflowExecutionContext,
  type WorkflowRuntimeAction,
  WorkflowRuntimeError,
} from "./model.ts";

function compareKeys(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalWorkflowJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalWorkflowJson).join(",")}]`;
  return `{${Object.entries(value)
    .toSorted(([left], [right]) => compareKeys(left, right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalWorkflowJson(entry)}`)
    .join(",")}}`;
}

function operandRoot(
  operand: WorkflowOperandV1,
  input: Readonly<Record<string, JsonValue>>,
  context: WorkflowExecutionContext,
): JsonValue | undefined {
  return operand.source === "input" ? input : context.stepOutputs[operand.stepId];
}

export function resolveWorkflowOperand(
  operand: WorkflowOperandV1,
  input: Readonly<Record<string, JsonValue>>,
  context: WorkflowExecutionContext,
): JsonValue | undefined {
  let value = operandRoot(operand, input, context);
  for (const segment of operand.path ?? []) {
    if (value === null || typeof value !== "object") return undefined;
    if (Array.isArray(value)) {
      if (typeof segment !== "number") return undefined;
      if (!Object.hasOwn(value, segment)) return undefined;
      value = value[segment];
      continue;
    }
    if (typeof segment !== "string") return undefined;
    if (!Object.hasOwn(value, segment)) return undefined;
    value = (value as Readonly<Record<string, JsonValue>>)[segment];
  }
  return value;
}

function truthy(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  return true;
}

export function evaluateWorkflowCondition(
  condition: WorkflowConditionV1,
  input: Readonly<Record<string, JsonValue>>,
  context: WorkflowExecutionContext,
): boolean {
  const left = resolveWorkflowOperand(condition.left, input, context);
  switch (condition.operator) {
    case "exists":
      return left !== undefined;
    case "truthy":
      return truthy(left);
    case "equals":
      return (
        left !== undefined && canonicalWorkflowJson(left) === canonicalWorkflowJson(condition.right)
      );
    case "not-equals":
      return (
        left === undefined || canonicalWorkflowJson(left) !== canonicalWorkflowJson(condition.right)
      );
  }
}

function stepInput(
  configured: Readonly<Record<string, JsonValue>> | undefined,
  input: Readonly<Record<string, JsonValue>>,
) {
  return configured ?? input;
}

export function planWorkflowStep(
  definition: WorkflowDefinitionDocumentV1,
  currentStepId: string,
  input: Readonly<Record<string, JsonValue>>,
  context: WorkflowExecutionContext,
  cancelRequested = false,
): WorkflowRuntimeAction {
  if (cancelRequested) return { kind: "cancel" };
  const step = definition.steps.find((candidate) => candidate.id === currentStepId);
  if (!step) {
    throw new WorkflowRuntimeError(
      "workflow_step_not_found",
      `Workflow step ${currentStepId} is absent from the pinned release.`,
    );
  }
  switch (step.type) {
    case "agent":
      return {
        agentDeploymentId: step.agentDeploymentId,
        input: stepInput(step.input, input),
        kind: "dispatch-agent",
        ...(step.onFailure ? { onFailure: step.onFailure } : {}),
        onSuccess: step.next!,
        stepId: step.id,
      };
    case "tool":
      return {
        agentDeploymentId: step.agentDeploymentId,
        ...(step.approvalStepId ? { approvalStepId: step.approvalStepId } : {}),
        input: stepInput(step.input, input),
        kind: "dispatch-tool",
        ...(step.onFailure ? { onFailure: step.onFailure } : {}),
        onSuccess: step.next!,
        stepId: step.id,
        toolName: step.toolName,
      };
    case "approval":
      return {
        kind: "request-approval",
        onApproved: step.onApproved,
        ...(step.onExpired ? { onExpired: step.onExpired } : {}),
        onRejected: step.onRejected,
        prompt: step.prompt,
        stepId: step.id,
        ...(step.timeoutSeconds ? { timeoutSeconds: step.timeoutSeconds } : {}),
      };
    case "notification":
      return {
        channel: step.channel,
        kind: "send-notification",
        message: step.message,
        ...(step.onFailure ? { onFailure: step.onFailure } : {}),
        onSuccess: step.next!,
        stepId: step.id,
        target: step.target,
      };
    case "branch": {
      const conditionResult = evaluateWorkflowCondition(step.condition, input, context);
      return {
        conditionResult,
        kind: "advance-branch",
        nextStepId: conditionResult ? step.onTrue : step.onFalse,
        stepId: step.id,
      };
    }
    case "escalation":
      return {
        kind: "emit-escalation",
        message: step.message,
        ...(step.onFailure ? { onFailure: step.onFailure } : {}),
        onSuccess: step.next!,
        stepId: step.id,
        target: step.target,
      };
    case "end":
      return { kind: "complete", output: step.outcome ?? {}, stepId: step.id };
  }
}

export function recordWorkflowStepOutput(
  context: WorkflowExecutionContext,
  stepId: string,
  output: JsonValue,
): WorkflowExecutionContext {
  return { stepOutputs: { ...context.stepOutputs, [stepId]: output } };
}
