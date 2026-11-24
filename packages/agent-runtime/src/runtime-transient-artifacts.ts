import { RuntimeArtifactValidationError, RuntimeToolExecutionKnownFailureError } from "./errors.ts";
import {
  MAX_CAPTURE_COUNT,
  MAX_TOTAL_CAPTURE_BYTES,
  executionContext,
  runtimeArtifactBytes,
} from "./runtime-core.ts";
import type { RuntimeExecutionState } from "./runtime-core.ts";
import { runtimeArtifactSummary } from "./runtime-artifacts.ts";
import type { AgentRunInput, AgentRuntimeDependencies, RuntimeArtifact } from "./types.ts";

export function transientArtifactBytes(state: RuntimeExecutionState) {
  return state.transientArtifacts.reduce(
    (total, artifact) => total + runtimeArtifactBytes(artifact),
    0,
  );
}

export function pruneTransientArtifactAccess(state: RuntimeExecutionState, artifactId: unknown) {
  if (typeof artifactId !== "string") return;
  for (let index = state.transientArtifacts.length - 1; index >= 0; index -= 1) {
    const metadata = state.transientArtifacts[index]?.metadata;
    if (metadata?.kind === "artifact-access" && metadata.artifactId === artifactId) {
      state.transientArtifacts.splice(index, 1);
    }
  }
}

export function validateTransientArtifacts(
  state: RuntimeExecutionState,
  artifacts: readonly RuntimeArtifact[],
  additionalDurableCount = 0,
  additionalDurableBytes = 0,
) {
  if (
    state.artifactIndexCursor +
      state.transientArtifacts.length +
      additionalDurableCount +
      artifacts.length >
    MAX_CAPTURE_COUNT
  ) {
    throw new RuntimeArtifactValidationError(
      `Runtime artifact count exceeds the per-run limit of ${MAX_CAPTURE_COUNT}.`,
    );
  }
  const bytes = artifacts.reduce(
    (total, artifact) => total + runtimeArtifactBytes(artifact),
    transientArtifactBytes(state),
  );
  if (state.artifactBytes + additionalDurableBytes + bytes > MAX_TOTAL_CAPTURE_BYTES) {
    throw new RuntimeArtifactValidationError(
      "Runtime artifacts exceed the per-run total byte limit.",
    );
  }
  for (const artifact of artifacts) runtimeArtifactSummary(artifact);
}

export async function refreshCompletedTransientArtifacts(
  input: AgentRunInput,
  dependencies: AgentRuntimeDependencies,
  state: RuntimeExecutionState,
) {
  const calls = state.completedToolCalls.filter(
    (call, callIndex, completedCalls) =>
      call.refreshTransientArtifacts === true &&
      !state.refreshedTransientToolCallIds.has(call.toolCallId) &&
      !(
        (call.toolName === "artifact.inspect" || call.toolName === "artifact.share") &&
        completedCalls
          .slice(callIndex + 1)
          .some(
            (later) =>
              later.toolName === "artifact.archive" &&
              later.input?.artifactId === call.input?.artifactId,
          )
      ),
  );
  if (calls.length === 0) return;
  if (!dependencies.executeToolCall) {
    throw new Error("Transient artifact refresh requires the tool execution port.");
  }
  for (const call of calls) {
    let result;
    try {
      result = await dependencies.executeToolCall({
        ...executionContext(input),
        completedToolCalls: [...state.completedToolCalls],
        decision: {
          action: "allow",
          ...(call.executionBinding ? { executionBinding: call.executionBinding } : {}),
          reason: call.policyReason,
          toolCallId: call.toolCallId,
        },
        effect: call.effect,
        idempotencyKey: call.idempotencyKey,
        ...(call.input ? { input: call.input } : {}),
        inputSummary: call.inputSummary,
        requiredScopes: call.requiredScopes,
        ...(input.signal ? { signal: input.signal } : {}),
        toolName: call.toolName,
      });
    } catch (cause) {
      if (cause instanceof RuntimeToolExecutionKnownFailureError) {
        state.refreshedTransientToolCallIds.add(call.toolCallId);
        continue;
      }
      throw cause;
    }
    const artifacts = result.transientArtifacts ?? [];
    if (result.status !== "completed" || artifacts.length === 0) {
      throw new Error(`Completed tool ${call.toolName} did not refresh its transient artifacts.`);
    }
    validateTransientArtifacts(state, artifacts);
    state.transientArtifacts.push(...artifacts);
    state.refreshedTransientToolCallIds.add(call.toolCallId);
  }
}
