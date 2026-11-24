import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { DatabaseError, type DynamoDatabaseService } from "../client-types.ts";
import { Ulid } from "../ids.ts";
import { tableForItemType, type PlatformRecord } from "../records/index.ts";
import { makeWorkflowApprovalPersistence } from "./approval-persistence.ts";

const id = (value: string) => Schema.decodeUnknownSync(Ulid)(value);
const organizationId = id("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const projectId = id("01ARZ3NDEKTSV4RRFFQ69G5FAW");
const environmentId = id("01ARZ3NDEKTSV4RRFFQ69G5FAX");
const executionId = id("01ARZ3NDEKTSV4RRFFQ69G5FAY");
const attemptId = id("01ARZ3NDEKTSV4RRFFQ69G5FAZ");
const approvalId = id("01ARZ3NDEKTSV4RRFFQ69G5FB0");
const actorId = id("01ARZ3NDEKTSV4RRFFQ69G5FB1");

function storageKey(record: Pick<PlatformRecord, "itemType" | "pk" | "sk">) {
  return `${tableForItemType(record.itemType)}\u0000${record.pk}\u0000${record.sk}`;
}

function memoryDatabase() {
  const records = new Map<string, PlatformRecord>();
  const transactionTokens: (string | undefined)[] = [];
  const database = {
    getRecord: async (_table: string, requested: { readonly pk: string; readonly sk: string }) =>
      [...records.values()].find(
        (record) => record.pk === requested.pk && record.sk === requested.sk,
      ),
    transactWrite: async (
      operations: readonly {
        readonly kind: string;
        readonly record?: PlatformRecord;
        readonly previousRecord?: PlatformRecord;
      }[],
      clientRequestToken?: string,
    ) => {
      transactionTokens.push(clientRequestToken);
      for (const operation of operations) {
        if (operation.kind !== "put" || !operation.record) continue;
        const existing = records.get(storageKey(operation.record));
        if (
          (!operation.previousRecord && existing) ||
          (operation.previousRecord &&
            (!existing ||
              (existing.data as { readonly version?: number }).version !==
                (operation.previousRecord.data as { readonly version?: number }).version))
        ) {
          throw new DatabaseError({
            cause: new Error("conditional conflict"),
            message: "Conditional write failed.",
            operation: "transact-write",
            reason: "conflict",
            table: "execution",
          });
        }
      }
      for (const operation of operations) {
        if (operation.kind === "put" && operation.record) {
          records.set(storageKey(operation.record), operation.record);
        }
      }
    },
  } as unknown as DynamoDatabaseService;
  return { database, records, transactionTokens };
}

function generator() {
  let counter = 2;
  return async () => id(`01ARZ3NDEKTSV4RRFFQ69G5FB${counter++}`);
}

const input = {
  environmentId,
  id: approvalId,
  organizationId,
  projectId,
  prompt: "Approve deployment",
  requestedBy: { id: actorId, type: "service-account" as const },
  stepAttemptId: attemptId,
  workflowExecutionId: executionId,
};

describe("workflow approval persistence", () => {
  test("creates, replays, and resolves an approval exactly once", async () => {
    const memory = memoryDatabase();
    const approvals = makeWorkflowApprovalPersistence({
      database: memory.database,
      generateId: generator(),
      now: () => new Date("2026-07-31T12:00:00.000Z"),
    });
    const created = await approvals.create(input);
    const replay = await approvals.create(input);
    const resolved = await approvals.resolve({
      decision: "approved",
      organizationId,
      resolvedBy: { id: actorId, type: "service-account" },
      workflowApprovalId: approvalId,
      workflowExecutionId: executionId,
    });
    const resolvedReplay = await approvals.resolve({
      decision: "approved",
      organizationId,
      resolvedBy: { id: actorId, type: "service-account" },
      workflowApprovalId: approvalId,
      workflowExecutionId: executionId,
    });

    expect(created.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(resolved.data).toMatchObject({ status: "approved", version: 1 });
    expect(resolvedReplay).toEqual(resolved);
    expect(
      [...memory.records.values()].filter((record) => record.itemType === "semantic-event"),
    ).toHaveLength(2);
    expect(new Set(memory.transactionTokens.slice(0, 2)).size).toBe(2);
  });

  test("expires a logically elapsed approval and rejects a conflicting decision", async () => {
    const memory = memoryDatabase();
    const approvals = makeWorkflowApprovalPersistence({
      database: memory.database,
      generateId: generator(),
      now: () => new Date("2026-07-31T12:01:00.000Z"),
    });
    await approvals.create({ ...input, expiresAt: "2026-07-31T12:00:00.000Z" });
    const expired = await approvals.resolve({
      decision: "approved",
      organizationId,
      resolvedBy: { id: actorId, type: "service-account" },
      workflowApprovalId: approvalId,
      workflowExecutionId: executionId,
    });
    expect(expired.data.status).toBe("expired");
    expect(
      approvals.resolve({
        decision: "rejected",
        organizationId,
        resolvedBy: { id: actorId, type: "service-account" },
        workflowApprovalId: approvalId,
        workflowExecutionId: executionId,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  test("durably expires an approval when it is read after its deadline", async () => {
    const memory = memoryDatabase();
    const approvals = makeWorkflowApprovalPersistence({
      database: memory.database,
      generateId: generator(),
      now: () => new Date("2026-07-31T12:01:00.000Z"),
    });
    await approvals.create({ ...input, expiresAt: "2026-07-31T12:00:00.000Z" });

    expect(approvals.getStored(organizationId, executionId, approvalId)).resolves.toMatchObject({
      data: { status: "pending", version: 0 },
    });
    expect(approvals.get(organizationId, executionId, approvalId)).resolves.toMatchObject({
      data: { status: "expired", version: 1 },
    });
    expect(
      [...memory.records.values()].filter(
        (record) =>
          record.itemType === "semantic-event" &&
          record.data.eventType === "workflow-approval.resolved",
      ),
    ).toHaveLength(1);
  });

  test("serializes concurrent opposing resolutions", async () => {
    const memory = memoryDatabase();
    const approvals = makeWorkflowApprovalPersistence({
      database: memory.database,
      generateId: generator(),
    });
    await approvals.create(input);
    const decisions = await Promise.allSettled(
      (["approved", "rejected"] as const).map((decision) =>
        approvals.resolve({
          decision,
          organizationId,
          resolvedBy: { id: actorId, type: "service-account" },
          workflowApprovalId: approvalId,
          workflowExecutionId: executionId,
        }),
      ),
    );
    expect(decisions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(decisions.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(new Set(memory.transactionTokens.slice(-2)).size).toBe(2);
  });
});
