import { createSqsWorkflowQueueEnqueue } from "./sqs.ts";
import { createWorkflowEventRouter, type SemanticEventEnvelope } from "./event-routing.ts";
import { cachedWorkflowRuntimeDependencies } from "./runtime-composition.ts";

const QUEUE_URL_ENV = "DEPLOYMENTS_AI_WORKFLOW_QUEUE_URL";

export async function handler(event: SemanticEventEnvelope) {
  const queueUrl = process.env[QUEUE_URL_ENV]?.trim();
  if (!queueUrl) throw new Error(`${QUEUE_URL_ENV} is required.`);
  const dependencies = await cachedWorkflowRuntimeDependencies();
  return createWorkflowEventRouter({
    enqueue: createSqsWorkflowQueueEnqueue({ queueUrl }),
    persistence: dependencies.persistence,
    ...(dependencies.recoverCorrelation
      ? { recoverCorrelation: dependencies.recoverCorrelation }
      : {}),
    ...(dependencies.scheduleApprovalExpiration
      ? { scheduleApprovalExpiration: dependencies.scheduleApprovalExpiration }
      : {}),
  })(event);
}
