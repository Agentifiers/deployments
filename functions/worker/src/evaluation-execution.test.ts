import { describe, expect, test } from "bun:test";
import { agentManifestContentHash, AgentManifestV1 } from "@deployments-ai/agent-manifest";
import {
  AgentReleaseRecord,
  DatabaseError,
  makeManifestModelAdmission,
  tableForItemType,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { makeEvaluationExecutionPort } from "./evaluation-execution.ts";
import { processEvaluationMessage } from "./evaluation-processor.ts";
import { startEvaluationRun } from "./evaluation-run-lifecycle.ts";
import {
  drainQueue,
  evaluationHarness,
  nextUlid,
  RELEASE_ID,
  scope,
  type EvaluationHarness,
} from "./evaluation-worker.fixture.ts";

const AGENT_RUN_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/agent-runs.fifo";

function seedRelease(harness: EvaluationHarness, modelId: string) {
  const manifest = Schema.decodeUnknownSync(AgentManifestV1)({
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: { key: "evaluation.subject", name: "Evaluation Subject", version: "1.0.0" },
    spec: {
      instructions: "Answer the case.",
      model: { id: modelId },
      sandbox: { mode: "none" },
    },
  });
  const release = Schema.decodeUnknownSync(AgentReleaseRecord)(
    withCanonicalRecordKeys({
      data: {
        ...scope,
        agentDefinitionId: nextUlid(),
        contentHash: agentManifestContentHash(manifest),
        createdAt: "2026-09-29T11:00:00.000Z",
        createdByPrincipalId: nextUlid(),
        id: RELEASE_ID,
        manifest,
        releaseNumber: 1,
        status: "active" as const,
        version: 0,
      },
      itemType: "agent-release" as const,
    }),
  );
  harness.memory.records.set(
    `${tableForItemType(release.itemType)}\u0000${release.pk}\u0000${release.sk}`,
    release,
  );
}

/** A started dataset replay over one case, executed by the real execution-binding port. */
async function startReplay(harness: EvaluationHarness, database: DynamoDatabaseService) {
  seedRelease(harness, "openrouter/qwen/qwen3.7-plus");
  const execution = makeEvaluationExecutionPort({
    admitManifest: makeManifestModelAdmission(database),
    agentRunQueueUrl: AGENT_RUN_QUEUE_URL,
    database,
  });
  const dependencies = { ...harness.dependencies, execution };
  const definition = await harness.seedDefinition({ kind: "contains", values: ["refund"] });
  const dataset = await harness.seedDataset([{ content: "Where is my refund?" }]);
  const run = await harness.createRun([definition], {
    createdByPrincipalId: nextUlid(),
    datasetId: dataset.datasetId,
    target: { agentReleaseId: RELEASE_ID, type: "release" },
  });
  await startEvaluationRun({ ...harness.context, execution }, run.data.id);
  expect((await harness.persistence.getEvaluationRun(run.data.id))?.data.status).toBe("running");
  return { dependencies, run };
}

describe("evaluation execution bindings", () => {
  test("fails the evaluation run with the model admission reason of the release under test", async () => {
    const harness = evaluationHarness();
    seedRelease(harness, "openrouter/vendor/unlisted");
    const definition = await harness.seedDefinition({ kind: "contains", values: ["refund"] });
    const dataset = await harness.seedDataset([{ content: "Where is my refund?" }]);
    const run = await harness.createRun([definition], {
      createdByPrincipalId: nextUlid(),
      datasetId: dataset.datasetId,
      target: { agentReleaseId: RELEASE_ID, type: "release" },
    });
    const context = {
      ...harness.context,
      execution: makeEvaluationExecutionPort({
        admitManifest: makeManifestModelAdmission(harness.memory.database),
        agentRunQueueUrl: AGENT_RUN_QUEUE_URL,
        database: harness.memory.database,
      }),
    };

    await startEvaluationRun(context, run.data.id);

    expect((await harness.persistence.getEvaluationRun(run.data.id))?.data).toMatchObject({
      error: {
        code: "model_not_allowed_by_environment_policy",
        message: expect.stringContaining("/spec/model/id:"),
      },
      status: "failed",
    });
    expect(await harness.persistence.listAllCaseRuns(run.data.id)).toHaveLength(0);
    expect(
      [...harness.memory.records.values()].filter(
        (record) => record.itemType === "execution-binding",
      ),
    ).toHaveLength(0);
  });

  test("fails a case whose turn the conversation service rejects permanently", async () => {
    const harness = evaluationHarness();
    const { dependencies, run } = await startReplay(harness, harness.memory.database);
    for (const [key, record] of harness.memory.records) {
      if (record.itemType !== "execution-binding") continue;
      harness.memory.records.set(key, {
        ...record,
        data: { ...record.data, expiresAt: "2026-01-01T00:00:00.000Z" },
      } as typeof record);
    }

    await drainQueue(harness, (message) => processEvaluationMessage(dependencies, message));

    expect((await harness.persistence.listAllCaseRuns(run.data.id)).map((c) => c.data)).toEqual([
      expect.objectContaining({
        error: {
          code: "execution_binding_expired",
          message: "Execution binding has expired and no longer accepts turns.",
        },
        status: "failed",
      }),
    ]);
    expect((await harness.persistence.getEvaluationRun(run.data.id))?.data.status).not.toBe(
      "running",
    );
  });

  test("redelivers a case whose turn submission fails transiently", async () => {
    const harness = evaluationHarness();
    let conflictTurnWrites = false;
    const database: DynamoDatabaseService = {
      ...harness.memory.database,
      transactWrite: async (operations, clientRequestToken, signal) => {
        if (conflictTurnWrites) {
          throw new DatabaseError({
            cause: undefined,
            message: "Transaction conflict.",
            operation: "transactWrite",
            reason: "conflict",
            table: "control",
          });
        }
        return harness.memory.database.transactWrite(operations, clientRequestToken, signal);
      },
    };
    const { dependencies, run } = await startReplay(harness, database);
    conflictTurnWrites = true;

    expect(
      drainQueue(harness, (message) => processEvaluationMessage(dependencies, message)),
    ).rejects.toMatchObject({ code: "write_failed", name: "ConversationError" });

    expect((await harness.persistence.listAllCaseRuns(run.data.id)).map((c) => c.data)).toEqual([
      expect.objectContaining({ status: "dispatched" }),
    ]);
  });
});
