import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  governanceLegacyDirectoryRecord,
  makeDynamoGovernanceStore,
  makeUniqueClaimRecord,
  uniqueClaimRequirements,
  type PlatformRecord,
} from "../index.ts";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

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

describe("governance AWS adapters", () => {
  test("deletes run locators and unique claims with retention candidates", async () => {
    const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const environmentId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
    const projectId = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
    const runId = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    const run = {
      data: {
        createdAt: "2025-01-01T00:00:00.000Z",
        environmentId,
        id: runId,
        organizationId,
        projectId,
        version: 3,
      },
      itemType: "run",
      pk: "run-pk",
      sk: "run-sk",
    } as PlatformRecord;
    const sandbox = {
      data: {
        externalSandboxId: "sandbox-external-id",
        id: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
        organizationId,
        provider: "aws_lambda_microvm",
        providerRouteKey: "default",
        updatedAt: "2025-01-01T00:00:00.000Z",
        version: 2,
      },
      itemType: "sandbox-lease",
      pk: "sandbox-pk",
      sk: "sandbox-sk",
    } as PlatformRecord;
    const [sandboxClaim] = uniqueClaimRequirements(sandbox);
    const claimRecord = makeUniqueClaimRecord(sandboxClaim!, "2026-07-25T00:00:00.000Z");
    const commands: TransactWriteCommand[] = [];
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: TransactWriteCommand) => {
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
    const cleanup = (record: PlatformRecord) => ({
      createdAt: "2026-07-25T00:00:00.000Z",
      id: `cleanup-${record.itemType}`,
      organizationId,
      references: [],
      sourceItemType: record.itemType,
      sourcePk: record.pk,
      sourceSk: record.sk,
      sourceTable: "execution" as const,
    });

    await store.stageRetentionCleanup(
      { record: run, table: "execution" },
      cleanup(run),
      "01ARZ3NDEKTSV4RRFFQ69G5FB1",
    );
    await store.stageRetentionCleanup(
      { record: sandbox, table: "execution" },
      cleanup(sandbox),
      "01ARZ3NDEKTSV4RRFFQ69G5FB1",
    );

    expect(
      commands[0]?.input.TransactItems?.find(
        (item) => item.Delete?.Key?.sk === `RUN-LOCATOR#${runId}`,
      )?.Delete,
    ).toMatchObject({
      Key: {
        pk: `ORG#${organizationId}#ENV#${environmentId}`,
        sk: `RUN-LOCATOR#${runId}`,
      },
      TableName: "control",
    });
    const claimDelete = commands[1]?.input.TransactItems?.find(
      (item) => item.Delete?.Key?.pk === claimRecord.pk && item.Delete.Key.sk === claimRecord.sk,
    )?.Delete;
    expect(claimDelete).toMatchObject({
      Key: { pk: claimRecord.pk, sk: claimRecord.sk },
      TableName: "control",
    });
    expect(claimDelete?.ConditionExpression).toContain("#dbClaimOwnerId");
  });

  test("deletes generated dependents during tenant erasure", async () => {
    const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const environmentId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
    const runId = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    const run = {
      data: {
        createdAt: "2025-01-01T00:00:00.000Z",
        environmentId,
        id: runId,
        organizationId,
        projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
        version: 3,
      },
      itemType: "run",
      pk: "run-pk",
      sk: "run-sk",
    } as PlatformRecord;
    const sandbox = {
      data: {
        externalSandboxId: "sandbox-external-id",
        id: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
        organizationId,
        provider: "aws_lambda_microvm",
        providerRouteKey: "default",
        updatedAt: "2025-01-01T00:00:00.000Z",
        version: 2,
      },
      itemType: "sandbox-lease",
      pk: "sandbox-pk",
      sk: "sandbox-sk",
    } as PlatformRecord;
    const [sandboxClaim] = uniqueClaimRequirements(sandbox);
    const claimRecord = makeUniqueClaimRecord(sandboxClaim!, "2026-07-25T00:00:00.000Z");
    const commands: TransactWriteCommand[] = [];
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: TransactWriteCommand) => {
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

    await store.deleteTenantRecords(
      [
        { record: run, table: "execution" },
        { record: sandbox, table: "execution" },
      ],
      "2026-07-25T00:15:00.000Z",
    );

    expect(commands).toHaveLength(2);
    expect(
      commands[0]?.input.TransactItems?.find(
        (item) => item.Delete?.Key?.sk === `RUN-LOCATOR#${runId}`,
      )?.Delete,
    ).toMatchObject({
      Key: {
        pk: `ORG#${organizationId}#ENV#${environmentId}`,
        sk: `RUN-LOCATOR#${runId}`,
      },
      TableName: "control",
    });
    expect(
      commands[1]?.input.TransactItems?.find(
        (item) => item.Delete?.Key?.pk === claimRecord.pk && item.Delete.Key.sk === claimRecord.sk,
      )?.Delete,
    ).toMatchObject({
      ConditionExpression: expect.stringContaining("#dbClaimOwnerId"),
      Key: { pk: claimRecord.pk, sk: claimRecord.sk },
      TableName: "control",
    });
    expect(
      commands[1]?.input.TransactItems?.find(
        (item) => item.Delete?.Key?.pk === sandbox.pk && item.Delete.Key.sk === sandbox.sk,
      )?.Delete,
    ).toMatchObject({
      Key: { pk: sandbox.pk, sk: sandbox.sk },
      TableName: "execution",
    });
    expect(commands.every((command) => command.input.ClientRequestToken !== undefined)).toBe(true);
  });

  test("deletes legacy idempotency records with their global directory locators", async () => {
    const legacyIdempotency = {
      data: {
        idempotencyKey: "agent-api:legacy",
        principalId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      },
      itemType: "idempotency",
      pk: "legacy-idempotency-pk",
      sk: "legacy-idempotency-sk",
    } as PlatformRecord;
    const legacyDirectory = governanceLegacyDirectoryRecord(legacyIdempotency);
    if (!legacyDirectory) throw new Error("Expected a legacy governance directory record.");
    const commands: TransactWriteCommand[] = [];
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: TransactWriteCommand) => {
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
      {
        batchWriteSleep: async () => undefined,
        now: () => new Date("2026-07-25T00:00:00.000Z"),
      },
    );

    expect(
      store.deleteTenantRecords(
        [{ record: legacyIdempotency, table: "events" }],
        "2026-07-25T00:15:00.000Z",
      ),
    ).resolves.toBeUndefined();

    expect(commands).toHaveLength(1);
    expect(commands[0]?.input.TransactItems).toEqual([
      {
        Delete: {
          Key: { pk: legacyIdempotency.pk, sk: legacyIdempotency.sk },
          TableName: "events",
        },
      },
      {
        Delete: {
          Key: { pk: legacyDirectory.pk, sk: legacyDirectory.sk },
          TableName: "control",
        },
      },
    ]);
  });

  test("materializes tenant erasure records once before batching", async () => {
    const accesses = Array.from({ length: 51 }, () => 0);
    const records = accesses.map((_, index) => {
      const record = {
        data: { id: `thread-${index}`, organizationId: "organization-id" },
        itemType: "thread",
        pk: `thread-pk-${index}`,
        sk: `thread-sk-${index}`,
      } as PlatformRecord;
      return {
        get record() {
          accesses[index] = accesses[index]! + 1;
          return record;
        },
        table: "execution" as const,
      };
    });
    const commands: TransactWriteCommand[] = [];
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: TransactWriteCommand) => {
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

    await store.deleteTenantRecords(records, "2026-07-25T00:15:00.000Z");

    expect(commands).toHaveLength(2);
    expect(accesses.every((count) => count === 1)).toBe(true);
  });

  test("does not delete a reassigned claim when replaying a completed owner transaction", async () => {
    const sandbox = {
      data: {
        externalSandboxId: "sandbox-external-id",
        id: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
        organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        provider: "aws_lambda_microvm",
        providerRouteKey: "default",
        updatedAt: "2025-01-01T00:00:00.000Z",
        version: 2,
      },
      itemType: "sandbox-lease",
      pk: "sandbox-pk",
      sk: "sandbox-sk",
    } as PlatformRecord;
    const commands: unknown[] = [];
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: unknown) => {
          commands.push(command);
          if (command instanceof TransactWriteCommand) {
            throw Object.assign(new Error("claim now belongs to another tenant"), {
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

    expect(
      store.deleteTenantRecords(
        [{ record: sandbox, table: "execution" }],
        "2026-07-25T00:15:00.000Z",
      ),
    ).resolves.toBeUndefined();

    expect(commands).toHaveLength(2);
    expect(commands[0]).toBeInstanceOf(TransactWriteCommand);
    expect(commands[1]).toBeInstanceOf(GetCommand);
    expect((commands[1] as GetCommand).input).toMatchObject({
      ConsistentRead: true,
      Key: { pk: sandbox.pk, sk: sandbox.sk },
      TableName: "execution",
    });
  });

  test("backs off and bounds unprocessed tenant erasure deletes", async () => {
    const commands: TransactWriteCommand[] = [];
    const retryDelays: number[] = [];
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: TransactWriteCommand) => {
          if (isShardWritesMarkerRead(command)) return {};
          commands.push(command);
          throw Object.assign(new Error("throttled"), {
            name: "ProvisionedThroughputExceededException",
          });
        },
      } as unknown as DynamoDBDocumentClient,
      {
        control: "control",
        events: "events",
        execution: "execution",
        usage: "usage",
      },
      {
        batchWriteRandom: () => 0.5,
        batchWriteSleep: async (milliseconds) => {
          retryDelays.push(milliseconds);
        },
        now: () => new Date("2026-07-25T00:00:00.000Z"),
      },
    );

    expect(
      store.deleteTenantRecords(
        [
          {
            record: {
              data: { id: "thread-id", organizationId: "organization-id" },
              itemType: "thread",
              pk: "thread-pk",
              sk: "thread-sk",
            } as PlatformRecord,
            table: "execution",
          },
        ],
        "2026-07-25T00:15:00.000Z",
      ),
    ).rejects.toMatchObject({ code: "tenant_erasure_delete_deferred" });

    expect(commands).toHaveLength(8);
    expect(retryDelays).toHaveLength(7);
    expect(retryDelays.every((delay) => delay > 0 && delay <= 1_000)).toBe(true);
  });

  test("atomically replaces a partial audit export with erasure cleanup metadata", async () => {
    const commands: TransactWriteCommand[] = [];
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: TransactWriteCommand) => {
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
    const item = {
      record: {
        data: {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
          kind: "audit-export",
          version: 5,
        },
        itemType: "governance-operation",
        pk: "operation-pk",
        sk: "operation-sk",
      },
      table: "control",
    } as never;
    const cleanup = {
      createdAt: "2026-07-25T00:00:00.000Z",
      id: "cleanup-audit",
      notBefore: "2033-07-23T00:00:00.000Z",
      organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      references: [],
      sourceItemType: "governance-operation",
      sourcePk: "operation-pk",
      sourceSk: "operation-sk",
      sourceTable: "control" as const,
    };

    await store.stageErasureRetentionCleanup(item, cleanup, "01ARZ3NDEKTSV4RRFFQ69G5FAX");

    const transaction = commands[0]?.input.TransactItems;
    expect(transaction?.[0]?.ConditionCheck).toMatchObject({
      ConditionExpression: "#data.#operationId = :erasureOperationId",
      ExpressionAttributeValues: {
        ":erasureOperationId": "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      },
    });
    expect(
      transaction?.find((entry) => entry.Put?.Item?.itemType === "retention-cleanup")?.Put?.Item,
    ).toMatchObject({
      data: { notBefore: "2033-07-23T00:00:00.000Z" },
      itemType: "retention-cleanup",
    });
    expect(
      transaction?.find(
        (entry) =>
          entry.Delete?.Key?.pk === "operation-pk" && entry.Delete.Key.sk === "operation-sk",
      )?.Delete,
    ).toMatchObject({
      ConditionExpression: "#data.#version = :version",
      ExpressionAttributeValues: { ":version": 5 },
    });
  });

  test("stages immutable audit cleanup after the canonical organization is erased", async () => {
    const commands: TransactWriteCommand[] = [];
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: TransactWriteCommand) => {
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
    const cleanup = {
      createdAt: "2033-07-24T00:00:00.000Z",
      id: "cleanup-audit",
      organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      references: [],
      sourceItemType: "immutable-audit-export",
      sourcePk: "audit-export",
      sourceSk: "audit-export",
      sourceTable: "events" as const,
    };

    expect(
      store.stageRetentionCleanup(
        {
          record: {
            data: {
              createdAt: "2026-07-25T00:00:00.000Z",
              id: "audit-export",
              retainedUntil: "2033-07-23T00:00:00.000Z",
            },
            itemType: "immutable-audit-export",
            pk: "audit-export",
            sk: "audit-export",
          },
          table: "events",
        } as never,
        cleanup,
      ),
    ).resolves.toBe(true);

    const transaction = commands[0]?.input.TransactItems;
    expect(transaction).toHaveLength(6);
    expect(transaction?.[0]?.ConditionCheck?.Key).toEqual({
      pk: "ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV",
      sk: "ERASURE-FENCE#01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
    expect(
      transaction?.find((entry) => entry.Put?.Item?.itemType === "retention-cleanup")?.Put?.Item,
    ).toMatchObject({
      itemType: "retention-cleanup",
    });
    expect(
      transaction?.find(
        (entry) =>
          entry.Delete?.Key?.pk === "audit-export" && entry.Delete.Key.sk === "audit-export",
      )?.Delete?.TableName,
    ).toBe("events");
  });

  test("reconciles an identical immutable audit record after a partial retry", async () => {
    const commands: unknown[] = [];
    let persisted: Record<string, unknown> | undefined;
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: unknown) => {
          commands.push(command);
          if (isShardWritesMarkerRead(command)) return {};
          if (command instanceof TransactWriteCommand) {
            persisted = command.input.TransactItems?.find(
              (item) => item.Put?.Item?.itemType === "immutable-audit-export",
            )?.Put?.Item;
            throw Object.assign(new Error("already committed"), {
              name: "TransactionCanceledException",
            });
          }
          if (command instanceof GetCommand) return { Item: persisted };
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
    const reference = {
      bucket: "governance",
      key: "governance/org/archive.jsonl",
      sha256: sha256("archive"),
      sizeBytes: 7,
      versionId: "version-1",
    };

    expect(
      store.appendImmutableAuditExport(
        {
          algorithm: "sha256-chain-v1",
          archive: reference,
          createdAt: "2026-07-25T00:00:00.000Z",
          createdByPrincipalId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
          object: {
            ...reference,
            key: "governance/org/manifest.json",
            sha256: sha256("manifest"),
          },
          organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          recordCount: 0,
          retainedUntil: "2033-07-23T00:00:00.000Z",
          rootHash: "0".repeat(64),
          signature: "signature",
          signatureKeyId: "signing-key",
          signaturePublicKey: "base64-der-public-key",
        },
        {
          createdAt: "2026-07-25T00:00:00.000Z",
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
          idempotencyKey: "audit-export",
          kind: "audit-export",
          leaseExpiresAt: "2026-07-25T00:16:00.000Z",
          organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          requestedByPrincipalId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
          status: "running",
          updatedAt: "2026-07-25T00:01:00.000Z",
          version: 5,
        },
        "2026-07-25T00:02:00.000Z",
      ),
    ).resolves.toBeUndefined();
    expect((commands[0] as GetCommand).input).toEqual(SHARD_WRITES_MARKER_READ);
    expect(commands[1]).toBeInstanceOf(TransactWriteCommand);
    expect(
      (commands[1] as TransactWriteCommand).input.TransactItems?.[0]?.ConditionCheck,
    ).toMatchObject({
      ConditionExpression:
        "#data.#version = :operationVersion AND #data.#status = :running AND #data.#leaseExpiresAt > :observedAt",
      ExpressionAttributeValues: {
        ":observedAt": "2026-07-25T00:02:00.000Z",
        ":operationVersion": 5,
        ":running": "running",
      },
      Key: {
        pk: "ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV",
        sk: "GOVERNANCE-OPERATION#01ARZ3NDEKTSV4RRFFQ69G5FAX",
      },
    });
    expect(commands[2]).toBeInstanceOf(GetCommand);
  });
});
