import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { makeDynamoDatabase } from "./client.ts";
import {
  organizationConditionKeys,
  recordingClient,
  shardWritesMarkerRead,
} from "./database-write-test-support.ts";
import { Ulid } from "./ids.ts";
import { Keys, UNIQUE_CLAIM_CONDITION } from "./keys.ts";
import { decodePlatformRecord, withCanonicalRecordKeys } from "./records/index.ts";

const ORG_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const PROJECT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAW");
const ENVIRONMENT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAX");
const EVENT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAY");
const REPLACEMENT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAZ");

async function organizationRecord(slug = "deployments-ai", version = 1) {
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          createdAt: "2026-07-20T00:00:00.000Z",
          id: ORG_ID,
          name: "Deployments.ai",
          slug,
          status: "active",
          updatedAt: "2026-07-20T00:00:00.000Z",
          version,
        },
        itemType: "organization",
      }),
    ),
  );
}

async function _semanticEventRecord(aggregateVersion = 1) {
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          aggregateId: ORG_ID,
          aggregateType: "organization",
          aggregateVersion,
          environmentId: ENVIRONMENT_ID,
          eventId: EVENT_ID,
          eventType: "organization.created",
          occurredAt: "2026-07-20T00:00:00.000Z",
          organizationId: ORG_ID,
          payload: {},
          projectId: PROJECT_ID,
        },
        itemType: "semantic-event",
      }),
    ),
  );
}

async function _auditEventRecord() {
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          action: "organization.created",
          actor: { id: PROJECT_ID, type: "principal" },
          environmentId: ENVIRONMENT_ID,
          eventId: EVENT_ID,
          occurredAt: "2026-07-20T00:00:00.000Z",
          organizationId: ORG_ID,
          projectId: PROJECT_ID,
        },
        itemType: "audit-event",
      }),
    ),
  );
}

async function _runtimeLeaseRecord() {
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          acquiredAt: "2026-07-20T00:00:00.000Z",
          environmentId: ENVIRONMENT_ID,
          expiresAt: "2026-07-20T00:15:00.000Z",
          id: EVENT_ID,
          leaseKey: `agent-run-thread/${EVENT_ID}`,
          organizationId: ORG_ID,
          owner: "worker:test",
          projectId: PROJECT_ID,
          runId: REPLACEMENT_ID,
          threadId: EVENT_ID,
          version: 0,
        },
        itemType: "runtime-lease",
      }),
    ),
  );
}

async function _principalIdempotencyCompletionRecord() {
  const expiresAt = "2026-07-21T00:00:00.000Z";
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          commandHash: "command-hash",
          createdAt: "2026-07-20T00:00:00.000Z",
          expiresAt,
          idempotencyKey: "principal-request",
          organizationId: ORG_ID,
          principalId: PROJECT_ID,
          resourceIds: [ORG_ID],
          response: { kind: "value", value: { id: ORG_ID } },
          responseEncoding: "protected-envelope-v1",
          status: "completed",
          version: 1,
        },
        itemType: "idempotency",
        ttl: Math.floor(Date.parse(expiresAt) / 1_000),
      }),
    ),
  );
}

async function _oauthAuthorizationAttemptRecord(
  version: number,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  const expiresAt = "2026-07-21T00:00:00.000Z";
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          createdAt: "2026-07-20T00:00:00.000Z",
          environmentId: ENVIRONMENT_ID,
          expiresAt,
          id: EVENT_ID,
          organizationId: ORG_ID,
          principalId: PROJECT_ID,
          projectId: PROJECT_ID,
          providerApplicationId: REPLACEMENT_ID,
          providerKey: "github",
          requestedScopes: ["repo", "user:email"],
          returnTo: "https://app.example.com/settings/connections",
          stateHash: "sha256:oauth-state",
          status: "pending",
          ...overrides,
          version,
        },
        itemType: "oauth-authorization-attempt",
        ttl: Math.floor(Date.parse(expiresAt) / 1_000),
      }),
    ),
  );
}

async function uniqueClaimRecord(value = "deployments-ai") {
  const owner = await organizationRecord();
  const recordKey = Keys.control.uniqueClaim("organization-slug", value);
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          createdAt: "2026-07-20T00:00:00.000Z",
          namespace: "organization-slug",
          ownerId: ORG_ID,
          ownerItemType: "organization",
          ownerPk: owner.pk,
          ownerSk: owner.sk,
          ownerTable: "control",
          value,
        },
        itemType: "unique-claim",
        ...recordKey,
      }),
    ),
  );
}

describe("DynamoDatabase writes and uniqueness", () => {
  test("requires a renamed resource to release its previous unique claim", async () => {
    const { client, commands, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);
    const previousRecord = await organizationRecord();
    const replacementRecord = await organizationRecord("deployments-platform", 2);
    const replacementClaim = await uniqueClaimRecord("deployments-platform");

    expect(
      database.transactWrite([
        {
          conditionExpression: UNIQUE_CLAIM_CONDITION,
          kind: "put",
          record: replacementClaim,
        },
        { kind: "put", previousRecord, record: replacementRecord },
      ]),
    ).rejects.toBeDefined();
    expect(commands).toHaveLength(0);

    await database.transactWrite([
      {
        conditionExpression: UNIQUE_CLAIM_CONDITION,
        kind: "put",
        record: replacementClaim,
      },
      { kind: "put", previousRecord, record: replacementRecord },
      {
        kind: "delete",
        record: await uniqueClaimRecord(),
      },
    ]);

    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject(shardWritesMarkerRead());
    expect(transactions).toHaveLength(1);
    const command = transactions[0]!;
    const resourcePut = command.input.TransactItems?.find(
      (item) => item.Put?.Item?.itemType === "organization",
    )?.Put;
    const previousClaim = await uniqueClaimRecord();
    const claimDelete = command.input.TransactItems?.find(
      (item) =>
        item.Delete?.Key?.pk === previousClaim.pk && item.Delete.Key.sk === previousClaim.sk,
    )?.Delete;
    expect(resourcePut?.ConditionExpression).toContain("#dbResourceVersion");
    expect(resourcePut?.ConditionExpression).toContain("#dbPreviousSlug");
    expect(resourcePut?.ExpressionAttributeValues?.[":dbPreviousVersion"]).toBe(1);
    expect(resourcePut?.ExpressionAttributeValues?.[":dbPreviousSlug"]).toBe("deployments-ai");
    expect(claimDelete?.ConditionExpression).toContain("#dbClaimOwnerId");
    expect(claimDelete?.ExpressionAttributeValues?.[":dbClaimOwnerId"]).toBe(ORG_ID);
  });

  test("checks the existing claim when a unique value is unchanged", async () => {
    const { client, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);
    const previousRecord = await organizationRecord();
    const replacementRecord = await organizationRecord("deployments-ai", 2);

    await database.transactWrite([{ kind: "put", previousRecord, record: replacementRecord }]);

    const command = transactions[0]!;
    expect(command.input.TransactItems).toHaveLength(4);
    const resourcePut = command.input.TransactItems?.find(
      (item) => item.Put?.Item?.itemType === "organization",
    )?.Put;
    const claimKey = Keys.control.uniqueClaim("organization-slug", "deployments-ai");
    const claimCheck = command.input.TransactItems?.find(
      (item) =>
        item.ConditionCheck?.Key?.pk === claimKey.pk && item.ConditionCheck.Key.sk === claimKey.sk,
    )?.ConditionCheck;
    expect(resourcePut?.ConditionExpression).toContain("#dbResourceVersion");
    expect(resourcePut?.ConditionExpression).toContain("#dbPreviousSlug");
    expect(resourcePut?.ExpressionAttributeValues?.[":dbPreviousVersion"]).toBe(1);
    expect(resourcePut?.ExpressionAttributeValues?.[":dbPreviousSlug"]).toBe("deployments-ai");
    expect(claimCheck?.Key).toEqual(
      Keys.control.uniqueClaim("organization-slug", "deployments-ai"),
    );
    expect(claimCheck?.ConditionExpression).toContain("#dbClaimOwnerId");
    expect(claimCheck?.ExpressionAttributeValues?.[":dbClaimOwnerId"]).toBe(ORG_ID);
    expect(claimCheck?.ExpressionAttributeValues?.[":dbClaimOwnerPk"]).toBe(previousRecord.pk);
    expect(claimCheck?.ExpressionAttributeValues?.[":dbClaimOwnerTable"]).toBe("control");
    expect(organizationConditionKeys(command)).toEqual([
      { pk: `ORG#${ORG_ID}`, sk: "ORGANIZATION-GATE-LANE#08" },
    ]);
  });
});
