import { WorkflowStepOutput } from "@deployments-ai/api-contract";
import { Schema } from "effect";
import { id } from "./canonical-id.ts";
import { continueWorkflowExecution } from "./continuation.ts";
import { dispatchWorkflowStep } from "./dispatch.ts";
import { processWorkflowExecution } from "./processor.ts";
import type { WorkflowDispatchDependencies, WorkflowQueueCommand } from "./types.ts";

export interface SqsRecordLike {
  readonly body?: string;
  readonly messageId?: string;
}

export interface SqsBatchLike {
  readonly Records: readonly SqsRecordLike[];
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

export function decodeWorkflowQueueCommand(value: unknown): WorkflowQueueCommand {
  const candidate = record(value, "Workflow queue command");
  const scope = {
    environmentId: id(candidate.environmentId, "environmentId"),
    executionId: id(candidate.executionId, "executionId"),
    organizationId: id(candidate.organizationId, "organizationId"),
    projectId: id(candidate.projectId, "projectId"),
  };
  if (candidate.kind === "advance") return { ...scope, kind: "advance" };
  if (candidate.kind === "dispatch") {
    return {
      ...scope,
      kind: "dispatch",
      stepAttemptId: id(candidate.stepAttemptId, "stepAttemptId"),
    };
  }
  if (candidate.kind === "continue") {
    const outcomes = new Set([
      "succeeded",
      "failed",
      "approved",
      "rejected",
      "expired",
      "delivered",
      "canceled",
    ]);
    if (typeof candidate.outcome !== "string" || !outcomes.has(candidate.outcome)) {
      throw new Error("Workflow continuation outcome is invalid.");
    }
    const output =
      candidate.output === undefined
        ? undefined
        : Schema.decodeUnknownSync(WorkflowStepOutput)(record(candidate.output, "output"));
    const error =
      candidate.error === undefined
        ? undefined
        : Schema.decodeUnknownSync(WorkflowStepOutput)(record(candidate.error, "error"));
    return {
      ...scope,
      ...(candidate.approvalId === undefined
        ? {}
        : { approvalId: id(candidate.approvalId, "approvalId") }),
      ...(error ? { error } : {}),
      kind: "continue",
      outcome: candidate.outcome as Extract<WorkflowQueueCommand, { kind: "continue" }>["outcome"],
      ...(output ? { output } : {}),
      stepAttemptId: id(candidate.stepAttemptId, "stepAttemptId"),
    };
  }
  throw new Error("Workflow queue command kind is unsupported.");
}

export async function handleWorkflowQueueCommand(
  command: WorkflowQueueCommand,
  dependencies: WorkflowDispatchDependencies,
) {
  switch (command.kind) {
    case "advance":
      return processWorkflowExecution(command, dependencies);
    case "dispatch":
      return dispatchWorkflowStep(command, dependencies);
    case "continue":
      return continueWorkflowExecution(
        {
          ...(command.approvalId ? { approvalId: command.approvalId } : {}),
          execution: command,
          ...(command.error ? { error: command.error } : {}),
          outcome: command.outcome,
          ...(command.output ? { output: command.output } : {}),
          stepAttemptId: command.stepAttemptId,
        },
        dependencies,
      );
  }
}

export function createWorkflowQueueHandler(dependencies: WorkflowDispatchDependencies) {
  return async (event: SqsBatchLike) => {
    const failures: { itemIdentifier: string }[] = [];
    await Promise.all(
      event.Records.map(async (record, index) => {
        const itemIdentifier = record.messageId?.trim() || `record-${index}`;
        try {
          if (!record.body) throw new Error("Workflow queue record body is required.");
          await handleWorkflowQueueCommand(
            decodeWorkflowQueueCommand(JSON.parse(record.body)),
            dependencies,
          );
        } catch (cause) {
          console.error("Workflow queue command failed.", {
            errorType: cause instanceof Error ? cause.name : "UnknownError",
            itemIdentifier,
          });
          failures.push({ itemIdentifier });
        }
      }),
    );
    return { batchItemFailures: failures };
  };
}
