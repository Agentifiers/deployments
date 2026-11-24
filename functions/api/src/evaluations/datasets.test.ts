import { describe, expect, test } from "bun:test";
import { parseCaseMaterial } from "@deployments-ai/observability/evaluators";
import {
  BASELINE_RELEASE,
  evaluationHarness,
  type EvaluationHarness,
  FINALIZED_TRACE,
  ROOT_RUN,
  RUN_INPUT,
  SESSION,
} from "./api.fixture.ts";

async function createDataset(harness: EvaluationHarness, name = "support-regressions") {
  const created = await harness.call("POST", "/v1/regression-datasets", { body: { name } });
  expect(created.status).toBe(201);
  return created.body.id as string;
}

function storedMaterial(harness: EvaluationHarness, datasetCase: Record<string, any>) {
  const [key, bytes] = [...harness.artifacts.objects].find(([objectKey]) =>
    objectKey.endsWith(`${datasetCase.contentSha256}.json`),
  )!;
  expect(key).toContain(`/evaluation-cases/${datasetCase.datasetId}/`);
  return parseCaseMaterial(bytes, datasetCase.contentSha256);
}

describe("regression dataset cases", () => {
  test("adds inline cases content-addressed so repeated content is not duplicated", async () => {
    const harness = evaluationHarness();
    const datasetId = await createDataset(harness);
    const body = {
      expectations: { mustInclude: ["refund"] },
      input: { content: "Can I get a refund?" },
      tags: ["billing"],
    };
    const first = await harness.call("POST", `/v1/regression-datasets/${datasetId}/cases`, {
      body,
      idempotencyKey: "case-1",
    });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      case: { expectationKinds: ["mustInclude"], provenance: "manual", tags: ["billing"] },
      created: true,
    });
    expect(storedMaterial(harness, first.body.case)).toEqual({
      expectations: { mustInclude: ["refund"] },
      input: { content: "Can I get a refund?" },
      schemaVersion: 1,
    });

    const repeat = await harness.call("POST", `/v1/regression-datasets/${datasetId}/cases`, {
      body,
      idempotencyKey: "case-2",
    });
    expect(repeat.body.created).toBe(false);
    expect(repeat.body.case.id).toBe(first.body.case.id);
    expect((await harness.call("GET", `/v1/regression-datasets/${datasetId}`)).body.caseCount).toBe(
      1,
    );
  });

  test("captures the user input of an existing run and of a trace root run", async () => {
    const harness = evaluationHarness();
    const datasetId = await createDataset(harness);
    const fromRun = await harness.call("POST", `/v1/regression-datasets/${datasetId}/cases`, {
      body: { source: { runId: ROOT_RUN, threadId: SESSION, type: "run" } },
    });
    expect(fromRun.status).toBe(201);
    expect(fromRun.body.case).toMatchObject({
      provenance: "trace",
      sourceRunId: ROOT_RUN,
      sourceThreadId: SESSION,
      sourceTraceId: FINALIZED_TRACE,
    });
    expect(storedMaterial(harness, fromRun.body.case).input.content).toBe(RUN_INPUT);

    const fromTrace = await harness.call("POST", `/v1/regression-datasets/${datasetId}/cases`, {
      body: { source: { traceId: FINALIZED_TRACE, type: "trace" } },
    });
    expect(fromTrace.body).toMatchObject({ case: { id: fromRun.body.case.id }, created: false });
  });

  test("imports case files, mapping known expectations and keeping the rest as constraints", async () => {
    const harness = evaluationHarness();
    const datasetId = await createDataset(harness);
    const caseFile = {
      expected: {
        mustInclude: ["refund"],
        mustNot: ["sorry"],
        mustUseTools: ["lookup_order"],
        tone: "friendly",
      },
      message: "Where is my refund?",
      priority: "high",
    };
    const imported = await harness.call(
      "POST",
      `/v1/regression-datasets/${datasetId}/cases/import`,
      {
        body: {
          cases: [
            { ...caseFile, id: "case-a" },
            { ...caseFile, id: "case-a-duplicate" },
            { id: "case-b", message: "Cancel my plan." },
          ],
        },
      },
    );
    expect(imported.status).toBe(200);
    expect(imported.body).toMatchObject({ created: 2, existing: 1 });
    expect(
      imported.body.items.map((item: Record<string, any>) => [item.externalId, item.created]),
    ).toEqual([
      ["case-a", true],
      ["case-a-duplicate", false],
      ["case-b", true],
    ]);
    expect(imported.body.items[1].case.id).toBe(imported.body.items[0].case.id);
    const first = imported.body.items[0].case;
    expect(first).toMatchObject({ externalId: "case-a", provenance: "import" });
    expect(first.expectationKinds).toEqual([
      "constraints",
      "mustInclude",
      "mustNot",
      "mustUseTools",
    ]);
    expect(storedMaterial(harness, first).expectations).toEqual({
      constraints: { priority: "high", tone: "friendly" },
      mustInclude: ["refund"],
      mustNot: ["sorry"],
      mustUseTools: ["lookup_order"],
    });
    const listed = await harness.call("GET", `/v1/regression-datasets/${datasetId}/cases`);
    expect(listed.body.items).toHaveLength(2);
  });

  test("rejects whitespace-only case input inline and in case files", async () => {
    const harness = evaluationHarness();
    const datasetId = await createDataset(harness);

    const added = await harness.call("POST", `/v1/regression-datasets/${datasetId}/cases`, {
      body: { input: { content: " \n\t " } },
    });
    const imported = await harness.call(
      "POST",
      `/v1/regression-datasets/${datasetId}/cases/import`,
      {
        body: { cases: [{ message: "Where is my order?" }, { message: "   " }] },
      },
    );

    for (const response of [added, imported]) {
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).toContain("Case input content must not be blank.");
    }
    expect((await harness.call("GET", `/v1/regression-datasets/${datasetId}`)).body.caseCount).toBe(
      0,
    );
  });

  test("an archived dataset accepts no cases and cannot start runs", async () => {
    const harness = evaluationHarness();
    const datasetId = await createDataset(harness);
    await harness.call("POST", `/v1/regression-datasets/${datasetId}/cases`, {
      body: { input: { content: "Can I get a refund?" } },
    });
    const definition = await harness.call("POST", "/v1/score-definitions", {
      body: { evaluator: { kind: "contains", values: ["refund"] }, name: "mentions-refund" },
    });
    const archived = await harness.call("POST", `/v1/regression-datasets/${datasetId}/archive`);
    expect(archived.body.status).toBe("archived");

    const added = await harness.call("POST", `/v1/regression-datasets/${datasetId}/cases`, {
      body: { input: { content: "Another question" } },
    });
    expect(added.status).toBe(409);
    expect(added.body.code).toBe("regression_dataset_archived");

    const run = await harness.call("POST", "/v1/evaluation-runs", {
      body: {
        datasetId,
        kind: "dataset-replay",
        scoreDefinitionIds: [definition.body.id],
        target: { agentReleaseId: BASELINE_RELEASE, type: "release" },
      },
    });
    expect(run.status).toBe(409);
    expect(run.body.code).toBe("regression_dataset_archived");
    expect(harness.sent).toHaveLength(0);
  });
});
