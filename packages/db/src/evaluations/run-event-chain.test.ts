import { describe, expect, test } from "bun:test";
import { makeDynamoDatabase } from "../dynamo-database.ts";
import { PersistenceError } from "../persistence-types.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { fakeDynamoDocumentClient } from "../testing/dynamo-document-client.fixture.ts";
import {
  LATER,
  NOW,
  datasetRunData,
  event,
  fixtureUlid,
  scope,
} from "./evaluation-records.fixture.ts";
import { makeEvaluationPersistence } from "./index.ts";

const COMPLETED_COUNTS = { failed: 0, pending: 0, running: 0, scored: 2, timedOut: 0 };
const DISPATCHED_COUNTS = { failed: 0, pending: 0, running: 2, scored: 0, timedOut: 0 };

/** A running dataset replay over the real DynamoDB persistence path, events at versions 1–2. */
async function runningRun() {
  const dynamo = fakeDynamoDocumentClient();
  dynamo.put(
    "control",
    withCanonicalRecordKeys({
      data: {
        createdAt: NOW,
        id: scope.organizationId,
        name: "Evaluations",
        slug: "evaluations",
        status: "active",
        updatedAt: NOW,
        version: 1,
      },
      itemType: "organization",
    }),
  );
  const database = makeDynamoDatabase(dynamo.client);
  const persistence = makeEvaluationPersistence(database, scope);
  const created = await persistence.createEvaluationRun(
    datasetRunData(fixtureUlid(), fixtureUlid(), fixtureUlid()),
    event("evaluation-run.created"),
  );
  const running = await persistence.updateEvaluationRun(
    created,
    {
      ...created.data,
      caseCount: 2,
      counts: { failed: 0, pending: 2, running: 0, scored: 0, timedOut: 0 },
      startedAt: NOW,
      status: "running",
      updatedAt: NOW,
      version: 2,
    },
    event("evaluation-run.started"),
  );
  return { database, dynamo, persistence, running };
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (cause) {
    return cause as PersistenceError;
  }
  throw new Error("Expected the update to fail.");
}

describe("evaluation run event chain", () => {
  test("advances a run whose stored version has no event", async () => {
    const { database, dynamo, persistence, running } = await runningRun();
    // A counts-only update committed without its semantic event, as the worker did before every
    // run version carried one: the event chain stops at version 2 while the run is at version 3.
    await database.transactWrite([
      {
        kind: "put",
        previousRecord: running,
        record: withCanonicalRecordKeys({
          data: { ...running.data, counts: DISPATCHED_COUNTS, updatedAt: LATER, version: 3 },
          itemType: "evaluation-run",
        }),
      },
    ]);
    const stored = (await persistence.getEvaluationRun(running.data.id))!;

    const completed = await persistence.updateEvaluationRun(
      stored,
      {
        ...stored.data,
        completedAt: LATER,
        counts: COMPLETED_COUNTS,
        status: "completed",
        updatedAt: LATER,
        version: 4,
      },
      event("evaluation-run.completed"),
    );

    expect({ status: completed.data.status, version: completed.data.version }).toEqual({
      status: "completed",
      version: 4,
    });
    expect((await persistence.getEvaluationRun(running.data.id))?.data.version).toBe(4);
    expect(dynamo.items("events").map((item) => item.sk)).toEqual([
      "SEMANTIC-EVENT#0000000000000001",
      "SEMANTIC-EVENT#0000000000000002",
      "SEMANTIC-EVENT#0000000000000004",
    ]);
  });

  test("keeps a lost race on an intact event chain a retryable conflict", async () => {
    const { dynamo, persistence, running } = await runningRun();
    const winner = await persistence.updateEvaluationRun(
      running,
      {
        ...running.data,
        completedAt: LATER,
        counts: COMPLETED_COUNTS,
        status: "completed",
        updatedAt: LATER,
        version: 3,
      },
      event("evaluation-run.completed"),
    );

    const failure = await rejection(
      persistence.updateEvaluationRun(
        running,
        { ...running.data, counts: DISPATCHED_COUNTS, updatedAt: LATER, version: 3 },
        event("evaluation-run.progressed"),
      ),
    );

    expect({ code: failure.code, kind: failure.kind }).toEqual({
      code: "evaluation_write_conflict",
      kind: "conflict",
    });
    expect((await persistence.getEvaluationRun(running.data.id))?.data).toEqual(winner.data);
    expect(dynamo.items("events").map((item) => item.sk)).toEqual([
      "SEMANTIC-EVENT#0000000000000001",
      "SEMANTIC-EVENT#0000000000000002",
      "SEMANTIC-EVENT#0000000000000003",
    ]);
  });
});
