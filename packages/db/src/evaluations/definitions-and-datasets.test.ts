import { describe, expect, test } from "bun:test";
import { PersistenceError } from "../persistence-types.ts";
import {
  makeEvaluationPersistence,
  MAX_ACTIVE_SCORE_DEFINITIONS,
  type EvaluationPersistence,
} from "./index.ts";
import { evaluationMemoryDatabase } from "./memory-database.fixture.ts";
import {
  LATER,
  NOW,
  OTHER_ENV,
  caseData,
  definitionData,
  event,
  fixtureUlid,
  revisionData,
  scope,
} from "./evaluation-records.fixture.ts";

function setup() {
  const memory = evaluationMemoryDatabase();
  return { memory, persistence: makeEvaluationPersistence(memory.database, scope) };
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (cause) {
    return cause;
  }
  throw new Error("Expected the operation to fail.");
}

describe("score definition persistence", () => {
  test("creates the definition, revision, name claim, and internal event in one transaction", async () => {
    const { memory, persistence } = setup();
    const id = fixtureUlid();
    const created = await persistence.createScoreDefinition(
      { definition: definitionData(id), revision: revisionData(id) },
      event("score-definition.created"),
    );

    expect(created.definition.pk).toBe(`ORG#${scope.organizationId}#ENV#${scope.environmentId}`);
    expect(created.definition.sk).toBe(`SCORE-DEFINITION#${id}`);
    expect(created.revision.pk).toBe(`ORG#${scope.organizationId}#SCORE-DEFINITION#${id}`);
    expect(created.revision.sk).toBe(`SCORE-DEFINITION-REVISION#${"1".padStart(16, "0")}`);
    expect(memory.transactions).toHaveLength(1);
    const itemTypes = memory.transactions[0]!.map((operation) =>
      operation.kind === "condition-check" ? "condition" : operation.record.itemType,
    );
    expect(itemTypes).toEqual([
      "score-definition",
      "unique-claim",
      "score-definition-revision",
      "semantic-event",
    ]);
    const semantic = memory.all().find((record) => record.itemType === "semantic-event");
    expect(semantic?.data).toMatchObject({
      aggregateType: "score_definition",
      aggregateVersion: 1,
      payload: { deploymentsAiInternal: true },
    });
  });

  test("rejects a second active definition with the same name in the environment", async () => {
    const { persistence } = setup();
    const first = fixtureUlid();
    await persistence.createScoreDefinition(
      { definition: definitionData(first), revision: revisionData(first) },
      event("score-definition.created"),
    );
    const second = fixtureUlid();
    const failure = await rejection(
      persistence.createScoreDefinition(
        { definition: definitionData(second), revision: revisionData(second) },
        event("score-definition.created"),
      ),
    );
    expect(failure).toBeInstanceOf(PersistenceError);
    expect((failure as PersistenceError).kind).toBe("conflict");
  });

  test("allows the same name in another environment", async () => {
    const { memory, persistence } = setup();
    const id = fixtureUlid();
    await persistence.createScoreDefinition(
      { definition: definitionData(id), revision: revisionData(id) },
      event("score-definition.created"),
    );
    const otherScope = { ...scope, environmentId: OTHER_ENV };
    const other = makeEvaluationPersistence(memory.database, otherScope);
    const otherId = fixtureUlid();
    expect(
      other.createScoreDefinition(
        {
          definition: { ...definitionData(otherId), environmentId: OTHER_ENV },
          revision: { ...revisionData(otherId), environmentId: OTHER_ENV },
        },
        event("score-definition.created"),
      ),
    ).resolves.toBeDefined();
  });

  test("rejects an evaluator whose type differs from the definition type", async () => {
    const { persistence } = setup();
    const id = fixtureUlid();
    const failure = await rejection(
      persistence.createScoreDefinition(
        {
          definition: definitionData(id, { type: "human" }),
          revision: revisionData(id),
        },
        event("score-definition.created"),
      ),
    );
    expect((failure as PersistenceError).code).toBe("score_definition_type_mismatch");
  });

  test("supersedes the previous revision when a new revision is created", async () => {
    const { persistence } = setup();
    const id = fixtureUlid();
    await persistence.createScoreDefinition(
      { definition: definitionData(id), revision: revisionData(id) },
      event("score-definition.created"),
    );
    const revised = await persistence.reviseScoreDefinition(
      {
        expectedRevision: 1,
        revision: revisionData(id, {
          createdAt: LATER,
          evaluator: { kind: "contains", values: ["refund", "credit"] },
          evaluatorVersionHash: "b".repeat(64),
          revision: 2,
          updatedAt: LATER,
        }),
        updatedAt: LATER,
      },
      event("score-definition.revised"),
    );
    expect(revised.definition.data).toMatchObject({ currentRevision: 2, version: 2 });
    const first = await persistence.getScoreDefinitionRevision(id, 1);
    expect(first?.data).toMatchObject({ status: "superseded", supersededAt: LATER, version: 2 });
    expect((await persistence.getScoreDefinitionRevision(id, 2))?.data.status).toBe("active");

    const stale = await rejection(
      persistence.reviseScoreDefinition(
        {
          expectedRevision: 1,
          revision: revisionData(id, { revision: 2 }),
          updatedAt: LATER,
        },
        event("score-definition.revised"),
      ),
    );
    expect((stale as PersistenceError).code).toBe("score_definition_revision_conflict");
  });

  test("archiving releases the name so a new active definition can reuse it", async () => {
    const { persistence } = setup();
    const id = fixtureUlid();
    await persistence.createScoreDefinition(
      { definition: definitionData(id), revision: revisionData(id) },
      event("score-definition.created"),
    );
    const archived = await persistence.archiveScoreDefinition(
      { archivedAt: LATER, scoreDefinitionId: id },
      event("score-definition.archived"),
    );
    expect(archived.definition.data.status).toBe("archived");
    expect(archived.revision.data.status).toBe("archived");
    expect(await persistence.listActiveScoreDefinitionRevisions()).toHaveLength(0);

    const replacement = fixtureUlid();
    expect(
      persistence.createScoreDefinition(
        { definition: definitionData(replacement), revision: revisionData(replacement) },
        event("score-definition.created"),
      ),
    ).resolves.toBeDefined();
    expect(await persistence.listActiveScoreDefinitionRevisions()).toHaveLength(1);
    const revise = await rejection(
      persistence.reviseScoreDefinition(
        { expectedRevision: 1, revision: revisionData(id, { revision: 2 }), updatedAt: LATER },
        event("score-definition.revised"),
      ),
    );
    expect((revise as PersistenceError).code).toBe("score_definition_archived");
  });

  test("refuses a new active definition at the environment cap until one is archived", async () => {
    const { persistence } = setup();
    const create = (id: ReturnType<typeof fixtureUlid>) =>
      persistence.createScoreDefinition(
        {
          definition: definitionData(id, { name: `definition-${id.toLowerCase()}` }),
          revision: revisionData(id),
        },
        event("score-definition.created"),
      );
    const ids = Array.from({ length: MAX_ACTIVE_SCORE_DEFINITIONS }, () => fixtureUlid());
    for (const id of ids) await create(id);

    const overflow = await rejection(create(fixtureUlid()));
    expect(overflow).toBeInstanceOf(PersistenceError);
    expect(overflow).toMatchObject({
      code: "score_definition_limit_reached",
      kind: "unprocessable",
    });
    expect(await persistence.listActiveScoreDefinitionRevisions()).toHaveLength(
      MAX_ACTIVE_SCORE_DEFINITIONS,
    );

    await persistence.archiveScoreDefinition(
      { archivedAt: LATER, scoreDefinitionId: ids[0]! },
      event("score-definition.archived"),
    );
    expect(create(fixtureUlid())).resolves.toBeDefined();
  });
});

describe("regression dataset persistence", () => {
  async function dataset(persistence: EvaluationPersistence) {
    return persistence.createRegressionDataset(
      {
        ...scope,
        caseCount: 0,
        createdAt: NOW,
        createdByPrincipalId: "principal-1",
        id: fixtureUlid(),
        name: "support-regressions",
        ownerPrincipalId: "principal-1",
        status: "active",
        updatedAt: NOW,
        version: 1,
      },
      event("regression-dataset.created"),
    );
  }

  test("adds content-addressed cases once and counts them on the dataset", async () => {
    const { persistence } = setup();
    const created = await dataset(persistence);
    const first = await persistence.addDatasetCases(
      {
        cases: [
          caseData(created.data.id, "1".repeat(64)),
          caseData(created.data.id, "2".repeat(64)),
        ],
        datasetId: created.data.id,
        updatedAt: LATER,
      },
      event("regression-dataset.cases-added"),
    );
    expect(first.created).toHaveLength(2);
    expect(first.dataset.data).toMatchObject({ caseCount: 2, version: 2 });
    expect(first.created[0]!.pk).toBe(`ORG#${scope.organizationId}#DATASET#${created.data.id}`);

    const replay = await persistence.addDatasetCases(
      {
        cases: [
          caseData(created.data.id, "1".repeat(64)),
          caseData(created.data.id, "3".repeat(64)),
        ],
        datasetId: created.data.id,
        updatedAt: LATER,
      },
      event("regression-dataset.cases-added"),
    );
    expect(replay.created.map((record) => record.data.contentSha256)).toEqual(["3".repeat(64)]);
    expect(replay.existing.map((record) => record.data.id)).toEqual([first.created[0]!.data.id]);
    expect(replay.dataset.data.caseCount).toBe(3);
    expect((await persistence.listAllDatasetCases(created.data.id)).length).toBe(3);
  });

  test("rejects cases for an archived dataset with a conflict", async () => {
    const { persistence } = setup();
    const created = await dataset(persistence);
    await persistence.archiveRegressionDataset(
      { archivedAt: LATER, datasetId: created.data.id },
      event("regression-dataset.archived"),
    );
    const failure = await rejection(
      persistence.addDatasetCases(
        {
          cases: [caseData(created.data.id, "4".repeat(64))],
          datasetId: created.data.id,
          updatedAt: LATER,
        },
        event("regression-dataset.cases-added"),
      ),
    );
    expect((failure as PersistenceError).code).toBe("regression_dataset_archived");
  });

  test("rejects case material whose hash does not match the content hash", async () => {
    const { persistence } = setup();
    const created = await dataset(persistence);
    const mismatched = caseData(created.data.id, "5".repeat(64));
    const failure = await rejection(
      persistence.addDatasetCases(
        {
          cases: [{ ...mismatched, material: { ...mismatched.material, sha256: "6".repeat(64) } }],
          datasetId: created.data.id,
          updatedAt: LATER,
        },
        event("regression-dataset.cases-added"),
      ),
    );
    expect((failure as PersistenceError).kind).toBe("invalid-input");
  });

  test("pages cases with scope-bound cursors", async () => {
    const { persistence } = setup();
    const created = await dataset(persistence);
    await persistence.addDatasetCases(
      {
        cases: ["7", "8", "9"].map((digit) => caseData(created.data.id, digit.repeat(64))),
        datasetId: created.data.id,
        updatedAt: LATER,
      },
      event("regression-dataset.cases-added"),
    );
    const firstPage = await persistence.listDatasetCases(created.data.id, { limit: 2 });
    expect(firstPage.items).toHaveLength(2);
    const secondPage = await persistence.listDatasetCases(created.data.id, {
      cursor: firstPage.nextCursor,
      limit: 2,
    });
    expect(secondPage.items).toHaveLength(1);
    const foreign = await rejection(
      persistence.listDatasetCases(fixtureUlid(), { cursor: firstPage.nextCursor, limit: 2 }),
    );
    expect((foreign as PersistenceError).code).toBe("invalid_cursor");
  });
});
