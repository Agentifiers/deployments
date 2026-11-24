import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { MessageRecord, RunRecord, ToolCallRecord } from "../records/conversations.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import { NOW, TRACE, fixtureUlid, scope } from "./evaluation-records.fixture.ts";
import {
  MAX_EVALUATION_RUN_MESSAGES,
  MAX_EVALUATION_RUN_TOOL_CALLS,
  makeEvaluationEvidencePersistence,
} from "./evidence.ts";
import { evaluationMemoryDatabase } from "./memory-database.fixture.ts";

const THREAD = fixtureUlid();

function runRecord(id: Ulid, userMessageId: Ulid, userMessageSequence: number) {
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...scope,
        agentDeploymentId: fixtureUlid(),
        agentReleaseId: fixtureUlid(),
        attempt: 0,
        captureMode: "full-content",
        createdAt: NOW,
        executor: "hosted",
        id,
        idempotencyKey: `run-${id}`,
        priority: 0,
        redactionPolicyVersion: 1,
        schemaVersion: 1,
        spanId: "0123456789abcdef",
        status: "completed",
        threadId: THREAD,
        traceId: TRACE,
        trigger: "api",
        updatedAt: NOW,
        userMessageId,
        userMessageSequence,
        version: 1,
      },
      itemType: "run",
    }),
  );
}

function message(sequence: number, role: "assistant" | "tool" | "user", runId: Ulid) {
  return Schema.decodeUnknownSync(MessageRecord)(
    withCanonicalRecordKeys({
      data: {
        ...scope,
        body: `${role} ${sequence}`,
        contentHash: `hash-${sequence}`,
        createdAt: NOW,
        id: fixtureUlid(),
        role,
        runId,
        sequence,
        threadId: THREAD,
      },
      itemType: "message",
    }),
  );
}

function toolCall(runId: Ulid) {
  return Schema.decodeUnknownSync(ToolCallRecord)(
    withCanonicalRecordKeys({
      data: {
        ...scope,
        createdAt: NOW,
        effect: "read",
        id: fixtureUlid(),
        inputSummary: "search",
        requiredScopes: [],
        runId,
        status: "succeeded",
        threadId: THREAD,
        toolName: "search",
        updatedAt: NOW,
        version: 0,
      },
      itemType: "tool-call",
    }),
  );
}

/** Wraps the memory database to count the items every query returns. */
function countingPersistence(records: readonly PlatformRecord[]) {
  const memory = evaluationMemoryDatabase(records);
  const counter = { itemsRead: 0 };
  const database: DynamoDatabaseService = {
    ...memory.database,
    queryRecords: async (table, query) => {
      const result = await memory.database.queryRecords(table, query);
      counter.itemsRead += result.items.length;
      return result;
    },
  };
  return { counter, persistence: makeEvaluationEvidencePersistence(database, scope) };
}

describe("run message evidence", () => {
  test("reads only the run's own messages from a long thread, skipping queued turns", async () => {
    const scored = fixtureUlid();
    const queued = fixtureUlid();
    const earlier = fixtureUlid();
    const userMessage = message(10, "user", scored);
    const records: PlatformRecord[] = [
      message(9, "user", earlier),
      userMessage,
      // A turn queued while the scored run executes, and an earlier run's late output.
      message(11, "user", queued),
      message(12, "assistant", earlier),
      message(13, "tool", scored),
      message(14, "assistant", scored),
      message(15, "assistant", queued),
    ];
    for (let turn = 0; turn < 3 * MAX_EVALUATION_RUN_MESSAGES; turn += 1) {
      const later = fixtureUlid();
      records.push(
        message(16 + turn * 2, "user", later),
        message(17 + turn * 2, "assistant", later),
      );
    }
    const { counter, persistence } = countingPersistence(records);

    const messages = await persistence.listRunMessages(
      runRecord(scored, userMessage.data.id, userMessage.data.sequence),
    );

    expect(messages.map((record) => record.data.sequence)).toEqual([10, 13, 14]);
    // One page of the thread, not the thousands of later turns.
    expect(counter.itemsRead).toBeLessThanOrEqual(100);
  });

  test("a run whose own messages exceed the bound yields no evidence instead of throwing", async () => {
    const scored = fixtureUlid();
    const userMessage = message(0, "user", scored);
    const records: PlatformRecord[] = [userMessage];
    for (let index = 1; index <= MAX_EVALUATION_RUN_MESSAGES + 5; index += 1) {
      records.push(message(index, index % 2 ? "tool" : "assistant", scored));
    }
    const { counter, persistence } = countingPersistence(records);

    expect(await persistence.listRunMessages(runRecord(scored, userMessage.data.id, 0))).toEqual(
      [],
    );
    expect(counter.itemsRead).toBe(MAX_EVALUATION_RUN_MESSAGES + 1);
  });

  test("a run that exactly fills the bound is read completely", async () => {
    const scored = fixtureUlid();
    const userMessage = message(0, "user", scored);
    const records: PlatformRecord[] = [userMessage];
    for (let index = 1; index < MAX_EVALUATION_RUN_MESSAGES; index += 1) {
      records.push(message(index, "assistant", scored));
    }
    const { persistence } = countingPersistence(records);

    const messages = await persistence.listRunMessages(runRecord(scored, userMessage.data.id, 0));

    expect(messages).toHaveLength(MAX_EVALUATION_RUN_MESSAGES);
  });
});

describe("run tool-call evidence", () => {
  test("returns the run's tool calls up to the bound and marks overflow unavailable", async () => {
    const bounded = fixtureUlid();
    const overflowing = fixtureUlid();
    const records: PlatformRecord[] = [];
    for (let index = 0; index < MAX_EVALUATION_RUN_TOOL_CALLS; index += 1) {
      records.push(toolCall(bounded), toolCall(overflowing));
    }
    records.push(toolCall(overflowing));
    const { persistence } = countingPersistence(records);

    expect(await persistence.listRunToolCalls(bounded)).toHaveLength(MAX_EVALUATION_RUN_TOOL_CALLS);
    expect(await persistence.listRunToolCalls(overflowing)).toBeUndefined();
  });
});
