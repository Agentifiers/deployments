import { describe, expect, test } from "bun:test";
import { DatabaseError, type DynamoDatabaseService } from "../client-types.ts";
import { Ulid } from "../ids.ts";
import { tableForItemType, type PlatformRecord } from "../records/index.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { WorkflowExecutionRecord } from "../records/workflows.ts";
import { Schema } from "effect";
import { makeWorkflowExecutionPersistence } from "./execution-persistence.ts";

const ORGANIZATION_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const PROJECT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAW");
const ENVIRONMENT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAX");
const PRINCIPAL_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAY");
const DEFINITION_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAZ");
const RELEASE_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FB0");

function storageKey(record: Pick<PlatformRecord, "itemType" | "pk" | "sk">) {
  return `${tableForItemType(record.itemType)}\u0000${record.pk}\u0000${record.sk}`;
}

function memoryDatabase() {
  const records = new Map<string, PlatformRecord>();
  const transactions: unknown[][] = [];
  const database: DynamoDatabaseService = {
    deleteRecord: async (record) => void records.delete(storageKey(record)),
    getRecord: async (_table, recordKey) =>
      [...records.values()].find(
        (record) => record.pk === recordKey.pk && record.sk === recordKey.sk,
      ),
    putRecord: async (record) => void records.set(storageKey(record), record),
    queryRecords: async () => ({ items: [] }),
    transactWrite: async (operations) => {
      transactions.push([...operations]);
      for (const operation of operations) {
        if (operation.kind !== "put") continue;
        const existing = records.get(storageKey(operation.record));
        if (
          (!operation.previousRecord && !operation.allowExisting && existing) ||
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
        if (operation.kind === "put") records.set(storageKey(operation.record), operation.record);
        if (operation.kind === "delete") records.delete(storageKey(operation.record));
      }
    },
  };
  return { database, records, transactions };
}

function ids() {
  const values = [
    "01ARZ3NDEKTSV4RRFFQ69G5FB1",
    "01ARZ3NDEKTSV4RRFFQ69G5FB2",
    "01ARZ3NDEKTSV4RRFFQ69G5FB3",
    "01ARZ3NDEKTSV4RRFFQ69G5FB4",
  ].map((value) => Schema.decodeUnknownSync(Ulid)(value));
  return async () => values.shift()!;
}

const createInput = {
  entryStepId: "prepare",
  environmentId: ENVIRONMENT_ID,
  idempotencyKey: "workflow/request-1",
  initiatedBy: { id: PRINCIPAL_ID, type: "principal" as const },
  input: { version: "2026.07.31" },
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  workflowContentHash: `sha256:${"a".repeat(64)}`,
  workflowDefinitionId: DEFINITION_ID,
  workflowReleaseId: RELEASE_ID,
  workflowReleaseNumber: 1,
};

describe("workflow execution persistence", () => {
  test("creates one release-pinned execution and replays its idempotency key", async () => {
    const memory = memoryDatabase();
    const persistence = makeWorkflowExecutionPersistence({
      database: memory.database,
      generateId: ids(),
      now: () => new Date("2026-07-31T12:00:00.000Z"),
    });

    const created = await persistence.create(createInput);
    const replayed = await persistence.create(createInput);

    expect(created.created).toBe(true);
    expect(replayed.created).toBe(false);
    expect(replayed.execution.data.id).toBe(created.execution.data.id);
    expect(created.execution.data).toMatchObject({
      currentStepId: "prepare",
      status: "queued",
      version: 0,
      workflowReleaseId: RELEASE_ID,
    });
    expect(
      [...memory.records.values()].filter((record) => record.itemType === "semantic-event"),
    ).toHaveLength(1);
  });

  test("rejects reuse of an idempotency key with different input", async () => {
    const memory = memoryDatabase();
    const persistence = makeWorkflowExecutionPersistence({
      database: memory.database,
      generateId: ids(),
    });
    await persistence.create(createInput);

    expect(
      persistence.create({ ...createInput, input: { version: "different" } }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  test("conditions creation on the observed active control resources", async () => {
    const memory = memoryDatabase();
    const persistence = makeWorkflowExecutionPersistence({
      database: memory.database,
      generateId: ids(),
    });
    await persistence.create(createInput, {
      prerequisites: [{ pk: "release-pk", sk: "release-sk", version: 4 }],
    });

    expect(memory.transactions[0]).toContainEqual({
      conditionExpression: "#data.#status = :active AND #data.#version = :version",
      expressionAttributeNames: {
        "#data": "data",
        "#status": "status",
        "#version": "version",
      },
      expressionAttributeValues: { ":active": "active", ":version": 4 },
      key: { pk: "release-pk", sk: "release-sk" },
      kind: "condition-check",
      table: "control",
    });
  });

  test("commits one optimistic execution transition with its semantic event", async () => {
    const memory = memoryDatabase();
    const persistence = makeWorkflowExecutionPersistence({
      database: memory.database,
      generateId: ids(),
      now: () => new Date("2026-07-31T12:00:00.000Z"),
    });
    const { execution } = await persistence.create(createInput);
    const next = Schema.decodeUnknownSync(WorkflowExecutionRecord)(
      withCanonicalRecordKeys({
        ...execution,
        data: {
          ...execution.data,
          startedAt: "2026-07-31T12:00:01.000Z",
          status: "running",
          updatedAt: "2026-07-31T12:00:01.000Z",
          version: 1,
        },
      }),
    );

    await persistence.commitTransition({
      actor: { id: PRINCIPAL_ID, type: "service-account" },
      eventType: "workflow-execution.started",
      nextExecution: next,
      previousExecution: execution,
    });

    expect((await persistence.get(ORGANIZATION_ID, execution.data.id)).data.status).toBe("running");
    expect(
      [...memory.records.values()].filter((record) => record.itemType === "semantic-event"),
    ).toHaveLength(2);
    expect(
      [...memory.records.values()].find(
        (record) =>
          record.itemType === "semantic-event" &&
          record.data.eventType === "workflow-execution.started",
      ),
    ).toMatchObject({
      data: { actor: { id: PRINCIPAL_ID, type: "service-account" } },
    });
    expect(
      persistence.commitTransition({
        eventType: "workflow-execution.started",
        nextExecution: next,
        previousExecution: execution,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  test("rejects transitions that change the immutable release pin", async () => {
    const memory = memoryDatabase();
    const persistence = makeWorkflowExecutionPersistence({
      database: memory.database,
      generateId: ids(),
    });
    const { execution } = await persistence.create(createInput);
    const next = Schema.decodeUnknownSync(WorkflowExecutionRecord)(
      withCanonicalRecordKeys({
        ...execution,
        data: {
          ...execution.data,
          version: 1,
          workflowReleaseNumber: 2,
        },
      }),
    );

    expect(
      persistence.commitTransition({
        eventType: "workflow-execution.started",
        nextExecution: next,
        previousExecution: execution,
      }),
    ).rejects.toThrow(/immutable/u);
  });
});
