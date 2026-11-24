import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeDynamoDatabase } from "./client.ts";
import { UNIQUE_CLAIM_CONDITION } from "./keys.ts";
import { decodePlatformRecord, withCanonicalRecordKeys } from "./records/index.ts";
import { makeUniqueClaimRecord, uniqueClaimRequirements } from "./unique-claims.ts";
import {
  ENVIRONMENT_ID,
  EVENT_ID,
  recordingClient,
  organizationRecord,
  oauthAuthorizationAttemptRecord,
  shardWritesMarkerRead,
  uniqueClaimRecord,
} from "./database-write-test-support.ts";

describe("DynamoDatabase writes and uniqueness", () => {
  test("OAuth state claims carry a directly resolvable owner key and matching expiration", async () => {
    const { client, commands, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);
    const owner = await oauthAuthorizationAttemptRecord(1);
    const [claim] = uniqueClaimRequirements(owner);
    const expiresAt = "2026-07-21T00:00:00.000Z";

    expect(claim).toMatchObject({
      expiresAt,
      namespace: `environment:${ENVIRONMENT_ID}:oauth-state-hash`,
      ownerId: EVENT_ID,
      ownerItemType: "oauth-authorization-attempt",
      ownerPk: owner.pk,
      ownerSk: owner.sk,
      ownerTable: "control",
      ttl: owner.ttl,
      value: "sha256:oauth-state",
    });

    const claimRecord = await Effect.runPromise(
      decodePlatformRecord(makeUniqueClaimRecord(claim!, "2026-07-20T00:00:00.000Z")),
    );
    await database.transactWrite([
      {
        conditionExpression: UNIQUE_CLAIM_CONDITION,
        kind: "put",
        record: claimRecord,
      },
      { kind: "put", record: owner },
    ]);

    expect((claimRecord.data as Readonly<Record<string, unknown>>).expiresAt).toBe(expiresAt);
    expect(claimRecord.ttl).toBe(owner.ttl);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject(shardWritesMarkerRead());
    expect(transactions).toHaveLength(1);
  });

  test("rejects unique claims outside the canonical transaction condition", async () => {
    const { client, commands } = recordingClient();
    const database = makeDynamoDatabase(client);
    const claim = await uniqueClaimRecord();

    expect(database.putRecord(claim)).rejects.toBeDefined();
    expect(database.transactWrite([{ kind: "put", record: claim }])).rejects.toBeDefined();
    expect(
      database.transactWrite([
        {
          conditionExpression: UNIQUE_CLAIM_CONDITION,
          kind: "put",
          record: claim,
        },
      ]),
    ).rejects.toBeDefined();
    expect(commands).toHaveLength(0);
  });

  test("rejects a unique-bearing resource without its exact claim", async () => {
    const { client, commands } = recordingClient();
    const database = makeDynamoDatabase(client);
    const organization = await organizationRecord();
    const mismatchedClaim = await uniqueClaimRecord("another-organization");

    expect(database.transactWrite([{ kind: "put", record: organization }])).rejects.toBeDefined();
    expect(
      database.transactWrite([
        {
          conditionExpression: UNIQUE_CLAIM_CONDITION,
          kind: "put",
          record: mismatchedClaim,
        },
        { kind: "put", record: organization },
      ]),
    ).rejects.toBeDefined();
    expect(commands).toHaveLength(0);
  });

  test("rejects unique claims not derived from the paired owner", async () => {
    const { client, commands } = recordingClient();
    const database = makeDynamoDatabase(client);

    expect(
      database.transactWrite([
        {
          conditionExpression: UNIQUE_CLAIM_CONDITION,
          kind: "put",
          record: await uniqueClaimRecord(),
        },
        {
          conditionExpression: UNIQUE_CLAIM_CONDITION,
          kind: "put",
          record: await uniqueClaimRecord("squatted-slug"),
        },
        { kind: "put", record: await organizationRecord() },
      ]),
    ).rejects.toBeDefined();
    expect(commands).toHaveLength(0);
  });

  test("rejects unique claims with forged owner lookup keys", async () => {
    const { client, commands } = recordingClient();
    const database = makeDynamoDatabase(client);
    const claim = await uniqueClaimRecord();
    const forgedClaim = await Effect.runPromise(
      decodePlatformRecord(
        withCanonicalRecordKeys({
          ...claim,
          data: { ...claim.data, ownerPk: "ORG#01ARZ3NDEKTSV4RRFFQ69G5FAZ" },
        }),
      ),
    );

    expect(
      database.transactWrite([
        {
          conditionExpression: UNIQUE_CLAIM_CONDITION,
          kind: "put",
          record: forgedClaim,
        },
        { kind: "put", record: await organizationRecord() },
      ]),
    ).rejects.toBeDefined();
    expect(commands).toHaveLength(0);
  });
});
