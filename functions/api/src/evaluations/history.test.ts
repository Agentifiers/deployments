import { describe, expect, test } from "bun:test";
import { Ulid } from "@deployments-ai/db";
import { Schema } from "effect";
import {
  BASELINE_RELEASE,
  CANDIDATE_RELEASE,
  ENV,
  evaluationHarness,
  OTHER_ENV,
  writerIdentity,
  type EvaluationHarness,
} from "./api.fixture.ts";

const bothEnvironments = { ...writerIdentity, environmentIds: [ENV, OTHER_ENV] };

async function seededHarness() {
  const harness = evaluationHarness({ identity: bothEnvironments });
  const definition = await harness.call("POST", "/v1/score-definitions", {
    body: { evaluator: { kind: "contains", values: ["refund"] }, name: "mentions-refund" },
  });
  const dataset = async (name: string) => {
    const created = await harness.call("POST", "/v1/regression-datasets", { body: { name } });
    await harness.call("POST", `/v1/regression-datasets/${created.body.id}/cases`, {
      body: { input: { content: "Can I get a refund?" } },
    });
    return created.body.id as string;
  };
  const primary = await dataset("support-regressions");
  const secondary = await dataset("billing-regressions");
  const replay = async (datasetId: string, agentReleaseId: string, key: string) =>
    (
      await harness.call("POST", "/v1/evaluation-runs", {
        body: {
          datasetId,
          kind: "dataset-replay",
          scoreDefinitionIds: [definition.body.id],
          target: { agentReleaseId, type: "release" },
        },
        idempotencyKey: key,
      })
    ).body.id as string;
  const baselineRun = await replay(primary, BASELINE_RELEASE, "baseline-replay");
  const candidateRun = await replay(secondary, CANDIDATE_RELEASE, "candidate-replay");
  const comparison = await harness.call("POST", "/v1/release-comparisons", {
    body: {
      baselineReleaseId: BASELINE_RELEASE,
      candidateReleaseId: CANDIDATE_RELEASE,
      datasetId: primary,
      scoreDefinitionIds: [definition.body.id],
    },
    idempotencyKey: "compare-1",
  });
  return {
    baselineRun,
    candidateRun,
    comparison: comparison.body,
    harness,
    primary,
    secondary,
  };
}

async function listIds(harness: EvaluationHarness, path: string) {
  const response = await harness.call("GET", path);
  expect(response.status).toBe(200);
  return (response.body.items as { id: string }[]).map((item) => item.id).sort();
}

describe("evaluation run history", () => {
  test("lists the environment's runs and filters by status, dataset, and release", async () => {
    const { baselineRun, candidateRun, comparison, harness, primary, secondary } =
      await seededHarness();
    const baselineComparisonRun: string = comparison.baseline.evaluationRunId;
    const candidateComparisonRun: string = comparison.candidate.evaluationRunId;

    expect(await listIds(harness, "/v1/evaluation-runs")).toEqual(
      [baselineRun, candidateRun, baselineComparisonRun, candidateComparisonRun].toSorted(),
    );
    expect(await listIds(harness, `/v1/evaluation-runs?datasetId=${secondary}`)).toEqual([
      candidateRun,
    ]);
    expect(
      await listIds(harness, `/v1/evaluation-runs?agentReleaseId=${CANDIDATE_RELEASE}`),
    ).toEqual([candidateRun, candidateComparisonRun].toSorted());
    expect(
      await listIds(
        harness,
        `/v1/evaluation-runs?agentReleaseId=${BASELINE_RELEASE}&datasetId=${primary}`,
      ),
    ).toEqual([baselineRun, baselineComparisonRun].toSorted());

    const queued = (await harness.persistence.getEvaluationRun(baselineRun))!;
    await harness.persistence.updateEvaluationRun(
      queued,
      { ...queued.data, status: "running", version: 2 },
      {
        eventId: Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5F99"),
        eventType: "evaluation-run.started",
        occurredAt: queued.data.createdAt,
        payload: {},
      },
    );
    expect(await listIds(harness, "/v1/evaluation-runs?status=running")).toEqual([baselineRun]);
    expect(await listIds(harness, "/v1/evaluation-runs?status=completed")).toEqual([]);

    const other = await harness.call("GET", "/v1/evaluation-runs", { environmentId: OTHER_ENV });
    expect(other.status).toBe(200);
    expect(other.body.items).toEqual([]);
  });

  test("pages runs with an opaque cursor", async () => {
    const { harness } = await seededHarness();
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const response = await harness.call(
        "GET",
        `/v1/evaluation-runs?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(response.body.items).toHaveLength(1);
      seen.push(response.body.items[0].id);
      cursor = response.body.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(4);
  });

  test("validates filters against the route contract", async () => {
    const harness = evaluationHarness();
    const status = await harness.call("GET", "/v1/evaluation-runs?status=archived");
    expect(status.status).toBe(400);
    expect(status.body.code).toBe("invalid_status");
    const release = await harness.call("GET", "/v1/evaluation-runs?agentReleaseId=release-1");
    expect(release.status).toBe(400);
    expect(release.body.code).toBe("invalid_agent_release_id");
    const comparisonStatus = await harness.call("GET", "/v1/release-comparisons?status=canceled");
    expect(comparisonStatus.status).toBe(400);
    expect(comparisonStatus.body.code).toBe("invalid_status");
    expect((await harness.call("GET", "/v1/regression-datasets?status=archived")).status).toBe(200);
  });

  test("requires observability:read like the other evaluation reads", async () => {
    const reader = evaluationHarness({
      identity: { ...writerIdentity, scopes: ["observability:read"] },
    });
    expect((await reader.call("GET", "/v1/evaluation-runs")).status).toBe(200);
    expect((await reader.call("GET", "/v1/release-comparisons")).status).toBe(200);
    const outsider = evaluationHarness({ identity: { ...writerIdentity, scopes: ["runs:read"] } });
    for (const path of ["/v1/evaluation-runs", "/v1/release-comparisons"]) {
      const response = await outsider.call("GET", path);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("insufficient_scope");
    }
    const foreign = await evaluationHarness().call("GET", "/v1/release-comparisons", {
      environmentId: OTHER_ENV,
    });
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe("environment_scope_violation");
  });
});

describe("release comparison history", () => {
  test("lists the environment's comparisons and filters by release and status", async () => {
    const { comparison, harness } = await seededHarness();
    const listed = await harness.call("GET", "/v1/release-comparisons");
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0]).toMatchObject({
      baseline: { agentReleaseId: BASELINE_RELEASE },
      candidate: { agentReleaseId: CANDIDATE_RELEASE },
      id: comparison.id,
      status: "queued",
    });
    expect(listed.body.items[0].report).toBeUndefined();

    expect(
      await listIds(harness, `/v1/release-comparisons?baselineReleaseId=${BASELINE_RELEASE}`),
    ).toEqual([comparison.id]);
    expect(
      await listIds(harness, `/v1/release-comparisons?baselineReleaseId=${CANDIDATE_RELEASE}`),
    ).toEqual([]);
    expect(
      await listIds(
        harness,
        `/v1/release-comparisons?candidateReleaseId=${CANDIDATE_RELEASE}&status=queued`,
      ),
    ).toEqual([comparison.id]);
    expect(await listIds(harness, "/v1/release-comparisons?status=running")).toEqual([]);
    const other = await harness.call("GET", "/v1/release-comparisons", {
      environmentId: OTHER_ENV,
    });
    expect(other.body.items).toEqual([]);
  });
});
