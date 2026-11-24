import { describe, expect, test } from "bun:test";
import { evaluationQueueEnvelope } from "@deployments-ai/observability/evaluators";
import {
  drainQueue,
  evaluationHarness,
  DEPLOYMENT_ID,
  RELEASE_ID,
} from "./evaluation-worker.fixture.ts";
import { processEvaluationMessage } from "./evaluation-processor.ts";
import { reconcileEvaluationRun, startEvaluationRun } from "./evaluation-run-lifecycle.ts";

async function datasetRun(caseCount: number, fields: { concurrency?: number } = {}) {
  const harness = evaluationHarness();
  const definition = await harness.seedDefinition({ kind: "contains", values: ["refund"] });
  const dataset = await harness.seedDataset(
    Array.from({ length: caseCount }, (_, index) => ({ content: `Where is refund ${index}?` })),
  );
  const run = await harness.createRun([definition], {
    datasetId: dataset.datasetId,
    target: { agentDeploymentId: DEPLOYMENT_ID, agentReleaseId: RELEASE_ID, type: "deployment" },
    ...fields,
  });
  return { dataset, definition, harness, run };
}

describe("evaluation run start", () => {
  test("plans pending case runs, binds the target release, and marks the run running", async () => {
    const { dataset, harness, run } = await datasetRun(3, { concurrency: 2 });

    await startEvaluationRun(harness.context, run.data.id);

    const started = await harness.persistence.getEvaluationRun(run.data.id);
    expect(started?.data).toMatchObject({
      caseCount: 3,
      counts: { failed: 0, pending: 3, running: 0, scored: 0, timedOut: 0 },
      executionBindingId: `binding-evaluation-run:${run.data.id}`,
      startedAt: "2026-09-29T12:00:00.000Z",
      status: "running",
    });
    const cases = await harness.persistence.listAllCaseRuns(run.data.id);
    expect(cases.map((record) => record.data.caseKey).sort()).toEqual(
      dataset.cases.map((record) => record.data.id).sort(),
    );
    expect(cases.every((record) => record.data.status === "pending")).toBe(true);
    expect(harness.bindings).toEqual([
      {
        createdBy: { id: "principal-1", type: "principal" },
        idempotencyKey: `evaluation-run:${run.data.id}`,
        purpose: "evaluation",
        runtimeConfigFromAgentDeploymentId: DEPLOYMENT_ID,
        scope: harness.context.scope,
        source: { agentReleaseId: RELEASE_ID, type: "release" },
        toolPolicy: "evaluation",
        // 3 cases * 600s / concurrency 2 + 1h.
        ttlSeconds: 900 + 3_600,
      },
    ]);
    expect(harness.sent).toEqual([
      {
        ...harness.context.scope,
        evaluationRunId: run.data.id,
        trigger: "start",
        type: "evaluation-run.reconcile",
      },
    ]);
  });

  test("a redelivered start does not plan or bind twice", async () => {
    const { harness, run } = await datasetRun(2);
    await startEvaluationRun(harness.context, run.data.id);
    await startEvaluationRun(harness.context, run.data.id);

    expect(harness.bindings).toHaveLength(1);
    expect(await harness.persistence.listAllCaseRuns(run.data.id)).toHaveLength(2);
    expect(harness.sent.map((message) => evaluationQueueEnvelope(message).deduplicationId)).toEqual(
      [`reconcile-${run.data.id}-start`, `reconcile-${run.data.id}-start`],
    );
  });

  test("fails the run instead of retrying when the execution binding is rejected", async () => {
    const { harness, run } = await datasetRun(1);
    const context = {
      ...harness.context,
      execution: {
        ...harness.context.execution,
        createBinding: async () => {
          throw new Error("Release is not deployable.");
        },
      },
    };

    await startEvaluationRun(context, run.data.id);

    expect((await harness.persistence.getEvaluationRun(run.data.id))?.data).toMatchObject({
      error: { code: "execution_binding_failed", message: "Release is not deployable." },
      status: "failed",
    });
    expect(await harness.persistence.listAllCaseRuns(run.data.id)).toHaveLength(0);
  });

  test("scores trace ids as cases without binding a release", async () => {
    const harness = evaluationHarness();
    const definition = await harness.seedDefinition({ kind: "contains", values: ["refund"] });
    const seeded = harness.seedRun({
      content: "Refund please",
      run: { outputText: "Refund issued.", status: "completed" },
    });
    const run = await harness.createRun([definition], {
      kind: "trace-score",
      traceIds: [seeded.traceId as never],
    });

    await startEvaluationRun(harness.context, run.data.id);

    expect(harness.bindings).toHaveLength(0);
    const [caseRun] = await harness.persistence.listAllCaseRuns(run.data.id);
    expect(caseRun?.data).toMatchObject({ caseKey: seeded.traceId, sourceTraceId: seeded.traceId });
  });
});

describe("evaluation run reconcile", () => {
  test("dispatches no more cases than the concurrency limit", async () => {
    const { harness, run } = await datasetRun(4, { concurrency: 2 });
    await startEvaluationRun(harness.context, run.data.id);
    harness.sent.length = 0;

    await reconcileEvaluationRun(harness.context, run.data.id);
    await reconcileEvaluationRun(harness.context, run.data.id);

    const cases = await harness.persistence.listAllCaseRuns(run.data.id);
    expect(cases.filter((record) => record.data.status === "dispatched")).toHaveLength(2);
    expect(cases.filter((record) => record.data.status === "pending")).toHaveLength(2);
    expect((await harness.persistence.getEvaluationRun(run.data.id))?.data.counts).toEqual({
      failed: 0,
      pending: 2,
      running: 2,
      scored: 0,
      timedOut: 0,
    });
    // The second reconcile replays the same advance messages; FIFO deduplication collapses them.
    const dedupIds = new Set(
      harness.sent.map((message) => evaluationQueueEnvelope(message).deduplicationId),
    );
    expect(dedupIds.size).toBe(2);
  });

  test("runs every case to completion and summarizes scores and latency", async () => {
    const { harness, run, definition } = await datasetRun(3, { concurrency: 2 });
    harness.setNextRun({ outputText: "Refund approved.", status: "completed", totalTokens: 40 });
    harness.sent.push({
      ...harness.context.scope,
      evaluationRunId: run.data.id,
      type: "evaluation-run.start",
    });

    await drainQueue(harness, (message) => processEvaluationMessage(harness.dependencies, message));

    const completed = await harness.persistence.getEvaluationRun(run.data.id);
    expect(completed?.data).toMatchObject({
      completedAt: "2026-09-29T12:00:00.000Z",
      counts: { failed: 0, pending: 0, running: 0, scored: 3, timedOut: 0 },
      status: "completed",
      summary: {
        costUsdMicros: 240,
        definitions: [
          {
            errors: 0,
            mean: 1,
            passRate: 1,
            passed: 3,
            revision: 1,
            scoreDefinitionId: definition.data.scoreDefinitionId,
            scored: 3,
          },
        ],
        latencyP50Ms: 1_500,
        latencyP95Ms: 1_500,
        totalTokens: 120,
      },
    });
    expect(harness.submissions).toHaveLength(3);
  });

  test("summarizes mixed outcomes with passed, failed, and errored scores", async () => {
    const { harness, run } = await datasetRun(3, { concurrency: 3 });
    const outcomes = [
      { outputText: "Refund approved.", status: "completed" as const },
      { outputText: "No money back.", status: "completed" as const },
      { status: "completed" as const },
    ];
    const submitTurn = harness.dependencies.execution.submitTurn;
    let index = 0;
    const dependencies = {
      ...harness.dependencies,
      execution: {
        ...harness.dependencies.execution,
        submitTurn: async (input: Parameters<typeof submitTurn>[0]) => {
          harness.setNextRun(outcomes[index++]!);
          return submitTurn(input);
        },
      },
    };
    harness.sent.push({
      ...harness.context.scope,
      evaluationRunId: run.data.id,
      type: "evaluation-run.start",
    });

    await drainQueue(harness, (message) => processEvaluationMessage(dependencies, message));

    const summary = (await harness.persistence.getEvaluationRun(run.data.id))?.data.summary;
    expect(summary?.definitions[0]).toMatchObject({
      errors: 1,
      mean: 0.5,
      passRate: 0.5,
      passed: 1,
      scored: 2,
    });
  });
});
