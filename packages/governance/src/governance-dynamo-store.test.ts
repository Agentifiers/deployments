import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  governanceOperationDispatchCompletion,
  governanceLegacyDirectoryRecord,
  listDispatchableGovernanceOperations,
  listGovernedOrganizationIds,
  makeDynamoGovernanceStore,
  withCanonicalRecordKeys,
  type Ulid,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";

describe("governance AWS adapters", () => {
  test("discovers every organization so default retention policies are swept", async () => {
    const commands: QueryCommand[] = [];
    const client = {
      send: async (command: QueryCommand) => {
        commands.push(command);
        if (command.input.TableName === "events") {
          return { Items: [{ data: { organizationId: "organization-c" } }] };
        }
        if (command.input.ExpressionAttributeValues?.[":itemType"] === "retention-cleanup") {
          return { Items: [{ data: { organizationId: "organization-d" } }] };
        }
        return command.input.ExclusiveStartKey === undefined
          ? {
              Items: [{ data: { id: "organization-b" } }],
              LastEvaluatedKey: { pk: "next", sk: "next" },
            }
          : { Items: [{ data: { id: "organization-a" } }] };
      },
    } as unknown as DynamoDBDocumentClient;

    expect(
      listGovernedOrganizationIds(client, { control: "control", events: "events" }),
    ).resolves.toEqual(["organization-a", "organization-b", "organization-c", "organization-d"]);
    expect(commands).toHaveLength(4);
    expect(commands[0]?.input).toMatchObject({
      ExpressionAttributeValues: { ":itemType": "organization" },
      TableName: "control",
    });
    expect(commands[2]?.input).toMatchObject({
      ExpressionAttributeValues: { ":itemType": "retention-cleanup" },
      TableName: "control",
    });
    expect(commands[3]?.input).toMatchObject({
      ExpressionAttributeValues: { ":itemType": "immutable-audit-export" },
      TableName: "events",
    });
  });

  test("reconciles only durable dispatch-ready operations and expired leases", async () => {
    const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const principalId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
    const operation = (
      id: string,
      status: "completed" | "failed" | "pending" | "running",
      kind: "tenant-erasure" | "tenant-export" = "tenant-export",
      leaseExpiresAt?: string,
      dispatchReadyAt?: string,
    ) =>
      withCanonicalRecordKeys({
        data: {
          createdAt: "2026-07-25T00:00:00.000Z",
          ...(dispatchReadyAt ? { dispatchReadyAt } : {}),
          id,
          idempotencyKey: `request-${id}`,
          kind,
          ...(leaseExpiresAt ? { leaseExpiresAt } : {}),
          organizationId,
          requestedByPrincipalId: principalId,
          status,
          updatedAt: "2026-07-25T00:01:00.000Z",
          version: 1,
        },
        itemType: "governance-operation",
      });
    const pendingExportId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
    const pendingErasureId = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
    const expiredLeaseId = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    const indexedOperations = [
      operation(pendingExportId, "pending", "tenant-export", undefined, "2026-07-25T00:01:30.000Z"),
      operation(pendingErasureId, "pending", "tenant-erasure"),
      operation("01ARZ3NDEKTSV4RRFFQ69G5FB0", "failed"),
      operation(
        expiredLeaseId,
        "running",
        "tenant-export",
        "2026-07-25T00:02:00.000Z",
        "2026-07-25T00:01:30.000Z",
      ),
      operation(
        "01ARZ3NDEKTSV4RRFFQ69G5FB1",
        "running",
        "tenant-export",
        "2026-07-25T00:04:00.000Z",
        "2026-07-25T00:01:30.000Z",
      ),
      operation("01ARZ3NDEKTSV4RRFFQ69G5FB2", "pending"),
    ];
    const client = {
      send: async (command: QueryCommand) => {
        const partition = command.input.ExpressionAttributeValues?.[":partition"];
        const due = command.input.ExpressionAttributeValues?.[":due"];
        return {
          Items: indexedOperations.filter(
            (item) => item.gsi2pk === partition && typeof due === "string" && item.gsi2sk! <= due,
          ),
        };
      },
    } as unknown as DynamoDBDocumentClient;

    expect(
      listDispatchableGovernanceOperations(
        client,
        { control: "control", events: "events" },
        new Date("2026-07-25T00:03:00.000Z"),
      ),
    ).resolves.toEqual([
      { operationId: pendingExportId, organizationId },
      { operationId: pendingErasureId, organizationId },
      { operationId: expiredLeaseId, organizationId },
    ]);
  });

  test("builds a durable dispatch marker and request audit for the idempotency completion", () => {
    const operation = {
      createdAt: "2026-07-25T00:00:00.000Z",
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      idempotencyKey: "snapshot-export",
      kind: "tenant-export" as const,
      organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      requestedByPrincipalId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      status: "pending" as const,
      updatedAt: "2026-07-25T00:00:00.000Z",
      version: 1,
    };
    const auditEventId = "01ARZ3NDEKTSV4RRFFQ69G5FAY";

    const completion = governanceOperationDispatchCompletion(
      operation,
      "2026-07-25T00:00:01.000Z",
      auditEventId,
    );
    expect(completion).toMatchObject([
      {
        kind: "put",
        record: {
          data: {
            dispatchReadyAt: "2026-07-25T00:00:01.000Z",
            status: "pending",
            version: 1,
          },
        },
      },
      {
        kind: "put",
        record: {
          data: {
            createdAt: operation.createdAt,
            kind: "tenant-export",
            operationId: operation.id,
          },
          itemType: "governance-operation-history",
          pk: `ORG#${operation.organizationId}`,
          sk: `GOVERNANCE-OPERATION-HISTORY#2026-07-25T00%3A00%3A00.000Z#${operation.id}`,
        },
      },
      {
        kind: "put",
        record: {
          data: {
            action: "tenant-export.requested",
            actor: { id: operation.requestedByPrincipalId, type: "principal" },
            eventId: auditEventId,
            organizationId: operation.organizationId,
            resourceId: operation.id,
            resourceType: "governance-operation",
          },
          itemType: "audit-event",
          pk: `ORG#${operation.organizationId}`,
          sk: `AUDIT-EVENT#${auditEventId}`,
        },
      },
    ]);
    expect(completion[2]?.kind === "put" && "environmentId" in completion[2].record.data).toBe(
      false,
    );
    const underAccess = governanceOperationDispatchCompletion(
      operation,
      "2026-07-25T00:00:01.000Z",
      auditEventId,
      "01ARZ3NDEKTSV4RRFFQ69G5FAG",
    );
    expect(underAccess[2]?.kind === "put" && underAccess[2].record.data).toMatchObject({
      actor: {
        id: operation.requestedByPrincipalId,
        operatorAccessGrantId: "01ARZ3NDEKTSV4RRFFQ69G5FAG",
        type: "principal",
      },
    });
    // A replay returns the already dispatch-ready operation and must not list or audit it again.
    expect(
      governanceOperationDispatchCompletion(
        { ...operation, dispatchReadyAt: "2026-07-25T00:00:01.000Z" },
        "2026-07-25T00:00:02.000Z",
        "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      ),
    ).toEqual([]);
  });

  test("returns a cursor for an empty tenant-directory page", async () => {
    const commands: unknown[] = [];
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: unknown) => {
          commands.push(command);
          if (command instanceof GetCommand) return {};
          return {
            Items: [],
            LastEvaluatedKey: { pk: "next", sk: "next" },
          };
        },
      } as unknown as DynamoDBDocumentClient,
      {
        control: "control",
        events: "events",
        execution: "execution",
        usage: "usage",
      },
    );

    const page = await store.listTenantRecords("01ARZ3NDEKTSV4RRFFQ69G5FAV");

    expect(page.items).toEqual([]);
    expect(page.cursor).toBeString();
    expect(commands).toHaveLength(2);
    const query = commands[0] as QueryCommand;
    expect(query.input.TableName).toBe("control");
    expect(query.input.ConsistentRead).toBe(true);
    expect(query.input.IndexName).toBeUndefined();
    expect(query.input.KeyConditionExpression).toBe("#inventory = :inventory");
    expect(query.input.ExpressionAttributeValues).toMatchObject({
      ":inventory": "ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV#GOVERNANCE-INVENTORY",
    });
    expect((commands[1] as GetCommand).input).toEqual({
      ConsistentRead: true,
      Key: {
        pk: "GLOBAL#deploy-migration",
        sk: "DEPLOY-MIGRATION#governance-inventory-shard-writes",
      },
      TableName: "control",
    });
  });

  test("correlates legacy unscoped runtime leases with tenant resource IDs", async () => {
    const matchingId = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
    const runtimeLease = (id: Ulid) =>
      withCanonicalRecordKeys({
        data: {
          acquiredAt: "2026-07-25T00:00:00.000Z",
          expiresAt: "2026-07-25T00:01:00.000Z",
          id,
          leaseKey: `agent-run-thread/${id}`,
          owner: "worker",
          version: 1,
        },
        itemType: "runtime-lease" as const,
      });
    const commands: BatchGetCommand[] = [];
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: BatchGetCommand) => {
          commands.push(command);
          return { Responses: { execution: [runtimeLease(matchingId)] } };
        },
      } as unknown as DynamoDBDocumentClient,
      {
        control: "control",
        events: "events",
        execution: "execution",
        usage: "usage",
      },
    );

    const leases = await store.listLegacyRuntimeLeases([matchingId]);

    expect(leases).toHaveLength(1);
    expect(leases[0]?.record).toMatchObject({
      data: { id: matchingId },
      itemType: "runtime-lease",
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.input.RequestItems).toEqual({
      execution: {
        ConsistentRead: true,
        Keys: [
          {
            pk: `RUNTIME-LEASE#${matchingId}`,
            sk: `RUNTIME-LEASE#agent-run-thread%2F${matchingId}`,
          },
        ],
      },
    });
  });

  test("classifies legacy principal idempotency after its principal record was removed", async () => {
    const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const principalId = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
    const expiresAt = "2026-07-26T00:00:00.000Z";
    const legacy = withCanonicalRecordKeys({
      data: {
        commandHash: "legacy-command-hash",
        createdAt: "2026-07-25T00:00:00.000Z",
        expiresAt,
        idempotencyKey: "agent-api:legacy",
        principalId,
        resourceIds: [],
        response: {
          algorithm: "AES-256-GCM",
          authTag: "tag",
          ciphertext: "ciphertext",
          encryptedDataKey: "key",
          iv: "iv",
          kmsKeyArn: "arn:aws:kms:us-east-2:123456789012:key/idempotency",
        },
        responseEncoding: "protected-envelope-v1" as const,
        status: "completed" as const,
        version: 1,
      },
      itemType: "idempotency" as const,
      ttl: Math.floor(Date.parse(expiresAt) / 1_000),
    });
    const directory = governanceLegacyDirectoryRecord(legacy as never);
    if (!directory) throw new Error("Expected legacy idempotency directory record.");
    const contexts: unknown[] = [];
    const commands: unknown[] = [];
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: unknown) => {
          commands.push(command);
          if (command instanceof QueryCommand) return { Items: [directory] };
          if (command instanceof BatchGetCommand) return { Responses: { events: [legacy] } };
          return {};
        },
      } as unknown as DynamoDBDocumentClient,
      {
        control: "control",
        events: "events",
        execution: "execution",
        usage: "usage",
      },
      {
        idempotencyResponseProtector: {
          prepare: async () => {
            throw new Error("not used");
          },
          unprotect: async (_response, context) => {
            contexts.push(context);
            return { id: organizationId, name: "Legacy organization" };
          },
        },
      },
    );

    const records = await store.listLegacyPrincipalIdempotency(organizationId);

    expect(records).toEqual([{ record: legacy, table: "events" }]);
    expect(contexts).toEqual([
      {
        fingerprint: "legacy-command-hash",
        idempotencyKey: "agent-api:legacy",
        principalId,
      },
    ]);
    expect((commands[0] as QueryCommand).input).toMatchObject({
      ConsistentRead: true,
      KeyConditionExpression: "#legacy = :legacy",
      TableName: "control",
    });
    expect((commands[1] as BatchGetCommand).input.RequestItems).toEqual({
      events: {
        ConsistentRead: true,
        Keys: [{ pk: legacy.pk, sk: legacy.sk }],
      },
    });
  });

  test("durably scopes correlated legacy leases before erasure deletes their resources", async () => {
    const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const operationId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
    const leaseId = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid;
    const lease = withCanonicalRecordKeys({
      data: {
        acquiredAt: "2026-07-25T00:00:00.000Z",
        expiresAt: "2026-07-25T00:01:00.000Z",
        id: leaseId,
        leaseKey: `agent-run-thread/${leaseId}`,
        owner: "worker",
        version: 1,
      },
      itemType: "runtime-lease" as const,
    });
    const commands: unknown[] = [];
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: unknown) => {
          if (
            command instanceof GetCommand &&
            command.input.Key?.sk === "DEPLOY-MIGRATION#governance-inventory-shard-writes"
          ) {
            return {};
          }
          commands.push(command);
          return {};
        },
      } as unknown as DynamoDBDocumentClient,
      {
        control: "control",
        events: "events",
        execution: "execution",
        usage: "usage",
      },
    );

    await store.scopeLegacyRuntimeLeases(
      organizationId,
      [{ record: lease, table: "execution" }],
      operationId,
    );

    const transaction = commands[0] as TransactWriteCommand;
    expect(transaction.input.TransactItems).toHaveLength(4);
    expect(transaction.input.TransactItems?.[0]?.ConditionCheck).toMatchObject({
      ExpressionAttributeValues: { ":fenceOperationId": operationId },
      Key: {
        pk: `ORG#${organizationId}`,
        sk: `ERASURE-FENCE#${organizationId}`,
      },
      TableName: "control",
    });
    expect(
      transaction.input.TransactItems?.find((item) => item.Put?.Item?.itemType === "runtime-lease")
        ?.Put,
    ).toMatchObject({
      ConditionExpression:
        "attribute_not_exists(#data.#organizationId) AND #data.#version = :version AND #data.#expiresAt = :expiresAt AND #data.#owner = :owner",
      Item: {
        data: { id: leaseId, organizationId },
        itemType: "runtime-lease",
      },
      TableName: "execution",
    });
  });

  test("checks organization existence and conditionally releases its erasure fence", async () => {
    const commands: unknown[] = [];
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: unknown) => {
          commands.push(command);
          return {};
        },
      } as unknown as DynamoDBDocumentClient,
      {
        control: "control",
        events: "events",
        execution: "execution",
        usage: "usage",
      },
    );

    expect(store.organizationExists("01ARZ3NDEKTSV4RRFFQ69G5FAV")).resolves.toBe(false);
    await store.releaseErasureFence({
      createdAt: "2026-07-25T00:00:00.000Z",
      operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });

    const get = commands[0] as GetCommand;
    expect(get.input).toMatchObject({
      ConsistentRead: true,
      Key: {
        pk: "ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV",
        sk: "ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV",
      },
    });
    const release = commands.find(
      (command): command is TransactWriteCommand => command instanceof TransactWriteCommand,
    )!;
    const fenceDelete = release.input.TransactItems?.find(
      (item) => item.Delete?.Key?.sk === "ERASURE-FENCE#01ARZ3NDEKTSV4RRFFQ69G5FAV",
    )?.Delete;
    expect(fenceDelete?.ConditionExpression).toContain("#data.#operationId = :operationId");
    expect(fenceDelete?.Key).toEqual({
      pk: "ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV",
      sk: "ERASURE-FENCE#01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
  });
});
