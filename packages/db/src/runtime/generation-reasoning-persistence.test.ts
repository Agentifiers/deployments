import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { DEFAULT_TABLE_NAMES, type DynamoDatabaseService } from "../client-types.ts";
import { makeDynamoDatabase } from "../dynamo-database.ts";
import { Ulid } from "../ids.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { fakeDynamoDocumentClient } from "../testing/dynamo-document-client.fixture.ts";
import {
  generationReasoningCreateOperation,
  listRunGenerationReasoning,
  type GenerationReasoningRunScope,
} from "./generation-reasoning-persistence.ts";

const id = (suffix: string) =>
  Schema.decodeUnknownSync(Ulid)(`01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}`);

const RUN: GenerationReasoningRunScope = {
  environmentId: id("1"),
  organizationId: id("2"),
  projectId: id("3"),
  runId: id("4"),
  threadId: id("5"),
};
const OTHER_RUN: GenerationReasoningRunScope = { ...RUN, runId: id("6") };

function create(scope: GenerationReasoningRunScope, modelCallIndex: number) {
  return generationReasoningCreateOperation({
    createdAt: "2026-10-12T08:00:00.000Z",
    modelCallIndex,
    producerAttemptId: `run:execution:1:assistant:${modelCallIndex}:run-attempt:0:fallback:0`,
    producerModelId: "openrouter/anthropic/claude-opus-5.5",
    reasoningDetails: [{ signature: `sig-${modelCallIndex}`, type: "reasoning.text" }],
    scope,
  });
}

function databaseWithOrganization() {
  const dynamo = fakeDynamoDocumentClient();
  dynamo.put(
    DEFAULT_TABLE_NAMES.control,
    withCanonicalRecordKeys({
      data: {
        createdAt: "2026-10-12T00:00:00.000Z",
        id: RUN.organizationId,
        name: "Reasoning Organization",
        slug: "reasoning-organization",
        status: "active",
        updatedAt: "2026-10-12T00:00:00.000Z",
        version: 1,
      },
      itemType: "organization",
    }),
  );
  return makeDynamoDatabase(dynamo.client);
}

function pagedByOne(db: DynamoDatabaseService): DynamoDatabaseService {
  return {
    ...db,
    queryRecords: (table, input, signal) => db.queryRecords(table, { ...input, Limit: 1 }, signal),
  };
}

describe("generation reasoning persistence", () => {
  test("builds a create-only put of the canonical record", () => {
    const operation: unknown = create(RUN, 2);

    expect(operation).toEqual({
      conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      kind: "put",
      record: {
        data: {
          createdAt: "2026-10-12T08:00:00.000Z",
          environmentId: "01ARZ3NDEKTSV4RRFFQ69G0001",
          modelCallIndex: 2,
          organizationId: "01ARZ3NDEKTSV4RRFFQ69G0002",
          producerAttemptId: "run:execution:1:assistant:2:run-attempt:0:fallback:0",
          producerModelId: "openrouter/anthropic/claude-opus-5.5",
          projectId: "01ARZ3NDEKTSV4RRFFQ69G0003",
          reasoningDetails: [{ signature: "sig-2", type: "reasoning.text" }],
          runId: "01ARZ3NDEKTSV4RRFFQ69G0004",
          threadId: "01ARZ3NDEKTSV4RRFFQ69G0005",
        },
        itemType: "generation-reasoning",
        pk: "ORG#01ARZ3NDEKTSV4RRFFQ69G0002#RUN#01ARZ3NDEKTSV4RRFFQ69G0004",
        sk: "GENERATION-REASONING#0000000000000002",
      },
    });
  });

  test("never replaces a generation's stored reasoning", async () => {
    const db = databaseWithOrganization();
    await db.transactWrite([create(RUN, 0)]);

    const replacement = generationReasoningCreateOperation({
      createdAt: "2026-10-12T09:00:00.000Z",
      modelCallIndex: 0,
      producerAttemptId: "run:execution:2:assistant:0:run-attempt:0:fallback:0",
      producerModelId: "openrouter/google/gemini-3.6-flash",
      reasoningDetails: [{ data: "ZW5j", type: "reasoning.encrypted" }],
      scope: RUN,
    });

    expect(db.transactWrite([replacement])).rejects.toMatchObject({
      _tag: "DatabaseError",
      reason: "conflict",
    });
    expect(
      (await listRunGenerationReasoning(db, RUN)).map((record) => record.data.producerModelId),
    ).toEqual(["openrouter/anthropic/claude-opus-5.5"]);
  });

  test("lists one run's reasoning in model call order across pages", async () => {
    const db = databaseWithOrganization();
    await db.transactWrite([create(RUN, 10), create(RUN, 2), create(OTHER_RUN, 1), create(RUN, 0)]);

    const records = await listRunGenerationReasoning(pagedByOne(db), RUN);

    expect(records.map((record) => record.data.modelCallIndex)).toEqual([0, 2, 10]);
    expect(records.map((record) => record.data.reasoningDetails[0].signature)).toEqual([
      "sig-0",
      "sig-2",
      "sig-10",
    ]);
  });

  test("rejects reasoning in the run's partition that names another thread", async () => {
    const db = databaseWithOrganization();
    await db.transactWrite([create(RUN, 0), create({ ...RUN, threadId: id("7") }, 1)]);

    expect(listRunGenerationReasoning(db, RUN)).rejects.toThrow(
      "Run 01ARZ3NDEKTSV4RRFFQ69G0004 stores generation reasoning outside its scope.",
    );
  });
});
