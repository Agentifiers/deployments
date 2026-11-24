import { describe, expect, test } from "bun:test";
import type { Ulid } from "../ids.ts";
import type { DynamoDatabaseService, QueryRecordsResult } from "../client-types.ts";
import type { PlatformRecord } from "../records/index.ts";
import { sessionRecords } from "./record-builders.ts";
import { makeIdentityRepository } from "./repository.ts";

const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const NEWER_SESSION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const OLDER_SESSION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;

function session(id: Ulid, createdAt: string, tokenHash: string) {
  return sessionRecords({
    authentication: { method: "password" },
    authenticationTime: createdAt,
    createdAt,
    expiresAt: "2026-08-28T00:00:00.000Z",
    id,
    idleExpiresAt: "2026-07-29T00:00:00.000Z",
    principalId: PRINCIPAL_ID,
    sessionEpoch: 0,
    tokenHash,
  });
}

function recordingDatabase(result: QueryRecordsResult) {
  const queries: { readonly input: Record<string, unknown>; readonly table: string }[] = [];
  const database: DynamoDatabaseService = {
    deleteRecord: async () => {},
    getRecord: async () => undefined,
    putRecord: async () => {},
    queryRecords: async (table, input) => {
      queries.push({ input: input as Record<string, unknown>, table });
      return result;
    },
    transactWrite: async () => {},
  };
  return { database, queries };
}

describe("identity session listing", () => {
  test("queries only the principal's active GSI1 range newest first", async () => {
    const newer = session(NEWER_SESSION_ID, "2026-07-28T02:00:00.000Z", "a".repeat(64));
    const older = session(OLDER_SESSION_ID, "2026-07-28T01:00:00.000Z", "b".repeat(64));
    const { database, queries } = recordingDatabase({
      items: [newer.session, older.session, newer.locator as PlatformRecord],
      lastEvaluatedKey: { pk: older.session.pk, sk: older.session.sk },
    });

    const page = await makeIdentityRepository(database).listActiveSessions(PRINCIPAL_ID, {
      limit: 2,
    });

    expect(queries).toEqual([
      {
        input: {
          ExpressionAttributeNames: { "#gsi1pk": "gsi1pk", "#gsi1sk": "gsi1sk" },
          ExpressionAttributeValues: {
            ":partition": `PRINCIPAL#${PRINCIPAL_ID}#IDENTITY-SESSIONS`,
            ":prefix": "IDENTITY-SESSION#active#",
          },
          IndexName: "gsi1",
          KeyConditionExpression: "#gsi1pk = :partition AND begins_with(#gsi1sk, :prefix)",
          Limit: 2,
          ScanIndexForward: false,
        },
        table: "identity",
      },
    ]);
    expect(page.items.map((item) => item.data.id)).toEqual([NEWER_SESSION_ID, OLDER_SESSION_ID]);
    // The cursor is derived from the decoded session, never from base-table keys.
    expect(page.next).toEqual({ createdAt: "2026-07-28T01:00:00.000Z", id: OLDER_SESSION_ID });
  });

  test("continues strictly before the keyset cursor and ends without a next cursor", async () => {
    const older = session(OLDER_SESSION_ID, "2026-07-28T01:00:00.000Z", "b".repeat(64));
    const revoked = {
      ...older.session,
      data: { ...older.session.data, status: "revoked" as const },
    };
    const { database, queries } = recordingDatabase({ items: [older.session, revoked] });

    const page = await makeIdentityRepository(database).listActiveSessions(PRINCIPAL_ID, {
      before: { createdAt: "2026-07-28T02:00:00.000Z", id: NEWER_SESSION_ID },
      limit: 50,
    });

    expect(queries[0]?.input).toMatchObject({
      ExpressionAttributeValues: {
        ":before": `IDENTITY-SESSION#active#2026-07-28T02%3A00%3A00.000Z#${NEWER_SESSION_ID}`,
        ":partition": `PRINCIPAL#${PRINCIPAL_ID}#IDENTITY-SESSIONS`,
      },
      KeyConditionExpression: "#gsi1pk = :partition AND #gsi1sk < :before",
      Limit: 50,
      ScanIndexForward: false,
    });
    expect(queries[0]?.input).not.toHaveProperty("ExclusiveStartKey");
    expect(queries[0]?.input).not.toHaveProperty("FilterExpression");
    expect(page.items.map((item) => item.data.id)).toEqual([OLDER_SESSION_ID]);
    expect(page.next).toBeUndefined();
  });
});
