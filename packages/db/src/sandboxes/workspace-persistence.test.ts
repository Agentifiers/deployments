import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  DatabaseError,
  type DynamoDatabaseService,
  type TransactionOperation,
} from "../client-types.ts";
import { Ulid } from "../ids.ts";
import {
  RecordDecodeError,
  tableForItemType,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "../records/index.ts";
import { MAX_SANDBOX_WORKSPACE_SNAPSHOT_BYTES, SandboxLeaseRecord } from "../records/sandboxes.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import { makeSandboxWorkspacePersistence } from "./workspace-persistence.ts";

const id = (suffix: string) =>
  Schema.decodeUnknownSync(Ulid)(`01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}`);
const organizationId = id("1");
const threadId = id("2");
const executionTargetId = id("3");
const executionTargetKind = "agent-deployment" as const;
const environmentId = id("4");
const projectId = id("6");
const leaseId = id("9");
const timestamp = "2026-09-29T12:00:00.000Z";
const workspaceKey = { executionTargetId, executionTargetKind, organizationId, threadId };
const bindingOwner = { executionTargetId, executionTargetKind: "execution-binding" as const };

function storageKey(table: string, pk: string, sk: string) {
  return `${table}\u0000${pk}\u0000${sk}`;
}

function memoryDatabase(seed: readonly PlatformRecord[] = []) {
  const records = new Map<string, PlatformRecord>(
    seed.map((record) => [
      storageKey(tableForItemType(record.itemType), record.pk, record.sk),
      record,
    ]),
  );
  const conflict = () =>
    new DatabaseError({
      cause: new Error("ConditionalCheckFailed"),
      message: "Conditional write failed.",
      operation: "transact-write",
      reason: "conflict",
      table: "execution",
    });
  const database = {
    getRecord: async (table: string, requested: { readonly pk: string; readonly sk: string }) =>
      records.get(storageKey(table, requested.pk, requested.sk)),
    transactWrite: async (operations: readonly TransactionOperation[]) => {
      for (const operation of operations) {
        if (operation.kind !== "put") continue;
        const existing = records.get(
          storageKey(
            tableForItemType(operation.record.itemType),
            operation.record.pk,
            operation.record.sk,
          ),
        );
        const previous = operation.previousRecord;
        const existingVersion =
          existing && "version" in existing.data ? existing.data.version : undefined;
        const previousVersion =
          previous && "version" in previous.data ? previous.data.version : undefined;
        const stale = previous
          ? existingVersion === undefined || existingVersion !== previousVersion
          : existing !== undefined;
        if (stale) throw conflict();
      }
      for (const operation of operations) {
        if (operation.kind !== "put") continue;
        records.set(
          storageKey(
            tableForItemType(operation.record.itemType),
            operation.record.pk,
            operation.record.sk,
          ),
          operation.record,
        );
      }
    },
  } as unknown as DynamoDatabaseService;
  return { database, records };
}

const workspaceData = {
  createdAt: timestamp,
  executionTargetId,
  executionTargetKind,
  environmentId,
  id: id("5"),
  organizationId,
  projectId,
  threadId,
  updatedAt: timestamp,
};

const snapshot = {
  bucket: "artifacts",
  byteSize: 4096,
  capturedAt: "2026-09-29T12:05:00.000Z",
  key: `organizations/${organizationId}/sandbox-workspaces/snapshot.tar.gz`,
  leaseId,
  sha256: "b".repeat(64),
  versionId: "s3-version-1",
};

describe("sandbox workspace persistence", () => {
  test("creates once and reads the committed workspace back", async () => {
    const memory = memoryDatabase();
    const persistence = makeSandboxWorkspacePersistence(memory.database);

    expect(await persistence.load(workspaceKey)).toBeUndefined();
    const created = await persistence.create(workspaceData);

    expect(created.data.version).toBe(0);
    expect(created.pk).toBe(`ORG#${organizationId}#THREAD#${threadId}`);
    expect(await persistence.load(workspaceKey)).toEqual(created);

    const duplicate = await persistence
      .create({ ...workspaceData, id: id("7") })
      .catch((error: unknown) => error);
    expect(isDatabaseWriteConflict(duplicate)).toBe(true);
    expect(await persistence.load(workspaceKey)).toEqual(created);
  });

  test("advances exactly one version and rejects stale replacements", async () => {
    const memory = memoryDatabase();
    const persistence = makeSandboxWorkspacePersistence(memory.database);
    const created = await persistence.create(workspaceData);

    const leased = await persistence.update(created, {
      ...created.data,
      leaseId,
      leaseRunId: id("8"),
    });
    const committed = await persistence.update(leased, {
      ...leased.data,
      leaseId: undefined,
      leaseRunId: undefined,
      snapshot,
      updatedAt: snapshot.capturedAt,
    });

    expect([leased.data.version, committed.data.version]).toEqual([1, 2]);
    expect(committed.data.leaseId).toBeUndefined();
    expect(await persistence.load(workspaceKey)).toEqual(committed);

    const stale = await persistence
      .update(leased, { ...leased.data, restoredLeaseId: leaseId })
      .catch((error: unknown) => error);
    expect(isDatabaseWriteConflict(stale)).toBe(true);
    expect(await persistence.load(workspaceKey)).toEqual(committed);
  });

  test("rejects invalid snapshots before writing", async () => {
    const memory = memoryDatabase();
    const persistence = makeSandboxWorkspacePersistence(memory.database);
    const created = await persistence.create(workspaceData);

    const oversized = await persistence
      .update(created, {
        ...created.data,
        snapshot: { ...snapshot, byteSize: MAX_SANDBOX_WORKSPACE_SNAPSHOT_BYTES + 1 },
      })
      .catch((error: unknown) => error);

    expect(oversized).toBeInstanceOf(RecordDecodeError);
    expect(await persistence.load(workspaceKey)).toEqual(created);
  });

  test("loads the sandbox lease named by the workspace", async () => {
    const lease = Schema.decodeUnknownSync(SandboxLeaseRecord)(
      withCanonicalRecordKeys({
        data: {
          computeUsageActive: true,
          createdAt: timestamp,
          executionTargetId,
          executionTargetKind,
          environmentId,
          externalSandboxId: "microvm-1",
          id: leaseId,
          isolationMode: "run-ephemeral" as const,
          organizationId,
          projectId,
          provider: "aws_lambda_microvm" as const,
          status: "ready" as const,
          updatedAt: timestamp,
          usageStartedAt: timestamp,
          version: 3,
        },
        itemType: "sandbox-lease" as const,
      }),
    );
    const memory = memoryDatabase([lease]);
    const persistence = makeSandboxWorkspacePersistence(memory.database);

    expect(await persistence.loadLease({ ...workspaceKey, leaseId })).toEqual(lease);
    expect(await persistence.loadLease({ ...workspaceKey, leaseId: id("A") })).toBeUndefined();
    expect(
      await persistence.loadLease({ ...bindingOwner, leaseId, organizationId }),
    ).toBeUndefined();
  });

  test("keeps an execution binding's workspace apart from a deployment with the same id", async () => {
    const memory = memoryDatabase();
    const persistence = makeSandboxWorkspacePersistence(memory.database);
    const deployment = await persistence.create(workspaceData);
    const binding = await persistence.create({ ...workspaceData, ...bindingOwner, id: id("7") });

    expect(binding.pk).toBe(deployment.pk);
    expect(binding.sk).not.toBe(deployment.sk);
    expect(await persistence.load(workspaceKey)).toEqual(deployment);
    expect(await persistence.load({ ...bindingOwner, organizationId, threadId })).toEqual(binding);
  });
});
