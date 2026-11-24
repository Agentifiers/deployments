import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { expiredIdempotencyReplacementCondition, makeDynamoDatabase } from "./client.ts";
import { organizationConditionKeys, recordingClient } from "./database-write-test-support.ts";
import { Ulid } from "./ids.ts";
import { Keys, UNIQUE_CLAIM_CONDITION } from "./keys.ts";
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

async function principalIdempotencyRecord(
  version: number,
  status: "completed" | "in-progress",
  organizationId?: string,
) {
  const expiresAt = "2026-07-21T00:00:00.000Z";
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          commandHash: "sha256:create-organization",
          createdAt: "2026-07-20T00:00:00.000Z",
          expiresAt,
          idempotencyKey: "request-create-organization",
          ...(organizationId ? { organizationId } : {}),
          principalId: PROJECT_ID,
          resourceIds: organizationId ? [organizationId] : [],
          status,
          version,
        },
        itemType: "idempotency",
        ttl: Math.floor(Date.parse(expiresAt) / 1_000),
      }),
    ),
  );
}

async function governanceOperationRecord(version: number, dispatchReadyAt?: string) {
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          createdAt: "2026-07-20T00:00:00.000Z",
          ...(dispatchReadyAt ? { dispatchReadyAt } : {}),
          id: EVENT_ID,
          idempotencyKey: "request-123",
          kind: "tenant-export",
          organizationId: ORG_ID,
          requestedByPrincipalId: PROJECT_ID,
          status: "pending",
          updatedAt: dispatchReadyAt ?? "2026-07-20T00:00:00.000Z",
          version,
        },
        itemType: "governance-operation",
      }),
    ),
  );
}

async function providerConnectionRecord(version: number, externalAccountId?: string) {
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          authMethod: "oauth",
          createdAt: "2026-07-20T00:00:00.000Z",
          environmentId: ENVIRONMENT_ID,
          ...(externalAccountId ? { externalAccountId } : {}),
          id: EVENT_ID,
          organizationId: ORG_ID,
          projectId: PROJECT_ID,
          providerKey: "github",
          scopes: [],
          status: "active",
          updatedAt: "2026-07-20T00:00:00.000Z",
          version,
        },
        itemType: "provider-connection",
      }),
    ),
  );
}

async function providerConnectionClaim(value: string) {
  const owner = await providerConnectionRecord(1, value);
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          createdAt: "2026-07-20T00:00:00.000Z",
          namespace: `environment:${ENVIRONMENT_ID}:provider-connection:github`,
          ownerId: EVENT_ID,
          ownerItemType: "provider-connection",
          ownerPk: owner.pk,
          ownerSk: owner.sk,
          ownerTable: "control",
          value,
        },
        itemType: "unique-claim",
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

describe("DynamoDatabase", () => {
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
    const ownerPut = command.input.TransactItems?.find(
      (item) => item.Put?.Item?.itemType === "oauth-authorization-attempt",
    )?.Put;
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

  test("atomically completes idempotency and marks a governance operation dispatch-ready", async () => {
    const { client, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);
    const pendingIdempotency = await idempotencyRecord(1, "in-progress");
    const completedIdempotency = await idempotencyRecord(2, "completed");
    const readyOperation = await governanceOperationRecord(1, "2026-07-20T00:00:01.000Z");

    await database.transactWrite([
      {
        kind: "put",
        previousRecord: pendingIdempotency,
        record: completedIdempotency,
      },
      {
        kind: "put",
        record: readyOperation,
      },
    ]);

    const command = transactions[0]!;
    expect(command.input.TransactItems).toHaveLength(5);
    expect(
      command.input.TransactItems?.filter(
        (item) => item.Put?.Item?.itemType !== "governance-tenant-record",
      ).map((item) => item.Put?.Item?.itemType),
    ).toEqual(["idempotency", "governance-operation"]);
    expect(
      command.input.TransactItems?.filter((item) => item.ConditionCheck).map(
        (item) => item.ConditionCheck?.Key,
      ),
    ).toEqual([{ pk: `ORG#${ORG_ID}`, sk: "ORGANIZATION-GATE-LANE#15" }]);
  });

  test("allows principal idempotency completion to record its newly created organization", async () => {
    const { client, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);
    const pending = await principalIdempotencyRecord(1, "in-progress");
    const completed = await principalIdempotencyRecord(2, "completed", ORG_ID);

    await database.transactWrite([{ kind: "put", previousRecord: pending, record: completed }]);

    const command = transactions[0]!;
    const put = command.input.TransactItems?.[0]?.Put;
    expect(put?.Item?.data).toMatchObject({
      organizationId: ORG_ID,
      principalId: PROJECT_ID,
      status: "completed",
    });
    expect(Object.values(put?.ExpressionAttributeNames ?? {})).not.toContain("organizationId");
    expect(organizationConditionKeys(command)).toEqual([
      { pk: `ORG#${ORG_ID}`, sk: "ORGANIZATION-GATE-LANE#23" },
    ]);
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

  test("allows only canonical expired idempotency replacement puts", async () => {
    const { client, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);
    const record = await idempotencyRecord(0, "completed");
    const replacement = {
      ...record,
      data: {
        ...record.data,
        createdAt: "2026-07-22T00:00:00.000Z",
        expiresAt: "2026-07-23T00:00:00.000Z",
      },
      ttl: Math.floor(Date.parse("2026-07-23T00:00:00.000Z") / 1_000),
    } as PlatformRecord;

    await database.transactWrite([
      {
        ...expiredIdempotencyReplacementCondition(replacement),
        kind: "put",
        record: replacement,
        replaceExpired: true,
      },
    ]);

    const command = transactions[0]!;
    expect(command.input.TransactItems?.[0]?.Put?.ConditionExpression).toBe(
      expiredIdempotencyReplacementCondition(replacement).conditionExpression,
    );
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

  test("checks stored absence before adding or deleting an optional unique field", async () => {
    const { client, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);
    const previousRecord = await providerConnectionRecord(1);
    const replacementRecord = await providerConnectionRecord(2, "account-123");

    await database.transactWrite([
      {
        conditionExpression: UNIQUE_CLAIM_CONDITION,
        kind: "put",
        record: await providerConnectionClaim("account-123"),
      },
      { kind: "put", previousRecord, record: replacementRecord },
    ]);
    await database.deleteRecord(previousRecord);

    const transaction = transactions[0]!;
    const ownerPut = transaction.input.TransactItems?.find(
      (item) => item.Put?.Item?.itemType === "provider-connection",
    )?.Put;
    const deleteTransaction = transactions[1]!;
    const tenantDelete = deleteTransaction.input.TransactItems?.find(
      (item) =>
        item.Delete?.Key?.pk === previousRecord.pk && item.Delete.Key.sk === previousRecord.sk,
    )?.Delete;
    expect(ownerPut?.ConditionExpression).toContain("attribute_not_exists");
    expect(ownerPut?.ConditionExpression).toContain("#dbPreviousExternalAccountId");
    expect(tenantDelete?.ConditionExpression).toContain("attribute_not_exists");
    expect(tenantDelete?.ConditionExpression).toContain("#dbPreviousExternalAccountId");
    expect(organizationConditionKeys(deleteTransaction)).toEqual([
      { pk: `ORG#${ORG_ID}`, sk: "ORGANIZATION-GATE-LANE#01" },
    ]);
  });

  test("binds immutable identity fields to stored updates and deletes", async () => {
    const { client, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);
    const previousRecord = await runRecord(EVENT_ID, 1);
    const replacementRecord = await runRecord(EVENT_ID, 2);

    await database.transactWrite([{ kind: "put", previousRecord, record: replacementRecord }]);
    await database.transactWrite([{ kind: "delete", record: previousRecord }]);

    const transaction = transactions[0]!;
    const ownerPut = transaction.input.TransactItems?.find(
      (item) => item.Put?.Item?.itemType === "run",
    )?.Put;
    const locatorPut = transaction.input.TransactItems?.find(
      (item) => item.Put?.Item?.itemType === "run-locator",
    )?.Put;
    const deleteTransaction = transactions[1]!;
    const ownerDelete = deleteTransaction.input.TransactItems?.find(
      (item) =>
        item.Delete?.Key?.pk === previousRecord.pk && item.Delete.Key.sk === previousRecord.sk,
    )?.Delete;
    const locatorDelete = deleteTransaction.input.TransactItems?.find(
      (item) =>
        item.Delete?.TableName === "control" && item.Delete.Key?.sk?.startsWith("RUN-LOCATOR#"),
    )?.Delete;
    expect(ownerPut?.ConditionExpression).toContain("#dbPreviousId");
    expect(ownerPut?.ConditionExpression).toContain("#dbImmutableItemType");
    expect(ownerPut?.ExpressionAttributeValues?.[":dbPreviousId"]).toBe(EVENT_ID);
    expect(ownerPut?.ExpressionAttributeValues?.[":dbImmutableItemType"]).toBe("run");
    expect(locatorPut?.ConditionExpression).toContain("attribute_not_exists(pk) OR");
    expect(locatorPut?.ExpressionAttributeValues?.[":locatorRunPk"]).toBe(replacementRecord.pk);
    expect(locatorPut?.ExpressionAttributeValues?.[":locatorRunSk"]).toBe(replacementRecord.sk);
    expect(ownerDelete?.ConditionExpression).toContain("#dbPreviousId");
    expect(ownerDelete?.ConditionExpression).toContain("#dbImmutableItemType");
    expect(locatorDelete?.ConditionExpression).toBeUndefined();
    expect(locatorDelete?.TableName).toBe("control");
  });
});
