import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { makeDynamoDatabase } from "./client.ts";
import { Ulid } from "./ids.ts";
import { bffFenceRecord, principalRecord } from "./identity/record-builders.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "./records/index.ts";

const PRINCIPAL_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAV");

function recordingClient() {
  const commands: unknown[] = [];
  const client = {
    send: async (command: unknown) => {
      commands.push(command);
      return {};
    },
  } as unknown as DynamoDBDocumentClient;
  return { client, commands };
}

describe("DynamoDatabase identity revocation fences", () => {
  test("requires the BFF fence when a human principal is disabled", async () => {
    const { client, commands } = recordingClient();
    const database = makeDynamoDatabase(client);
    const principal = principalRecord({
      createdAt: "2026-07-20T00:00:00.000Z",
      id: PRINCIPAL_ID,
      primaryEmail: "user@example.com",
    });
    const disabled = withCanonicalRecordKeys({
      ...principal,
      data: {
        ...principal.data,
        status: "disabled",
        updatedAt: "2026-07-20T00:01:00.000Z",
        version: 2,
      },
    }) as PlatformRecord;

    const exit = await database
      .transactWrite([{ kind: "put", previousRecord: principal, record: disabled }])
      .then(
        () => "Success" as const,
        () => "Failure" as const,
      );

    expect(exit).toBe("Failure");
    expect(commands).toHaveLength(0);
  });

  test("does not allow a status projection to roll back the BFF session epoch", async () => {
    const { client, commands } = recordingClient();
    const database = makeDynamoDatabase(client);
    const principal = principalRecord({
      createdAt: "2026-07-20T00:00:00.000Z",
      id: PRINCIPAL_ID,
      primaryEmail: "user@example.com",
    });
    const disabled = withCanonicalRecordKeys({
      ...principal,
      data: {
        ...principal.data,
        status: "disabled",
        updatedAt: "2026-07-20T00:01:00.000Z",
        version: 2,
      },
    }) as PlatformRecord;
    const fence = bffFenceRecord({
      createdAt: "2026-07-20T00:00:00.000Z",
      principalId: PRINCIPAL_ID,
      principalStatus: "active",
      sessionEpoch: 5,
      version: 1,
    });
    const rolledBackFence = withCanonicalRecordKeys({
      ...fence,
      data: {
        ...fence.data,
        principalStatus: "disabled",
        sessionEpoch: 4,
        updatedAt: "2026-07-20T00:01:00.000Z",
        version: 2,
      },
    }) as PlatformRecord;

    const exit = await database
      .transactWrite([
        { kind: "put", previousRecord: principal, record: disabled },
        { kind: "put", previousRecord: fence, record: rolledBackFence },
      ])
      .then(
        () => "Success" as const,
        () => "Failure" as const,
      );

    expect(exit).toBe("Failure");
    expect(commands).toHaveLength(0);
  });
});
