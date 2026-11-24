import { makeAgentRunPlanPersistence } from "@deployments-ai/db";
import type { AgentRunWorkerDependencies, RunRecordValue } from "./types.ts";

export async function channelAgentStreamPlan(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
) {
  const persisted = await makeAgentRunPlanPersistence(dependencies.database).load({
    organizationId: run.data.organizationId,
    runId: run.data.id,
  });
  if (persisted?.data.runExecutionVersion !== run.data.version) return undefined;
  return {
    tasks: persisted.data.tasks.map((task) => ({
      id: task.id,
      order: task.order,
      status: task.status,
      title: task.title,
      ...(task.details ? { details: task.details } : {}),
    })),
    title: persisted.data.title,
  };
}
