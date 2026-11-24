import { describe, expect, test } from "bun:test";
import {
  RunLocatorRecord,
  RunRecord,
  TraceRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { customerRunPins, fixtures, inMemoryDatabase } from "./agent-run.fixture.ts";
import { modelInvocationRecord } from "./model-invocations.ts";
import { observabilityFactsForTransition } from "./observability-normalizer.ts";
import { reconcileTraceFinalization } from "./trace-finalization.ts";
import { traceErrorClass, UNCLASSIFIED_TRACE_ERROR_CLASS } from "./trace-root-summary.ts";

type Run = Extract<PlatformRecord, { readonly itemType: "run" }>;

function failedRoot(source: Run) {
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      ...source,
      data: {
        ...source.data,
        completedAt: "2026-07-22T00:00:02.500Z",
        error: { message: "Provider rate limit." },
        releaseSelection: "candidate" as const,
        startedAt: "2026-07-22T00:00:00.000Z",
        status: "failed" as const,
        updatedAt: "2026-07-22T00:00:02.500Z",
        version: 2,
      },
    }),
  );
}

function invocation(
  run: Run,
  index: number,
  input: { readonly completedAt: string; readonly errorClass?: string; readonly failed: boolean },
) {
  return modelInvocationRecord({
    agentDefinitionId: fixtures().release.data.agentDefinitionId,
    ...customerRunPins(run.data),
    agentManifestHash: "sha256:test-manifest",
    attemptId: `${run.data.id}:attempt:${index}`,
    captureMode: run.data.captureMode,
    completedAt: input.completedAt,
    environmentId: run.data.environmentId,
    ...(input.errorClass ? { errorClass: input.errorClass } : {}),
    fallbackAttempt: index,
    internalEvaluator: false,
    invocationId: `${run.data.id}:invocation:${index}`,
    invocationKind: "assistant",
    modelCallIndex: 0,
    organizationId: run.data.organizationId,
    parentSpanId: run.data.spanId,
    projectId: run.data.projectId,
    requestedModelId: "openrouter/primary",
    runAttempt: 1,
    runExecutionVersion: 1,
    runId: run.data.id,
    spanId: `fedcba987654321${index}`,
    startedAt: "2026-07-22T00:00:00.100Z",
    status: input.failed ? "failed" : "succeeded",
    streaming: false,
    threadId: run.data.threadId,
    traceId: run.data.traceId,
    ...(run.data.workspaceId ? { workspaceId: run.data.workspaceId } : {}),
  });
}

function openTrace(root: Run) {
  return Schema.decodeUnknownSync(TraceRecord)(
    withCanonicalRecordKeys({
      data: {
        captureMode: "metadata-only" as const,
        createdAt: root.data.createdAt,
        environmentId: root.data.environmentId,
        id: root.data.traceId,
        organizationId: root.data.organizationId,
        projectId: root.data.projectId,
        redactionPolicyVersion: 1 as const,
        rootRunId: root.data.id,
        rootSpanId: root.data.spanId,
        runIds: [root.data.id],
        schemaVersion: 1 as const,
        sessionId: root.data.threadId,
        status: "open" as const,
        traceId: root.data.traceId,
        updatedAt: root.data.updatedAt,
        version: 0,
        workspaceId: root.data.workspaceId,
      },
      itemType: "trace" as const,
    }),
  );
}

describe("trace root summary", () => {
  test("a finalized trace fact carries the agent identity and outcome of its root run", async () => {
    const fixture = fixtures();
    const root = failedRoot(fixture.run);
    const trace = openTrace(root);
    const locator = Schema.decodeUnknownSync(RunLocatorRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: root.data.createdAt,
          environmentId: root.data.environmentId,
          id: root.data.id,
          organizationId: root.data.organizationId,
          projectId: root.data.projectId,
          runPk: root.pk,
          runSk: root.sk,
        },
        itemType: "run-locator" as const,
      }),
    );
    const memory = inMemoryDatabase([
      root,
      trace,
      locator,
      fixture.release,
      invocation(root, 0, {
        completedAt: "2026-07-22T00:00:01.000Z",
        errorClass: "ProviderTimeoutError",
        failed: true,
      }),
      invocation(root, 1, {
        completedAt: "2026-07-22T00:00:02.000Z",
        errorClass: "RateLimitError",
        failed: true,
      }),
    ]);

    const finalized = await reconcileTraceFinalization(
      memory.database,
      root,
      new Date("2026-07-22T00:00:03.000Z"),
    );
    expect(finalized?.data).toMatchObject({
      agentDefinitionId: fixture.release.data.agentDefinitionId,
      agentDeploymentId: root.data.agentDeploymentId,
      agentReleaseId: root.data.agentReleaseId,
      durationMs: 2_500,
      errorClass: "RateLimitError",
      executionPurpose: "customer",
      outcome: "error",
      releaseSelection: "candidate",
      status: "finalized",
      trigger: "api",
    });

    if (!finalized) throw new Error("The trace was not finalized.");
    const facts = await observabilityFactsForTransition({
      current: finalized,
      eventName: "MODIFY",
      normalizedAt: "2026-07-22T00:00:04.000Z",
      previous: trace,
      streamArn: "arn:aws:dynamodb:us-east-2:123:table/execution/stream/1",
      streamSequenceNumber: "200",
      table: "execution",
    });
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      factType: "trace.finalized",
      payload: {
        agentDefinitionId: fixture.release.data.agentDefinitionId,
        agentDeploymentId: root.data.agentDeploymentId,
        agentReleaseId: root.data.agentReleaseId,
        durationMs: 2_500,
        errorClass: "RateLimitError",
        executionPurpose: "customer",
        outcome: "error",
        releaseSelection: "candidate",
        rootRunId: root.data.id,
        trigger: "api",
      },
    });
  });

  test("classifies trace errors by the root's final failure, then the first failure", () => {
    const root = fixtures().run;
    const child = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        ...root,
        data: { ...root.data, id: "01ARZ3NDEKTSV4RRFFQ69G5FZZ", idempotencyKey: "run/child" },
      }),
    );
    const childFailure = invocation(child, 0, {
      completedAt: "2026-07-22T00:00:01.000Z",
      errorClass: "ChildError",
      failed: true,
    });
    const rootRecovered = invocation(root, 1, {
      completedAt: "2026-07-22T00:00:00.500Z",
      errorClass: "TransientError",
      failed: true,
    });
    const rootSucceeded = invocation(root, 2, {
      completedAt: "2026-07-22T00:00:02.000Z",
      failed: false,
    });
    const rootFailed = invocation(root, 3, {
      completedAt: "2026-07-22T00:00:03.000Z",
      errorClass: "RootError",
      failed: true,
    });

    expect(traceErrorClass(root.data.id, [childFailure, rootSucceeded, rootFailed])).toBe(
      "RootError",
    );
    // The root's last model call succeeded: the earliest classified failure explains the trace.
    expect(traceErrorClass(root.data.id, [childFailure, rootRecovered, rootSucceeded])).toBe(
      "TransientError",
    );
    expect(traceErrorClass(root.data.id, [rootSucceeded])).toBe(UNCLASSIFIED_TRACE_ERROR_CLASS);
  });
});
