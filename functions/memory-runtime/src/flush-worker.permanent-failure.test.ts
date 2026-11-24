import { describe, expect, it, spyOn } from "bun:test";
import { MemoryPlatformError, type MemoryPlatform } from "@deployments-ai/memory";
import { handleMemoryFlushQueue } from "./flush-worker.ts";

const scope = {
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FA6",
};
const flushId = "01ARZ3NDEKTSV4RRFFQ69G5FA7";
const runId = "01ARZ3NDEKTSV4RRFFQ69G5FA9";
const event = {
  Records: [
    {
      body: JSON.stringify({
        detail: { ...scope, idempotencyKey: `memory-flush:${runId}`, runId },
        "detail-type": "memory.flush.queued",
      }),
      messageId: "message-1",
    },
  ],
};
const claimedFlush = {
  data: {
    attempt: 6,
    id: flushId,
    memoryMode: "organization",
    memorySpaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA8",
    status: "running",
  },
};

function flushPlatform(overrides: Partial<Record<keyof MemoryPlatform, unknown>>) {
  const failed: unknown[] = [];
  const platform = {
    agentReleaseForRun: async () => ({
      data: {
        agentDefinitionId: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
        manifest: { spec: { model: { id: "openrouter/openai/gpt-4o" } } },
      },
    }),
    claimFlush: async () => claimedFlush,
    completeFlush: async () => {
      throw new Error("A failed flush must not complete.");
    },
    failFlush: async (_flush: unknown, cause: unknown) => {
      failed.push(cause);
    },
    findRun: async () => ({ data: { id: runId, threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAA" } }),
    messagesForThread: async () => [
      { data: { body: "Production changes happen Tuesday.", role: "assistant" } },
    ],
    modelTokenQuantityForRun: async () => 16_000,
    ...overrides,
  } as unknown as MemoryPlatform;
  return { failed, platform };
}

const dependencies = {
  generateCompletion: async () =>
    JSON.stringify({
      memories: [{ confidence: 0.9, content: "Use the Tuesday window.", scope: "organization" }],
    }),
  getModelCatalogEntries: async () => new Map(),
};

describe("memory flush worker permanent failures", () => {
  it("fails and acknowledges a flush whose memory space was archived after it queued", async () => {
    const archived = new MemoryPlatformError(
      409,
      "memory_space_archived",
      "Memory space is archived.",
    );
    const { failed, platform } = flushPlatform({
      importFlushCandidates: async () => {
        throw archived;
      },
    });
    const consoleWarn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await handleMemoryFlushQueue(event, { ...dependencies, platform });

      expect(result).toEqual({ batchItemFailures: [] });
      expect(failed).toEqual([archived]);
      expect(consoleWarn).toHaveBeenCalledWith("Memory flush failed permanently.", {
        code: "memory_space_archived",
        flushId,
        messageId: "message-1",
        status: 409,
      });
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("acknowledges a message whose flush record no longer exists", async () => {
    const { failed, platform } = flushPlatform({
      claimFlush: async () => {
        throw new MemoryPlatformError(404, "flush_not_found", "Memory flush was not found.");
      },
    });
    const consoleWarn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await handleMemoryFlushQueue(event, { ...dependencies, platform });

      expect(result).toEqual({ batchItemFailures: [] });
      expect(failed).toEqual([]);
      expect(consoleWarn).toHaveBeenCalledWith("Memory flush failed permanently.", {
        code: "flush_not_found",
        messageId: "message-1",
        status: 404,
      });
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("retries an active lease and logs its bounded platform status and code", async () => {
    const { platform } = flushPlatform({
      claimFlush: async () => {
        throw new MemoryPlatformError(409, "flush_lease_active", "Lease held for tenant secret.");
      },
    });
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await handleMemoryFlushQueue(event, { ...dependencies, platform });

      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "message-1" }] });
      expect(consoleError).toHaveBeenCalledWith("Memory queue record failed.", {
        code: "flush_lease_active",
        errorType: "MemoryPlatformError",
        messageId: "message-1",
        status: 409,
      });
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("tenant secret");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("fails and retries a flush on a server-class platform error", async () => {
    const unavailable = new MemoryPlatformError(
      503,
      "memory_search_not_serving",
      "Memory search is not serving.",
    );
    const { failed, platform } = flushPlatform({
      importFlushCandidates: async () => {
        throw unavailable;
      },
    });
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await handleMemoryFlushQueue(event, { ...dependencies, platform });

      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "message-1" }] });
      expect(failed).toEqual([unavailable]);
    } finally {
      consoleError.mockRestore();
    }
  });
});
