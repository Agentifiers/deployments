import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { isDatabaseContention, makeDynamoDatabase } from "./client.ts";
import { databaseFailure } from "./transaction-conditions.ts";
import { Ulid } from "./ids.ts";
import { decodePlatformRecord, withCanonicalRecordKeys } from "./records/index.ts";

const ORGANIZATION_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const PRINCIPAL_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAW");

async function organizationMemberRecord() {
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          createdAt: "2026-07-20T00:00:00.000Z",
          organizationId: ORGANIZATION_ID,
          principalId: PRINCIPAL_ID,
          role: "member",
          status: "active",
          updatedAt: "2026-07-20T00:00:00.000Z",
          version: 0,
        },
        itemType: "organization-member",
      }),
    ),
  );
}

function canceled(codes: readonly string[]) {
  return Object.assign(new Error("Transaction canceled."), {
    CancellationReasons: codes.map((Code) => ({ Code })),
    name: "TransactionCanceledException",
  });
}

describe("DynamoDatabase transaction retries", () => {
  test("retries transient transaction conflicts", async () => {
    let calls = 0;
    const client = {
      send: async (command: unknown) => {
        if (command instanceof GetCommand) return {};
        calls += 1;
        if (calls < 3) throw canceled(["None", "TransactionConflict", "TransactionConflict"]);
        return {};
      },
    } as unknown as DynamoDBDocumentClient;
    const database = makeDynamoDatabase(client);

    await database.transactWrite([{ kind: "put", record: await organizationMemberRecord() }]);

    expect(calls).toBe(3);
  });

  test("retries cancellations that mix throttling with conflicts", async () => {
    const attempts: string[][] = [
      ["None", "TransactionConflict", "ThrottlingError"],
      ["ThrottlingError", "None", "None"],
      ["ProvisionedThroughputExceeded", "TransactionConflict", "None"],
    ];
    let calls = 0;
    const client = {
      send: async (command: unknown) => {
        if (command instanceof GetCommand) return {};
        const codes = attempts[calls];
        calls += 1;
        if (codes) throw canceled(codes);
        return {};
      },
    } as unknown as DynamoDBDocumentClient;
    const database = makeDynamoDatabase(client);

    await database.transactWrite([{ kind: "put", record: await organizationMemberRecord() }]);

    expect(calls).toBe(4);
  });

  test("reports throttles that outlast the retries as contention", async () => {
    let calls = 0;
    const client = {
      send: async (command: unknown) => {
        if (command instanceof GetCommand) return {};
        calls += 1;
        throw canceled(["ThrottlingError", "None", "None"]);
      },
    } as unknown as DynamoDBDocumentClient;
    const database = makeDynamoDatabase(client);
    const record = await organizationMemberRecord();

    const failure = await database.transactWrite([{ kind: "put", record }]).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(calls).toBe(8);
    expect(failure).toMatchObject({ operation: "transact-write", reason: "unknown" });
    expect(isDatabaseContention(failure)).toBe(true);
    expect(isDatabaseContention(databaseFailure("put", "control", { name: "Boom" }))).toBe(false);
  });

  test("does not retry a cancellation that a failed condition caused", async () => {
    let calls = 0;
    const client = {
      send: async (command: unknown) => {
        if (command instanceof GetCommand) return {};
        calls += 1;
        throw canceled(["ConditionalCheckFailed", "ThrottlingError", "None"]);
      },
    } as unknown as DynamoDBDocumentClient;
    const database = makeDynamoDatabase(client);

    expect(
      database.transactWrite([{ kind: "put", record: await organizationMemberRecord() }]),
    ).rejects.toMatchObject({ reason: "conflict" });
    expect(calls).toBe(1);
  });

  test("does not retry conditional transaction failures", async () => {
    let calls = 0;
    const client = {
      send: async (command: unknown) => {
        if (command instanceof GetCommand) return {};
        calls += 1;
        throw canceled(["ConditionalCheckFailed", "None", "None"]);
      },
    } as unknown as DynamoDBDocumentClient;
    const database = makeDynamoDatabase(client);

    expect(
      database.transactWrite([{ kind: "put", record: await organizationMemberRecord() }]),
    ).rejects.toMatchObject({ reason: "conflict" });
    expect(calls).toBe(1);
  });

  test("retries transient conflicts for tenant-scoped putRecord transactions", async () => {
    let calls = 0;
    const client = {
      send: async (command: unknown) => {
        if (command instanceof GetCommand) return {};
        calls += 1;
        if (calls < 3) throw canceled(["None", "TransactionConflict", "TransactionConflict"]);
        return {};
      },
    } as unknown as DynamoDBDocumentClient;
    const database = makeDynamoDatabase(client);

    await database.putRecord(await organizationMemberRecord());

    expect(calls).toBe(3);
  });

  test("fails with a conflict after exhausting transient conflict retries", async () => {
    let calls = 0;
    const client = {
      send: async (command: unknown) => {
        if (command instanceof GetCommand) return {};
        calls += 1;
        throw canceled(["None", "TransactionConflict", "TransactionConflict"]);
      },
    } as unknown as DynamoDBDocumentClient;
    const database = makeDynamoDatabase(client);
    const record = await organizationMemberRecord();

    // The backoff now runs on the real clock inside the Promise boundary (≤ ~810 ms total).
    const failure = await database.transactWrite([{ kind: "put", record }]).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(calls).toBe(8);
    expect(failure).toMatchObject({
      message: "DynamoDB transact-write failed for table multiple.",
      operation: "transact-write",
      reason: "conflict",
      table: "multiple",
    });
  });

  test("stops a conflict backoff when the request signal aborts", async () => {
    let calls = 0;
    const controller = new AbortController();
    const client = {
      send: async (command: unknown) => {
        if (command instanceof GetCommand) return {};
        calls += 1;
        if (calls === 1) queueMicrotask(() => controller.abort());
        throw canceled(["None", "TransactionConflict", "TransactionConflict"]);
      },
    } as unknown as DynamoDBDocumentClient;
    const database = makeDynamoDatabase(client);
    const record = await organizationMemberRecord();

    const failure = await database
      .transactWrite([{ kind: "put", record }], undefined, controller.signal)
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );

    expect(calls).toBe(1);
    expect(failure).toMatchObject({ cause: controller.signal.reason, reason: "unknown" });
  });
});
