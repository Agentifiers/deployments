import { describe, expect, test } from "bun:test";
import { DatabaseError } from "./client-types.ts";
import {
  databaseFailure,
  isDatabaseWriteConflict,
  makeDatabaseTransactionToken,
  makePersistenceTransactionToken,
} from "./transaction-conditions.ts";

describe("database error classification", () => {
  test("classifies Dynamo write conflicts before they cross the db boundary", () => {
    const conditional = databaseFailure("put", "control", {
      name: "ConditionalCheckFailedException",
    });
    const canceled = databaseFailure("transact-write", "control", {
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
      name: "TransactionCanceledException",
    });
    const throttled = databaseFailure("transact-write", "control", {
      CancellationReasons: [{ Code: "ProvisionedThroughputExceeded" }],
      name: "TransactionCanceledException",
    });

    expect(conditional.reason).toBe("conflict");
    expect(canceled.reason).toBe("conflict");
    expect(throttled.reason).toBe("unknown");
    expect(isDatabaseWriteConflict(conditional)).toBe(true);
    expect(isDatabaseWriteConflict(throttled)).toBe(false);
  });

  test("honors an adapter-provided reason without inspecting its cause", () => {
    const conflict = new DatabaseError({
      cause: new Error("opaque adapter error"),
      message: "write failed",
      operation: "put",
      reason: "conflict",
      table: "control",
    });

    expect(isDatabaseWriteConflict(conflict)).toBe(true);
  });

  test("creates stable bounded transaction tokens", () => {
    const parts = ["principal", "agent-definition.create", "request-key", "0"];
    const token = makeDatabaseTransactionToken(parts);

    expect(token).toHaveLength(36);
    expect(makeDatabaseTransactionToken(parts)).toBe(token);
    expect(makeDatabaseTransactionToken([...parts.slice(0, -1), "1"])).not.toBe(token);
  });

  test("separates persistence transaction tokens by tenant scope", () => {
    const invocation = {
      body: undefined,
      identity: {
        principalId: "principal",
        organizationIds: ["organization-a", "organization-b"],
        projectIds: ["project-a"],
      },
      idempotencyKey: "request-key",
      query: {},
      scope: {
        environmentId: "environment-a",
        organizationId: "organization-a",
        projectId: "project-a",
      },
    } as const;
    const token = makePersistenceTransactionToken(invocation, "agent-definition.create");

    expect(token).toHaveLength(36);
    expect(
      makePersistenceTransactionToken(
        {
          ...invocation,
          identity: {
            ...invocation.identity,
            organizationIds: [...invocation.identity.organizationIds].reverse(),
          },
        },
        "agent-definition.create",
      ),
    ).toBe(token);
    expect(
      makePersistenceTransactionToken(
        {
          ...invocation,
          scope: { ...invocation.scope, organizationId: "organization-b" },
        },
        "agent-definition.create",
      ),
    ).not.toBe(token);
    expect(
      makePersistenceTransactionToken(
        {
          ...invocation,
          scope: { ...invocation.scope, environmentId: "environment-b" },
        },
        "agent-definition.create",
      ),
    ).not.toBe(token);
  });
});
