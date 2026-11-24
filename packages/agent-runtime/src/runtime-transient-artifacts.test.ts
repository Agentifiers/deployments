import { describe, expect, test } from "bun:test";
import { RuntimeArtifactValidationError } from "./errors.ts";
import type { RuntimeExecutionState } from "./runtime-core.ts";
import {
  transientArtifactBytes,
  validateTransientArtifacts,
} from "./runtime-transient-artifacts.ts";

function state(transientCount: number, content = "x"): RuntimeExecutionState {
  return {
    artifactBytes: 0,
    artifactIndexCursor: 0,
    artifacts: [],
    brainEvidence: [],
    completedToolCalls: [],
    generationReasoning: [],
    pendingArtifactPublicationIndexes: [],
    persistedCompletedToolCallIds: new Set(),
    persistedModelCallCount: 0,
    providerPersistedUsageIdempotencyKeys: new Set(),
    refreshedTransientToolCallIds: new Set(),
    sandboxCompleted: false,
    transientArtifacts: Array.from({ length: transientCount }, (_, index) => ({
      content,
      fileName: `transient-${index}.txt`,
      label: `Transient ${index}`,
    })),
    usage: [],
  };
}

describe("transient runtime artifacts", () => {
  test("count and byte budgets include already-produced transient artifacts", () => {
    const countState = state(31);
    expect(() => validateTransientArtifacts(countState, [], 2)).toThrow(
      RuntimeArtifactValidationError,
    );
    expect(transientArtifactBytes(state(2, "four"))).toBe(8);
  });
});
