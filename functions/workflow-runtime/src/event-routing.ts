import {
  WorkflowExecutionPersistenceError,
  type WorkflowStepCorrelationRecordValue,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { WorkflowStepOutput, type JsonValue } from "@deployments-ai/api-contract";
import type {
  WorkflowDispatchDependencies,
  WorkflowQueueCommand,
  WorkflowRuntimePersistence,
} from "./types.ts";
import { id } from "./canonical-id.ts";

export interface SemanticEventEnvelope {
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly "detail-type"?: string;
  readonly id?: string;
}

function object(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function scope(detail: Readonly<Record<string, unknown>>) {
  return {
    environmentId: id(detail.environmentId, "event environmentId"),
    organizationId: id(detail.organizationId, "event organizationId"),
    projectId: id(detail.projectId, "event projectId"),
  };
}

function correlatedCommand(
  detail: Readonly<Record<string, unknown>>,
  correlation: WorkflowStepCorrelationRecordValue,
  outcome: Extract<WorkflowQueueCommand, { kind: "continue" }>["outcome"],
): Extract<WorkflowQueueCommand, { kind: "continue" }> {
  return {
    ...scope(detail),
    executionId: correlation.data.workflowExecutionId,
    kind: "continue",
    outcome,
    stepAttemptId: correlation.data.stepAttemptId,
  };
}

const FailureMessage = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(32_000)),
);

function terminalError(
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, JsonValue>> | undefined {
  if (payload.error === undefined) return undefined;
  if (typeof payload.error === "string") {
    return { message: Schema.decodeUnknownSync(FailureMessage)(payload.error) };
  }
  return Schema.decodeUnknownSync(WorkflowStepOutput)(
    object(payload.error, "Terminal event error"),
  );
}

export async function workflowQueueCommandFromSemanticEvent(
  event: SemanticEventEnvelope,
  persistence: Pick<WorkflowRuntimePersistence, "getCorrelation">,
  recoverCorrelation?: WorkflowDispatchDependencies["recoverCorrelation"],
): Promise<WorkflowQueueCommand | undefined> {
  const detail = object(event.detail, "Semantic event detail");
  const eventType = event["detail-type"];
  if (typeof eventType !== "string" || detail.eventType !== eventType) {
    throw new Error("Semantic event detail-type does not match detail.eventType.");
  }
  const payload = object(detail.payload ?? {}, "Semantic event payload");
  const common = scope(detail);
  if (
    eventType === "workflow-execution.requested" ||
    eventType === "workflow-execution.advance-requested" ||
    eventType === "workflow-execution.cancel-requested"
  ) {
    return {
      ...common,
      executionId: id(detail.aggregateId, "workflow execution aggregateId"),
      kind: "advance",
    };
  }
  if (
    eventType === "workflow-step.dispatch-requested" ||
    eventType === "workflow-notification.requested" ||
    eventType === "workflow-escalation.requested"
  ) {
    return {
      ...common,
      executionId: id(detail.aggregateId, "workflow execution aggregateId"),
      kind: "dispatch",
      stepAttemptId: id(payload.stepAttemptId, "stepAttemptId"),
    };
  }
  if (eventType === "workflow-approval.resolved") {
    const decision = payload.decision;
    if (
      decision !== "approved" &&
      decision !== "rejected" &&
      decision !== "expired" &&
      decision !== "canceled"
    ) {
      throw new Error("Workflow approval resolution decision is invalid.");
    }
    const approvalId = id(detail.aggregateId, "workflow approval aggregateId");
    return {
      ...common,
      executionId: id(payload.workflowExecutionId, "workflowExecutionId"),
      kind: "continue",
      approvalId,
      outcome: decision,
      stepAttemptId: id(payload.stepAttemptId, "stepAttemptId"),
    };
  }
  const correlationKinds: Readonly<
    Record<string, WorkflowStepCorrelationRecordValue["data"]["externalKind"] | undefined>
  > = {
    "channel-delivery": "delivery",
    run: "child-run",
    "tool-call": "tool-call",
  };
  const aggregateType = typeof detail.aggregateType === "string" ? detail.aggregateType : "";
  const correlationKind = correlationKinds[aggregateType];
  if (!correlationKind) return undefined;
  const terminalOutcome =
    eventType === "run.completed" ||
    eventType === "tool-call.completed" ||
    eventType === "channel.delivery.sent"
      ? aggregateType === "channel-delivery"
        ? "delivered"
        : "succeeded"
      : eventType === "run.canceled"
        ? "canceled"
        : eventType === "run.failed" ||
            eventType === "tool-call.failed" ||
            eventType === "channel.delivery.failed"
          ? "failed"
          : undefined;
  if (!terminalOutcome) return undefined;
  const externalId = id(detail.aggregateId, `${aggregateType} aggregateId`);
  let correlation: WorkflowStepCorrelationRecordValue;
  try {
    correlation = await persistence.getCorrelation(
      common.organizationId,
      correlationKind,
      externalId,
    );
  } catch (cause) {
    if (cause instanceof WorkflowExecutionPersistenceError && cause.code === "not_found") {
      if (correlationKind === "child-run" && typeof payload.threadId !== "string") {
        return undefined;
      }
      const recovered = await recoverCorrelation?.({
        ...common,
        externalId,
        externalKind: correlationKind,
        payload,
      });
      if (!recovered) return undefined;
      correlation = recovered;
    } else {
      throw cause;
    }
  }
  const error = terminalOutcome === "failed" ? terminalError(payload) : undefined;
  const command = {
    ...correlatedCommand(detail, correlation, terminalOutcome),
    ...(error ? { error } : {}),
  };
  if (eventType === "run.completed" && payload.messageId) {
    return {
      ...command,
      output: {
        messageId: id(payload.messageId, "messageId"),
        runId: externalId,
      },
    };
  }
  return command;
}

export function createWorkflowEventRouter(options: {
  readonly enqueue: (command: WorkflowQueueCommand, deduplicationId: string) => Promise<void>;
  readonly persistence: Pick<WorkflowRuntimePersistence, "getCorrelation">;
  readonly recoverCorrelation?: WorkflowDispatchDependencies["recoverCorrelation"];
  readonly scheduleApprovalExpiration?: NonNullable<
    WorkflowDispatchDependencies["scheduleApprovalExpiration"]
  >;
}) {
  return async (event: SemanticEventEnvelope) => {
    if (event["detail-type"] === "workflow-approval.requested") {
      const detail = object(event.detail, "Semantic event detail");
      if (detail.eventType !== "workflow-approval.requested") {
        throw new Error("Semantic event detail-type does not match detail.eventType.");
      }
      const payload = object(detail.payload ?? {}, "Semantic event payload");
      if (payload.expiresAt === undefined) return { routed: false };
      if (
        typeof payload.expiresAt !== "string" ||
        !Number.isFinite(Date.parse(payload.expiresAt))
      ) {
        throw new Error("Workflow approval expiresAt must be a canonical timestamp.");
      }
      if (!options.scheduleApprovalExpiration) {
        throw new Error("Workflow approval expiration scheduler is unavailable.");
      }
      await options.scheduleApprovalExpiration({
        approvalId: id(detail.aggregateId, "workflow approval aggregateId"),
        executionId: id(payload.workflowExecutionId, "workflowExecutionId"),
        expiresAt: payload.expiresAt,
        organizationId: id(detail.organizationId, "event organizationId"),
      });
      return { routed: false, scheduled: true };
    }
    const command = await workflowQueueCommandFromSemanticEvent(
      event,
      options.persistence,
      options.recoverCorrelation,
    );
    if (!command) return { routed: false };
    const eventId = event.id?.trim();
    if (!eventId) throw new Error("Semantic event envelope id is required for deduplication.");
    await options.enqueue(command, eventId);
    return { routed: true };
  };
}
