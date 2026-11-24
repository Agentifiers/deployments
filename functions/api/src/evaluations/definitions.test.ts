import { CURATED_MODEL_IDS } from "@deployments-ai/model-gateway";
import { describe, expect, test } from "bun:test";
import { evaluationHarness, FINALIZED_TRACE, PRINCIPAL, ROOT_RUN, SESSION } from "./api.fixture.ts";

const CURATED_JUDGE_MODEL_ID = CURATED_MODEL_IDS[0]!;

describe("score definitions", () => {
  test("creates with defaults, revises to a new revision, and archives", async () => {
    const { call } = evaluationHarness();
    const created = await call("POST", "/v1/score-definitions", {
      body: { evaluator: { kind: "contains", values: ["refund"] }, name: "mentions-refund" },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      currentRevision: 1,
      ownerPrincipalId: PRINCIPAL,
      revision: {
        revision: 1,
        sampling: { rate: 0 },
        status: "active",
        target: "root-run",
        threshold: 1,
      },
      status: "active",
      type: "deterministic",
    });

    const revised = await call("POST", `/v1/score-definitions/${created.body.id}/revisions`, {
      body: {
        evaluator: { kind: "contains", mode: "any", values: ["refund", "credit"] },
        expectedRevision: 1,
        threshold: 0.5,
      },
    });
    expect(revised.status).toBe(201);
    expect(revised.body.currentRevision).toBe(2);
    expect(revised.body.revision).toMatchObject({ revision: 2, threshold: 0.5 });
    expect(revised.body.revision.evaluatorVersionHash).not.toBe(
      created.body.revision.evaluatorVersionHash,
    );

    const stale = await call("POST", `/v1/score-definitions/${created.body.id}/revisions`, {
      body: { evaluator: { kind: "contains", values: ["x"] }, expectedRevision: 1 },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("score_definition_revision_conflict");

    const archived = await call("POST", `/v1/score-definitions/${created.body.id}/archive`);
    expect(archived.status).toBe(200);
    expect(archived.body.status).toBe("archived");
    const afterArchive = await call("POST", `/v1/score-definitions/${created.body.id}/revisions`, {
      body: { evaluator: { kind: "contains", values: ["x"] }, expectedRevision: 2 },
    });
    expect(afterArchive.status).toBe(409);
    expect(afterArchive.body.code).toBe("score_definition_archived");

    const fetched = await call("GET", `/v1/score-definitions/${created.body.id}`);
    expect(fetched.body).toMatchObject({ currentRevision: 2, status: "archived" });
  });

  test("rejects regular expressions without linear-time matching", async () => {
    const { call } = evaluationHarness();
    const response = await call("POST", "/v1/score-definitions", {
      body: { evaluator: { kind: "regex", pattern: "(a)\\1" }, name: "unsafe-regex" },
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe("invalid_evaluator");
  });

  test("caps model-judge automatic sampling at a quarter of traces", async () => {
    const { call } = evaluationHarness();
    const evaluator = {
      kind: "model_judge",
      modelId: CURATED_JUDGE_MODEL_ID,
      prompt: "Grade {{output}} against {{input}}.",
    };
    const tooHigh = await call("POST", "/v1/score-definitions", {
      body: { evaluator, name: "judge-high", sampling: { rate: 0.3 } },
    });
    expect(tooHigh.status).toBe(422);
    expect(tooHigh.body.code).toBe("invalid_sampling_rate");

    const allowed = await call("POST", "/v1/score-definitions", {
      body: { evaluator, name: "judge-ok", sampling: { rate: 0.25 } },
    });
    expect(allowed.status).toBe(201);
    expect(allowed.body.type).toBe("model-judged");
    expect(allowed.body.revision.judgeModelId).toBe(CURATED_JUDGE_MODEL_ID);
    expect(allowed.body.revision.judgePromptHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("admits judge models against the environment model policy on create and revise", async () => {
    const { call } = evaluationHarness();
    const prompt = "Grade {{output}} against {{input}}.";
    const denied = await call("POST", "/v1/score-definitions", {
      body: {
        evaluator: { kind: "model_judge", modelId: "openrouter/vendor/frontier-model", prompt },
        name: "judge-uncurated",
      },
    });
    expect(denied.status).toBe(422);
    expect(denied.body.code).toBe("model_not_allowed_by_environment_policy");

    const created = await call("POST", "/v1/score-definitions", {
      body: {
        evaluator: { kind: "model_judge", modelId: CURATED_JUDGE_MODEL_ID, prompt },
        name: "judge-curated",
      },
    });
    expect(created.status).toBe(201);
    const revised = await call("POST", `/v1/score-definitions/${created.body.id}/revisions`, {
      body: {
        evaluator: { kind: "model_judge", modelId: "openrouter/vendor/frontier-model", prompt },
        expectedRevision: 1,
      },
    });
    expect(revised.status).toBe(422);
    expect(revised.body.code).toBe("model_not_allowed_by_environment_policy");
  });

  test("never samples human definitions automatically", async () => {
    const { call } = evaluationHarness();
    const response = await call("POST", "/v1/score-definitions", {
      body: { evaluator: { kind: "human" }, name: "reviewer", sampling: { rate: 0.1 } },
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe("invalid_sampling_rate");
  });
});

describe("recorded trace scores", () => {
  test("records human scores as passed only at or above the threshold", async () => {
    const { call } = evaluationHarness();
    const definition = await call("POST", "/v1/score-definitions", {
      body: { evaluator: { kind: "human" }, name: "helpfulness", threshold: 0.7 },
    });
    const passing = await call("POST", `/v1/traces/${FINALIZED_TRACE}/score-results`, {
      body: { scoreDefinitionId: definition.body.id, value: 0.8 },
      idempotencyKey: "score-1",
    });
    expect(passing.status).toBe(201);
    expect(passing.body).toMatchObject({
      executionStatus: "succeeded",
      humanActorPrincipalId: PRINCIPAL,
      passed: true,
      source: "api",
      threshold: 0.7,
      value: 0.8,
    });

    const failing = await call("POST", `/v1/traces/${FINALIZED_TRACE}/score-results`, {
      body: { scoreDefinitionId: definition.body.id, value: 0.5 },
      idempotencyKey: "score-2",
    });
    expect(failing.body).toMatchObject({ passed: false, value: 0.5, version: 2 });

    const listed = await call("GET", `/v1/traces/${FINALIZED_TRACE}/score-results`);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0]).toMatchObject({ passed: false, value: 0.5 });
  });

  test("rejects recording scores for automated definitions", async () => {
    const { call } = evaluationHarness();
    const definition = await call("POST", "/v1/score-definitions", {
      body: { evaluator: { kind: "contains", values: ["refund"] }, name: "automated" },
    });
    const response = await call("POST", `/v1/traces/${FINALIZED_TRACE}/score-results`, {
      body: { scoreDefinitionId: definition.body.id, value: 1 },
    });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("score_definition_not_recordable");
  });

  test("requires the trace to exist in the environment", async () => {
    const { call } = evaluationHarness();
    const definition = await call("POST", "/v1/score-definitions", {
      body: { evaluator: { kind: "human" }, name: "reviewer" },
    });
    const response = await call("POST", `/v1/traces/${"a".repeat(32)}/score-results`, {
      body: { scoreDefinitionId: definition.body.id, value: 1 },
    });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("trace_not_found");
  });

  test("names the cited run's thread on recorded scores and annotations", async () => {
    const { call, persistence } = evaluationHarness();
    const definition = await call("POST", "/v1/score-definitions", {
      body: { evaluator: { kind: "human" }, name: "grounded" },
    });
    const score = await call("POST", `/v1/traces/${FINALIZED_TRACE}/score-results`, {
      body: { runId: ROOT_RUN, scoreDefinitionId: definition.body.id, value: 1 },
      idempotencyKey: "score-run",
    });
    const annotation = await call("POST", `/v1/traces/${FINALIZED_TRACE}/annotations`, {
      body: { body: "Cites the refund policy.", runId: ROOT_RUN },
      idempotencyKey: "annotation-run",
    });

    expect([score.status, annotation.status]).toEqual([201, 201]);
    const scores = await persistence.listTraceScoreResults(FINALIZED_TRACE, {});
    const annotations = await persistence.listAnnotations(FINALIZED_TRACE, {});
    expect(scores.items.map((item) => item.data)).toMatchObject([
      { runId: ROOT_RUN, threadId: SESSION },
    ]);
    expect(annotations.items.map((item) => item.data)).toMatchObject([
      { runId: ROOT_RUN, threadId: SESSION },
    ]);
  });
});
