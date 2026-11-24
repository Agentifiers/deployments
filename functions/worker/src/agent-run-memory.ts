import type { RuntimeMemoryMode } from "@deployments-ai/agent-runtime";
import type { MemoryReviewMode } from "@deployments-ai/memory";
import { compileAgentManifestRuntime } from "./agent-manifest-runtime.ts";
import { loadAgentRelease } from "./records.ts";
import {
  EXTERNAL_PUBLICATION_SETTLED_RECOVERY_REASON,
  THREAD_CONTINUITY_RECOVERY_REASON,
  type AgentRunQueueMessage,
  type AgentRunWorkerDependencies,
  type RunRecordValue,
} from "./types.ts";

export async function ensureCompletedRunMemoryFlush(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
  knownMemoryMode: RuntimeMemoryMode | undefined,
  queue: AgentRunQueueMessage,
  knownCheckpointMode?: "auto" | "off",
  knownReviewMode?: MemoryReviewMode,
  knownModelId?: string,
): Promise<"enqueued" | "skipped" | "unconfigured"> {
  // Preview and evaluation runs never write durable memory or conversation checkpoints.
  if (
    run.data.status !== "completed" ||
    !dependencies.enqueueMemoryFlush ||
    run.data.executionBindingId !== undefined
  ) {
    return "skipped";
  }
  const automaticPublication = run.data.trigger === "heartbeat" || run.data.trigger === "schedule";
  const requiresExternalPublicationSettlement =
    automaticPublication || run.data.responsePublication === "external";
  if (
    requiresExternalPublicationSettlement &&
    queue.recoveryReason !== EXTERNAL_PUBLICATION_SETTLED_RECOVERY_REASON &&
    queue.recoveryReason !== THREAD_CONTINUITY_RECOVERY_REASON
  ) {
    return "skipped";
  }
  const effectiveKnownMemoryMode = automaticPublication ? "off" : knownMemoryMode;
  if (effectiveKnownMemoryMode === "off" && knownCheckpointMode === "off") return "skipped";
  // An unknown review mode needs no manifest here: the memory platform resolves an omitted one
  // from the manifest and the flush's memory space.
  const requiresManifest =
    effectiveKnownMemoryMode === undefined ||
    knownCheckpointMode === undefined ||
    knownModelId === undefined;
  const compiled = requiresManifest
    ? compileAgentManifestRuntime(
        (await loadAgentRelease(dependencies.database, queue, run.data.agentReleaseId)).data
          .manifest,
      )
    : undefined;
  const memoryMode = effectiveKnownMemoryMode ?? compiled!.memoryMode;
  const checkpointMode = knownCheckpointMode ?? compiled!.contextCheckpointMode;
  const reviewMode = knownReviewMode ?? compiled?.memoryReviewMode;
  const modelId = knownModelId ?? compiled?.modelId;
  if (memoryMode === "off" && checkpointMode === "off") return "skipped";
  return dependencies.enqueueMemoryFlush(run, memoryMode, checkpointMode, reviewMode, modelId);
}
