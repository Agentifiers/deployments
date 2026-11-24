import { createWorkflowQueueHandler } from "./queue.ts";
import { cachedWorkflowRuntimeDependencies } from "./runtime-composition.ts";
import type { SqsBatchLike } from "./queue.ts";

export async function handler(event: SqsBatchLike) {
  return createWorkflowQueueHandler(await cachedWorkflowRuntimeDependencies())(event);
}
