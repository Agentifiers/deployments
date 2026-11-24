import { describe, expect, test } from "bun:test";
import type { Ulid } from "@deployments-ai/db";
import {
  comparisonReportObjectKey,
  DEFAULT_COMPARISON_GATE_POLICY,
} from "@deployments-ai/observability/evaluators";
import type { SubmitEvaluationTurnInput } from "./evaluation-ports.ts";
import { processEvaluationMessage } from "./evaluation-processor.ts";
import {
  drainQueue,
  evaluationHarness,
  nextUlid,
  RELEASE_ID,
} from "./evaluation-worker.fixture.ts";

const CANDIDATE_RELEASE_ID = "01J00000000000000000000RE2" as Ulid;

async function comparison(
  candidateOutput: string | undefined,
  options: { readonly archiveDataset?: boolean } = {},
) {
  const harness = evaluationHarness();
  const definition = await harness.seedDefinition({ kind: "contains", values: ["refund"] });
  const dataset = await harness.seedDataset([
    { content: "Refund one?" },
    { content: "Refund two?" },
  ]);
  const comparisonId = nextUlid();
  const arm = (role: "baseline" | "candidate", agentReleaseId: Ulid) =>
    harness.runData([definition], {
      comparison: { releaseComparisonId: comparisonId, role },
      datasetId: dataset.datasetId,
      target: { agentReleaseId, type: "release" },
    });
  const baseline = arm("baseline", RELEASE_ID);
  const candidate = arm("candidate", CANDIDATE_RELEASE_ID);
  const now = new Date(harness.clock.now).toISOString();
  await harness.persistence.createReleaseComparison(
    {
      baseline,
      candidate,
      comparison: {
        ...harness.context.scope,
        baseline: { agentReleaseId: RELEASE_ID, evaluationRunId: baseline.id },
        candidate: { agentReleaseId: CANDIDATE_RELEASE_ID, evaluationRunId: candidate.id },
        createdAt: now,
        createdByPrincipalId: "principal-1",
        datasetId: dataset.datasetId,
        gateMode: "advisory",
        gatePolicy: DEFAULT_COMPARISON_GATE_POLICY,
        id: comparisonId,
        idempotencyKey: "compare-1",
        reasons: [],
        scoreDefinitions: baseline.scoreDefinitions,
        status: "queued",
        updatedAt: now,
        version: 1,
      },
    },
    {
      baseline: {
        eventId: nextUlid(),
        eventType: "evaluation-run.created",
        occurredAt: now,
        payload: {},
      },
      candidate: {
        eventId: nextUlid(),
        eventType: "evaluation-run.created",
        occurredAt: now,
        payload: {},
      },
      comparison: {
        eventId: nextUlid(),
        eventType: "release-comparison.created",
        occurredAt: now,
        payload: {},
      },
    },
  );
  if (options.archiveDataset) {
    await harness.persistence.archiveRegressionDataset(
      { archivedAt: now, datasetId: dataset.datasetId },
      {
        eventId: nextUlid(),
        eventType: "regression-dataset.archived",
        occurredAt: now,
        payload: {},
      },
    );
  }
  const submitTurn = harness.dependencies.execution.submitTurn;
  const dependencies = {
    ...harness.dependencies,
    execution: {
      ...harness.dependencies.execution,
      submitTurn: async (input: SubmitEvaluationTurnInput) => {
        const isCandidate = input.executionBindingId.includes(candidate.id);
        harness.setNextRun(
          isCandidate
            ? candidateOutput === undefined
              ? { status: "failed" }
              : { outputText: candidateOutput, status: "completed" }
            : { outputText: "Refund issued.", status: "completed" },
        );
        return submitTurn(input);
      },
    },
  };
  for (const run of [baseline, candidate]) {
    harness.sent.push({
      ...harness.context.scope,
      evaluationRunId: run.id,
      type: "evaluation-run.start",
    });
  }
  await drainQueue(harness, (message) => processEvaluationMessage(dependencies, message), 400);
  const stored = await harness.persistence.getReleaseComparison(comparisonId);
  return { comparisonId, harness, stored: stored! };
}

describe("release comparison reconcile", () => {
  test("completes with a fail verdict, summary, and stored report artifacts when the candidate regresses", async () => {
    const { comparisonId, harness, stored } = await comparison("I cannot help.");

    expect(stored.data.status).toBe("completed");
    expect(stored.data.verdict).toBe("fail");
    expect(stored.data.reasons.length).toBeGreaterThan(0);
    expect(stored.data.summary).toMatchObject({
      comparableCases: 2,
      regressions: 2,
      totalCases: 2,
    });
    expect(stored.data.summary?.definitions[0]).toMatchObject({
      baselineMean: 1,
      candidateMean: 0,
      meanDelta: -1,
    });
    const organizationId = harness.context.scope.organizationId;
    expect(harness.reports.map((report) => [report.key, report.contentType])).toEqual([
      [comparisonReportObjectKey(organizationId, comparisonId, "md"), "text/markdown"],
      [comparisonReportObjectKey(organizationId, comparisonId, "json"), "application/json"],
    ]);
    expect(stored.data.reportMarkdown?.key).toBe(
      comparisonReportObjectKey(organizationId, comparisonId, "md"),
    );
    expect(stored.data.reportJson?.key).toBe(
      comparisonReportObjectKey(organizationId, comparisonId, "json"),
    );
    expect(JSON.parse(harness.reports[1]!.body)).toMatchObject({ verdict: "fail" });
    expect(harness.reports[0]!.body).toContain(comparisonId);
  });

  test("passes when both releases score the same", async () => {
    const { stored } = await comparison("Refund issued.");
    expect(stored.data).toMatchObject({ reasons: [], status: "completed", verdict: "pass" });
  });

  test("reports a missing-evidence error verdict when candidate cases fail", async () => {
    const { stored } = await comparison(undefined);
    expect(stored.data.status).toBe("completed");
    expect(stored.data.verdict).toBe("error");
    expect(stored.data.summary?.missingEvidence).toEqual({ baseline: 0, candidate: 2 });
  });

  test("fails the comparison when an arm's evaluation run fails", async () => {
    const { harness, stored } = await comparison("Refund issued.", { archiveDataset: true });
    expect(stored.data).toMatchObject({
      error: { code: "evaluation_run_failed" },
      status: "failed",
    });
    expect(stored.data.verdict).toBeUndefined();
    expect(harness.reports).toEqual([]);
  });
});
