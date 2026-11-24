import { describe, expect, test } from "bun:test";
import {
  RunEdgeRecord,
  RunLocatorRecord,
  RunRecord,
  ProviderMutationClaimRecord,
  TraceRecord,
  key,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { customerRunPins, fixtures, id, inMemoryDatabase } from "./agent-run.fixture.ts";
import { modelInvocationRecord } from "./model-invocations.ts";
import { runtimeUsageRecord, settledCanceledRun } from "./records.ts";
import { attemptTraceFinalization, reconcileTraceFinalization } from "./trace-finalization.ts";

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const ROOT_SPAN_ID = "0123456789abcdef";

function terminalRun(
  source: ReturnType<typeof fixtures>["run"],
  runId = source.data.id,
  status: "canceled" | "completed" | "failed" | "running" = "completed",
) {
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      ...source,
      data: {
        ...source.data,
        ...(status === "running" ? {} : { completedAt: "2026-07-22T00:00:02.000Z" }),
        id: runId,
        idempotencyKey: `run/${runId}`,
        status,
        updatedAt: "2026-07-22T00:00:02.000Z",
        version: 2,
      },
    }),
  );
}

function traceRecord(root: ReturnType<typeof terminalRun>, runIds: readonly Ulid[]) {
  return Schema.decodeUnknownSync(TraceRecord)(
    withCanonicalRecordKeys({
      data: {
        captureMode: "metadata-only" as const,
        createdAt: root.data.createdAt,
        environmentId: root.data.environmentId,
        id: TRACE_ID,
        organizationId: root.data.organizationId,
        projectId: root.data.projectId,
        redactionPolicyVersion: 1 as const,
        rootRunId: root.data.id,
        rootSpanId: ROOT_SPAN_ID,
        runIds: [...runIds],
        schemaVersion: 1 as const,
        sessionId: root.data.threadId,
        status: "open" as const,
        traceId: TRACE_ID,
        updatedAt: root.data.updatedAt,
        version: 0,
        workspaceId: root.data.workspaceId,
      },
      itemType: "trace" as const,
    }),
  );
}

function locator(run: ReturnType<typeof terminalRun>) {
  return Schema.decodeUnknownSync(RunLocatorRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: run.data.createdAt,
        environmentId: run.data.environmentId,
        id: run.data.id,
        organizationId: run.data.organizationId,
        projectId: run.data.projectId,
        runPk: run.pk,
        runSk: run.sk,
      },
      itemType: "run-locator" as const,
    }),
  );
}

describe("trace finalization", () => {
  test("leaves transient synchronous failures for durable repair", async () => {
    const root = terminalRun(fixtures().run);
    const memory = inMemoryDatabase([root, traceRecord(root, [root.data.id]), locator(root)]);
    const database = {
      ...memory.database,
      getRecord: async () => {
        throw new Error("transient read failure");
      },
    } as unknown as DynamoDatabaseService;

    expect(attemptTraceFinalization(database, root)).resolves.toBeUndefined();
    expect(reconcileTraceFinalization(database, root)).rejects.toThrow("transient read failure");
  });

  test("finalizes a terminal root exactly once with a stable graph watermark", async () => {
    const root = terminalRun(fixtures().run);
    const trace = traceRecord(root, [root.data.id]);
    const memory = inMemoryDatabase([root, trace, locator(root)]);

    const first = await reconcileTraceFinalization(
      memory.database,
      root,
      new Date("2026-07-22T00:00:03.000Z"),
    );
    const replay = await reconcileTraceFinalization(
      memory.database,
      root,
      new Date("2026-07-22T00:00:04.000Z"),
    );

    expect(first?.data).toMatchObject({
      completedAt: "2026-07-22T00:00:02.000Z",
      finalizedAt: "2026-07-22T00:00:03.000Z",
      outcome: "ok",
      status: "finalized",
      totalCostUsdMicros: 0,
      totalTokens: 0,
      version: 2,
    });
    expect(replay?.data.graphWatermark).toBe(first?.data.graphWatermark);
    expect(
      memory.transactionInputs.filter((operations) =>
        operations.some(
          (operation) => operation.kind === "put" && operation.record.itemType === "trace",
        ),
      ),
    ).toHaveLength(2);
  });

  test("does not acknowledge a failed write when the stored outcome is stale", async () => {
    const root = terminalRun(fixtures().run);
    const initial = inMemoryDatabase([root, traceRecord(root, [root.data.id]), locator(root)]);
    const finalized = await reconcileTraceFinalization(initial.database, root);
    const { outcome: _outcome, ...legacyData } = finalized!.data;
    const legacyFinalized = Schema.decodeUnknownSync(TraceRecord)(
      withCanonicalRecordKeys({
        ...finalized!,
        data: legacyData,
      }),
    );
    const raced = inMemoryDatabase([root, legacyFinalized, locator(root)]);
    const database = {
      ...raced.database,
      transactWrite: async () => {
        throw new Error("transaction rejected");
      },
    } as unknown as DynamoDatabaseService;

    expect(reconcileTraceFinalization(database, root)).rejects.toThrow("transaction rejected");
  });

  test("waits for every reachable child run before finalizing", async () => {
    const root = terminalRun(fixtures().run);
    const child = terminalRun(fixtures().run, id(90), "running");
    const trace = traceRecord(root, [root.data.id, child.data.id]);
    const edge = Schema.decodeUnknownSync(RunEdgeRecord)(
      withCanonicalRecordKeys({
        data: {
          childRunId: child.data.id,
          childThreadId: child.data.threadId,
          createdAt: root.data.createdAt,
          environmentId: root.data.environmentId,
          fromAgentDeploymentId: root.data.agentDeploymentId,
          id: id(91),
          kind: "child-agent",
          organizationId: root.data.organizationId,
          parentRunId: root.data.id,
          parentSpanId: root.data.spanId,
          projectId: root.data.projectId,
          threadId: root.data.threadId,
          toAgentDeploymentId: child.data.agentDeploymentId,
          traceId: TRACE_ID,
        },
        itemType: "run-edge" as const,
      }),
    );
    const memory = inMemoryDatabase([root, child, trace, edge, locator(root), locator(child)]);

    const result = await reconcileTraceFinalization(memory.database, root);

    expect(result?.data.status).toBe("open");
    expect(memory.queryInputs).toHaveLength(0);
    expect(
      [...memory.records.values()].filter(
        (record): record is Extract<PlatformRecord, { readonly itemType: "trace" }> =>
          record.itemType === "trace" && record.data.status === "finalized",
      ),
    ).toHaveLength(0);

    const completedChild = terminalRun(child, child.data.id, "completed");
    await memory.database.putRecord(completedChild);
    const finalized = await reconcileTraceFinalization(memory.database, completedChild);
    expect(finalized?.data.status).toBe("finalized");
  });

  test("waits for an externally canceled execution to settle", async () => {
    const source = terminalRun(fixtures().run, undefined, "canceled");
    const canceled = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        ...source,
        data: {
          ...source.data,
          claimedAt: "2026-07-22T00:00:01.000Z",
          claimedBy: "worker-in-flight",
          heartbeatAt: "2026-07-22T00:00:01.000Z",
        },
      }),
    );
    const memory = inMemoryDatabase([
      canceled,
      traceRecord(canceled, [canceled.data.id]),
      locator(canceled),
    ]);

    const waiting = await reconcileTraceFinalization(memory.database, canceled);
    expect(waiting?.data.status).toBe("open");

    const settled = settledCanceledRun(canceled, new Date("2026-07-22T00:00:03.000Z"));
    await memory.database.putRecord(settled);
    const finalized = await reconcileTraceFinalization(memory.database, settled);
    expect(finalized?.data.status).toBe("finalized");
  });

  test("waits for unresolved provider mutation claims but not releasable claims", async () => {
    const root = terminalRun(fixtures().run);
    const claim = Schema.decodeUnknownSync(ProviderMutationClaimRecord)(
      withCanonicalRecordKeys({
        data: {
          claimAttemptId: "provider-attempt-1",
          connectionId: id(70),
          createdAt: "2026-07-22T00:00:01.000Z",
          environmentId: root.data.environmentId,
          id: id(71),
          idempotencyKey: "provider-mutation-1",
          immutableIdentityHash: "sha256:provider-mutation-1",
          operation: "provider.issue.create",
          organizationId: root.data.organizationId,
          projectId: root.data.projectId,
          runId: root.data.id,
          status: "unknown" as const,
          threadId: root.data.threadId,
          toolCallId: id(72),
          updatedAt: "2026-07-22T00:00:01.000Z",
          version: 0,
        },
        itemType: "provider-mutation-claim" as const,
      }),
    );
    const memory = inMemoryDatabase([
      root,
      traceRecord(root, [root.data.id]),
      locator(root),
      claim,
    ]);

    const waiting = await reconcileTraceFinalization(memory.database, root);
    expect(waiting?.data.status).toBe("open");
    expect(
      memory.queryInputs.some((input) => {
        const values = (
          input as {
            readonly ExpressionAttributeValues?: Readonly<Record<string, unknown>>;
          }
        ).ExpressionAttributeValues;
        return (
          values?.[":pk"] ===
            key("ORG", root.data.organizationId, "ENV", root.data.environmentId) &&
          values[":prefix"] === undefined
        );
      }),
    ).toBe(false);

    const releasable = Schema.decodeUnknownSync(ProviderMutationClaimRecord)(
      withCanonicalRecordKeys({
        ...claim,
        data: { ...claim.data, status: "releasable" as const, version: 1 },
      }),
    );
    await memory.database.putRecord(releasable);
    const finalized = await reconcileTraceFinalization(memory.database, root);
    expect(finalized?.data.status).toBe("finalized");
  });

  test("counts one canonical usage event once across duplicate invocation references", async () => {
    const root = terminalRun(fixtures().run);
    const usageEntry = {
      costUsdMicros: 7,
      idempotencyKey: `${root.data.id}:shared-model-usage`,
      modelId: "openrouter/test",
      occurredAt: "2026-07-22T00:00:01.000Z",
      provider: "openrouter",
      quantity: 5,
      runId: root.data.id,
      source: "model-gateway",
      payer: { kind: "operator" as const },
      type: "model_tokens",
      unit: "tokens",
    } as const;
    const invocation = (suffix: number) =>
      modelInvocationRecord({
        actualModelId: "openrouter/test",
        agentDefinitionId: id(30),
        ...customerRunPins(root.data),
        agentManifestHash: "sha256:test",
        attemptId: `${root.data.id}:attempt:${suffix}`,
        captureMode: root.data.captureMode,
        completedAt: "2026-07-22T00:00:01.000Z",
        costUsdMicros: 7,
        environmentId: root.data.environmentId,
        fallbackAttempt: suffix,
        internalEvaluator: false,
        invocationId: `${root.data.id}:invocation:${suffix}`,
        invocationKind: "assistant",
        modelCallIndex: 0,
        organizationId: root.data.organizationId,
        parentSpanId: root.data.spanId,
        projectId: root.data.projectId,
        requestedModelId: "openrouter/test",
        runAttempt: root.data.attempt,
        runExecutionVersion: root.data.version,
        runId: root.data.id,
        spanId: suffix === 0 ? "1111111111111111" : "2222222222222222",
        startedAt: "2026-07-22T00:00:00.000Z",
        status: "succeeded",
        streaming: false,
        threadId: root.data.threadId,
        totalTokens: 5,
        traceId: root.data.traceId,
        usageEntry,
        usageIdempotencyKey: usageEntry.idempotencyKey,
        ...(root.data.workspaceId ? { workspaceId: root.data.workspaceId } : {}),
      });
    const usage = runtimeUsageRecord({
      entry: usageEntry,
      id: id(32),
      run: root,
    });
    const memory = inMemoryDatabase([
      root,
      traceRecord(root, [root.data.id]),
      locator(root),
      invocation(0),
      invocation(1),
      usage,
    ]);

    const result = await reconcileTraceFinalization(memory.database, root);

    expect(result?.data).toMatchObject({
      status: "finalized",
      totalCostUsdMicros: 7,
      totalTokens: 5,
    });
  });

  test("includes trace-scoped memory model usage without an invocation record", async () => {
    const root = terminalRun(fixtures().run);
    const usage = runtimeUsageRecord({
      entry: {
        costUsdMicros: 13,
        idempotencyKey: "memory-rerank:1",
        modelId: "openai/gpt-4o-mini",
        occurredAt: "2026-07-22T00:00:01.000Z",
        provider: "bifrost",
        quantity: 21,
        runId: root.data.id,
        source: "memory-rerank",
        payer: { kind: "operator" as const },
        type: "model_tokens",
        unit: "tokens",
      },
      id: id(33),
      run: root,
    });
    const memory = inMemoryDatabase([
      root,
      traceRecord(root, [root.data.id]),
      locator(root),
      usage,
    ]);

    const result = await reconcileTraceFinalization(memory.database, root);

    expect(result?.data).toMatchObject({
      status: "finalized",
      totalCostUsdMicros: 13,
      totalTokens: 21,
    });
  });

  test("reconciles trace totals when run usage arrives after finalization", async () => {
    const root = terminalRun(fixtures().run);
    const memory = inMemoryDatabase([root, traceRecord(root, [root.data.id]), locator(root)]);
    const finalized = await reconcileTraceFinalization(memory.database, root);
    const usage = runtimeUsageRecord({
      entry: {
        costUsdMicros: 17,
        idempotencyKey: `${root.data.id}:model_tokens:memory-flush:1`,
        modelId: "openai/gpt-4o-mini",
        occurredAt: "2026-07-22T00:00:04.000Z",
        provider: "bifrost",
        quantity: 34,
        runId: root.data.id,
        source: "memory-flush",
        payer: { kind: "operator" as const },
        type: "model_tokens",
        unit: "tokens",
      },
      id: id(34),
      run: root,
    });
    await memory.database.putRecord(usage);

    const reconciled = await reconcileTraceFinalization(memory.database, root);

    expect(finalized?.data).toMatchObject({
      status: "finalized",
      totalTokens: 0,
      version: 2,
    });
    expect(reconciled?.data).toMatchObject({
      status: "finalized",
      totalCostUsdMicros: 17,
      totalTokens: 34,
      version: 3,
    });
  });

  test("saturates aggregate usage totals at the maximum safe integer", async () => {
    const root = terminalRun(fixtures().run);
    const invocationAndUsage = (suffix: number, quantity: number) => {
      const usageEntry = {
        costUsdMicros: quantity,
        idempotencyKey: `${root.data.id}:overflow-usage:${suffix}`,
        modelId: "openrouter/test",
        occurredAt: "2026-07-22T00:00:01.000Z",
        provider: "openrouter",
        quantity,
        runId: root.data.id,
        source: "model-gateway",
        payer: { kind: "operator" as const },
        type: "model_tokens",
        unit: "tokens",
      } as const;
      return [
        modelInvocationRecord({
          actualModelId: "openrouter/test",
          agentDefinitionId: id(30),
          ...customerRunPins(root.data),
          agentManifestHash: "sha256:test",
          attemptId: `${root.data.id}:overflow-attempt:${suffix}`,
          captureMode: root.data.captureMode,
          completedAt: "2026-07-22T00:00:01.000Z",
          costUsdMicros: quantity,
          environmentId: root.data.environmentId,
          fallbackAttempt: suffix,
          internalEvaluator: false,
          invocationId: `${root.data.id}:overflow-invocation:${suffix}`,
          invocationKind: "assistant",
          modelCallIndex: 0,
          organizationId: root.data.organizationId,
          parentSpanId: root.data.spanId,
          projectId: root.data.projectId,
          requestedModelId: "openrouter/test",
          runAttempt: root.data.attempt,
          runExecutionVersion: root.data.version,
          runId: root.data.id,
          spanId: suffix === 0 ? "3333333333333333" : "4444444444444444",
          startedAt: "2026-07-22T00:00:00.000Z",
          status: "succeeded",
          streaming: false,
          threadId: root.data.threadId,
          totalTokens: quantity,
          traceId: root.data.traceId,
          usageEntry,
          usageIdempotencyKey: usageEntry.idempotencyKey,
          ...(root.data.workspaceId ? { workspaceId: root.data.workspaceId } : {}),
        }),
        runtimeUsageRecord({
          entry: usageEntry,
          id: id(40 + suffix),
          run: root,
        }),
      ] as const;
    };
    const [firstInvocation, firstUsage] = invocationAndUsage(0, Number.MAX_SAFE_INTEGER);
    const [secondInvocation, secondUsage] = invocationAndUsage(1, 1);
    const memory = inMemoryDatabase(
      [
        root,
        traceRecord(root, [root.data.id]),
        locator(root),
        firstInvocation,
        firstUsage,
        secondInvocation,
        secondUsage,
      ],
      { queryPageSize: 1 },
    );

    const result = await reconcileTraceFinalization(memory.database, root);

    expect(result?.data).toMatchObject({
      status: "finalized",
      totalCostUsdMicros: Number.MAX_SAFE_INTEGER,
      totalTokens: Number.MAX_SAFE_INTEGER,
    });
  });
});
