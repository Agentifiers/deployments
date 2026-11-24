import { describe, expect, spyOn, test } from "bun:test";
import { DatabaseError, PersistenceError, withCanonicalRecordKeys } from "@deployments-ai/db";
import { evaluationQueueEnvelope } from "@deployments-ai/observability/evaluators";
import { startEvaluationRun } from "./evaluation-run-lifecycle.ts";
import {
  evaluationFailureLogFields,
  handleEvaluationQueueEvent,
} from "./evaluation-worker-main.ts";
import { DEPLOYMENT_ID, evaluationHarness, RELEASE_ID } from "./evaluation-worker.fixture.ts";

/** Two started dataset replays, each with two pending cases; the first one's event chain has a gap. */
async function startedRuns() {
  const harness = evaluationHarness();
  const definition = await harness.seedDefinition({ kind: "contains", values: ["refund"] });
  const dataset = await harness.seedDataset([
    { content: "Where is refund 1?" },
    { content: "Where is refund 2?" },
  ]);
  const startedRun = async () => {
    const run = await harness.createRun([definition], {
      datasetId: dataset.datasetId,
      target: { agentDeploymentId: DEPLOYMENT_ID, agentReleaseId: RELEASE_ID, type: "deployment" },
    });
    await startEvaluationRun(harness.context, run.data.id);
    return (await harness.persistence.getEvaluationRun(run.data.id))!;
  };
  const gapped = await startedRun();
  const healthy = await startedRun();
  // A run version committed without its semantic event, as the worker wrote counts-only updates
  // before every run version carried an event.
  await harness.memory.database.transactWrite([
    {
      kind: "put",
      previousRecord: gapped,
      record: withCanonicalRecordKeys({
        data: { ...gapped.data, version: gapped.data.version + 1 },
        itemType: "evaluation-run",
      }),
    },
  ]);
  const reconcile = (evaluationRunId: string) => ({
    body: evaluationQueueEnvelope({
      environmentId: gapped.data.environmentId,
      evaluationRunId,
      organizationId: gapped.data.organizationId,
      projectId: gapped.data.projectId,
      trigger: "start",
      type: "evaluation-run.reconcile",
    }).body,
    messageId: `reconcile-${evaluationRunId}`,
  });
  return { gapped, harness, healthy, reconcile };
}

describe("evaluation queue batches", () => {
  test("reconciles a run whose stored version has no semantic event", async () => {
    const { gapped, harness, healthy, reconcile } = await startedRuns();

    const result = await handleEvaluationQueueEvent(
      { Records: [reconcile(gapped.data.id), reconcile(healthy.data.id)] },
      harness.dependencies,
    );

    expect(result.batchItemFailures).toEqual([]);
    const dispatched = { failed: 0, pending: 0, running: 2, scored: 0, timedOut: 0 };
    expect((await harness.persistence.getEvaluationRun(gapped.data.id))?.data).toMatchObject({
      counts: dispatched,
      version: 4,
    });
    expect((await harness.persistence.getEvaluationRun(healthy.data.id))?.data.counts).toEqual(
      dispatched,
    );
  });

  test("reports a retryable failure and every later message for redelivery", async () => {
    const { gapped, harness, healthy, reconcile } = await startedRuns();
    const unavailable = new DatabaseError({
      cause: new Error("Service unavailable"),
      message: "DynamoDB get failed for table execution.",
      operation: "get",
      reason: "unknown",
      table: "execution",
    });
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = await handleEvaluationQueueEvent(
        { Records: [reconcile(healthy.data.id), reconcile(gapped.data.id)] },
        {
          ...harness.dependencies,
          database: {
            ...harness.memory.database,
            getRecord: async () => {
              throw unavailable;
            },
          },
        },
      );

      expect(result.batchItemFailures).toEqual([
        { itemIdentifier: `reconcile-${healthy.data.id}` },
        { itemIdentifier: `reconcile-${gapped.data.id}` },
      ]);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("evaluation failure log fields", () => {
  test("names the persistence failure kind, code, and message", () => {
    expect(
      evaluationFailureLogFields(
        new PersistenceError(
          "conflict",
          "evaluation_write_conflict",
          "The evaluation evaluation run update conflicted with a concurrent change; retry the request.",
        ),
      ),
    ).toEqual({
      code: "evaluation_write_conflict",
      error: "PersistenceError",
      kind: "conflict",
      message:
        "The evaluation evaluation run update conflicted with a concurrent change; retry the request.",
    });
  });

  test("omits record-decode messages, which echo record content", () => {
    const fields = evaluationFailureLogFields(
      new PersistenceError(
        "invalid-input",
        "invalid_evaluation_record",
        'Expected string, got "customer rationale text"',
      ),
    );
    expect(fields).toEqual({
      code: "invalid_evaluation_record",
      error: "PersistenceError",
      kind: "invalid-input",
    });
  });

  test("names the database operation, table, and AWS error class without its message", () => {
    const denied = new Error("User arn:aws:sts::1:assumed-role/x is not authorized");
    denied.name = "AccessDeniedException";
    expect(
      evaluationFailureLogFields(
        new DatabaseError({
          cause: denied,
          message: "DynamoDB query failed for table execution.",
          operation: "query",
          reason: "unknown",
          table: "execution",
        }),
      ),
    ).toEqual({
      causeName: "AccessDeniedException",
      error: "DatabaseError",
      operation: "query",
      reason: "unknown",
      table: "execution",
    });
  });

  test("logs only the class name of other errors", () => {
    expect(evaluationFailureLogFields(new SyntaxError('Unexpected token "secret"'))).toEqual({
      error: "SyntaxError",
    });
    expect(evaluationFailureLogFields("thrown string")).toEqual({ error: "UnknownError" });
  });
});
