import { describe, expect, it } from "bun:test";
import { type PlatformRecord, type Ulid } from "@deployments-ai/db";
import {
  AgentRunMessageBodyWriteOutcomeUnknownError,
  parseAgentRunQueueMessage,
  processAgentRun,
} from "./index.ts";
import type { AgentRunWorkerDependencies } from "./types.ts";
import {
  fifoQueueRecord,
  fixtures,
  id,
  inMemoryDatabase,
  processQueueRecords,
  workerDependencies,
} from "./agent-run.fixture.ts";

describe("DynamoDB agent run worker", () => {
  it("continues database heartbeats when queue visibility extension stalls", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const base = workerDependencies(memory.database);
    let visibilityCalls = 0;
    let visibilityTimeouts = 0;
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      extendQueueVisibility: Object.assign(
        async () => {
          visibilityCalls += 1;
          await new Promise<void>(() => undefined);
        },
        { renewalIntervalMs: 2 },
      ),
      heartbeatIntervalMs: 5,
      queueVisibilityExtensionTimeoutMs: 5,
      reportQueueVisibilityFailure: async () => {
        visibilityTimeouts += 1;
      },
      runningClaimTimeoutMs: 50,
      runtime: {
        generateAssistantMessage: async () => {
          await Bun.sleep(20);
          return { assistantMessage: "Visibility stall independent result." };
        },
      },
    };

    const result = await processAgentRun(fixture.queue, dependencies, {
      messageId: "visibility-stall-delivery",
      receiptHandle: "visibility-stall-receipt",
    });

    expect(result.action).toBe("completed");
    expect(visibilityCalls).toBe(1);
    expect(visibilityTimeouts).toBeGreaterThan(0);
    expect(
      [...memory.records.values()].filter(
        (record) =>
          record.itemType === "semantic-event" && record.data.eventType === "run.heartbeat",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("redacts terminal dependency errors before DynamoDB and semantic events", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const { dependencies } = workerDependencies(memory.database);
    const failing: AgentRunWorkerDependencies = {
      ...dependencies,
      runtime: {
        generateAssistantMessage: async () => {
          throw new Error("authorization=super-secret Bearer provider-token");
        },
      },
    };

    const result = await processAgentRun(fixture.queue, failing);
    expect(result).toMatchObject({ action: "skipped", run: { data: { status: "failed" } } });

    const serialized = JSON.stringify([...memory.records.values()]);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("provider-token");
    expect(serialized).toContain("[redacted]");
  });

  it("fails explicitly before persisting an oversized inline assistant body", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const { dependencies } = workerDependencies(memory.database);
    const oversized: AgentRunWorkerDependencies = {
      ...dependencies,
      runtime: {
        generateAssistantMessage: async () => ({ assistantMessage: "x".repeat(300_000) }),
      },
    };

    const result = await processAgentRun(fixture.queue, oversized);
    expect(result).toMatchObject({ action: "skipped", run: { data: { status: "failed" } } });
    expect(
      [...memory.records.values()].some(
        (record) => record.itemType === "message" && record.data.role === "assistant",
      ),
    ).toBe(false);
  });

  it("requires exact-version cleanup before writing an externalized assistant body", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const base = workerDependencies(memory.database);
    let writes = 0;
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: {
        generateAssistantMessage: async () => ({ assistantMessage: "x".repeat(300_000) }),
      },
      writeMessageBody: async (input) => {
        writes += 1;
        return {
          bucket: "message-bodies",
          byteSize: new TextEncoder().encode(input.body).byteLength,
          contentType: "text/plain; charset=utf-8",
          key: `messages/${input.messageId}`,
          sha256: input.contentHash,
        };
      },
    };

    const result = await processAgentRun(fixture.queue, dependencies);
    expect(result).toMatchObject({ action: "skipped", run: { data: { status: "failed" } } });
    expect(result.run?.data.error?.message).toContain("exact-version cleanup adapter");
    expect(writes).toBe(0);
    const run = [...memory.records.values()].find(
      (record) => record.itemType === "run" && record.data.id === fixture.run.data.id,
    ) as Extract<PlatformRecord, { readonly itemType: "run" }> | undefined;
    expect(run?.data.status).toBe("failed");
  });

  it("fails a run when an externalized body reference is invalid before completion", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const base = workerDependencies(memory.database);
    const assistantBody = "x".repeat(300_000);
    let deletes = 0;
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      deleteMessageBody: async () => {
        deletes += 1;
      },
      runtime: {
        generateAssistantMessage: async () => ({ assistantMessage: assistantBody }),
      },
      writeMessageBody: async (input) => ({
        bucket: "message-bodies",
        byteSize: new TextEncoder().encode(input.body).byteLength + 1,
        contentType: "text/plain; charset=utf-8",
        key: `messages/${input.messageId}`,
        sha256: input.contentHash,
        versionId: "invalid-reference-version",
      }),
    };

    const result = await processAgentRun(fixture.queue, dependencies);

    expect(result).toMatchObject({ action: "skipped", run: { data: { status: "failed" } } });
    expect(result.run?.data.error?.message).toContain("body reference does not match");
    expect(deletes).toBe(1);
    expect(
      [...memory.records.values()].some(
        (record) => record.itemType === "message" && record.data.role === "assistant",
      ),
    ).toBe(false);
  });

  it("persists an oversized assistant body through the external body writer", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const { dependencies, events } = workerDependencies(memory.database);
    const assistantBody = "x".repeat(300_000);
    let writes = 0;
    let deletes = 0;
    const externalized: AgentRunWorkerDependencies = {
      ...dependencies,
      deleteMessageBody: async () => {
        deletes += 1;
      },
      runtime: {
        generateAssistantMessage: async () => ({ assistantMessage: assistantBody }),
      },
      writeMessageBody: async (input) => {
        writes += 1;
        expect(input.body).toBe(assistantBody);
        expect(input.signal?.aborted).toBe(false);
        return {
          bucket: "message-bodies",
          byteSize: new TextEncoder().encode(input.body).byteLength,
          contentType: "text/plain; charset=utf-8",
          key: `messages/${input.messageId}`,
          sha256: input.contentHash,
          versionId: "message-version",
        };
      },
    };

    const result = await processAgentRun(fixture.queue, externalized);

    expect(result.action).toBe("completed");
    expect(writes).toBe(1);
    expect(deletes).toBe(0);
    const assistant = [...memory.records.values()].find(
      (record) => record.itemType === "message" && record.data.role === "assistant",
    ) as Extract<PlatformRecord, { readonly itemType: "message" }> | undefined;
    expect(assistant?.data.body).toBeUndefined();
    expect(assistant?.data.bodyRef).toMatchObject({
      bucket: "message-bodies",
      byteSize: 300_000,
      versionId: "message-version",
    });
    expect(
      events.find((event) => event.eventType === "assistant-message.finalized")?.payload,
    ).toMatchObject({
      bodyByteSize: 300_000,
      bodyExternalized: true,
      contentHash: assistant?.data.contentHash,
    });
  });

  it("externalizes an inline-sized body whose finalized stream event would exceed one batch", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const base = workerDependencies(memory.database);
    const assistantBody = "\u0001".repeat(180_000);
    let writes = 0;
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      deleteMessageBody: async () => undefined,
      runtime: {
        generateAssistantMessage: async () => ({ assistantMessage: assistantBody }),
      },
      writeMessageBody: async (input) => {
        writes += 1;
        return {
          bucket: "message-bodies",
          byteSize: new TextEncoder().encode(input.body).byteLength,
          contentType: "text/plain; charset=utf-8",
          key: `messages/${input.messageId}`,
          sha256: input.contentHash,
          versionId: "stream-sized-version",
        };
      },
    };

    expect(processAgentRun(fixture.queue, dependencies)).resolves.toMatchObject({
      action: "completed",
    });

    expect(writes).toBe(1);
    const assistant = [...memory.records.values()].find(
      (record) => record.itemType === "message" && record.data.role === "assistant",
    ) as Extract<PlatformRecord, { readonly itemType: "message" }> | undefined;
    expect(assistant?.data.body).toBeUndefined();
    expect(assistant?.data.bodyRef?.byteSize).toBe(180_000);
    expect(
      base.events.find((event) => event.eventType === "assistant-message.finalized")?.payload,
    ).toMatchObject({
      bodyByteSize: 180_000,
      bodyExternalized: true,
    });
  });

  it("uses a stable externalized assistant message ID across worker processes", async () => {
    const runOnce = async (firstGeneratedId: number) => {
      const fixture = fixtures();
      const memory = inMemoryDatabase([
        fixture.release,
        fixture.deployment,
        fixture.thread,
        fixture.userMessage,
        fixture.run,
      ]);
      const base = workerDependencies(memory.database);
      let nextId = firstGeneratedId;
      let writtenMessageId: Ulid | undefined;
      const dependencies: AgentRunWorkerDependencies = {
        ...base.dependencies,
        deleteMessageBody: async () => undefined,
        generateId: async () => id(nextId++),
        runtime: {
          generateAssistantMessage: async () => ({ assistantMessage: "x".repeat(300_000) }),
        },
        writeMessageBody: async (input) => {
          writtenMessageId = input.messageId;
          return {
            bucket: "message-bodies",
            byteSize: new TextEncoder().encode(input.body).byteLength,
            contentType: "text/plain; charset=utf-8",
            key: `messages/${input.messageId}`,
            sha256: input.contentHash,
            versionId: `version-${firstGeneratedId}`,
          };
        },
      };

      await processAgentRun(fixture.queue, dependencies);
      const assistant = [...memory.records.values()].find(
        (record) => record.itemType === "message" && record.data.role === "assistant",
      ) as Extract<PlatformRecord, { readonly itemType: "message" }> | undefined;
      return { persistedMessageId: assistant?.data.id, writtenMessageId };
    };

    const first = await runOnce(100);
    const second = await runOnce(500);

    expect(first.writtenMessageId).toBeDefined();
    expect(first.writtenMessageId).toBe(second.writtenMessageId);
    expect(first.persistedMessageId).toBe(first.writtenMessageId);
    expect(second.persistedMessageId).toBe(second.writtenMessageId);
  });

  it("keeps ambiguous external body writes retryable instead of terminalizing the run", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const base = workerDependencies(memory.database);
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      deleteMessageBody: async () => undefined,
      runtime: {
        generateAssistantMessage: async () => ({ assistantMessage: "x".repeat(300_000) }),
      },
      writeMessageBody: async () => {
        throw new AgentRunMessageBodyWriteOutcomeUnknownError([
          new Error("PUT response lost"),
          new Error("HEAD reconciliation unavailable"),
        ]);
      },
    };

    expect(processAgentRun(fixture.queue, dependencies)).rejects.toBeInstanceOf(
      AgentRunMessageBodyWriteOutcomeUnknownError,
    );

    const persistedRun = [...memory.records.values()].find(
      (record) => record.itemType === "run" && record.data.id === fixture.run.data.id,
    ) as Extract<PlatformRecord, { readonly itemType: "run" }> | undefined;
    expect(persistedRun?.data.status).toBe("running");
    expect(
      [...memory.records.values()].some(
        (record) => record.itemType === "semantic-event" && record.data.eventType === "run.failed",
      ),
    ).toBe(false);
  });

  it("leaves only failed queue records unacknowledged", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const { dependencies } = workerDependencies(memory.database);
    const response = await processQueueRecords(
      [
        fifoQueueRecord(fixture.queue, "good", "receipt-good"),
        { body: "not-json", messageId: "bad", receiptHandle: "receipt-bad" },
        {
          body: JSON.stringify({ ...fixture.queue, threadId: "not-a-ulid" }),
          messageId: "malformed-id",
          receiptHandle: "receipt-malformed-id",
        },
      ],
      dependencies,
    );
    expect(response).toEqual(["bad", "malformed-id"]);
  });

  it("rejects records outside the exact per-thread FIFO message group", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const base = workerDependencies(memory.database);
    let generated = false;
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: {
        generateAssistantMessage: async () => {
          generated = true;
          return { assistantMessage: "unexpected" };
        },
      },
    };
    const valid = fifoQueueRecord(fixture.queue, "valid-shape", "valid-shape-receipt");

    const response = await processQueueRecords(
      [
        { body: valid.body, messageId: "missing-group", receiptHandle: "missing-group-receipt" },
        { ...valid, messageGroupId: "another-thread", messageId: "wrong-group" },
      ],
      dependencies,
    );

    expect(response).toEqual(["missing-group", "wrong-group"]);
    expect(generated).toBe(false);
    const run = [...memory.records.values()].find(
      (record) => record.itemType === "run" && record.data.id === fixture.run.data.id,
    ) as Extract<PlatformRecord, { readonly itemType: "run" }> | undefined;
    expect(run?.data.status).toBe("queued");
  });

  it("keeps malformed FIFO records with the later records in their message group", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const base = workerDependencies(memory.database);
    let generated = false;
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: {
        generateAssistantMessage: async () => {
          generated = true;
          return { assistantMessage: "unexpected" };
        },
      },
    };
    const valid = fifoQueueRecord(fixture.queue, "valid-after-malformed", "valid-receipt");

    const response = await processQueueRecords(
      [{ ...valid, body: "not-json", messageId: "malformed-grouped" }, valid],
      dependencies,
    );

    expect(response).toEqual(["malformed-grouped", "valid-after-malformed"]);
    expect(generated).toBe(false);
  });

  it("acknowledges a stale queue record whose run and triggering message are gone", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([]);
    const { dependencies } = workerDependencies(memory.database);

    const response = await processQueueRecords(
      [fifoQueueRecord(fixture.queue, "stale-run", "stale-receipt")],
      dependencies,
    );

    expect(response).toEqual([]);
  });

  it("validates queue ULIDs and bounds idempotency keys before lookup", () => {
    const fixture = fixtures();
    expect(() =>
      parseAgentRunQueueMessage(JSON.stringify({ ...fixture.queue, runId: "not-a-ulid" })),
    ).toThrow("runId must be a canonical ULID");
    expect(() =>
      parseAgentRunQueueMessage(
        JSON.stringify({ ...fixture.queue, idempotencyKey: "x".repeat(257) }),
      ),
    ).toThrow("at most 256 UTF-8 bytes");
  });

  it("accepts only exact completed-run recovery markers", () => {
    const fixture = fixtures();
    for (const recoveryReason of [
      "external-publication-settled",
      "thread-continuity-recovery",
    ] as const) {
      expect(
        parseAgentRunQueueMessage(JSON.stringify({ ...fixture.queue, recoveryReason })),
      ).toEqual({ ...fixture.queue, recoveryReason });
    }
    for (const recoveryReason of [
      "publication-settled",
      "external-publication-settled ",
      "EXTERNAL-PUBLICATION-SETTLED",
      "thread-continuity-recovery ",
      true,
    ]) {
      expect(() =>
        parseAgentRunQueueMessage(JSON.stringify({ ...fixture.queue, recoveryReason })),
      ).toThrow("recoveryReason is invalid");
    }
  });

  it("fails closed when a queue idempotency key disagrees with the canonical run lookup", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const { dependencies } = workerDependencies(memory.database);

    expect(
      processAgentRun({ ...fixture.queue, idempotencyKey: "corrupted-delivery-key" }, dependencies),
    ).rejects.toThrow("does not match the canonical run lookup");
  });
});
