import { describe, expect, test } from "bun:test";

import {
  DatabaseError,
  PersistenceError,
  makeIdempotencyPersistence,
  tableForItemType,
  type DynamoDatabaseService,
  type IdempotencyResponseProtector,
  type PlatformRecord,
  type TransactionOperation,
} from "./index.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const responseProtector: IdempotencyResponseProtector = {
  prepare: async () => ({
    dispose: () => undefined,
    protect: async (value) =>
      value === undefined ? { kind: "undefined" } : { kind: "value", value },
  }),
  unprotect: async (value) => (value.kind === "undefined" ? undefined : value.value),
};

function storageKey(record: PlatformRecord) {
  return `${tableForItemType(record.itemType)}\u0000${record.pk}\u0000${record.sk}`;
}

function makeDatabase() {
  const records = new Map<string, PlatformRecord>();
  const database: DynamoDatabaseService = {
    deleteRecord: async (record) => {
      records.delete(storageKey(record));
    },
    getRecord: async (table, key) => {
      const record = records.get(`${table}\u0000${key.pk}\u0000${key.sk}`);
      return record ? structuredClone(record) : undefined;
    },
    putRecord: async (record) => {
      records.set(storageKey(record), structuredClone(record));
    },
    queryRecords: async () => ({ items: [] }),
    transactWrite: async (operations: readonly TransactionOperation[]) => {
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        if (operation.kind === "delete") {
          records.delete(storageKey(operation.record));
        } else {
          records.set(storageKey(operation.record), structuredClone(operation.record));
        }
      }
    },
  };
  return { database, records };
}

describe("idempotency persistence", () => {
  test("replays completed responses and rejects fingerprint reuse", async () => {
    const storage = makeDatabase();
    const persistence = makeIdempotencyPersistence({
      database: storage.database,
      now: () => new Date("2026-07-24T12:00:00.000Z"),
      responseProtector,
    });
    let calls = 0;
    const input = {
      fingerprint: "fingerprint-one",
      key: "request-key",
      operation: async () => {
        calls += 1;
        return { id: "result" };
      },
      organizationId: ORGANIZATION_ID,
      principalId: PRINCIPAL_ID,
    };

    expect(await persistence.execute(input)).toEqual({ id: "result" });
    expect(await persistence.execute(input)).toEqual({ id: "result" });
    expect(calls).toBe(1);
    expect(
      [...storage.records.values()].find((record) => record.itemType === "idempotency")?.pk,
    ).toBe(`ORG#${ORGANIZATION_ID}`);
    expect(persistence.execute({ ...input, fingerprint: "fingerprint-two" })).rejects.toMatchObject(
      {
        code: "idempotency_conflict",
        kind: "conflict",
      },
    );
  });

  test("leases only the in-progress claim and replays a leased response for the full retention", async () => {
    const storage = makeDatabase();
    let clock = Date.parse("2026-07-24T12:00:00.000Z");
    const persistence = makeIdempotencyPersistence({
      database: storage.database,
      now: () => new Date(clock),
      responseProtector,
    });
    let calls = 0;
    const input = {
      fingerprint: "leased",
      inProgressLeaseSeconds: 60,
      key: "leased-key",
      operation: async () => {
        calls += 1;
        return { answer: calls };
      },
      organizationId: ORGANIZATION_ID,
      principalId: PRINCIPAL_ID,
    };

    expect(await persistence.execute(input)).toEqual({ answer: 1 });
    clock += 60 * 60 * 1_000;
    expect(await persistence.execute(input)).toEqual({ answer: 1 });
    expect(calls).toBe(1);
  });

  test("persists pre-organization requests in a principal-scoped partition", async () => {
    const storage = makeDatabase();
    const persistence = makeIdempotencyPersistence({
      database: storage.database,
      now: () => new Date("2026-07-24T12:00:00.000Z"),
      responseProtector,
    });

    expect(
      await persistence.execute({
        fingerprint: "create-organization",
        key: "bootstrap-key",
        operation: async () => ({ id: ORGANIZATION_ID }),
        principalId: PRINCIPAL_ID,
        resolveOrganizationId: (result) =>
          result && typeof result === "object" && "id" in result ? String(result.id) : undefined,
      }),
    ).toEqual({ id: ORGANIZATION_ID });
    expect(
      [...storage.records.values()].some(
        (record) =>
          record.itemType === "idempotency" &&
          record.pk === `PRINCIPAL#${PRINCIPAL_ID}#IDEMPOTENCY`,
      ),
    ).toBe(true);
    expect(
      [...storage.records.values()].find((record) => record.itemType === "idempotency")?.data
        .resourceIds,
    ).toEqual([ORGANIZATION_ID] as never);
    expect(
      [...storage.records.values()].find((record) => record.itemType === "idempotency")?.data,
    ).toMatchObject({
      organizationId: ORGANIZATION_ID,
      principalId: PRINCIPAL_ID,
    });
  });

  test("preserves primitive, array, null, and undefined responses on replay", async () => {
    const storage = makeDatabase();
    const persistence = makeIdempotencyPersistence({
      database: storage.database,
      now: () => new Date("2026-07-24T12:00:00.000Z"),
      responseProtector,
    });
    const values = ["result", ["one", 2], null, undefined] as const;

    for (const [index, value] of values.entries()) {
      let calls = 0;
      const input = {
        fingerprint: `fingerprint-${index}`,
        key: `request-${index}`,
        operation: async () => {
          calls += 1;
          return value;
        },
        principalId: PRINCIPAL_ID,
      };
      expect(await persistence.execute(input)).toEqual(value);
      expect(await persistence.execute(input)).toEqual(value);
      expect(calls).toBe(1);
    }
  });

  test("does not re-execute an undefined response after losing acquisition", async () => {
    const storage = makeDatabase();
    const now = () => new Date("2026-07-24T12:00:00.000Z");
    const input = {
      fingerprint: "undefined-race",
      key: "undefined-race",
      operation: async () => undefined,
      principalId: PRINCIPAL_ID,
    };
    await makeIdempotencyPersistence({
      database: storage.database,
      now,
      responseProtector,
    }).execute(input);

    let getCalls = 0;
    let operationCalls = 0;
    const persistence = makeIdempotencyPersistence({
      database: {
        ...storage.database,
        getRecord: (...arguments_) => {
          getCalls += 1;
          return getCalls === 1
            ? Promise.resolve(undefined)
            : storage.database.getRecord(...arguments_);
        },
        transactWrite: () =>
          Promise.reject(
            new DatabaseError({
              cause: new Error("conditional write lost"),
              message: "write failed",
              operation: "transact-write",
              reason: "conflict",
              table: "events",
            }),
          ),
      },
      now,
      responseProtector,
    });

    expect(
      await persistence.execute({
        ...input,
        operation: async () => {
          operationCalls += 1;
          return undefined;
        },
      }),
    ).toBeUndefined();
    expect(operationCalls).toBe(0);
  });

  test("releases the pending claim when response protection cannot be prepared", async () => {
    const storage = makeDatabase();
    let operationCalls = 0;
    const persistence = makeIdempotencyPersistence({
      database: storage.database,
      responseProtector: {
        prepare: async () => {
          throw new Error("KMS unavailable");
        },
        unprotect: (value, context) => responseProtector.unprotect(value, context),
      },
    });

    expect(
      persistence.execute({
        fingerprint: "protection-failure",
        key: "protection-failure",
        operation: async () => {
          operationCalls += 1;
          return { id: "result" };
        },
        principalId: PRINCIPAL_ID,
      }),
    ).rejects.toMatchObject({ code: "persistence_error", kind: "internal" });
    expect(operationCalls).toBe(0);
    expect(storage.records.size).toBe(0);
  });

  test("retries a transient completion failure without re-executing the operation", async () => {
    const storage = makeDatabase();
    let transactionCalls = 0;
    let operationCalls = 0;
    const persistence = makeIdempotencyPersistence({
      database: {
        ...storage.database,
        transactWrite: (operations) => {
          transactionCalls += 1;
          if (transactionCalls === 2) {
            return Promise.reject(
              new DatabaseError({
                cause: new Error("transient completion failure"),
                message: "write failed",
                operation: "transact-write",
                reason: "unknown",
                table: "events",
              }),
            );
          }
          return storage.database.transactWrite(operations);
        },
      },
      responseProtector,
    });

    expect(
      await persistence.execute({
        fingerprint: "completion-retry",
        key: "completion-retry",
        operation: async () => {
          operationCalls += 1;
          return { id: "result" };
        },
        principalId: PRINCIPAL_ID,
      }),
    ).toEqual({ id: "result" });
    expect(transactionCalls).toBe(3);
    expect(operationCalls).toBe(1);
  });

  test("commits caller completion operations atomically with the idempotency response", async () => {
    const storage = makeDatabase();
    const transactions: (readonly TransactionOperation[])[] = [];
    const persistence = makeIdempotencyPersistence({
      database: {
        ...storage.database,
        transactWrite: (operations) => {
          transactions.push(operations);
          return storage.database.transactWrite(operations);
        },
      },
      responseProtector,
    });
    const dispatchReady: TransactionOperation = {
      conditionExpression: "attribute_exists(pk)",
      key: { pk: `ORG#${ORGANIZATION_ID}`, sk: "GOVERNANCE-OPERATION#operation" },
      kind: "condition-check",
      table: "control",
    };

    await persistence.execute({
      completionOperations: () => [dispatchReady],
      fingerprint: "atomic-completion",
      key: "atomic-completion",
      operation: async () => ({ id: "result" }),
      organizationId: ORGANIZATION_ID,
      principalId: PRINCIPAL_ID,
    });

    expect(transactions).toHaveLength(2);
    expect(transactions[1]).toEqual([
      expect.objectContaining({
        kind: "put",
        record: expect.objectContaining({
          data: expect.objectContaining({ status: "completed" }),
          itemType: "idempotency",
        }),
      }),
      dispatchReady,
    ]);
  });

  test("removes a pending claim when the operation fails", async () => {
    const storage = makeDatabase();
    const persistence = makeIdempotencyPersistence({
      database: storage.database,
      now: () => new Date("2026-07-24T12:00:00.000Z"),
      responseProtector,
    });
    const failure = new Error("operation failed");

    expect(
      persistence.execute({
        fingerprint: "failed-operation",
        key: "failed-key",
        operation: async () => {
          throw failure;
        },
        principalId: PRINCIPAL_ID,
      }),
    ).rejects.toBe(failure);
    expect(storage.records.size).toBe(0);
  });

  test("retains a pending claim after an ambiguous internal operation failure", async () => {
    const storage = makeDatabase();
    const persistence = makeIdempotencyPersistence({
      database: storage.database,
      now: () => new Date("2026-07-24T12:00:00.000Z"),
      responseProtector,
    });
    const failure = new PersistenceError(
      "internal",
      "ambiguous_write_outcome",
      "The write outcome is unknown.",
    );

    expect(
      persistence.execute({
        fingerprint: "ambiguous-operation",
        key: "ambiguous-key",
        operation: async () => {
          throw failure;
        },
        principalId: PRINCIPAL_ID,
      }),
    ).rejects.toBe(failure);
    expect([...storage.records.values()]).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ status: "in-progress" }),
        itemType: "idempotency",
      }),
    ]);
  });
});
