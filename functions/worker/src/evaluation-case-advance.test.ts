import { describe, expect, test } from "bun:test";
import type { EvaluatorConfig } from "@deployments-ai/observability/evaluator-config";
import { evaluationQueueEnvelope } from "@deployments-ai/observability/evaluators";
import { advanceEvaluationCase } from "./evaluation-case-advance.ts";
import { reconcileEvaluationRun, startEvaluationRun } from "./evaluation-run-lifecycle.ts";
import { scoreRun } from "./evaluation-scoring.ts";
import { evaluationHarness, RELEASE_ID, type SimulatedRun } from "./evaluation-worker.fixture.ts";

async function dispatchedCase(
  run: SimulatedRun,
  evaluators: readonly EvaluatorConfig[] = [{ kind: "contains", values: ["refund"] }],
) {
  const harness = evaluationHarness();
  const definitions = await Promise.all(
    evaluators.map((evaluator) => harness.seedDefinition(evaluator)),
  );
  const dataset = await harness.seedDataset([
    { content: "Where is my refund?", expectations: { mustInclude: ["refund"] } },
  ]);
  const evaluationRun = await harness.createRun(definitions, {
    caseTimeoutSeconds: 60,
    datasetId: dataset.datasetId,
    target: { agentReleaseId: RELEASE_ID, type: "release" },
  });
  harness.setNextRun(run);
  await startEvaluationRun(harness.context, evaluationRun.data.id);
  await reconcileEvaluationRun(harness.context, evaluationRun.data.id);
  harness.sent.length = 0;
  const caseKey = dataset.cases[0]!.data.id;
  const advance = (attempt: number) =>
    advanceEvaluationCase(harness.context, {
      attempt,
      caseKey,
      evaluationRunId: evaluationRun.data.id,
    });
  const caseRun = async () =>
    (await harness.persistence.getCaseRun(evaluationRun.data.id, caseKey))!;
  return { advance, caseKey, caseRun, definitions, evaluationRun, harness };
}

describe("evaluation case advance", () => {
  test("submits the case material through the binding and schedules the first poll", async () => {
    const { advance, caseKey, caseRun, evaluationRun, harness } = await dispatchedCase({
      status: "running",
    });

    await advance(0);

    expect(harness.submissions).toEqual([
      {
        actor: { id: "principal-1", type: "principal" },
        content: "Where is my refund?",
        executionBindingId: `binding-evaluation-run:${evaluationRun.data.id}`,
        idempotencyKey: `evaluation:${evaluationRun.data.id}:${caseKey}`,
        scope: harness.context.scope,
        title: `eval:${evaluationRun.data.id}:${caseKey}`,
      },
    ]);
    const submitted = await caseRun();
    expect(submitted.data).toMatchObject({
      attempts: 1,
      deadlineAt: "2026-09-29T12:01:00.000Z",
      status: "submitted",
      submittedAt: "2026-09-29T12:00:00.000Z",
    });
    expect(submitted.data.runId).toBeDefined();
    expect(harness.sent).toEqual([
      {
        ...harness.context.scope,
        attempt: 1,
        caseKey,
        evaluationRunId: evaluationRun.data.id,
        type: "evaluation-case.advance",
      },
    ]);
  });

  test("polls an unfinished run by re-enqueueing with distinct deduplication ids", async () => {
    const { advance, caseRun, harness } = await dispatchedCase({ status: "running" });
    await advance(0);
    await advance(1);
    await advance(2);

    expect((await caseRun()).data).toMatchObject({
      attempts: 3,
      runStatus: "running",
      status: "submitted",
    });
    const attempts = harness.sent.map(
      (message) => message.type === "evaluation-case.advance" && message.attempt,
    );
    expect(attempts).toEqual([1, 2, 3]);
    const dedup = harness.sent.map((message) => evaluationQueueEnvelope(message).deduplicationId);
    expect(new Set(dedup).size).toBe(3);
  });

  test("ignores stale deliveries and replays a lost follow-up send", async () => {
    const { advance, caseRun, harness } = await dispatchedCase({ status: "running" });
    await advance(0);
    harness.sent.length = 0;

    await advance(0);

    expect(harness.submissions).toHaveLength(1);
    expect((await caseRun()).data.attempts).toBe(1);
    expect(
      harness.sent.map((message) => message.type === "evaluation-case.advance" && message.attempt),
    ).toEqual([1]);
  });

  test("times out a case whose run is still running past the deadline", async () => {
    const { advance, caseKey, caseRun, evaluationRun, harness } = await dispatchedCase({
      status: "running",
    });
    await advance(0);
    harness.clock.now += 61_000;
    harness.sent.length = 0;

    await advance(1);

    expect((await caseRun()).data).toMatchObject({
      error: { code: "case_timeout" },
      status: "timed_out",
    });
    expect(harness.sent).toEqual([
      {
        ...harness.context.scope,
        evaluationRunId: evaluationRun.data.id,
        trigger: `case-${caseKey}`,
        type: "evaluation-run.reconcile",
      },
    ]);
  });

  test("marks the case failed without scores when the evaluated run fails", async () => {
    const { advance, caseRun } = await dispatchedCase({ status: "failed" });
    await advance(0);
    await advance(1);

    expect((await caseRun()).data).toMatchObject({
      error: { code: "run_failed" },
      runStatus: "failed",
      scores: [],
      status: "failed",
    });
  });

  test("scores a completed run and records one idempotent score result per definition", async () => {
    const { advance, caseRun, definitions, evaluationRun, harness } = await dispatchedCase(
      { outputText: "Your refund was issued.", status: "completed", toolNames: ["orders.lookup"] },
      [
        { kind: "contains", values: ["refund", "tracking"] },
        { kind: "tool_called", tools: ["orders.lookup"] },
        { kind: "regex", pattern: "never-configured-here" },
        { kind: "json_schema" },
      ],
    );
    await advance(0);
    await advance(1);

    const scored = await caseRun();
    const [contains, toolCalled, regex, jsonSchema] = definitions;
    expect(scored.data.status).toBe("scored");
    expect(scored.data.latencyMs).toBe(1_500);
    expect(scored.data.scores).toEqual([
      {
        executionStatus: "succeeded",
        passed: false,
        revision: 1,
        scoreDefinitionId: contains!.data.scoreDefinitionId,
        value: 0.5,
      },
      {
        executionStatus: "succeeded",
        passed: true,
        revision: 1,
        scoreDefinitionId: toolCalled!.data.scoreDefinitionId,
        value: 1,
      },
      {
        executionStatus: "succeeded",
        passed: false,
        revision: 1,
        scoreDefinitionId: regex!.data.scoreDefinitionId,
        value: 0,
      },
    ]);
    expect(scored.data.notApplicable).toEqual([jsonSchema!.data.scoreDefinitionId]);

    const traceId = scored.data.traceId!;
    const results = (await harness.persistence.listTraceScoreResults(traceId, {})).items;
    expect(results).toHaveLength(3);
    const containsResult = results.find(
      (result) => result.data.scoreDefinitionId === contains!.data.scoreDefinitionId,
    );
    expect(containsResult?.data).toMatchObject({
      evaluationRunId: evaluationRun.data.id,
      idempotencyKey: `${traceId}:${contains!.data.scoreDefinitionId}:1`,
      runId: scored.data.runId,
      source: "evaluation-run",
      value: 0.5,
    });
    expect(containsResult?.data.evidenceRefs.map((reference) => reference.kind)).toEqual([
      "run",
      "trace",
      "message",
    ]);

    // Replaying the scoring of the same trace keeps the original results.
    const run = await harness.persistence.getRun(scored.data.threadId!, scored.data.runId!);
    await scoreRun(harness.context, {
      definitions: [{ revision: 1, scoreDefinitionId: contains!.data.scoreDefinitionId }],
      expectations: {},
      run: run!,
      source: "evaluation-run",
    });
    expect((await harness.persistence.listTraceScoreResults(traceId, {})).items).toHaveLength(3);
  });

  test("stores an evaluator error as an error result without a value", async () => {
    const { advance, caseRun, definitions, harness } = await dispatchedCase({
      status: "completed",
    });
    await advance(0);
    await advance(1);

    const scored = await caseRun();
    expect(scored.data.scores).toEqual([
      {
        errorClass: "missing_evidence",
        executionStatus: "error",
        revision: 1,
        scoreDefinitionId: definitions[0]!.data.scoreDefinitionId,
      },
    ]);
    const [result] = (await harness.persistence.listTraceScoreResults(scored.data.traceId!, {}))
      .items;
    expect(result?.data.executionStatus).toBe("error");
    expect(result?.data.errorClass).toBe("missing_evidence");
    expect(result?.data.value).toBeUndefined();
    expect(result?.data.passed).toBeUndefined();
  });
});
