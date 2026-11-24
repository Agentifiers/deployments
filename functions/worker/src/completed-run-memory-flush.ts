import type { runtimeMemoryPlatform } from "@deployments-ai/memory-runtime";
import { MemoryPlatformError } from "@deployments-ai/memory";
import type { AgentRunWorkerDependencies } from "./types.ts";

export function createCompletedRunMemoryFlushEnqueuer(
  loadMemoryPlatform: typeof runtimeMemoryPlatform,
): NonNullable<AgentRunWorkerDependencies["enqueueMemoryFlush"]> {
  return async (run, memoryMode, checkpointMode = "off", reviewMode, modelId) => {
    const platform = await loadMemoryPlatform();
    const scope = {
      environmentId: run.data.environmentId,
      organizationId: run.data.organizationId,
      projectId: run.data.projectId,
      ...(run.data.workspaceId ? { workspaceId: run.data.workspaceId } : {}),
    };
    try {
      const existing = await platform.requiredFlush(scope, run.data.id).catch((cause) => {
        if (cause instanceof MemoryPlatformError && cause.code === "flush_not_found") {
          return undefined;
        }
        throw cause;
      });
      if (existing && existing.data.status !== "failed") return "enqueued";
      const enqueue = () =>
        platform.enqueueFlush(scope, run, {
          checkpointMode,
          memoryMode,
          ...(modelId ? { modelId } : {}),
          ...(reviewMode ? { reviewMode } : {}),
        });
      try {
        await enqueue();
      } catch (cause) {
        // A workspace-memory agent's first run in a workspace sets up the workspace's default
        // memory, then flushes into it. Other memory modes stay unconfigured until granted.
        if (
          !isMemorySpaceRequired(cause) ||
          memoryMode !== "workspace" ||
          !(await platform.provisionDefaultWorkspaceMemory(scope, run))
        ) {
          throw cause;
        }
        await enqueue();
      }
      return "enqueued";
    } catch (cause) {
      // enqueueFlush reaches this error only after memory access performs a
      // strong base-table grant fallback, so this is a stable configuration
      // absence rather than transient GSI propagation.
      if (isMemorySpaceRequired(cause)) return "unconfigured";
      throw cause;
    }
  };
}

function isMemorySpaceRequired(cause: unknown) {
  return cause instanceof MemoryPlatformError && cause.code === "memory_space_required";
}
