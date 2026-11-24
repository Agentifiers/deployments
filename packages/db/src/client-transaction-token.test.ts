import { describe, expect, test } from "bun:test";
import { brainErasureFromRecord, brainErasureRecord } from "./brains/erasure-repository.ts";
import { makeDynamoDatabase } from "./client.ts";
import { withCanonicalRecordKeys } from "./records/index.ts";
import {
  fakeDynamoDocumentClient,
  transactionCanceledError,
} from "./testing/dynamo-document-client.fixture.ts";

const organizationId = "01ARZ3NDEKTSV4RRFFQ69G6006";
const pending = brainErasureRecord({
  brainId: "01M3TKGBADCYBG97VHNKANM58Q",
  contentVerificationCount: 0,
  createdAt: "2026-10-01T02:08:35.068Z",
  erasureGeneration: 1,
  id: "5V27YRC4MRPJDHJFZ44P3745Q8",
  nextDueAt: "2026-10-01T02:08:35.068Z",
  organizationId,
  phase: "draining",
  priority: 0,
  requestedByPrincipalId: "01KYK5W3M7Z4KR6VP8BJTA8ACF",
  status: "pending",
  updatedAt: "2026-10-01T02:08:35.068Z",
  version: 0,
});

function rescheduled(nextDueAt: string) {
  return brainErasureRecord({
    ...brainErasureFromRecord(pending),
    nextDueAt,
    updatedAt: nextDueAt,
    version: 1,
  });
}

function seeded() {
  const dynamo = fakeDynamoDocumentClient();
  dynamo.put(
    "control",
    withCanonicalRecordKeys({
      data: {
        createdAt: "2026-10-01T00:00:00.000Z",
        id: organizationId,
        name: "Token Organization",
        slug: "token-organization",
        status: "active",
        updatedAt: "2026-10-01T00:00:00.000Z",
        version: 1,
      },
      itemType: "organization",
    }),
  );
  dynamo.put("execution", pending);
  return { database: makeDynamoDatabase(dynamo.client), dynamo };
}

describe("DynamoDB transaction request tokens", () => {
  test("a request token reused for a rebuilt create is rejected instead of committing twice", async () => {
    const { database, dynamo } = seeded();
    const created = (id: string) =>
      brainErasureRecord({ ...brainErasureFromRecord(pending), id, version: 0 });
    const first = created("01M3TZ0000000000000000000A");
    const rebuilt = created("01M3TZ0000000000000000000B");

    await database.transactWrite([{ kind: "put", record: first }], "create-1");
    const replayed = await database
      .transactWrite([{ kind: "put", record: rebuilt }], "create-1")
      .then(
        () => "Success" as const,
        () => "Failure" as const,
      );

    expect(replayed).toBe("Failure");
    expect(dynamo.get("execution", first)).toBeDefined();
    expect(dynamo.get("execution", rebuilt)).toBeUndefined();
  });

  test("a conflict retry resends the identical request under the same token", async () => {
    const { database, dynamo } = seeded();
    dynamo.failNextTransaction(
      () => true,
      () => transactionCanceledError(["TransactionConflict", "None", "None", "None"]),
    );

    await database.transactWrite(
      [
        {
          kind: "put",
          previousRecord: pending,
          record: rescheduled("2026-10-01T02:10:00.000Z"),
        },
      ],
      "job-1",
    );

    const [conflicted, committed] = dynamo.transactions;
    expect(conflicted?.outcome).toBe("failed");
    expect(committed?.outcome).toBe("applied");
    expect(committed?.input).toEqual(conflicted!.input);
    expect(dynamo.get("execution", pending)).toMatchObject({ data: { version: 1 } });
  });
});
