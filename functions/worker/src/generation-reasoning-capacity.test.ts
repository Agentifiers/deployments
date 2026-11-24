import { describe, expect, it } from "bun:test";
import {
  MAX_MODEL_TOOL_CALLS_PER_GENERATION,
  MAX_RUNTIME_UNPERSISTED_TOOL_REQUESTS,
  MAX_UNPERSISTED_REASONING_BYTES,
  runtimeTransactionCapacityExceeded,
  validateGenerationReasoning,
  type RuntimeCompletedToolCall,
  type RuntimeGenerationReasoning,
  type RuntimeModelContinuation,
  type RuntimePendingAction,
  type RuntimeUsageEntry,
} from "@deployments-ai/agent-runtime";
import {
  MAX_DYNAMODB_ITEM_BYTES,
  MAX_GENERATION_REASONING_BYTES,
  ToolCallRecord,
  dynamoItemByteSize,
  prepareDynamoTransactionOperations,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type TransactionOperation,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { persistPausedRun } from "./agent-run-completion.ts";
import type { RuntimeLeaseRecordValue } from "./agent-run-input.ts";
import {
  persistCheckpointedRun,
  persistInterruptedRun,
  persistRetryableRun,
} from "./agent-run-terminal.ts";
import { abandonedRunWithLease } from "./agent-run-state.fixture.ts";
import { fixtures, id, inMemoryDatabase, workerDependencies } from "./agent-run.fixture.ts";
import { withRunToolContinuationReferences } from "./continuation.ts";
import { pausedToolCallRecord } from "./records.ts";
import type { AgentRunWorkerDependencies, RunRecordValue } from "./types.ts";

const OPUS = "openrouter/anthropic/claude-opus-5.5";
const KIB = 1_024;
// AWS caps TransactWriteItems at 100 items and "4 MB" of items; the decimal reading is stricter.
const TRANSACTION_OPERATION_LIMIT = 100;
const TRANSACTION_BYTE_LIMIT = 4_000_000;
const PERSISTED_MODEL_CALLS = 2;
const USAGE_ENTRIES = 2;
const BATCH = MAX_MODEL_TOOL_CALLS_PER_GENERATION;

const BOUNDARIES = [
  "checkpointed",
  "interrupted",
  "retry-scheduled",
  "paused for approval",
  "paused on an asynchronous tool",
  "paused on a resumed tool",
] as const;
type Boundary = (typeof BOUNDARIES)[number];

class Measured extends Error {}

function padded(field: string, bytes: number): Readonly<Record<string, string>> {
  return { [field]: "x".repeat(bytes - JSON.stringify({ [field]: "" }).length) };
}

function reasoningDetails(bytes: number) {
  const block = { format: "anthropic-claude-v1", signature: "", type: "reasoning.text" };
  return [{ ...block, signature: "s".repeat(bytes - JSON.stringify([block]).length) }];
}

function completedCall(index: number, withInput: boolean): RuntimeCompletedToolCall {
  return {
    effect: "read",
    idempotencyKey: `capacity-tool-${index}`,
    ...(withInput ? { input: padded("query", 128 * KIB) } : {}),
    inputSummary: `Read capacity resource ${index}.`,
    output: padded("result", 128 * KIB),
    outputSummary: `Capacity resource ${index} was read.`,
    policyAction: "allow",
    policyReason: "Reads are allowed.",
    requiredScopes: [],
    toolCallId: id(1_000 + index),
    toolName: "provider.read",
  };
}

function approvedPendingRecord(call: RuntimeCompletedToolCall, run: RunRecordValue) {
  const waiting = pausedToolCallRecord({
    action: {
      approvalId: call.approvalId!,
      effect: call.effect,
      idempotencyKey: call.idempotencyKey,
      ...(call.input ? { input: call.input } : {}),
      inputSummary: call.inputSummary,
      kind: "approval",
      policyReason: call.policyReason,
      requiredScopes: call.requiredScopes,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
    },
    now: new Date("2026-07-22T00:00:00.500Z"),
    run,
  });
  return Schema.decodeUnknownSync(ToolCallRecord)(
    withCanonicalRecordKeys({
      data: { ...waiting.data, status: "pending", version: waiting.data.version + 1 },
      itemType: "tool-call" as const,
    }),
  );
}

function pendingAction(call: RuntimeCompletedToolCall, kind: "approval" | "tool") {
  const request = {
    effect: call.effect,
    idempotencyKey: call.idempotencyKey,
    ...(call.input ? { input: call.input } : {}),
    inputSummary: call.inputSummary,
    policyReason: call.policyReason,
    requiredScopes: call.requiredScopes,
    toolCallId: call.toolCallId,
    toolName: call.toolName,
  };
  return kind === "approval"
    ? ({ ...request, approvalId: id(3_000), kind } satisfies RuntimePendingAction)
    : ({ ...request, externalOperationId: "operation-1", kind } satisfies RuntimePendingAction);
}

function generationReasoning(
  unpersisted: readonly number[],
): readonly RuntimeGenerationReasoning[] {
  const sizes = [...Array.from({ length: PERSISTED_MODEL_CALLS }, () => KIB), ...unpersisted];
  return validateGenerationReasoning(
    sizes.map((bytes, modelCallIndex) => ({
      details: reasoningDetails(bytes),
      modelCallIndex,
      producerAttemptId: `capacity:assistant:${modelCallIndex}:run-attempt:0:fallback:0`,
      producerModelId: OPUS,
    })),
    sizes.length,
  );
}

function modelContinuation(unpersisted: readonly number[]): RuntimeModelContinuation {
  const modelCallCount = PERSISTED_MODEL_CALLS + unpersisted.length;
  return {
    generationReasoning: generationReasoning(unpersisted),
    modelCallCount,
    toolRequests: Array.from({ length: modelCallCount }, (_, index) => ({
      effect: "read" as const,
      idempotencyKey: `model-request-${index}`,
      inputSummary: `Model requested read ${index}.`,
      requiredScopes: [],
      toolName: "provider.read",
    })),
  };
}

const usage: readonly RuntimeUsageEntry[] = Array.from({ length: USAGE_ENTRIES }, (_, index) => ({
  idempotencyKey: `capacity-usage-${index}`,
  modelId: OPUS,
  occurredAt: "2026-07-22T00:00:01.000Z",
  provider: "openrouter",
  quantity: 1,
  source: "model-gateway",
  payer: { kind: "operator" as const },
  type: "model_tokens",
  unit: "tokens",
}));

function itemBytes(operation: TransactionOperation): number {
  if (operation.kind === "condition-check") return dynamoItemByteSize(operation.key);
  return operation.record.itemType === "run"
    ? MAX_DYNAMODB_ITEM_BYTES
    : dynamoItemByteSize(operation.record);
}

interface BoundaryHarness {
  readonly approved: readonly [RuntimeCompletedToolCall, RuntimeCompletedToolCall];
  readonly dependencies: AgentRunWorkerDependencies;
  readonly lease: RuntimeLeaseRecordValue;
  readonly measured: (readonly TransactionOperation[])[];
  readonly previous: RunRecordValue;
}

function boundaryHarness(): BoundaryHarness {
  const fixture = fixtures();
  const claimed = abandonedRunWithLease(fixture);
  const previous = withRunToolContinuationReferences(claimed.run, {
    completedToolCallIds: [],
    modelContinuation: modelContinuation([]),
  });
  const approval = {
    policyAction: "require-approval",
    policyReason: "Approved by an operator.",
  } as const;
  const approved = [
    { ...completedCall(0, true), ...approval, approvalId: id(2_000) },
    { ...completedCall(99, true), ...approval, approvalId: id(2_099) },
  ] as const;
  const memory = inMemoryDatabase([
    fixture.release,
    fixture.deployment,
    fixture.thread,
    fixture.userMessage,
    previous,
    claimed.lease,
    ...approved.map((call) => approvedPendingRecord(call, previous)),
  ]);
  const measured: (readonly TransactionOperation[])[] = [];
  const database: DynamoDatabaseService = {
    ...memory.database,
    transactWrite: async (operations) => {
      measured.push(await prepareDynamoTransactionOperations(operations));
      throw new Measured();
    },
  };
  const { dependencies } = workerDependencies(database);
  return { approved, dependencies, lease: claimed.lease, measured, previous };
}

function boundaryTransaction(
  harness: BoundaryHarness,
  boundary: Boundary,
  before: readonly RuntimeCompletedToolCall[],
  continuation: RuntimeModelContinuation,
): readonly TransactionOperation[] {
  const { dependencies, lease, previous } = harness;
  const batch = Array.from({ length: BATCH }, (_, index) =>
    completedCall(100 + before.length + index, index === BATCH - 1),
  );
  const paused = boundary.startsWith("paused");
  const completedToolCalls = [...before, ...(paused ? batch.slice(0, -1) : batch)];
  const requeued = {
    completedToolCalls,
    modelContinuation: continuation,
    modelInvocationAttempts: [],
    usage,
  };
  const persisted =
    boundary === "checkpointed"
      ? persistCheckpointedRun(dependencies, previous, lease, requeued)
      : boundary === "interrupted"
        ? persistInterruptedRun(dependencies, previous, lease, requeued)
        : boundary === "retry-scheduled"
          ? persistRetryableRun(
              dependencies,
              previous,
              new Error("Provider unavailable."),
              lease,
              completedToolCalls,
              undefined,
              usage,
              continuation,
            )
          : persistPausedRun(
              dependencies,
              previous,
              lease,
              boundary === "paused for approval" ? "waiting-for-approval" : "waiting-for-tool",
              "Paused.",
              completedToolCalls,
              boundary === "paused for approval"
                ? pendingAction(batch.at(-1)!, "approval")
                : boundary === "paused on an asynchronous tool"
                  ? pendingAction(batch.at(-1)!, "tool")
                  : pendingAction(harness.approved[1], "tool"),
              { artifactBytes: 0, artifactIndexCursor: 0, artifacts: [] },
              continuation,
              usage,
            );
  expect(persisted).rejects.toBeInstanceOf(Measured);
  return harness.measured.pop()!;
}

describe("continued boundary transaction capacity", () => {
  it("keeps every boundary the runtime admits within one DynamoDB transaction", () => {
    const harness = boundaryHarness();
    const summary: Partial<Record<Boundary, { fixed: number; operations: number }>> = {};
    let boundaries = 0;
    for (let generations = 0; generations <= MAX_RUNTIME_UNPERSISTED_TOOL_REQUESTS; generations++) {
      const priorBytes = Math.min(
        MAX_GENERATION_REASONING_BYTES,
        Math.floor(
          (MAX_UNPERSISTED_REASONING_BYTES - MAX_GENERATION_REASONING_BYTES) /
            Math.max(generations, 1),
        ),
      );
      const prior = Array.from({ length: generations }, () => priorBytes);
      for (let tools = generations; tools <= MAX_RUNTIME_UNPERSISTED_TOOL_REQUESTS; tools++) {
        const before = Array.from({ length: tools }, (_, index) =>
          index === 0 ? harness.approved[0] : completedCall(index, index < 7),
        );
        const admitted = !runtimeTransactionCapacityExceeded(
          {
            completedToolCalls: before,
            generationReasoning: [...generationReasoning(prior)],
            persistedCompletedToolCallIds: new Set(),
            persistedModelCallCount: PERSISTED_MODEL_CALLS,
            providerPersistedUsageIdempotencyKeys: new Set(),
            usage: [],
          },
          { reservePendingTools: BATCH, reserveUsageEntries: 1 },
        );
        if (!admitted) continue;
        const continuation = modelContinuation([...prior, MAX_GENERATION_REASONING_BYTES]);
        for (const boundary of BOUNDARIES) {
          const operations = boundaryTransaction(harness, boundary, before, continuation);
          const reasoningPuts = operations.filter(
            (operation) =>
              operation.kind === "put" && operation.record.itemType === "generation-reasoning",
          ).length;
          const bytes = operations.reduce((total, operation) => total + itemBytes(operation), 0);
          expect(reasoningPuts).toBe(generations + 1);
          expect(operations.length).toBeLessThanOrEqual(TRANSACTION_OPERATION_LIMIT);
          expect(bytes).toBeLessThanOrEqual(TRANSACTION_BYTE_LIMIT);
          const toolSlots = tools + BATCH;
          const fixed =
            operations.length - (4 * toolSlots + 1 + 2 * USAGE_ENTRIES + 2 * reasoningPuts);
          summary[boundary] = {
            fixed: Math.max(summary[boundary]?.fixed ?? 0, fixed),
            operations: Math.max(summary[boundary]?.operations ?? 0, operations.length),
          };
          boundaries += 1;
        }
      }
    }
    expect(boundaries).toBe(276);
    expect(summary).toEqual({
      checkpointed: { fixed: 12, operations: 93 },
      interrupted: { fixed: 12, operations: 93 },
      "paused for approval": { fixed: 16, operations: 97 },
      "paused on a resumed tool": { fixed: 12, operations: 93 },
      "paused on an asynchronous tool": { fixed: 12, operations: 93 },
      "retry-scheduled": { fixed: 12, operations: 93 },
    });
  }, 30_000);
});
