import { expect, test } from "bun:test";
import {
  createMockPlatformSdk,
  createPlatformSdk,
  EvaluationWaitTimeoutError,
  PlatformRequestError,
} from "./index.ts";

const context = {
  environmentId: "environment-1",
  organizationId: "organization-1",
  projectId: "project-1",
};
const DEFINITION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";

function recordingSdk(respond: (request: Request) => unknown = () => ({ items: [] })) {
  const requests: Request[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    requests.push(request);
    return Response.json(respond(request));
  }) as unknown as typeof fetch;
  const sdk = createPlatformSdk({
    apiKey: "credential",
    baseUrl: "https://api.test",
    fetch: fetchImpl,
  });
  return { evaluations: sdk.evaluations(context), requests };
}

test("evaluation requests carry tenant scope, query filters, and idempotency keys", async () => {
  const { evaluations, requests } = recordingSdk();
  await evaluations.listScoreResults({ limit: 10, scoreDefinitionId: DEFINITION_ID });
  await evaluations.recordTraceScoreResult(
    TRACE_ID,
    { scoreDefinitionId: DEFINITION_ID, value: 0.5 } as never,
    { idempotencyKey: "score-1" },
  );
  await evaluations.archiveRegressionDataset(DEFINITION_ID);
  await evaluations.archiveRegressionDataset(DEFINITION_ID);

  const [list, record, firstArchive, secondArchive] = requests;
  expect(list?.url).toBe(
    `https://api.test/v1/score-results?limit=10&scoreDefinitionId=${DEFINITION_ID}`,
  );
  expect(list?.headers.get("idempotency-key")).toBeNull();
  expect(list?.headers.get("x-deployments-organization")).toBe("organization-1");
  expect(list?.headers.get("x-deployments-project")).toBe("project-1");
  expect(list?.headers.get("x-deployments-environment")).toBe("environment-1");
  expect(record?.method).toBe("POST");
  expect(record?.url).toBe(`https://api.test/v1/traces/${TRACE_ID}/score-results`);
  expect(record?.headers.get("idempotency-key")).toBe("score-1");
  expect(await record?.json()).toEqual({ scoreDefinitionId: DEFINITION_ID, value: 0.5 });
  expect(firstArchive?.url).toBe(
    `https://api.test/v1/regression-datasets/${DEFINITION_ID}/archive`,
  );
  const generated = firstArchive?.headers.get("idempotency-key");
  expect(generated).toMatch(/^[0-9a-f-]{36}$/u);
  expect(secondArchive?.headers.get("idempotency-key")).not.toBe(generated);
  expect(() => evaluations.getEvaluationRun("..")).toThrow("evaluationRunId must not be empty.");
  expect(() =>
    evaluations.archiveScoreDefinition(DEFINITION_ID, { idempotencyKey: " padded " }),
  ).toThrow(PlatformRequestError);
});

test("waitForEvaluationRun polls until a terminal status", async () => {
  const statuses = ["queued", "running", "canceled"];
  const { evaluations, requests } = recordingSdk(() => ({ id: "run", status: statuses.shift() }));
  const response = await evaluations.waitForEvaluationRun("run", { intervalMs: 1 });
  expect(response.data.status).toBe("canceled");
  expect(requests).toHaveLength(3);
  expect(new Set(requests.map((request) => request.url))).toEqual(
    new Set(["https://api.test/v1/evaluation-runs/run"]),
  );
});

test("waitForReleaseComparison fails with a bounded timeout error", async () => {
  const { evaluations, requests } = recordingSdk(() => ({ id: "cmp", status: "running" }));
  const started = Date.now();
  const failure = await evaluations
    .waitForReleaseComparison("cmp", { intervalMs: 5, timeoutMs: 40 })
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(EvaluationWaitTimeoutError);
  expect((failure as EvaluationWaitTimeoutError).lastStatus).toBe("running");
  expect((failure as Error).message).toContain("release comparison cmp");
  expect(evaluations.waitForEvaluationRun("run", { timeoutMs: 0 })).rejects.toThrow("timeoutMs");
  expect(requests.length).toBeGreaterThan(1);
  expect(Date.now() - started).toBeLessThan(1_000);
});

test("mock evaluations replay a dataset and compare releases deterministically", async () => {
  const evaluations = createMockPlatformSdk({
    now: () => new Date("2026-09-01T00:00:00.000Z"),
  }).evaluations(context);
  const definition = await evaluations.createScoreDefinition(
    { evaluator: { kind: "contains", values: ["refund"] }, name: "mentions-refund" },
    { idempotencyKey: "definition-1" },
  );
  expect(definition.data).toMatchObject({ currentRevision: 1, type: "deterministic" });
  const replay = await evaluations.createScoreDefinition(
    { evaluator: { kind: "contains", values: ["refund"] }, name: "mentions-refund" },
    { idempotencyKey: "definition-1" },
  );
  expect(replay.data.id).toBe(definition.data.id);
  expect(
    evaluations.createScoreDefinition(
      { evaluator: { kind: "no_tool" }, name: "other" },
      { idempotencyKey: "definition-1" },
    ),
  ).rejects.toThrow("already used for a different request");

  const dataset = await evaluations.createRegressionDataset({ name: "refunds" });
  const cases = [
    { expected: { mustInclude: ["refund"], tone: "calm" }, id: "a", message: "Refund?" },
    { id: "b", message: "Charge me twice", priority: "high" },
  ];
  const imported = await evaluations.importDatasetCases(dataset.data.id, { cases } as never);
  expect(imported.data).toMatchObject({ created: 2, existing: 0 });
  expect(imported.data.items[0]?.case.expectationKinds).toEqual(["constraints", "mustInclude"]);
  expect(imported.data.items[1]?.case.expectationKinds).toEqual(["constraints"]);
  const reimported = await evaluations.importDatasetCases(dataset.data.id, { cases } as never);
  expect(reimported.data).toMatchObject({ created: 0, existing: 2 });
  expect((await evaluations.getRegressionDataset(dataset.data.id)).data.caseCount).toBe(2);

  const run = await evaluations.createEvaluationRun({
    datasetId: dataset.data.id,
    kind: "dataset-replay",
    scoreDefinitionIds: [definition.data.id],
    target: { agentReleaseId: DEFINITION_ID, type: "release" },
  } as never);
  const finished = await evaluations.waitForEvaluationRun(run.data.id, { intervalMs: 1 });
  expect(finished.data).toMatchObject({ caseCount: 2, status: "completed" });
  const results = await evaluations.listEvaluationRunResults(run.data.id, { limit: 1 });
  expect(results.data.items).toHaveLength(1);
  expect(results.data.nextCursor).toBeString();

  const comparison = await evaluations.createReleaseComparison({
    baselineReleaseId: DEFINITION_ID,
    candidateReleaseId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    datasetId: dataset.data.id,
    gatePolicy: { maxNewFailures: 2 },
    scoreDefinitionIds: [definition.data.id],
  } as never);
  expect(comparison.data).toMatchObject({
    gatePolicy: { maxNewFailures: 2, minComparableCases: 1 },
    status: "completed",
    summary: { comparableCases: 2, regressions: 0 },
    verdict: "pass",
  });
  const baselineRun = await evaluations.getEvaluationRun(comparison.data.baseline.evaluationRunId);
  expect(baselineRun.data.comparison).toEqual({
    releaseComparisonId: comparison.data.id,
    role: "baseline",
  });
  const releaseRuns = await evaluations.listEvaluationRuns({ agentReleaseId: DEFINITION_ID });
  expect(releaseRuns.data.items.map((item) => item.id)).toEqual([
    comparison.data.baseline.evaluationRunId,
    run.data.id,
  ]);
  const comparisons = await evaluations.listReleaseComparisons({
    candidateReleaseId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    status: "completed",
  });
  expect(comparisons.data.items.map((item) => item.id)).toEqual([comparison.data.id]);
  expect(comparisons.data.items[0]?.report).toBeUndefined();
  const noMatches = await evaluations.listReleaseComparisons({
    baselineReleaseId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  });
  expect(noMatches.data.items).toEqual([]);

  await evaluations.archiveRegressionDataset(dataset.data.id);
  expect(
    evaluations.addDatasetCase(dataset.data.id, { input: { content: "late" } } as never),
  ).rejects.toThrow("is archived");
  expect(evaluations.getEvaluationRun(DEFINITION_ID)).rejects.toThrow("was not found");
});
