import { PersistenceError } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { sampledForAutomaticScoring } from "@deployments-ai/observability/evaluators";
import { scoreFinalizedTrace } from "./evaluation-auto-scoring.ts";
import { evaluationHarness, type SimulatedRun } from "./evaluation-worker.fixture.ts";

async function automaticScoring(run: SimulatedRun) {
  const harness = evaluationHarness();
  const sampled = await harness.seedDefinition(
    { kind: "contains", values: ["refund"] },
    { samplingRate: 1 },
  );
  await harness.seedDefinition({ kind: "contains", values: ["refund"] }); // sampling rate 0
  // Human definitions are never run automatically, even if a sampling rate were stored.
  await harness.seedDefinition({ kind: "human" }, { samplingRate: 1 });
  const seeded = harness.seedRun({ content: "Refund?", run });
  await scoreFinalizedTrace(harness.context, seeded.traceId);
  const results = (await harness.persistence.listTraceScoreResults(seeded.traceId, {})).items;
  return { results, sampled, seeded };
}

describe("automatic trace scoring", () => {
  test("scores sampled automated definitions on a finalized customer trace", async () => {
    const { results, sampled, seeded } = await automaticScoring({
      outputText: "Refund sent.",
      status: "completed",
    });

    expect(results.map((result) => result.data.scoreDefinitionId)).toEqual([
      sampled.data.scoreDefinitionId,
    ]);
    expect(results[0]?.data).toMatchObject({
      passed: true,
      runId: seeded.runId,
      source: "automatic",
      value: 1,
    });
    expect(results[0]?.data.evaluationRunId).toBeUndefined();
  });

  test("never scores evaluation, preview, or execution-bound runs", async () => {
    for (const run of [
      { executionPurpose: "evaluation" },
      { executionPurpose: "preview" },
      { executionBindingId: "binding-1", executionPurpose: "customer" },
    ]) {
      const { results } = await automaticScoring({
        outputText: "Refund sent.",
        status: "completed",
        ...run,
      });
      expect(results).toEqual([]);
    }
  });

  test("scores explicitly customer-purpose runs", async () => {
    const { results } = await automaticScoring({
      executionPurpose: "customer",
      outputText: "Refund sent.",
      status: "completed",
    });
    expect(results).toHaveLength(1);
  });

  test("skips traces that are not finalized", async () => {
    const { results } = await automaticScoring({ outputText: "Refund sent.", status: "running" });
    expect(results).toEqual([]);
  });

  test("respects the deterministic sampling decision for partial rates", async () => {
    const harness = evaluationHarness();
    const definition = await harness.seedDefinition(
      { kind: "contains", values: ["refund"] },
      { samplingRate: 0.5 },
    );
    const traces = Array.from({ length: 8 }, () =>
      harness.seedRun({
        content: "Refund?",
        run: { outputText: "Refund sent.", status: "completed" },
      }),
    );
    for (const trace of traces) await scoreFinalizedTrace(harness.context, trace.traceId);

    for (const trace of traces) {
      const scored = (await harness.persistence.listTraceScoreResults(trace.traceId, {})).items
        .length;
      expect(scored).toBe(
        sampledForAutomaticScoring(trace.traceId, definition.data.scoreDefinitionId, 0.5) ? 1 : 0,
      );
    }
  });

  test("skips the trace instead of failing when active definitions overflow the read cap", async () => {
    const harness = evaluationHarness();
    await harness.seedDefinition({ kind: "contains", values: ["refund"] }, { samplingRate: 1 });
    const seeded = harness.seedRun({
      content: "Refund?",
      run: { outputText: "Refund sent.", status: "completed" },
    });
    const overflowing = {
      ...harness.context,
      persistence: {
        ...harness.context.persistence,
        listActiveScoreDefinitionRevisions: () =>
          Promise.reject(
            new PersistenceError(
              "unprocessable",
              "evaluation_collection_too_large",
              "The score-definition-revision collection exceeds 200 records.",
            ),
          ),
      },
    };
    expect(scoreFinalizedTrace(overflowing, seeded.traceId)).resolves.toBeUndefined();
    expect((await harness.persistence.listTraceScoreResults(seeded.traceId, {})).items).toEqual([]);
  });
});
