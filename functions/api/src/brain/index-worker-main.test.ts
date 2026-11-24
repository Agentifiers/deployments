import { describe, expect, test } from "bun:test";
import { DatabaseError } from "@deployments-ai/db";
import { brainIndexFailureLogContext } from "./index-worker-main.ts";

describe("Brain index worker failure diagnostics", () => {
  test("retains safe DynamoDB transaction details", () => {
    const nested = Object.assign(new Error("Transaction cancelled."), {
      CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }],
      name: "TransactionCanceledException",
    });
    const cause = new DatabaseError({
      cause: nested,
      message: "DynamoDB transact-write failed for table multiple.",
      operation: "transact-write",
      reason: "conflict",
      table: "multiple",
    });

    expect(brainIndexFailureLogContext(cause)).toEqual({
      databaseCancellationCodes: ["None", "ConditionalCheckFailed"],
      databaseOperation: "transact-write",
      databaseReason: "conflict",
      databaseTable: "multiple",
      innerCauseMessage: "Transaction cancelled.",
      innerCauseType: "TransactionCanceledException",
      message: "DynamoDB transact-write failed for table multiple.",
    });
  });
});
