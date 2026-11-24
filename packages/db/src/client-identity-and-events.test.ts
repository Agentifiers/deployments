import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { makeDynamoDatabase } from "./client.ts";
import { recordingClient } from "./database-write-test-support.ts";
import { Ulid } from "./ids.ts";
import { Keys } from "./keys.ts";
import { securityStateRecord } from "./identity/record-builders.ts";
import { makeIdentitySecurityEventRecord } from "./identity/security-events.ts";
import {
  decodePlatformRecord,
  type PlatformRecord,
  withCanonicalRecordKeys,
} from "./records/index.ts";

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

async function semanticEventRecord(aggregateVersion = 1) {
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

async function idempotencyRecord(
  version: number,
  status: "completed" | "in-progress",
  commandHash = "sha256:command",
) {
  const expiresAt = "2026-07-21T00:00:00.000Z";
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          commandHash,
          createdAt: "2026-07-20T00:00:00.000Z",
          expiresAt,
          idempotencyKey: "request-123",
          organizationId: ORG_ID,
          resourceIds: [],
          status,
          version,
        },
        itemType: "idempotency",
        ttl: Math.floor(Date.parse(expiresAt) / 1_000),
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

async function oauthAuthorizationAttemptRecord(
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

async function workspaceConnectionAuthorizationRecord(
  version: number,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          authorizationVersion: 3,
          connectionId: EVENT_ID,
          createdAt: "2026-07-20T00:00:00.000Z",
          environmentId: ENVIRONMENT_ID,
          externalAccountId: "account-123",
          externalResourceConstraints: { repository: "Agentifiers/deployments" },
          id: REPLACEMENT_ID,
          organizationId: ORG_ID,
          projectId: PROJECT_ID,
          providerKey: "github",
          purpose: "deployment",
          resourceScopeHash: "sha256:resource-scope",
          status: "active",
          updatedAt: "2026-07-20T00:00:00.000Z",
          version,
          workspaceId: PROJECT_ID,
          ...overrides,
        },
        itemType: "workspace-connection-authorization",
      }),
    ),
  );
}

async function mcpSessionRecord(
  version: number,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  const expiresAt = "2026-07-21T00:00:00.000Z";
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          connectionId: EVENT_ID,
          createdAt: "2026-07-20T00:00:00.000Z",
          environmentId: ENVIRONMENT_ID,
          expiresAt,
          id: REPLACEMENT_ID,
          mcpServerId: PROJECT_ID,
          organizationId: ORG_ID,
          projectId: PROJECT_ID,
          status: "active",
          version,
          ...overrides,
        },
        itemType: "mcp-session",
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

describe("DynamoDatabase identity and events", () => {
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
    const ownerPut = command.input.TransactItems?.find(
      (item) => item.Put?.Item?.itemType === "principal-identity",
    )?.Put;
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

  test("does not allow OAuth authorization attempts to be rebound", async () => {
    const { client, commands } = recordingClient();
    const database = makeDynamoDatabase(client);
    const previousRecord = await oauthAuthorizationAttemptRecord(1);

    for (const overrides of [
      { principalId: REPLACEMENT_ID },
      { providerApplicationId: PROJECT_ID },
      { providerKey: "gitlab" },
      { requestedScopes: ["admin:org"] },
      { returnTo: "https://attacker.example.com/callback" },
      { stateHash: "sha256:other-oauth-state" },
    ]) {
      const exit = await database
        .transactWrite([
          {
            kind: "put",
            previousRecord,
            record: await oauthAuthorizationAttemptRecord(2, overrides),
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

  test("does not allow connection authorizations or MCP sessions to be rebound", async () => {
    const { client, commands } = recordingClient();
    const database = makeDynamoDatabase(client);
    const authorization = await workspaceConnectionAuthorizationRecord(1);
    const session = await mcpSessionRecord(1);

    for (const record of [
      await workspaceConnectionAuthorizationRecord(2, { connectionId: PROJECT_ID }),
      await workspaceConnectionAuthorizationRecord(2, { providerKey: "gitlab" }),
      await workspaceConnectionAuthorizationRecord(2, {
        externalResourceConstraints: { repository: "another/repository" },
      }),
      await mcpSessionRecord(2, { connectionId: PROJECT_ID }),
      await mcpSessionRecord(2, { mcpServerId: EVENT_ID }),
    ]) {
      const previousRecord = record.itemType === "mcp-session" ? session : authorization;
      const exit = await database.transactWrite([{ kind: "put", previousRecord, record }]).then(
        () => "Success" as const,
        () => "Failure" as const,
      );
      expect(exit).toBe("Failure");
    }

    expect(commands).toHaveLength(0);
  });

  test("binds security token identity fields to stored status updates", async () => {
    const { client, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);
    const previousRecord = await oauthAuthorizationAttemptRecord(1);
    const replacementRecord = await oauthAuthorizationAttemptRecord(2, {
      completedAt: "2026-07-20T00:01:00.000Z",
      connectionId: PROJECT_ID,
      status: "completed",
    });

    await database.transactWrite([{ kind: "put", previousRecord, record: replacementRecord }]);

    const command = transactions[0]!;
    const ownerPut = command.input.TransactItems?.[0]?.Put;
    expect(ownerPut?.ConditionExpression).toContain("#dbPreviousStateHash");
    expect(ownerPut?.ConditionExpression).toContain("#dbPreviousRequestedScopes");
    expect(ownerPut?.ConditionExpression).toContain("#dbPreviousReturnTo");
    expect(ownerPut?.ExpressionAttributeValues?.[":dbPreviousStateHash"]).toBe(
      "sha256:oauth-state",
    );
    expect(ownerPut?.ExpressionAttributeValues?.[":dbPreviousRequestedScopes"]).toEqual([
      "repo",
      "user:email",
    ]);
    const claimKey = Keys.control.uniqueClaim(
      `environment:${ENVIRONMENT_ID}:oauth-state-hash`,
      "sha256:oauth-state",
    );
    const claimCheck = command.input.TransactItems?.find(
      (item) =>
        item.ConditionCheck?.Key?.pk === claimKey.pk && item.ConditionCheck.Key.sk === claimKey.sk,
    )?.ConditionCheck;
    expect(claimCheck?.Key).toEqual(claimKey);
    expect(claimCheck?.ExpressionAttributeValues?.[":dbClaimExpiresAt"]).toBe(
      "2026-07-21T00:00:00.000Z",
    );
  });

  test("updates versioned coordination records without mutable timestamps", async () => {
    const { client, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);
    const previousRecord = await idempotencyRecord(1, "in-progress");
    const replacementRecord = await idempotencyRecord(2, "completed");

    await database.transactWrite([{ kind: "put", previousRecord, record: replacementRecord }]);

    const command = transactions[0]!;
    expect(command.input.TransactItems?.[0]?.Put?.ConditionExpression).toContain(
      "#dbResourceVersion",
    );
    expect(
      command.input.TransactItems?.[0]?.Put?.ExpressionAttributeValues?.[":dbPreviousVersion"],
    ).toBe(1);
  });

  test("does not allow idempotency keys to be rebound to another command", async () => {
    const { client, commands } = recordingClient();
    const database = makeDynamoDatabase(client);
    const previousRecord = await idempotencyRecord(1, "in-progress");
    const replacementRecord = await idempotencyRecord(2, "completed", "sha256:other-command");

    const exit = await database
      .transactWrite([{ kind: "put", previousRecord, record: replacementRecord }])
      .then(
        () => "Success" as const,
        () => "Failure" as const,
      );

    expect(exit).toBe("Failure");
    expect(commands).toHaveLength(0);
  });

  test("enforces append-only contiguous semantic events in the database layer", async () => {
    const { client, commands, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);
    const firstEvent = await semanticEventRecord();

    const directPut = await database.putRecord(firstEvent).then(
      () => "Success" as const,
      () => "Failure" as const,
    );
    const directDelete = await database.deleteRecord(firstEvent).then(
      () => "Success" as const,
      () => "Failure" as const,
    );
    const transactionDelete = await database
      .transactWrite([{ kind: "delete", record: firstEvent }])
      .then(
        () => "Success" as const,
        () => "Failure" as const,
      );

    expect(directPut).toBe("Failure");
    expect(directDelete).toBe("Failure");
    expect(transactionDelete).toBe("Failure");
    expect(commands).toHaveLength(0);

    await database.transactWrite([{ kind: "put", record: await semanticEventRecord(3) }]);

    const command = transactions[0]!;
    const predecessorCheck = command.input.TransactItems?.find(
      (item) => item.ConditionCheck,
    )?.ConditionCheck;
    expect(predecessorCheck?.Key).toEqual({
      pk: `ORG#${ORG_ID}#AGGREGATE#organization#${ORG_ID}`,
      sk: "SEMANTIC-EVENT#0000000000000002",
    });
    expect(predecessorCheck?.ExpressionAttributeValues?.[":aggregateVersion"]).toBe(2);
  });

  test("enforces current semantic event limits at the transaction boundary", async () => {
    const { client, commands } = recordingClient();
    const database = makeDynamoDatabase(client);
    const event = await semanticEventRecord();
    const oversizedEvent = withCanonicalRecordKeys({
      ...event,
      data: { ...event.data, aggregateType: "x".repeat(129) },
    }) as PlatformRecord;

    const exit = await database.transactWrite([{ kind: "put", record: oversizedEvent }]).then(
      () => "Success" as const,
      () => "Failure" as const,
    );

    expect(exit).toBe("Failure");
    expect(commands).toHaveLength(0);
  });

  test("binds identity security events to the aggregate mutation and exact version", async () => {
    const createdAt = "2026-07-20T00:00:00.000Z";
    const previousSecurity = securityStateRecord({
      createdAt,
      credentialVersion: 1,
      principalId: ORG_ID,
      sessionEpoch: 0,
      version: 1,
    });
    const nextSecurity = withCanonicalRecordKeys({
      ...previousSecurity,
      data: {
        ...previousSecurity.data,
        authenticationFailureCount: 1,
        updatedAt: "2026-07-20T00:01:00.000Z",
        version: 2,
      },
    }) as PlatformRecord;
    const matchingEvent = makeIdentitySecurityEventRecord({
      aggregateId: ORG_ID,
      aggregateType: "principal-security-state",
      aggregateVersion: 2,
      eventId: EVENT_ID,
      eventType: "identity.sign-in-failed",
      occurredAt: "2026-07-20T00:01:00.000Z",
      principalId: ORG_ID,
    });

    const standalone = recordingClient();
    const directPutExit = await makeDynamoDatabase(standalone.client)
      .putRecord(matchingEvent)
      .then(
        () => "Success" as const,
        () => "Failure" as const,
      );
    const standaloneExit = await makeDynamoDatabase(standalone.client)
      .transactWrite([{ kind: "put", record: matchingEvent }])
      .then(
        () => "Success" as const,
        () => "Failure" as const,
      );
    expect(directPutExit).toBe("Failure");
    expect(standaloneExit).toBe("Failure");
    expect(standalone.commands).toHaveLength(0);

    const skipped = recordingClient();
    const skippedExit = await makeDynamoDatabase(skipped.client)
      .transactWrite([
        { kind: "put", previousRecord: previousSecurity, record: nextSecurity },
        {
          kind: "put",
          record: withCanonicalRecordKeys({
            ...matchingEvent,
            data: { ...matchingEvent.data, aggregateVersion: 3 },
          }) as PlatformRecord,
        },
      ])
      .then(
        () => "Success" as const,
        () => "Failure" as const,
      );
    expect(skippedExit).toBe("Failure");
    expect(skipped.commands).toHaveLength(0);

    const matched = recordingClient();
    await makeDynamoDatabase(matched.client).transactWrite([
      { kind: "put", previousRecord: previousSecurity, record: nextSecurity },
      { kind: "put", record: matchingEvent },
    ]);
    expect(matched.commands).toHaveLength(1);
  });

  test("reserves semantic event predecessor condition keys for database sequencing", async () => {
    const { client, commands } = recordingClient();
    const database = makeDynamoDatabase(client);
    const event = await semanticEventRecord(3);

    const exit = await database
      .transactWrite([
        {
          conditionExpression: "attribute_exists(pk)",
          key: {
            pk: event.pk,
            sk: "SEMANTIC-EVENT#0000000000000002",
          },
          kind: "condition-check",
          table: "events",
        },
        { kind: "put", record: event },
      ])
      .then(
        () => "Success" as const,
        () => "Failure" as const,
      );

    expect(exit).toBe("Failure");
    expect(commands).toHaveLength(0);
  });
});
