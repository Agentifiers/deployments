import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { PersistenceError } from "../persistence-types.ts";
import { ScoreResultRecord } from "../records/evaluations.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { makeEvaluationPersistence } from "./index.ts";
import { evaluationMemoryDatabase } from "./memory-database.fixture.ts";
import {
  LATER,
  NOW,
  TRACE,
  caseRunData,
  datasetRunData,
  event,
  fixtureUlid,
  scope,
  scoreData,
} from "./evaluation-records.fixture.ts";

function setup() {
  const memory = evaluationMemoryDatabase();
  return { memory, persistence: makeEvaluationPersistence(memory.database, scope) };
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (cause) {
    return cause;
  }
  throw new Error("Expected the operation to fail.");
}

describe("score result records", () => {
  test("keys results by trace, definition, and revision and indexes them by definition", () => {
    const record = Schema.decodeUnknownSync(ScoreResultRecord)(
      withCanonicalRecordKeys({ data: scoreData(), itemType: "score-result" }),
    );
    const data = scoreData();
    expect(record.pk).toBe(`ORG#${scope.organizationId}#TRACE#${TRACE}`);
    expect(record.sk).toBe(`SCORE-RESULT#${data.scoreDefinitionId}#${"1".padStart(16, "0")}`);
    expect(record.gsi1pk).toBe(
      `ORG#${scope.organizationId}#SCORE-DEFINITION#${data.scoreDefinitionId}#SCORE-RESULTS`,
    );
    expect(record.gsi2pk).toBe(`ENV#${scope.environmentId}`);
  });

  test("rejects evaluator errors carrying a value and pass states that contradict the threshold", () => {
    const decode = (data: unknown) =>
      Schema.decodeUnknownSync(ScoreResultRecord)(
        withCanonicalRecordKeys({
          data: data as Record<string, unknown>,
          itemType: "score-result",
        }),
      );
    const { passed: _passed, value: _value, ...withoutValue } = scoreData();
    expect(() =>
      decode({
        ...withoutValue,
        errorClass: "judge_invalid_output",
        executionStatus: "error",
        value: 0,
      }),
    ).toThrow("never a value");
    expect(() =>
      decode({ ...withoutValue, errorClass: "judge_timeout", executionStatus: "error" }),
    ).not.toThrow();
    expect(() => decode(scoreData({ passed: true, threshold: 0.8, value: 0.5 }))).toThrow();
    expect(() => decode(scoreData({ passed: true, threshold: 0.5, value: 0.5 }))).not.toThrow();
  });

  test("records an automated score once per trace, definition, and revision", async () => {
    const { persistence } = setup();
    const first = await persistence.recordAutomatedScore(scoreData());
    const second = await persistence.recordAutomatedScore(
      scoreData({ id: fixtureUlid(), idempotencyKey: "score-2", passed: false, value: 0 }),
    );
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.result.data.id).toBe(first.result.data.id);
    expect(second.result.data.value).toBe(1);
    expect((await persistence.listTraceScoreResults(TRACE, {})).items).toHaveLength(1);
  });

  test("supersedes a submitted human score in place and replays identical submissions", async () => {
    const { persistence } = setup();
    const human = {
      scoreType: "human" as const,
      source: "api" as const,
      humanActorPrincipalId: "reviewer",
    };
    const first = await persistence.recordSubmittedScore(
      scoreData({ ...human, idempotencyKey: "human-1", passed: false, threshold: 0.5, value: 0.2 }),
    );
    const replay = await persistence.recordSubmittedScore(
      scoreData({ ...human, idempotencyKey: "human-1", passed: false, threshold: 0.5, value: 0.2 }),
    );
    const revised = await persistence.recordSubmittedScore(
      scoreData({
        ...human,
        idempotencyKey: "human-2",
        passed: true,
        threshold: 0.5,
        updatedAt: LATER,
        value: 0.9,
      }),
    );
    expect(replay.created).toBe(false);
    expect(revised.result.data).toMatchObject({
      createdAt: NOW,
      id: first.result.data.id,
      updatedAt: LATER,
      value: 0.9,
      version: 2,
    });
    const automated = await rejection(persistence.recordAutomatedScore(scoreData({ ...human })));
    expect((automated as PersistenceError).code).toBe("invalid_score_result");
  });

  test("lists results for one definition through its index", async () => {
    const { persistence } = setup();
    const definitionId = fixtureUlid();
    await persistence.recordAutomatedScore(scoreData({ scoreDefinitionId: definitionId }));
    await persistence.recordAutomatedScore(
      scoreData({ scoreDefinitionId: definitionId, traceId: "f".repeat(32) as typeof TRACE }),
    );
    await persistence.recordAutomatedScore(scoreData({ scoreDefinitionId: fixtureUlid() }));
    const page = await persistence.listScoreResults({ scoreDefinitionId: definitionId });
    expect(page.items.map((record) => record.data.scoreDefinitionId)).toEqual([
      definitionId,
      definitionId,
    ]);
    expect((await persistence.listScoreResults({})).items).toHaveLength(3);
  });
});

describe("evaluation run persistence", () => {
  test("requires dataset replays to carry a dataset and target", async () => {
    const { persistence } = setup();
    const run = datasetRunData(fixtureUlid(), fixtureUlid(), fixtureUlid());
    const failure = await rejection(
      persistence.createEvaluationRun(
        { ...run, target: undefined },
        event("evaluation-run.created"),
      ),
    );
    expect((failure as PersistenceError).kind).toBe("invalid-input");
  });

  test("creates missing case runs idempotently and advances versions on update", async () => {
    const { persistence } = setup();
    const run = await persistence.createEvaluationRun(
      datasetRunData(fixtureUlid(), fixtureUlid(), fixtureUlid()),
      event("evaluation-run.created"),
    );
    const keys = Array.from({ length: 45 }, () => fixtureUlid());
    const created = await persistence.createCaseRuns(
      run.data.id,
      keys.map((caseKey) => caseRunData(run.data.id, caseKey)),
    );
    expect(created).toHaveLength(45);
    const replay = await persistence.createCaseRuns(
      run.data.id,
      keys.slice(0, 3).map((caseKey) => caseRunData(run.data.id, caseKey)),
    );
    expect(replay).toHaveLength(0);
    expect(await persistence.listAllCaseRuns(run.data.id)).toHaveLength(45);

    const caseRun = (await persistence.getCaseRun(run.data.id, keys[0]!))!;
    const updated = await persistence.updateCaseRun(caseRun, {
      ...caseRun.data,
      status: "dispatched",
      dispatchedAt: LATER,
      updatedAt: LATER,
      version: caseRun.data.version + 1,
    });
    expect(updated.data.version).toBe(2);
    const stale = await rejection(
      persistence.updateCaseRun(caseRun, { ...caseRun.data, version: caseRun.data.version + 1 }),
    );
    expect((stale as PersistenceError).kind).toBe("conflict");
  });

  test("creates a comparison with both evaluation runs atomically", async () => {
    const { memory, persistence } = setup();
    const comparisonId = fixtureUlid();
    const datasetId = fixtureUlid();
    const baselineReleaseId = fixtureUlid();
    const candidateReleaseId = fixtureUlid();
    const baseline = {
      ...datasetRunData(fixtureUlid(), datasetId, baselineReleaseId),
      comparison: { releaseComparisonId: comparisonId, role: "baseline" as const },
    };
    const candidate = {
      ...datasetRunData(fixtureUlid(), datasetId, candidateReleaseId),
      comparison: { releaseComparisonId: comparisonId, role: "candidate" as const },
    };
    const created = await persistence.createReleaseComparison(
      {
        baseline,
        candidate,
        comparison: {
          ...scope,
          baseline: { agentReleaseId: baselineReleaseId, evaluationRunId: baseline.id },
          candidate: { agentReleaseId: candidateReleaseId, evaluationRunId: candidate.id },
          createdAt: NOW,
          createdByPrincipalId: "principal-1",
          datasetId,
          gateMode: "advisory",
          gatePolicy: {
            maxEvaluatorErrorRate: 0.1,
            maxMeanDecrease: 0.05,
            maxMissingEvidenceRate: 0.1,
            maxNewFailures: 0,
            maxPassRateDecrease: 0.05,
            minComparableCases: 1,
          },
          id: comparisonId,
          idempotencyKey: "comparison-1",
          reasons: [],
          scoreDefinitions: baseline.scoreDefinitions,
          status: "queued",
          updatedAt: NOW,
          version: 1,
        },
      },
      {
        baseline: event("evaluation-run.created"),
        candidate: event("evaluation-run.created"),
        comparison: event("release-comparison.created"),
      },
    );
    expect(created.comparison.data.status).toBe("queued");
    expect(memory.transactions).toHaveLength(1);
    expect(await persistence.getEvaluationRun(baseline.id)).toBeDefined();
    expect(await persistence.getEvaluationRun(candidate.id)).toBeDefined();

    // Each comparison run starts its own event chain, so the worker can advance it.
    const started = await persistence.updateEvaluationRun(
      created.baseline,
      {
        ...created.baseline.data,
        startedAt: LATER,
        status: "running",
        updatedAt: LATER,
        version: 2,
      },
      event("evaluation-run.started"),
    );
    expect(started.data.version).toBe(2);

    const incomplete = await rejection(
      persistence.updateReleaseComparison(
        created.comparison,
        { ...created.comparison.data, status: "completed", verdict: "pass", version: 2 },
        event("release-comparison.completed"),
      ),
    );
    expect((incomplete as PersistenceError).kind).toBe("invalid-input");
  });
});
