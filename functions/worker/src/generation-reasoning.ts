import {
  validateGenerationReasoning,
  type RuntimeModelContinuation,
  type RuntimeModelContinuationRecord,
} from "@deployments-ai/agent-runtime";
import {
  generationReasoningCreateOperation,
  listRunGenerationReasoning,
  type DynamoDatabaseService,
  type GenerationReasoningRunScope,
  type TransactionOperation,
} from "@deployments-ai/db";
import { runToolContinuation } from "./continuation.ts";
import type { RunRecordValue } from "./types.ts";

function generationReasoningScope(run: RunRecordValue): GenerationReasoningRunScope {
  return {
    environmentId: run.data.environmentId,
    organizationId: run.data.organizationId,
    projectId: run.data.projectId,
    runId: run.data.id,
    threadId: run.data.threadId,
  };
}

export function generationReasoningPersistence(input: {
  readonly modelContinuation: RuntimeModelContinuation | undefined;
  readonly now: Date;
  readonly previousRun: RunRecordValue;
}): readonly TransactionOperation[] {
  const persistedModelCallCount =
    runToolContinuation(input.previousRun).modelContinuation?.modelCallCount ?? 0;
  return (input.modelContinuation?.generationReasoning ?? [])
    .filter((entry) => entry.modelCallIndex >= persistedModelCallCount)
    .map((entry) =>
      generationReasoningCreateOperation({
        createdAt: input.now.toISOString(),
        modelCallIndex: entry.modelCallIndex,
        producerAttemptId: entry.producerAttemptId,
        producerModelId: entry.producerModelId,
        reasoningDetails: entry.details,
        scope: generationReasoningScope(input.previousRun),
      }),
    );
}

export async function hydratedModelContinuation(input: {
  readonly database: DynamoDatabaseService;
  readonly record: RuntimeModelContinuationRecord;
  readonly run: RunRecordValue;
  readonly signal?: AbortSignal;
}): Promise<RuntimeModelContinuation> {
  const { modelCallCount } = input.record;
  const stored = await listRunGenerationReasoning(
    input.database,
    generationReasoningScope(input.run),
    input.signal,
  );
  const uncounted = stored.filter((record) => record.data.modelCallIndex >= modelCallCount);
  if (uncounted.length > 0) {
    console.warn("Generation reasoning beyond the run's model continuation was not replayed.", {
      modelCallCount,
      modelCallIndexes: uncounted.map((record) => record.data.modelCallIndex),
      runId: input.run.data.id,
    });
  }
  return {
    ...input.record,
    generationReasoning: validateGenerationReasoning(
      stored
        .filter((record) => record.data.modelCallIndex < modelCallCount)
        .map((record) => ({
          details: record.data.reasoningDetails,
          modelCallIndex: record.data.modelCallIndex,
          producerAttemptId: record.data.producerAttemptId,
          producerModelId: record.data.producerModelId,
        })),
      modelCallCount,
    ),
  };
}
