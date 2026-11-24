import {
  Ulid,
  WorkflowExecutionPersistenceError,
  makeWorkflowApprovalPersistence,
} from "@deployments-ai/db";
import { createAgentRunWorkerDependencies } from "@deployments-ai/worker";
import { Schema } from "effect";

const Command = Schema.Struct({
  approvalId: Ulid,
  executionId: Ulid,
  organizationId: Ulid,
});

let dependenciesPromise: ReturnType<typeof createAgentRunWorkerDependencies> | undefined;

async function dependencies() {
  return (dependenciesPromise ??= createAgentRunWorkerDependencies().catch((cause) => {
    dependenciesPromise = undefined;
    throw cause;
  }));
}

export async function handler(event: unknown) {
  const command = Schema.decodeUnknownSync(Command)(event);
  const worker = await dependencies();
  const approvals = makeWorkflowApprovalPersistence({
    database: worker.database,
    generateId: worker.generateId,
  });
  const current = await approvals.get(
    command.organizationId,
    command.executionId,
    command.approvalId,
  );
  if (current.data.status !== "pending") {
    return { approvalId: current.data.id, status: current.data.status };
  }
  let approval;
  try {
    approval = await approvals.resolve({
      decision: "expired",
      organizationId: command.organizationId,
      resolvedBy: { type: "system" },
      workflowApprovalId: command.approvalId,
      workflowExecutionId: command.executionId,
    });
  } catch (cause) {
    if (!(cause instanceof WorkflowExecutionPersistenceError) || cause.code !== "conflict") {
      throw cause;
    }
    const reconciled = await approvals.get(
      command.organizationId,
      command.executionId,
      command.approvalId,
    );
    if (reconciled.data.status === "pending") throw cause;
    approval = reconciled;
  }
  return { approvalId: approval.data.id, status: approval.data.status };
}
