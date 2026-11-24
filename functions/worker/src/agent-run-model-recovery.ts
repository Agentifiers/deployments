import {
  RuntimeModelInvocationPersistenceError,
  type RuntimeModelInvocationAttempt,
} from "@deployments-ai/agent-runtime";
import type { DynamoDatabaseService } from "@deployments-ai/db";
import {
  canonicalModelInvocationAttempt,
  hasInvalidInvocationUsage,
  invocationWithoutInvalidUsage,
  modelInvocationsForRunAttempt,
} from "./model-invocations.ts";
import { AgentRunWorkerRecordError } from "./records.ts";
import type { RunRecordValue } from "./types.ts";

export async function recoverModelFallbackStartIndex(
  database: DynamoDatabaseService,
  run: RunRecordValue,
): Promise<number | undefined> {
  const previousInvocations = await modelInvocationsForRunAttempt(database, run, run.data.attempt);
  // Selection is private, separately billed work, not assistant progress. A new run attempt may
  // select again; never consume its fallback slots or suppress recovery after successful selection.
  const assistantInvocations = previousInvocations.filter((invocation) => {
    const prefix = `${run.data.id}:execution:${invocation.data.runExecutionVersion}:response-depth:`;
    const invocationId = invocation.data.invocationId;
    return !(
      invocationId.startsWith(prefix) && /^(?:0|[1-9]\d*)$/u.test(invocationId.slice(prefix.length))
    );
  });
  if (assistantInvocations.length === 0) return undefined;
  const invocationIds = new Set(
    assistantInvocations.map((invocation) => invocation.data.invocationId),
  );
  const fallbackAttempts = assistantInvocations.map(
    (invocation) => invocation.data.fallbackAttempt,
  );
  const firstFallbackAttempt = fallbackAttempts[0]!;
  const contiguousFallbacks = fallbackAttempts.every(
    (fallbackAttempt, index) => fallbackAttempt === firstFallbackAttempt + index,
  );
  if (
    invocationIds.size === 1 &&
    contiguousFallbacks &&
    assistantInvocations.every((invocation) => invocation.data.status === "failed")
  ) {
    return fallbackAttempts.at(-1)! + 1;
  }
  throw new AgentRunWorkerRecordError(
    "orphaned_model_invocation",
    "A prior execution persisted a model response without advancing the run; recovery will not dispatch the provider again.",
  );
}

export function captureModelInvocationFailure(
  cause: unknown,
  modelInvocationAttempts: RuntimeModelInvocationAttempt[],
) {
  const invalidInvocationUsage =
    cause instanceof RuntimeModelInvocationPersistenceError &&
    ((cause.persistenceCause instanceof AgentRunWorkerRecordError &&
      cause.persistenceCause.code === "invalid_usage_entry") ||
      hasInvalidInvocationUsage(cause.attempt));
  const persistenceAttempt =
    cause instanceof RuntimeModelInvocationPersistenceError
      ? canonicalModelInvocationAttempt(
          invalidInvocationUsage ? invocationWithoutInvalidUsage(cause.attempt) : cause.attempt,
        )
      : undefined;
  const capturedInvocationAttempts =
    persistenceAttempt &&
    !modelInvocationAttempts.some((attempt) => attempt.attemptId === persistenceAttempt.attemptId)
      ? [...modelInvocationAttempts, persistenceAttempt]
      : modelInvocationAttempts;
  return {
    capturedInvocationAttempts,
    invalidInvocationUsage,
    persistenceCause:
      cause instanceof RuntimeModelInvocationPersistenceError ? cause.persistenceCause : undefined,
  };
}
