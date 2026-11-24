import { describe, expect, test } from "bun:test";
import { Effect, Exit, Schema } from "effect";
import { makeDynamoDatabase } from "./dynamo-database.ts";
import { Ulid } from "./ids.ts";
import {
  readMemorySearchIndexDropReceipt,
  recordMemorySearchIndexDrop,
} from "./memory-search-index-drop-receipts.ts";
import { decodePlatformRecord, withCanonicalRecordKeys } from "./records/index.ts";
import { fakeDynamoDocumentClient } from "./testing/dynamo-document-client.fixture.ts";

const organizationId = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G6006");
const operatorHold = {
  id: "operator/eval-closeout",
  placedAt: "2026-10-20T09:00:00.000Z",
  reason: "manual" as const,
};

function store() {
  const dynamo = fakeDynamoDocumentClient();
  dynamo.put(
    "control",
    withCanonicalRecordKeys({
      data: {
        createdAt: "2026-10-01T00:00:00.000Z",
        id: organizationId,
        name: "Acme",
        slug: "acme",
        status: "active",
        updatedAt: "2026-10-01T00:00:00.000Z",
        version: 1,
      },
      itemType: "organization" as const,
    }),
  );
  return { database: makeDynamoDatabase(dynamo.client), dynamo };
}

describe("memory search index drop receipts", () => {
  test("keeps one create-only receipt in the organization partition", async () => {
    const { database, dynamo } = store();

    const recorded = await recordMemorySearchIndexDrop(database, {
      droppedAt: "2026-10-23T12:00:00.000Z",
      indexes: ["memory-01arz3ndektsv4rrffq69g6006-v1"],
      operatorHold,
      organizationId,
    });

    expect(
      dynamo.get("control", {
        pk: `ORG#${organizationId}`,
        sk: "MEMORY-SEARCH-INDEX-DROP-RECEIPT",
      }),
    ).toEqual({
      data: {
        createdAt: "2026-10-23T12:00:00.000Z",
        droppedAt: "2026-10-23T12:00:00.000Z",
        indexes: ["memory-01arz3ndektsv4rrffq69g6006-v1"],
        operatorHold,
        organizationId,
        updatedAt: "2026-10-23T12:00:00.000Z",
        version: 0,
      },
      gsi1pk: `ORG#${organizationId}`,
      gsi1sk: "MEMORY-SEARCH-INDEX-DROP-RECEIPT#all#2026-10-23T12%3A00%3A00.000Z",
      itemType: "memory-search-index-drop-receipt",
      pk: `ORG#${organizationId}`,
      sk: "MEMORY-SEARCH-INDEX-DROP-RECEIPT",
    });
    expect(await readMemorySearchIndexDropReceipt(database, organizationId)).toEqual(recorded);
  });

  test("a second drop returns the stored receipt and writes nothing", async () => {
    const { database, dynamo } = store();
    const first = await recordMemorySearchIndexDrop(database, {
      droppedAt: "2026-10-23T12:00:00.000Z",
      indexes: ["memory-01arz3ndektsv4rrffq69g6006-v1"],
      operatorHold,
      organizationId,
    });
    const transactions = dynamo.transactions.length;

    const second = await recordMemorySearchIndexDrop(database, {
      droppedAt: "2026-10-23T13:00:00.000Z",
      indexes: ["memory-01arz3ndektsv4rrffq69g6006-v2"],
      operatorHold,
      organizationId,
    });

    expect([second.data.droppedAt, second.data.indexes, second.data.version]).toEqual([
      "2026-10-23T12:00:00.000Z",
      ["memory-01arz3ndektsv4rrffq69g6006-v1"],
      0,
    ]);
    expect(second).toEqual(first);
    expect(
      dynamo.transactions.slice(transactions).map((transaction) => transaction.outcome),
    ).toEqual(["failed"]);
  });

  test("a receipt names at least one index", async () => {
    const receipt = (indexes: readonly string[]) =>
      Effect.runPromiseExit(
        decodePlatformRecord(
          withCanonicalRecordKeys({
            data: {
              createdAt: "2026-10-23T12:00:00.000Z",
              droppedAt: "2026-10-23T12:00:00.000Z",
              indexes,
              operatorHold,
              organizationId,
              updatedAt: "2026-10-23T12:00:00.000Z",
              version: 0,
            },
            itemType: "memory-search-index-drop-receipt" as const,
          }),
        ),
      );

    expect([
      Exit.isSuccess(await receipt([])),
      Exit.isSuccess(await receipt(["memory-01arz3ndektsv4rrffq69g6006-v1"])),
    ]).toEqual([false, true]);
  });
});
