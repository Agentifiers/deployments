import type { RuntimeModelInvocationAttempt } from "@deployments-ai/agent-runtime";
import {
  ModelInvocationRecord,
  Ulid,
  key,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  workerPersistence,
} from "@deployments-ai/db";
import {
  OBSERVABILITY_REDACTION_POLICY_VERSION,
  OBSERVABILITY_SCHEMA_VERSION,
} from "@deployments-ai/observability";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { runtimeUsageOperations } from "./agent-run-claim.ts";
import { canonicalRuntimeUsageIdempotencyKey } from "./record-builders.ts";
import { requireThreadExecutionLease } from "./agent-run-lease-release.ts";
import { loadRun } from "./records.ts";
import type { AgentRunQueueMessage, AgentRunWorkerDependencies, RunRecordValue } from "./types.ts";
import type { RuntimeLeaseRecordValue } from "./agent-run-input.ts";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
type Run = Extract<PlatformRecord, { readonly itemType: "run" }>;
type Invocation = Extract<PlatformRecord, { readonly itemType: "model-invocation" }>;

export async function modelInvocationsForRunAttempt(
  database: DynamoDatabaseService,
  run: Run,
  runAttempt: number,
): Promise<readonly Invocation[]> {
  const claimStartedAt = Date.parse(run.data.claimedAt ?? "");
  if (!Number.isFinite(claimStartedAt)) {
    throw new Error(`Run ${run.data.id} model invocation recovery requires a claim timestamp.`);
  }
  const invocations: Invocation[] = [];
  let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
  do {
    const page = await workerPersistence.find(database, "execution", {
      ConsistentRead: true,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      ExpressionAttributeNames: { "#pk": "pk" },
      ExpressionAttributeValues: {
        ":pk": key("ORG", run.data.organizationId, "RUN", run.data.id),
      },
      KeyConditionExpression: "#pk = :pk",
      Limit: 100,
    });
    invocations.push(
      ...page.items.filter(
        (record): record is Invocation =>
          record.itemType === "model-invocation" &&
          record.data.runId === run.data.id &&
          record.data.traceId === run.data.traceId &&
          record.data.runAttempt === runAttempt &&
          Date.parse(record.data.startedAt) >= claimStartedAt,
      ),
    );
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey);
  const latestExecutionVersion = invocations.reduce(
    (latest, invocation) => Math.max(latest, invocation.data.runExecutionVersion),
    -1,
  );
  return invocations
    .filter((invocation) => invocation.data.runExecutionVersion === latestExecutionVersion)
    .toSorted(
      (left, right) =>
        left.data.invocationId.localeCompare(right.data.invocationId) ||
        left.data.fallbackAttempt - right.data.fallbackAttempt,
    );
}

export function stableModelInvocationId(runId: Ulid, attemptId: string): Ulid {
  const bytes = createHash("sha256")
    .update("deployments-ai:model-invocation:v1\u0000")
    .update(attemptId)
    .digest()
    .subarray(0, 10);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let suffix = "";
  for (let index = 0; index < 16; index += 1) {
    suffix = CROCKFORD_BASE32[Number(value & 31n)]! + suffix;
    value >>= 5n;
  }
  return Schema.decodeUnknownSync(Ulid)(`${runId.slice(0, 10)}${suffix}`);
}

export function modelInvocationRecord(
  attempt: RuntimeModelInvocationAttempt,
): Extract<PlatformRecord, { readonly itemType: "model-invocation" }> {
  const id = stableModelInvocationId(attempt.runId, attempt.attemptId);
  return Schema.decodeUnknownSync(ModelInvocationRecord)(
    withCanonicalRecordKeys({
      data: {
        ...(attempt.actualModelId ? { actualModelId: attempt.actualModelId } : {}),
        ...(attempt.actualProvider ? { actualProvider: attempt.actualProvider } : {}),
        ...(attempt.executionBindingId === undefined
          ? {
              agentDefinitionId: attempt.agentDefinitionId,
              agentDeploymentId: attempt.agentDeploymentId,
              agentReleaseId: attempt.agentReleaseId,
            }
          : {
              ...(attempt.agentDefinitionId
                ? { agentDefinitionId: attempt.agentDefinitionId }
                : {}),
              ...(attempt.agentReleaseId ? { agentReleaseId: attempt.agentReleaseId } : {}),
              executionBindingId: attempt.executionBindingId,
              executionPurpose: attempt.executionPurpose,
            }),
        agentManifestHash: attempt.agentManifestHash,
        attemptId: attempt.attemptId,
        ...(attempt.cachedTokens !== undefined ? { cachedTokens: attempt.cachedTokens } : {}),
        captureMode: attempt.captureMode,
        completedAt: attempt.completedAt,
        ...(attempt.costUsdMicros !== undefined ? { costUsdMicros: attempt.costUsdMicros } : {}),
        currency: "USD" as const,
        ...(attempt.errorClass ? { errorClass: attempt.errorClass } : {}),
        fallbackAttempt: attempt.fallbackAttempt,
        ...(attempt.fallbackReason ? { fallbackReason: attempt.fallbackReason } : {}),
        id,
        ...(attempt.inputTokens !== undefined ? { inputTokens: attempt.inputTokens } : {}),
        internalEvaluator: attempt.internalEvaluator,
        invocationId: attempt.invocationId,
        invocationKind: attempt.invocationKind,
        modelCallIndex: attempt.modelCallIndex,
        organizationId: attempt.organizationId,
        ...(attempt.outputTokens !== undefined ? { outputTokens: attempt.outputTokens } : {}),
        parentSpanId: attempt.parentSpanId,
        persistedAt: attempt.completedAt,
        projectId: attempt.projectId,
        ...(attempt.providerRequestId ? { providerRequestId: attempt.providerRequestId } : {}),
        redactionPolicyVersion: OBSERVABILITY_REDACTION_POLICY_VERSION,
        requestedModelId: attempt.requestedModelId,
        ...(attempt.requestedProvider ? { requestedProvider: attempt.requestedProvider } : {}),
        runAttempt: attempt.runAttempt,
        runExecutionVersion: attempt.runExecutionVersion,
        runId: attempt.runId,
        schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
        spanId: attempt.spanId,
        startedAt: attempt.startedAt,
        status: attempt.status,
        ...(attempt.stopReason ? { stopReason: attempt.stopReason } : {}),
        streaming: attempt.streaming,
        threadId: attempt.threadId,
        ...(attempt.totalTokens !== undefined ? { totalTokens: attempt.totalTokens } : {}),
        traceId: attempt.traceId,
        ...(attempt.usageIdempotencyKey
          ? {
              usageIdempotencyKey: canonicalRuntimeUsageIdempotencyKey(
                attempt.runId,
                attempt.usageIdempotencyKey,
              ),
            }
          : {}),
        version: 0,
        environmentId: attempt.environmentId,
        ...(attempt.workspaceId ? { workspaceId: attempt.workspaceId } : {}),
      },
      itemType: "model-invocation" as const,
    }),
  );
}

export function invocationWithoutInvalidUsage(
  attempt: RuntimeModelInvocationAttempt,
): RuntimeModelInvocationAttempt {
  const {
    costUsdMicros: _costUsdMicros,
    totalTokens: _totalTokens,
    usageEntry: _usageEntry,
    usageIdempotencyKey: _usageIdempotencyKey,
    ...retained
  } = attempt;
  return retained;
}

export function canonicalModelInvocationAttempt(
  attempt: RuntimeModelInvocationAttempt,
): RuntimeModelInvocationAttempt | undefined {
  try {
    modelInvocationRecord(attempt);
    return attempt;
  } catch {
    return undefined;
  }
}

export function hasInvalidInvocationUsage(attempt: RuntimeModelInvocationAttempt): boolean {
  const usage = attempt.usageEntry;
  return (
    usage !== undefined &&
    (!Number.isSafeInteger(usage.quantity) ||
      usage.quantity < 0 ||
      (usage.costUsdNanoDollars !== undefined &&
        (!Number.isSafeInteger(usage.costUsdNanoDollars) || usage.costUsdNanoDollars < 0)) ||
      (usage.costUsdMicros !== undefined &&
        (!Number.isSafeInteger(usage.costUsdMicros) || usage.costUsdMicros < 0)))
  );
}

export async function modelInvocationPersistenceOperations(
  database: DynamoDatabaseService,
  attempts: readonly RuntimeModelInvocationAttempt[],
): Promise<readonly TransactionOperation[]> {
  const operations: TransactionOperation[] = [];
  const attemptIds = new Set<string>();
  for (const attempt of attempts) {
    if (attemptIds.has(attempt.attemptId)) {
      throw new Error(`Model invocation ${attempt.attemptId} was captured more than once.`);
    }
    attemptIds.add(attempt.attemptId);
    const record = modelInvocationRecord(attempt);
    const existing = await workerPersistence.read(
      database,
      "execution",
      {
        pk: key("ORG", attempt.organizationId, "RUN", attempt.runId),
        sk: key("MODEL-INVOCATION", record.data.id),
      },
      true,
    );
    if (!existing) {
      operations.push({ kind: "put", record });
      continue;
    }
    if (existing.itemType === "model-invocation" && isDeepStrictEqual(existing, record)) continue;
    throw new Error(`Model invocation ${attempt.attemptId} conflicts with its durable record.`);
  }
  return operations;
}

function requireCanceledExecution(
  run: RunRecordValue,
  attempt: RuntimeModelInvocationAttempt,
): TransactionOperation {
  if (
    run.data.status !== "canceled" ||
    run.data.id !== attempt.runId ||
    run.data.traceId !== attempt.traceId ||
    run.data.organizationId !== attempt.organizationId ||
    run.data.projectId !== attempt.projectId ||
    run.data.environmentId !== attempt.environmentId ||
    run.data.attempt !== attempt.runAttempt ||
    !run.data.claimedBy
  ) {
    throw new Error("Canceled run does not match the in-flight model invocation execution.");
  }
  return {
    conditionExpression:
      "#data.#status = :canceled AND #data.#attempt = :attempt AND #data.#claimedBy = :claimedBy AND #data.#version = :version",
    expressionAttributeNames: {
      "#attempt": "attempt",
      "#claimedBy": "claimedBy",
      "#data": "data",
      "#status": "status",
      "#version": "version",
    },
    expressionAttributeValues: {
      ":attempt": run.data.attempt,
      ":canceled": "canceled",
      ":claimedBy": run.data.claimedBy,
      ":version": run.data.version,
    },
    key: { pk: run.pk, sk: run.sk },
    kind: "condition-check",
    table: "execution",
  };
}

async function pendingProviderBoundaryOperations(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
  attempt: RuntimeModelInvocationAttempt,
) {
  const [invocations, usage] = await Promise.all([
    modelInvocationPersistenceOperations(dependencies.database, [attempt]),
    attempt.usageEntry
      ? runtimeUsageOperations(dependencies, run, [attempt.usageEntry])
      : Promise.resolve([]),
  ]);
  return [...invocations, ...usage];
}

export async function persistModelInvocationAtProviderBoundary(
  dependencies: AgentRunWorkerDependencies,
  queue: AgentRunQueueMessage,
  run: RunRecordValue,
  lease: RuntimeLeaseRecordValue,
  attempt: RuntimeModelInvocationAttempt,
): Promise<void> {
  const operations = await pendingProviderBoundaryOperations(dependencies, run, attempt);
  if (operations.length === 0) return;
  try {
    await workerPersistence.commit(dependencies.database, [
      ...operations,
      requireThreadExecutionLease(lease),
    ]);
    return;
  } catch (leaseCause) {
    const remaining = await pendingProviderBoundaryOperations(dependencies, run, attempt);
    if (remaining.length === 0) return;
    const canceled = await loadRun(dependencies.database, queue);
    if (canceled?.data.status !== "canceled") throw leaseCause;
    try {
      await workerPersistence.commit(dependencies.database, [
        ...remaining,
        requireCanceledExecution(canceled, attempt),
      ]);
    } catch (canceledCause) {
      const stillPending = await pendingProviderBoundaryOperations(dependencies, run, attempt);
      if (stillPending.length > 0) throw canceledCause;
    }
  }
}
