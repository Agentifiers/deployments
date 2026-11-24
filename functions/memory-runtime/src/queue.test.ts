import { DatabaseError } from "@deployments-ai/db";
import {
  AwsNativeMemoryError,
  MemoryIndexingError,
  MemorySearchProvisioningStageError,
  type MemoryPlatform,
} from "@deployments-ai/memory";
import { standingInstallation } from "@deployments-ai/organization-admission/testing";
import { describe, expect, it, spyOn } from "bun:test";
import { handleMemoryIndexQueue } from "./index-worker.ts";
import { processQueue, queuePayload, queueScope } from "./queue.ts";
const payload = {
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
  idempotencyKey: "memory:1:7:index",
  memoryId: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FA6",
};
const { repository: standing } = standingInstallation();
const indexRecord = {
  attributes: { ApproximateReceiveCount: "1" },
  body: JSON.stringify({ detail: payload }),
  messageId: "message-1",
  receiptHandle: "receipt-1",
};

function indexDependencies(platform: MemoryPlatform) {
  const visibility: [string, number][] = [];
  return {
    dependencies: {
      changeVisibility: async (receiptHandle: string, seconds: number) => {
        visibility.push([receiptHandle, seconds]);
      },
      now: () => new Date("2026-07-21T18:00:00.000Z"),
      platform,
      random: () => 1,
      standing,
    },
    visibility,
  };
}

describe("memory queues", () => {
  it("unwraps semantic EventBridge messages without losing tenant scope", () => {
    const parsed = queuePayload({
      body: JSON.stringify({
        detail: {
          ...payload,
          payload: { idempotencyKey: payload.idempotencyKey, memoryId: payload.memoryId },
        },
      }),
      messageId: "message-1",
    });
    expect(queueScope(parsed)).toMatchObject({
      environmentId: payload.environmentId,
      organizationId: payload.organizationId,
      projectId: payload.projectId,
    });
  });

  it("does not let event payloads override canonical tenant scope", () => {
    const parsed = queuePayload({
      body: JSON.stringify({
        detail: {
          ...payload,
          payload: {
            environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
            organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
            projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
            workspaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA8",
          },
        },
      }),
      messageId: "message-1",
    });

    expect(queueScope(parsed)).toMatchObject({
      environmentId: payload.environmentId,
      organizationId: payload.organizationId,
      projectId: payload.projectId,
      workspaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA8",
    });
  });

  it("dispatches index records and reports only failed messages", async () => {
    const calls: unknown[] = [];
    const platform = {
      processIndexJob: async (
        scope: Parameters<MemoryPlatform["processIndexJob"]>[0],
        input: Parameters<MemoryPlatform["processIndexJob"]>[1],
      ) => {
        calls.push({ scope, input });
        return { data: { status: "succeeded" } };
      },
    } as unknown as MemoryPlatform;
    const { dependencies, visibility } = indexDependencies(platform);
    const result = await handleMemoryIndexQueue({ Records: [indexRecord] }, dependencies);
    expect(result).toEqual({ batchItemFailures: [] });
    expect(calls).toHaveLength(1);
    expect(visibility).toEqual([]);
  });

  it("logs actionable database context for failed queue records", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await processQueue(
        { Records: [{ body: JSON.stringify({ detail: payload }), messageId: "message-1" }] },
        async () => {
          throw new DatabaseError({
            cause: {
              CancellationReasons: [
                { Code: "None" },
                { Code: "TransactionConflict" },
                { Code: "None" },
              ],
              name: "TransactionCanceledException",
            },
            message: "Unable to transact records.",
            operation: "transactWrite",
            reason: "unknown",
            table: "execution",
          });
        },
      );

      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "message-1" }] });
      expect(consoleError).toHaveBeenCalledWith("Memory queue record failed.", {
        databaseCancellationCodes: ["None", "TransactionConflict", "None"],
        databaseCauseType: "TransactionCanceledException",
        databaseOperation: "transactWrite",
        databaseReason: "unknown",
        databaseTable: "execution",
        errorType: "DatabaseError",
        messageId: "message-1",
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not log arbitrary queue failure messages", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await processQueue(
        { Records: [{ body: JSON.stringify({ detail: payload }), messageId: "message-1" }] },
        async () => {
          throw new Error("sensitive tenant memory content");
        },
      );

      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "message-1" }] });
      expect(consoleError).toHaveBeenCalledWith("Memory queue record failed.", {
        errorType: "Error",
        messageId: "message-1",
      });
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
        "sensitive tenant memory content",
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("logs bounded provider context from a failed production index job", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const platform = {
        processIndexJob: async () => {
          throw new MemoryIndexingError({
            cause: new AwsNativeMemoryError({
              cause: new Error("sensitive provider response"),
              message: "AWS-native evidence cleanup failed.",
              operation: "delete-evidence-vector",
            }),
            memoryId: payload.memoryId,
            message: "AWS-native memory indexing failed.",
          });
        },
      } as unknown as MemoryPlatform;
      const { dependencies, visibility } = indexDependencies(platform);
      const result = await handleMemoryIndexQueue({ Records: [indexRecord] }, dependencies);

      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "message-1" }] });
      expect(visibility).toEqual([["receipt-1", 2]]);
      expect(consoleError).toHaveBeenCalledWith("Memory queue record failed.", {
        errorType: "MemoryIndexingError",
        messageId: "message-1",
        providerOperation: "delete-evidence-vector",
      });
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("sensitive provider response");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("logs a bounded readiness mismatch without provider response data", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await processQueue(
        { Records: [{ body: JSON.stringify({ detail: payload }), messageId: "message-1" }] },
        async () => {
          throw new MemorySearchProvisioningStageError(
            "prepare-provider",
            new AwsNativeMemoryError({
              cause: Object.assign(
                new Error("OpenSearch index is incompatible (settings.analysis)."),
                { details: "sensitive provider response" },
              ),
              message: "AWS-native memory validate-open-search-readiness failed.",
              operation: "validate-open-search-readiness",
            }),
          );
        },
      );

      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "message-1" }] });
      expect(consoleError).toHaveBeenCalledWith("Memory queue record failed.", {
        errorType: "MemorySearchProvisioningStageError",
        messageId: "message-1",
        provisioningStage: "prepare-provider",
        providerOperation: "validate-open-search-readiness",
        providerReason: "OpenSearch index is incompatible (settings.analysis).",
      });
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("sensitive provider response");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("preserves database diagnostics through a provisioning stage", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await processQueue(
        { Records: [{ body: JSON.stringify({ detail: payload }), messageId: "message-1" }] },
        async () => {
          throw new MemorySearchProvisioningStageError(
            "resolve-provider",
            new DatabaseError({
              cause: { name: "ResourceNotFoundException" },
              message: "Unable to read the provider target.",
              operation: "getRecord",
              reason: "unknown",
              table: "control",
            }),
          );
        },
      );

      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "message-1" }] });
      expect(consoleError).toHaveBeenCalledWith("Memory queue record failed.", {
        databaseCauseType: "ResourceNotFoundException",
        databaseOperation: "getRecord",
        databaseReason: "unknown",
        databaseTable: "control",
        errorType: "MemorySearchProvisioningStageError",
        messageId: "message-1",
        provisioningStage: "resolve-provider",
      });
    } finally {
      consoleError.mockRestore();
    }
  });
});
