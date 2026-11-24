import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";
import { makeDynamoGovernanceStore, withCanonicalRecordKeys } from "../index.ts";
import { describe, expect, test } from "bun:test";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const SHARD_WRITES_MARKER_READ = {
  ConsistentRead: true,
  Key: { pk: "GLOBAL#deploy-migration", sk: "DEPLOY-MIGRATION#governance-inventory-shard-writes" },
  TableName: "control",
};
const isShardWritesMarkerRead = (command: unknown) =>
  command instanceof GetCommand &&
  command.input.Key?.pk === SHARD_WRITES_MARKER_READ.Key.pk &&
  command.input.Key.sk === SHARD_WRITES_MARKER_READ.Key.sk;

const LANE_KEYS = Array.from({ length: 32 }, (_, lane) => ({
  pk: "ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV",
  sk: `ORGANIZATION-GATE-LANE#${String(lane).padStart(2, "0")}`,
}));

/** A client whose lane read returns the organization's 32 lanes at version 0, open and active. */
function clientWithStoredLanes(commands: unknown[]) {
  const lanes = LANE_KEYS.map((_, lane) =>
    withCanonicalRecordKeys({
      data: {
        createdAt: "2026-07-24T00:00:00.000Z",
        lane,
        memoryProviderGates: {},
        organization: { status: "active" },
        organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        updatedAt: "2026-07-24T00:00:00.000Z",
        version: 0,
      },
      itemType: "organization-gate-lane",
    }),
  );
  return {
    send: async (command: unknown) => {
      commands.push(command);
      return command instanceof QueryCommand ? { Items: lanes } : {};
    },
  } as unknown as DynamoDBDocumentClient;
}

function laneWrites(transaction: TransactWriteCommand) {
  return (transaction.input.TransactItems ?? []).filter((item) => {
    const sk = item.Put?.Item?.sk ?? item.Delete?.Key?.sk;
    return typeof sk === "string" && sk.startsWith("ORGANIZATION-GATE-LANE#");
  });
}

describe("governance AWS adapters", () => {
  test("queries the authoritative tenant directory during organization erasure", async () => {
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
        identity: "identity",
        "identity-email-outbox": "identity-email-outbox",
        usage: "usage",
      },
    );
    let cursor: string | undefined;
    do {
      const page = await store.listTenantRecords("01ARZ3NDEKTSV4RRFFQ69G5FAV", cursor);
      cursor = page.cursor;
    } while (cursor);

    const queries = commands.filter(
      (command): command is QueryCommand => command instanceof QueryCommand,
    );
    expect(queries.map(({ input }) => input.ExpressionAttributeValues?.[":inventory"])).toEqual([
      "ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV#GOVERNANCE-INVENTORY",
      ...Array.from(
        { length: 16 },
        (_, shard) =>
          `ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV#GOVERNANCE-INVENTORY#SHARD#${String(shard).padStart(2, "0")}`,
      ),
    ]);
    for (const query of queries) {
      expect(query.input).toMatchObject({
        ConsistentRead: true,
        KeyConditionExpression: "#inventory = :inventory",
        TableName: "control",
      });
      expect(query.input.IndexName).toBeUndefined();
    }
  });

  test("allows an expired retention lease to be atomically replaced", async () => {
    const commands: unknown[] = [];
    const store = makeDynamoGovernanceStore(clientWithStoredLanes(commands), {
      control: "control",
      events: "events",
      execution: "execution",
      usage: "usage",
    });

    await store.beginErasure({
      createdAt: "2026-07-25T00:00:00.000Z",
      leaseExpiresAt: "2026-07-25T00:30:00.000Z",
      operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });

    const [laneRead, markerRead, transaction] = commands as [
      QueryCommand,
      GetCommand,
      TransactWriteCommand,
    ];
    expect(markerRead.input).toEqual(SHARD_WRITES_MARKER_READ);
    expect(laneRead.input).toMatchObject({
      ConsistentRead: true,
      ExpressionAttributeValues: { ":pk": "ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      TableName: "control",
    });
    expect(transaction.input.TransactItems?.[1]?.Put).toMatchObject({
      ConditionExpression: "attribute_not_exists(pk) OR #data.#leaseExpiresAt <= :createdAt",
      ExpressionAttributeNames: {
        "#data": "data",
        "#leaseExpiresAt": "leaseExpiresAt",
      },
      ExpressionAttributeValues: {
        ":createdAt": "2026-07-25T00:00:00.000Z",
      },
      Item: {
        data: {
          leaseExpiresAt: "2026-07-25T00:30:00.000Z",
          operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        },
        itemType: "erasure-fence",
      },
    });
    const lanes = laneWrites(transaction);
    expect(lanes.map((item) => ({ pk: item.Put?.Item?.pk, sk: item.Put?.Item?.sk }))).toEqual(
      LANE_KEYS,
    );
    expect(lanes[0]?.Put).toEqual({
      ConditionExpression: "#data.#version = :previousVersion",
      ExpressionAttributeNames: { "#data": "data", "#version": "version" },
      ExpressionAttributeValues: { ":previousVersion": 0 },
      Item: {
        data: {
          createdAt: "2026-07-24T00:00:00.000Z",
          erasureFence: {
            leaseExpiresAt: "2026-07-25T00:30:00.000Z",
            operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
          },
          lane: 0,
          memoryProviderGates: {},
          organization: { status: "active" },
          organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          updatedAt: "2026-07-25T00:00:00.000Z",
          version: 1,
        },
        itemType: "organization-gate-lane",
        pk: "ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV",
        sk: "ORGANIZATION-GATE-LANE#00",
      },
      TableName: "control",
    });
  });

  test("atomically installs an operation-owned snapshot fence when claiming an export", async () => {
    const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const operationId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
    const commands: unknown[] = [];
    const store = makeDynamoGovernanceStore(clientWithStoredLanes(commands), {
      control: "control",
      events: "events",
      execution: "execution",
      usage: "usage",
    });

    await store.claimOperation(
      {
        createdAt: "2026-07-25T00:00:00.000Z",
        dispatchReadyAt: "2026-07-25T00:00:00.500Z",
        id: operationId,
        idempotencyKey: "snapshot-export",
        kind: "tenant-export",
        organizationId,
        requestedByPrincipalId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        status: "running",
        updatedAt: "2026-07-25T00:00:01.000Z",
        version: 2,
      },
      1,
    );

    const transaction = commands[2] as TransactWriteCommand;
    expect((commands[0] as GetCommand).input).toEqual(SHARD_WRITES_MARKER_READ);
    expect(commands[1]).toBeInstanceOf(QueryCommand);
    expect(transaction.input.TransactItems?.[0]?.Put).toMatchObject({
      ConditionExpression:
        "attribute_not_exists(pk) OR #data.#operationId = :operationId OR #data.#leaseExpiresAt <= :observedAt",
      ExpressionAttributeValues: {
        ":observedAt": "2026-07-25T00:00:01.000Z",
        ":operationId": operationId,
      },
      Item: {
        data: { operationId, organizationId },
        itemType: "erasure-fence",
        pk: `ORG#${organizationId}`,
        sk: `ERASURE-FENCE#${organizationId}`,
      },
      TableName: "control",
    });
    expect(
      transaction.input.TransactItems?.find(
        (item) => item.Put?.Item?.itemType === "governance-operation",
      )?.Put,
    ).toMatchObject({
      ConditionExpression:
        "#data.#version = :previousVersion AND attribute_exists(#data.#dispatchReadyAt)",
      ExpressionAttributeValues: { ":previousVersion": 1 },
      TableName: "control",
    });
    const lanes = laneWrites(transaction);
    expect(lanes.map((item) => item.Put?.Item?.sk)).toEqual(LANE_KEYS.map((key) => key.sk));
    expect(lanes.map((item) => item.Put?.Item?.data.erasureFence)).toEqual(
      LANE_KEYS.map(() => ({ operationId })),
    );
  });

  test("allows an already-running operation to finish behind a later tenant fence", async () => {
    const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const operationId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
    const commands: unknown[] = [];
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: unknown) => {
          if (isShardWritesMarkerRead(command)) return {};
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

    await store.updateOperation(
      {
        completedAt: "2026-07-25T00:02:00.000Z",
        createdAt: "2026-07-25T00:00:00.000Z",
        dispatchReadyAt: "2026-07-25T00:00:00.500Z",
        id: operationId,
        idempotencyKey: "snapshot-export",
        kind: "tenant-export",
        organizationId,
        requestedByPrincipalId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        status: "completed",
        updatedAt: "2026-07-25T00:02:00.000Z",
        version: 3,
      },
      2,
    );

    const transaction = commands[0] as TransactWriteCommand;
    expect(transaction.input.TransactItems).toHaveLength(3);
    expect(transaction.input.TransactItems?.[0]?.ConditionCheck?.Key).toEqual({
      pk: `ORG#${organizationId}`,
      sk: `ORG#${organizationId}`,
    });
    expect(
      transaction.input.TransactItems?.find(
        (item) => item.Put?.Item?.itemType === "governance-operation",
      )?.Put,
    ).toMatchObject({
      ConditionExpression: "#data.#version = :previousVersion AND #data.#status = :running",
      ExpressionAttributeValues: {
        ":previousVersion": 2,
        ":running": "running",
      },
      TableName: "control",
    });
  });

  test("maps a raced singleton erasure request to replay or requester conflict", async () => {
    const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const operationId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
    const requesterId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
    const existing = withCanonicalRecordKeys({
      data: {
        createdAt: "2026-07-25T00:00:00.000Z",
        id: operationId,
        idempotencyKey: "first-erasure",
        kind: "tenant-erasure",
        organizationId,
        requestedByPrincipalId: requesterId,
        status: "pending",
        updatedAt: "2026-07-25T00:00:00.000Z",
        version: 1,
      },
      itemType: "governance-operation",
    });
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: unknown) => {
          if (command instanceof TransactWriteCommand) {
            throw Object.assign(new Error("raced"), {
              name: "TransactionCanceledException",
            });
          }
          if (command instanceof GetCommand) return { Item: existing };
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
    const request = {
      createdAt: "2026-07-25T00:00:00.000Z",
      id: operationId,
      idempotencyKey: "second-erasure",
      kind: "tenant-erasure" as const,
      organizationId,
      requestedByPrincipalId: requesterId,
      status: "pending" as const,
      updatedAt: "2026-07-25T00:00:00.000Z",
      version: 1,
    };

    expect(store.createOperation(request)).resolves.toMatchObject({
      id: operationId,
      requestedByPrincipalId: requesterId,
    });
    expect(
      store.createOperation({
        ...request,
        requestedByPrincipalId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
      }),
    ).rejects.toMatchObject({ code: "tenant_erasure_already_requested" });
  });

  test("atomically fences retention policy creates and updates against erasure", async () => {
    const commands: unknown[] = [];
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: unknown) => {
          if (isShardWritesMarkerRead(command)) return {};
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
    const policy = {
      artifacts: 30,
      audit: 2_555,
      createdAt: "2026-07-25T00:00:00.000Z",
      events: 30,
      messages: 30,
      organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      runs: 30,
      threads: 30,
      updatedAt: "2026-07-25T00:00:00.000Z",
      updatedByPrincipalId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      version: 1,
    };

    await store.putRetentionPolicy(policy);
    await store.putRetentionPolicy({ ...policy, version: 2 }, 1);

    expect(commands).toHaveLength(2);
    const create = commands[0] as TransactWriteCommand;
    expect(create.input.TransactItems?.[0]?.ConditionCheck).toMatchObject({
      ConditionExpression:
        "attribute_not_exists(pk) OR #fenceData.#fenceLeaseExpiresAt <= :fenceObservedAt",
      ExpressionAttributeNames: {
        "#fenceData": "data",
        "#fenceLeaseExpiresAt": "leaseExpiresAt",
      },
      Key: {
        pk: "ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV",
        sk: "ERASURE-FENCE#01ARZ3NDEKTSV4RRFFQ69G5FAV",
      },
      TableName: "control",
    });
    expect(
      Date.parse(
        String(
          create.input.TransactItems?.[0]?.ConditionCheck?.ExpressionAttributeValues?.[
            ":fenceObservedAt"
          ],
        ),
      ),
    ).toBeNumber();
    expect(create.input.TransactItems?.[1]?.ConditionCheck).toMatchObject({
      ConditionExpression: "attribute_exists(pk)",
      Key: {
        pk: "ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV",
        sk: "ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV",
      },
    });
    expect(create.input.TransactItems?.[2]?.Put?.ConditionExpression).toBe(
      "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    );
    const update = commands[1] as TransactWriteCommand;
    expect(update.input.TransactItems?.[2]?.Put).toMatchObject({
      ConditionExpression: "#data.#version = :previousVersion",
      ExpressionAttributeValues: { ":previousVersion": 1 },
      TableName: "control",
    });
  });

  test("allows only the erasure fence owner to cancel a stale governance operation", async () => {
    const commands: unknown[] = [];
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: unknown) => {
          if (isShardWritesMarkerRead(command)) return {};
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

    await store.cancelOperationForErasure(
      {
        createdAt: "2026-07-25T00:00:00.000Z",
        error: { code: "operation_canceled_by_erasure" },
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
        idempotencyKey: "stale-export",
        kind: "tenant-export",
        organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        requestedByPrincipalId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        status: "canceled",
        updatedAt: "2026-07-25T00:02:00.000Z",
        version: 3,
      },
      2,
      "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    );

    const command = commands[0] as TransactWriteCommand;
    expect(command.input.TransactItems?.[0]?.ConditionCheck).toMatchObject({
      ConditionExpression: "#data.#operationId = :erasureOperationId",
      ExpressionAttributeValues: {
        ":erasureOperationId": "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      },
      Key: {
        pk: "ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV",
        sk: "ERASURE-FENCE#01ARZ3NDEKTSV4RRFFQ69G5FAV",
      },
    });
    expect(command.input.TransactItems?.[2]?.Put).toMatchObject({
      ConditionExpression: "#data.#version = :previousVersion",
      ExpressionAttributeValues: { ":previousVersion": 2 },
    });
  });

  test("reports an erasure fence that cancels a retention policy transaction", async () => {
    const commands: unknown[] = [];
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: unknown) => {
          commands.push(command);
          if (isShardWritesMarkerRead(command)) return {};
          if (command instanceof TransactWriteCommand) {
            throw Object.assign(new Error("transaction canceled"), {
              name: "TransactionCanceledException",
            });
          }
          return { Item: { fence: true } };
        },
      } as unknown as DynamoDBDocumentClient,
      {
        control: "control",
        events: "events",
        execution: "execution",
        usage: "usage",
      },
    );

    expect(
      store.putRetentionPolicy({
        artifacts: 30,
        audit: 2_555,
        createdAt: "2026-07-25T00:00:00.000Z",
        events: 30,
        messages: 30,
        organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        runs: 30,
        threads: 30,
        updatedAt: "2026-07-25T00:00:00.000Z",
        updatedByPrincipalId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        version: 1,
      }),
    ).rejects.toMatchObject({ code: "tenant_erasure_in_progress" });
    expect((commands[0] as GetCommand).input).toEqual(SHARD_WRITES_MARKER_READ);
    expect(commands[2]).toBeInstanceOf(GetCommand);
    expect((commands[2] as GetCommand).input).toMatchObject({
      ConsistentRead: true,
      Key: {
        pk: "ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV",
        sk: "ERASURE-FENCE#01ARZ3NDEKTSV4RRFFQ69G5FAV",
      },
    });
  });

  test("atomically replaces a tenant erasure operation with its pseudonymous receipt", async () => {
    const commands: unknown[] = [];
    const store = makeDynamoGovernanceStore(clientWithStoredLanes(commands), {
      control: "control",
      events: "events",
      execution: "execution",
      usage: "usage",
    });

    await store.finalizeErasure(
      {
        createdAt: "2026-07-25T00:00:00.000Z",
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        idempotencyKey: "erase",
        kind: "tenant-erasure",
        organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        requestedByPrincipalId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        startedAt: "2026-07-25T00:01:00.000Z",
        status: "running",
        updatedAt: "2026-07-25T00:01:00.000Z",
        version: 2,
      },
      {
        auditRootHash: "0".repeat(64),
        completedAt: "2026-07-25T00:02:00.000Z",
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        organizationHash: sha256("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
        recordsDeleted: 42,
        requestedByPrincipalHash: sha256("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
      },
      2,
    );

    const command = commands[1] as TransactWriteCommand;
    expect(commands[0]).toBeInstanceOf(QueryCommand);
    expect(command).toBeInstanceOf(TransactWriteCommand);
    expect(command.input.TransactItems).toHaveLength(10 + 32);
    expect(
      command.input.TransactItems?.filter((item) =>
        String(item.Delete?.Key?.sk).startsWith("RECORD#"),
      ).map((item) => item.Delete?.Key?.pk),
    ).toEqual([
      "ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV#GOVERNANCE-INVENTORY",
      "ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV#GOVERNANCE-INVENTORY#SHARD#02",
      "ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV#GOVERNANCE-INVENTORY",
      "ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV#GOVERNANCE-INVENTORY#SHARD#01",
      "ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV#GOVERNANCE-INVENTORY",
      "ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV#GOVERNANCE-INVENTORY#SHARD#10",
    ]);
    expect(laneWrites(command).map((item) => item.Delete)).toEqual(
      LANE_KEYS.map((key) => ({
        ConditionExpression: "#data.#version = :previousVersion",
        ExpressionAttributeNames: { "#data": "data", "#version": "version" },
        ExpressionAttributeValues: { ":previousVersion": 0 },
        Key: key,
        TableName: "control",
      })),
    );
    expect(command.input.TransactItems?.[0]?.Put?.Item).not.toHaveProperty("data.organizationId");
    expect(
      command.input.TransactItems?.find(
        (item) => item.Delete?.Key?.sk === "GOVERNANCE-OPERATION#01ARZ3NDEKTSV4RRFFQ69G5FAX",
      )?.Delete,
    ).toMatchObject({
      ConditionExpression: "#data.#version = :previousVersion",
    });
    expect(
      command.input.TransactItems?.find(
        (item) => item.Delete?.Key?.sk === "ERASURE-FENCE#01ARZ3NDEKTSV4RRFFQ69G5FAV",
      )?.Delete,
    ).toMatchObject({
      ConditionExpression: "#data.#operationId = :operationId",
    });
    expect(
      command.input.TransactItems?.find(
        (item) => item.Delete?.Key?.sk === "ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV",
      )?.Delete,
    ).toMatchObject({
      ConditionExpression: "#itemType = :organization AND #data.#id = :organizationId",
      ExpressionAttributeValues: {
        ":organization": "organization",
        ":organizationId": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      },
      Key: {
        pk: "ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV",
        sk: "ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV",
      },
    });
  });

  test("atomically stages retention cleanup and skips changed candidates", async () => {
    const commands: TransactWriteCommand[] = [];
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: TransactWriteCommand) => {
          if (isShardWritesMarkerRead(command)) return {};
          commands.push(command);
          if (commands.length === 2) {
            throw Object.assign(new Error("changed"), {
              name: "TransactionCanceledException",
            });
          }
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
    const candidates = [
      {
        record: {
          data: { updatedAt: "2025-01-01T00:00:00.000Z", version: 3 },
          itemType: "thread",
          pk: "thread-1",
          sk: "thread-1",
        },
        table: "execution",
      },
      {
        record: {
          data: { createdAt: "2025-01-01T00:00:00.000Z" },
          itemType: "message",
          pk: "message-1",
          sk: "message-1",
        },
        table: "execution",
      },
    ] as const;

    const cleanup = (id: string) => ({
      createdAt: "2026-07-25T00:00:00.000Z",
      id,
      organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      references: [],
      sourceItemType: "thread",
      sourcePk: id,
      sourceSk: id,
      sourceTable: "execution" as const,
    });
    const first = await store.stageRetentionCleanup(candidates[0] as never, cleanup("cleanup-1"));
    const second = await store.stageRetentionCleanup(candidates[1] as never, cleanup("cleanup-2"));
    const fenced = await store.stageRetentionCleanup(
      candidates[0] as never,
      cleanup("cleanup-3"),
      "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    );

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(fenced).toBe(true);
    expect(
      commands[0]?.input.TransactItems?.find(
        (item) => item.Delete?.Key?.pk === "thread-1" && item.Delete.Key.sk === "thread-1",
      )?.Delete,
    ).toMatchObject({
      ConditionExpression: "#data.#field = :expected",
      ExpressionAttributeNames: { "#field": "version" },
      ExpressionAttributeValues: { ":expected": 3 },
    });
    expect(
      commands[1]?.input.TransactItems?.find(
        (item) => item.Delete?.Key?.pk === "message-1" && item.Delete.Key.sk === "message-1",
      )?.Delete?.ExpressionAttributeNames,
    ).toMatchObject({ "#field": "createdAt" });
    expect(commands[2]?.input.TransactItems?.[0]?.ConditionCheck).toMatchObject({
      ConditionExpression: "#data.#operationId = :fenceOperationId",
      ExpressionAttributeValues: {
        ":fenceOperationId": "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      },
    });
  });
});
