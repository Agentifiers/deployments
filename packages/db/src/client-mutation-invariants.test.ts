import { agentManifestContentHash, AgentManifestV1 } from "@deployments-ai/agent-manifest";
import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { makeDynamoDatabase } from "./client.ts";
import {
  organizationConditionKeys,
  recordingClient,
  shardWritesMarkerRead,
} from "./database-write-test-support.ts";
import { Ulid } from "./ids.ts";
import { Keys } from "./keys.ts";
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

async function organizationMemberRecord(principalId: typeof PROJECT_ID, version: number) {
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          createdAt: "2026-07-20T00:00:00.000Z",
          organizationId: ORG_ID,
          principalId,
          role: "member",
          status: "active",
          updatedAt: "2026-07-20T00:00:00.000Z",
          version,
        },
        itemType: "organization-member",
      }),
    ),
  );
}

async function runRecord(id: typeof EVENT_ID, version: number) {
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          agentDeploymentId: EVENT_ID,
          agentReleaseId: PROJECT_ID,
          attempt: 1,
          captureMode: "metadata-only",
          createdAt: "2026-07-20T00:00:00.000Z",
          environmentId: ENVIRONMENT_ID,
          executor: "platform",
          id,
          idempotencyKey: "run/request-123",
          organizationId: ORG_ID,
          priority: 1,
          projectId: PROJECT_ID,
          redactionPolicyVersion: 1,
          schemaVersion: 1,
          spanId: "0123456789abcdef",
          status: "queued",
          threadId: PROJECT_ID,
          traceId: "0123456789abcdef0123456789abcdef",
          trigger: "api",
          updatedAt: "2026-07-20T00:00:00.000Z",
          version,
        },
        itemType: "run",
      }),
    ),
  );
}

async function agentReleaseRecord(version: number, instructions: string) {
  const manifest = Schema.decodeUnknownSync(AgentManifestV1)({
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: {
      key: "immutable-release",
      name: "Immutable Release",
      version: "1.0.0",
    },
    spec: {
      instructions,
      model: { id: "openrouter/test" },
      sandbox: { mode: "none" },
    },
  });
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          agentDefinitionId: PROJECT_ID,
          contentHash: agentManifestContentHash(manifest),
          createdAt: "2026-07-20T00:00:00.000Z",
          createdByPrincipalId: ORG_ID,
          environmentId: ENVIRONMENT_ID,
          id: EVENT_ID,
          manifest,
          organizationId: ORG_ID,
          projectId: PROJECT_ID,
          releaseNumber: 1,
          status: "active",
          version,
        },
        itemType: "agent-release",
      }),
    ),
  );
}

async function agentReleaseControlRecord(version: number, activeDeploymentCount: number) {
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          activeDeploymentCount,
          agentDefinitionId: PROJECT_ID,
          agentReleaseId: EVENT_ID,
          createdAt: "2026-07-20T00:00:00.000Z",
          environmentId: ENVIRONMENT_ID,
          id: EVENT_ID,
          organizationId: ORG_ID,
          projectId: PROJECT_ID,
          releaseNumber: 1,
          updatedAt: "2026-07-20T00:00:00.000Z",
          version,
        },
        itemType: "agent-release-control",
      }),
    ),
  );
}

async function principalIdentityRecord(principalId: typeof PROJECT_ID, version: number) {
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          createdAt: "2026-07-20T00:00:00.000Z",
          id: EVENT_ID,
          issuer: "https://identity.example.com",
          organizationId: ORG_ID,
          principalId,
          subject: "user-123",
          updatedAt: "2026-07-20T00:00:00.000Z",
          version,
        },
        itemType: "principal-identity",
      }),
    ),
  );
}

async function approvalActionTokenRecord(
  version: number,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  const expiresAt = "2026-07-21T00:00:00.000Z";
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          approvalId: EVENT_ID,
          channel: "slack",
          createdAt: "2026-07-20T00:00:00.000Z",
          expiresAt,
          id: PROJECT_ID,
          organizationId: ORG_ID,
          status: "active",
          tokenHash: "sha256:approval-token",
          ...overrides,
          version,
        },
        itemType: "approval-action-token",
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

describe("DynamoDatabase", () => {
  test("prevents an agent release payload from changing under the same release ID", async () => {
    const { client, commands } = recordingClient();
    const database = makeDynamoDatabase(client);
    const previousRecord = await agentReleaseRecord(0, "Original instructions.");
    const replacementRecord = await agentReleaseRecord(1, "Changed instructions.");

    const exit = await database
      .transactWrite([{ kind: "put", previousRecord, record: replacementRecord }])
      .then(
        () => "Success" as const,
        () => "Failure" as const,
      );

    expect(exit).toBe("Failure");
    expect(commands).toHaveLength(0);
  });

  test("allows deployment count updates on an immutable release control", async () => {
    const { client, commands, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);
    const previousRecord = await agentReleaseControlRecord(0, 0);
    const replacementRecord = await agentReleaseControlRecord(1, 1);

    await database.transactWrite([{ kind: "put", previousRecord, record: replacementRecord }]);

    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject(shardWritesMarkerRead());
    expect(transactions).toHaveLength(1);
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

  test("rejects stale versions and standalone unique deletions", async () => {
    const { client, commands } = recordingClient();
    const database = makeDynamoDatabase(client);
    const organization = await organizationRecord();
    const claim = await uniqueClaimRecord();

    const staleUpdateExit = await database
      .transactWrite([{ kind: "put", previousRecord: organization, record: organization }])
      .then(
        () => "Success" as const,
        () => "Failure" as const,
      );
    const directOwnerDeleteExit = await database.deleteRecord(organization).then(
      () => "Success" as const,
      () => "Failure" as const,
    );
    const directClaimDeleteExit = await database.deleteRecord(claim).then(
      () => "Success" as const,
      () => "Failure" as const,
    );
    const transactionClaimDeleteExit = await database
      .transactWrite([{ kind: "delete", record: claim }])
      .then(
        () => "Success" as const,
        () => "Failure" as const,
      );

    expect(staleUpdateExit).toBe("Failure");
    expect(directOwnerDeleteExit).toBe("Failure");
    expect(directClaimDeleteExit).toBe("Failure");
    expect(transactionClaimDeleteExit).toBe("Failure");
    expect(commands).toHaveLength(0);
  });

  test("binds previousRecord to the same canonical key", async () => {
    const { client, commands } = recordingClient();
    const database = makeDynamoDatabase(client);
    const previousRecord = await organizationMemberRecord(PROJECT_ID, 1);
    const replacementRecord = await organizationMemberRecord(ENVIRONMENT_ID, 2);

    const exit = await database
      .transactWrite([{ kind: "put", previousRecord, record: replacementRecord }])
      .then(
        () => "Success" as const,
        () => "Failure" as const,
      );

    expect(exit).toBe("Failure");
    expect(commands).toHaveLength(0);
  });

  test("does not allow idempotency-keyed records to replace their ULID", async () => {
    const { client, commands } = recordingClient();
    const database = makeDynamoDatabase(client);
    const previousRecord = await runRecord(EVENT_ID, 1);
    const replacementRecord = await runRecord(REPLACEMENT_ID, 2);

    expect(previousRecord.pk).toBe(replacementRecord.pk);
    expect(previousRecord.sk).toBe(replacementRecord.sk);

    const exit = await database
      .transactWrite([{ kind: "put", previousRecord, record: replacementRecord }])
      .then(
        () => "Success" as const,
        () => "Failure" as const,
      );

    expect(exit).toBe("Failure");
    expect(commands).toHaveLength(0);
  });

  test("does not allow a run to change its observability identity", async () => {
    const { client, commands } = recordingClient();
    const database = makeDynamoDatabase(client);
    const previousRecord = await runRecord(EVENT_ID, 1);
    const replacementRecord = await Effect.runPromise(
      decodePlatformRecord(
        withCanonicalRecordKeys({
          ...previousRecord,
          data: {
            ...previousRecord.data,
            traceId: "fedcba9876543210fedcba9876543210",
            version: 2,
          },
        }),
      ),
    );

    const exit = await database
      .transactWrite([{ kind: "put", previousRecord, record: replacementRecord }])
      .then(
        () => "Success" as const,
        () => "Failure" as const,
      );

    expect(exit).toBe("Failure");
    expect(commands).toHaveLength(0);
  });

  test("does not allow authentication ownership to be reassigned", async () => {
    const { client, commands, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);
    const previousRecord = await principalIdentityRecord(PROJECT_ID, 1);
    const reassignedRecord = await principalIdentityRecord(REPLACEMENT_ID, 2);

    const reassignedExit = await database
      .transactWrite([{ kind: "put", previousRecord, record: reassignedRecord }])
      .then(
        () => "Success" as const,
        () => "Failure" as const,
      );

    expect(reassignedExit).toBe("Failure");
    expect(commands).toHaveLength(0);

    await database.transactWrite([
      {
        kind: "put",
        previousRecord,
        record: await principalIdentityRecord(PROJECT_ID, 2),
      },
    ]);

    const command = transactions[0]!;
    const ownerPut = command.input.TransactItems?.[0]?.Put;
    expect(ownerPut?.ConditionExpression).toContain("#dbPreviousPrincipalId");
    expect(ownerPut?.ExpressionAttributeValues?.[":dbPreviousPrincipalId"]).toBe(PROJECT_ID);
  });

  test("does not allow approval action tokens to be rebound", async () => {
    const { client, commands } = recordingClient();
    const database = makeDynamoDatabase(client);
    const previousRecord = await approvalActionTokenRecord(1);

    for (const overrides of [
      { approvalId: REPLACEMENT_ID },
      { channel: "email" },
      { tokenHash: "sha256:other-approval-token" },
    ]) {
      const exit = await database
        .transactWrite([
          {
            kind: "put",
            previousRecord,
            record: await approvalActionTokenRecord(2, overrides),
          },
        ])
        .then(
          () => "Success" as const,
          () => "Failure" as const,
        );
      expect(exit).toBe("Failure");
    }

    expect(commands).toHaveLength(0);
  });
});
