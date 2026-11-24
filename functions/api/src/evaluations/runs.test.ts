import { describe, expect, test } from "bun:test";
import { Ulid } from "@deployments-ai/db";
import { Schema } from "effect";
import {
  BASELINE_RELEASE,
  CANDIDATE_RELEASE,
  evaluationHarness,
  FINALIZED_TRACE,
  NOW,
  OPEN_TRACE,
  type EvaluationHarness,
  type EvaluationHarnessOptions,
} from "./api.fixture.ts";

async function preparedHarness(options: EvaluationHarnessOptions = {}) {
  const harness = evaluationHarness(options);
  const definition = await harness.call("POST", "/v1/score-definitions", {
    body: { evaluator: { kind: "contains", values: ["refund"] }, name: "mentions-refund" },
  });
  const dataset = await harness.call("POST", "/v1/regression-datasets", {
    body: { name: "support-regressions" },
  });
  await harness.call("POST", `/v1/regression-datasets/${dataset.body.id}/cases`, {
    body: { input: { content: "Can I get a refund?" } },
  });
  return {
    datasetId: dataset.body.id as string,
    definitionId: definition.body.id as string,
    harness,
  };
}

function replayBody(datasetId: string, definitionId: string) {
  return {
    datasetId,
    kind: "dataset-replay",
    scoreDefinitionIds: [definitionId],
    target: { agentReleaseId: BASELINE_RELEASE, type: "release" },
  };
}

function startDeduplicationIds(harness: EvaluationHarness) {
  return harness.sent
    .filter((sent) => sent.message.type === "evaluation-run.start")
    .map((sent) => sent.envelope.deduplicationId);
}

describe("evaluation runs", () => {
  test("derives the run from the Idempotency-Key and resends its start message", async () => {
    const { datasetId, definitionId, harness } = await preparedHarness({
      idempotency: { execute: (input) => input.operation() },
    });
    const first = await harness.call("POST", "/v1/evaluation-runs", {
      body: replayBody(datasetId, definitionId),
      idempotencyKey: "nightly-run",
    });
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({
      caseCount: 1,
      caseTimeoutSeconds: 600,
      concurrency: 5,
      kind: "dataset-replay",
      scoreDefinitions: [{ name: "mentions-refund", revision: 1, scoreDefinitionId: definitionId }],
      status: "queued",
      target: { agentReleaseId: BASELINE_RELEASE, type: "release" },
    });

    const retry = await harness.call("POST", "/v1/evaluation-runs", {
      body: replayBody(datasetId, definitionId),
      idempotencyKey: "nightly-run",
    });
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.body.version).toBe(1);
    expect(startDeduplicationIds(harness)).toEqual([
      `start-${first.body.id}`,
      `start-${first.body.id}`,
    ]);

    const other = await harness.call("POST", "/v1/evaluation-runs", {
      body: replayBody(datasetId, definitionId),
      idempotencyKey: "another-run",
    });
    expect(other.body.id).not.toBe(first.body.id);
    expect((await harness.call("GET", `/v1/evaluation-runs/${first.body.id}`)).status).toBe(200);
  });

  test("scores only finalized traces with automated definitions", async () => {
    const { definitionId, harness } = await preparedHarness();
    const open = await harness.call("POST", "/v1/evaluation-runs", {
      body: { kind: "trace-score", scoreDefinitionIds: [definitionId], traceIds: [OPEN_TRACE] },
    });
    expect(open.status).toBe(409);
    expect(open.body.code).toBe("trace_not_finalized");

    const human = await harness.call("POST", "/v1/score-definitions", {
      body: { evaluator: { kind: "human" }, name: "reviewer" },
    });
    const notAutomated = await harness.call("POST", "/v1/evaluation-runs", {
      body: {
        kind: "trace-score",
        scoreDefinitionIds: [human.body.id],
        traceIds: [FINALIZED_TRACE],
      },
    });
    expect(notAutomated.status).toBe(422);
    expect(notAutomated.body.code).toBe("score_definition_not_automated");

    const created = await harness.call("POST", "/v1/evaluation-runs", {
      body: {
        kind: "trace-score",
        scoreDefinitionIds: [definitionId],
        traceIds: [FINALIZED_TRACE, FINALIZED_TRACE],
      },
    });
    expect(created.status).toBe(202);
    expect(created.body).toMatchObject({ caseCount: 1, traceIds: [FINALIZED_TRACE] });
  });

  test("answers 503 for runs without a queue while reads keep working", async () => {
    const { datasetId, definitionId, harness } = await preparedHarness({ queue: false });
    const response = await harness.call("POST", "/v1/evaluation-runs", {
      body: replayBody(datasetId, definitionId),
    });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("evaluations_unavailable");
    expect((await harness.call("GET", "/v1/score-definitions")).status).toBe(200);
  });
});

describe("release comparisons", () => {
  test("creates the comparison with a replay run per release and starts both", async () => {
    const { datasetId, definitionId, harness } = await preparedHarness();
    const response = await harness.call("POST", "/v1/release-comparisons", {
      body: {
        baselineReleaseId: BASELINE_RELEASE,
        candidateReleaseId: CANDIDATE_RELEASE,
        datasetId,
        gatePolicy: { maxNewFailures: 2 },
        scoreDefinitionIds: [definitionId],
      },
      idempotencyKey: "compare-1",
    });
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      baseline: { agentReleaseId: BASELINE_RELEASE, releaseContentHash: "baseline-content-hash" },
      candidate: {
        agentReleaseId: CANDIDATE_RELEASE,
        releaseContentHash: "candidate-content-hash",
      },
      gateMode: "advisory",
      gatePolicy: { maxMeanDecrease: 0.05, maxNewFailures: 2 },
      reasons: [],
      status: "queued",
    });
    const baselineRunId = response.body.baseline.evaluationRunId;
    const candidateRunId = response.body.candidate.evaluationRunId;
    expect(baselineRunId).not.toBe(candidateRunId);

    const baseline = await harness.call("GET", `/v1/evaluation-runs/${baselineRunId}`);
    const candidate = await harness.call("GET", `/v1/evaluation-runs/${candidateRunId}`);
    expect(baseline.body).toMatchObject({
      comparison: { releaseComparisonId: response.body.id, role: "baseline" },
      target: { agentReleaseId: BASELINE_RELEASE, type: "release" },
    });
    expect(candidate.body).toMatchObject({
      comparison: { releaseComparisonId: response.body.id, role: "candidate" },
      target: { agentReleaseId: CANDIDATE_RELEASE, type: "release" },
    });
    expect(startDeduplicationIds(harness)).toEqual([
      `start-${baselineRunId}`,
      `start-${candidateRunId}`,
    ]);
  });

  test("includes report download URLs once the comparison completes", async () => {
    const { datasetId, definitionId, harness } = await preparedHarness();
    const created = await harness.call("POST", "/v1/release-comparisons", {
      body: {
        baselineReleaseId: BASELINE_RELEASE,
        candidateReleaseId: CANDIDATE_RELEASE,
        datasetId,
        scoreDefinitionIds: [definitionId],
      },
    });
    const queued = await harness.call("GET", `/v1/release-comparisons/${created.body.id}`);
    expect(queued.body.report).toBeUndefined();

    const previous = (await harness.persistence.getReleaseComparison(created.body.id))!;
    const report = (format: "json" | "md", contentType: string) => ({
      bucket: "artifacts",
      byteSize: 512,
      contentType,
      key: `organizations/${previous.data.organizationId}/evaluation-reports/${created.body.id}/report.${format}`,
      sha256: format === "json" ? "a".repeat(64) : "b".repeat(64),
      versionId: `${format}-version`,
    });
    await harness.persistence.updateReleaseComparison(
      previous,
      {
        ...previous.data,
        completedAt: NOW,
        reasons: [],
        reportJson: report("json", "application/json"),
        reportMarkdown: report("md", "text/markdown"),
        status: "completed",
        summary: {
          comparableCases: 1,
          costUsdMicros: { baselineTotal: 10, candidateTotal: 12, delta: 2 },
          definitions: [],
          evaluatorErrors: { baseline: 0, candidate: 0 },
          latency: {},
          missingEvidence: { baseline: 0, candidate: 0 },
          regressions: 0,
          tokens: { baselineTotal: 100, candidateTotal: 90, delta: -10 },
          totalCases: 1,
        },
        updatedAt: NOW,
        verdict: "pass",
        version: previous.data.version + 1,
      },
      {
        eventId: Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5F99"),
        eventType: "release-comparison.completed",
        occurredAt: NOW,
        payload: {},
      },
    );

    const completed = await harness.call("GET", `/v1/release-comparisons/${created.body.id}`);
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ status: "completed", verdict: "pass" });
    expect(completed.body.report).toEqual({
      json: {
        contentType: "application/json",
        downloadUrl: `https://downloads.example/${report("json", "application/json").key}`,
        downloadUrlExpiresAt: "2026-09-29T12:05:00.000Z",
        sha256: "a".repeat(64),
        sizeBytes: 512,
      },
      markdown: {
        contentType: "text/markdown",
        downloadUrl: `https://downloads.example/${report("md", "text/markdown").key}`,
        downloadUrlExpiresAt: "2026-09-29T12:05:00.000Z",
        sha256: "b".repeat(64),
        sizeBytes: 512,
      },
    });
    expect(
      harness.artifacts.downloads.map((reference) => reference.versionId ?? "").toSorted(),
    ).toEqual(["json-version", "md-version"]);
  });
});
