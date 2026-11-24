import { DatabaseError } from "@deployments-ai/db";
import type { MemoryPlatform } from "@deployments-ai/memory";
import { standingInstallation } from "@deployments-ai/organization-admission/testing";
import { describe, expect, spyOn, test } from "bun:test";
import { handleMemoryApi } from "./api.ts";
import { event, ids } from "./api-test-support.ts";

function failingWith(cause: unknown) {
  return {
    organizationGate: standingInstallation({ organizationId: ids.organization }).gate,
    platform: {
      createMemorySpace: async () => {
        throw cause;
      },
    } as unknown as MemoryPlatform,
  };
}

function transactionFailure(reason: "conflict" | "unknown", codes: readonly string[]) {
  return new DatabaseError({
    cause: Object.assign(new Error("Transaction cancelled."), {
      CancellationReasons: codes.map((Code) => ({ Code })),
      name: "TransactionCanceledException",
    }),
    message: "DynamoDB transact-write failed for table multiple.",
    operation: "transact-write",
    reason,
    table: "multiple",
  });
}

describe("memory API database contention", () => {
  test("answers a write that kept conflicting or throttling with a retryable 503", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const create = event("/v1/memory-spaces", "POST", { name: "notes" });
      const results = [
        await handleMemoryApi(
          create,
          failingWith(transactionFailure("conflict", ["TransactionConflict", "None"])),
        ),
        await handleMemoryApi(
          create,
          failingWith(transactionFailure("unknown", ["ThrottlingError", "None"])),
        ),
        await handleMemoryApi(create, failingWith(new Error("boom"))),
      ];

      expect(
        results.map((result) => [
          result.statusCode,
          JSON.parse(result.body ?? "{}").code,
          "retry-after" in result.headers ? result.headers["retry-after"] : undefined,
        ]),
      ).toEqual([
        [503, "memory_busy", "1"],
        [503, "memory_busy", "1"],
        [500, "memory_internal_error", undefined],
      ]);
    } finally {
      consoleError.mockRestore();
    }
  });
});
