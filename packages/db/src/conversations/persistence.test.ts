import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { DynamoDatabaseService, RecordKey, TransactionOperation } from "../client-types.ts";
import { ConversationCheckpointRecord } from "../records/conversations.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import {
  InvalidConversationHistoryCursorError,
  makeConversationPersistence,
} from "./persistence.ts";
import { makeConversationContinuityRecoveryPersistence } from "./continuity-recovery.ts";
import {
  continuationCheckpointRecord,
  makeConversationThreadContinuityPersistence,
} from "./thread-continuity.ts";

function database(overrides: Partial<DynamoDatabaseService> = {}): DynamoDatabaseService {
  return {
    deleteRecord: () => Promise.resolve(),
    getRecord: () => Promise.resolve(undefined),
    putRecord: () => Promise.resolve(),
    queryRecords: () => Promise.resolve({ items: [] }),
    transactWrite: () => Promise.resolve(),
    ...overrides,
  };
}

describe("conversation persistence", () => {
  test("rebases a copied checkpoint onto the start of its successor thread", () => {
    const source = {
      data: {
        agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
        contentHash: "a".repeat(64),
        createdAt: "2026-08-29T00:00:00.000Z",
        environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
        fromMessageCreatedAt: "2026-08-28T23:00:00.000Z",
        fromSequence: 0,
        id: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
        organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FA4",
        projectId: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
        runId: "01ARZ3NDEKTSV4RRFFQ69G5FA6",
        sourceMessageCount: 18,
        summary: "A compact, non-sensitive continuity summary.",
        threadId: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
        throughMessageCreatedAt: "2026-08-29T00:00:00.000Z",
        throughSequence: 18,
      },
      itemType: "conversation-checkpoint",
    } as unknown as Extract<PlatformRecord, { readonly itemType: "conversation-checkpoint" }>;

    const copied = continuationCheckpointRecord(source, {
      agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FA8" as never,
      createdAt: "2026-08-29T01:00:00.000Z",
      id: "01ARZ3NDEKTSV4RRFFQ69G5FA9" as never,
      threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAA" as never,
    });

    expect(copied.data).toMatchObject({
      agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FA8",
      continuedFromCheckpointId: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
      continuedFromThreadId: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
      continuedFromThroughSequence: 18,
      fromMessageCreatedAt: "2026-08-28T23:00:00.000Z",
      fromSequence: 0,
      runId: "01ARZ3NDEKTSV4RRFFQ69G5FA6",
      sourceMessageCount: 18,
      summary: "A compact, non-sensitive continuity summary.",
      threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
      throughMessageCreatedAt: "2026-08-29T00:00:00.000Z",
      throughSequence: 0,
    });
    expect(copied.pk).toBe("ORG#01ARZ3NDEKTSV4RRFFQ69G5FA4#THREAD#01ARZ3NDEKTSV4RRFFQ69G5FAA");
  });

  test("rejects inverted checkpoint source-time bounds", () => {
    expect(() =>
      Schema.decodeUnknownSync(ConversationCheckpointRecord)(
        withCanonicalRecordKeys({
          data: {
            agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
            contentHash: "a".repeat(64),
            createdAt: "2026-08-29T01:00:00.000Z",
            environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
            fromMessageCreatedAt: "2026-08-29T00:30:00.000Z",
            fromSequence: 0,
            id: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
            organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FA4",
            projectId: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
            runId: "01ARZ3NDEKTSV4RRFFQ69G5FA6",
            sourceMessageCount: 2,
            summary: "A compact, non-sensitive continuity summary.",
            threadId: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
            throughMessageCreatedAt: "2026-08-29T00:00:00.000Z",
            throughSequence: 1,
          },
          itemType: "conversation-checkpoint" as const,
        }),
      ),
    ).toThrow("throughMessageCreatedAt must not precede fromMessageCreatedAt");
  });

  test("orders same-sequence checkpoints by partial-message coverage before run identity", () => {
    const checkpointKey = (throughMessageCharacterOffset: number | undefined, id: string) =>
      withCanonicalRecordKeys({
        data: {
          id,
          organizationId: "organization-id",
          threadId: "thread-id",
          ...(throughMessageCharacterOffset === undefined ? {} : { throughMessageCharacterOffset }),
          throughSequence: 42,
        },
        itemType: "conversation-checkpoint" as const,
      }).sk;

    const partial12k = checkpointKey(12_000, "02EARLIERRUN00000000000000");
    const partial24k = checkpointKey(24_000, "01LATERRUN000000000000000");
    const complete = checkpointKey(undefined, "00COMPLETERUN000000000000");

    expect(partial12k < partial24k).toBe(true);
    expect(partial24k < complete).toBe(true);
    expect(complete < "CONVERSATION-CHECKPOINT#0000000000000042#~#~").toBe(true);
  });

  test("derives canonical record locations inside packages/db", async () => {
    let observed: { readonly key: RecordKey; readonly table: string } | undefined;
    const persistence = makeConversationPersistence(
      database({
        getRecord: (table, key) =>
          (async () => {
            observed = { key, table };
            return undefined;
          })(),
      }),
    );

    await persistence.get({
      kind: "message",
      messageId: "message-id",
      organizationId: "organization-id",
      sequence: 7,
      threadId: "thread-id",
    });

    expect(observed).toEqual({
      key: {
        pk: "ORG#organization-id#THREAD#thread-id",
        sk: "MESSAGE#0000000000000007#message-id",
      },
      table: "execution",
    });
  });

  test("keeps pagination keys opaque and scoped to one thread", async () => {
    const queries: Readonly<Record<string, unknown>>[] = [];
    const lastEvaluatedKey = {
      pk: "ORG#organization-id#THREAD#thread-id",
      sk: "MESSAGE#0000000000000007#message-id",
    };
    const persistence = makeConversationPersistence(
      database({
        queryRecords: (_table, input) =>
          (async () => {
            queries.push(input);
            return queries.length === 1 ? { items: [], lastEvaluatedKey } : { items: [] };
          })(),
      }),
    );
    const scope = { organizationId: "organization-id", threadId: "thread-id" };
    const upperSk = "MESSAGE#9999999999999999#~";
    const first = await persistence.listMessages(scope, { limit: 25, upperSk });

    expect(first.nextCursor).toBeString();
    expect(first.nextCursor).not.toContain("thread-id");
    const currentUpperSk = "MESSAGE#9999999999999999#~~";
    await persistence.listMessages(scope, {
      cursor: first.nextCursor!,
      limit: 25,
      upperSk: currentUpperSk,
    });
    expect(queries[1]).toMatchObject({
      ExclusiveStartKey: lastEvaluatedKey,
      ExpressionAttributeValues: { ":upper": upperSk },
    });

    expect(
      persistence.listMessages(
        { organizationId: "organization-id", threadId: "another-thread" },
        { cursor: first.nextCursor!, limit: 25 },
      ),
    ).rejects.toBeInstanceOf(InvalidConversationHistoryCursorError);

    const tamperedCursor = Buffer.from(
      JSON.stringify({ ...lastEvaluatedKey, upperSk: `${currentUpperSk}~` }),
      "utf8",
    ).toString("base64url");
    expect(
      persistence.listMessages(scope, { cursor: tamperedCursor, limit: 25, upperSk }),
    ).rejects.toBeInstanceOf(InvalidConversationHistoryCursorError);
  });

  test("loads the newest checkpoint at or before the requested sequence", async () => {
    let query: Readonly<Record<string, unknown>> | undefined;
    const checkpoint = {
      data: { throughSequence: 42 },
      itemType: "conversation-checkpoint",
    } as unknown as Extract<PlatformRecord, { readonly itemType: "conversation-checkpoint" }>;
    const persistence = makeConversationPersistence(
      database({
        queryRecords: (_table, input) => {
          query = input;
          return Promise.resolve({ items: [checkpoint] });
        },
      }),
    );

    expect(
      await persistence.latestCheckpoint(
        { organizationId: "organization-id", threadId: "thread-id" },
        42,
      ),
    ).toBe(checkpoint);
    expect(query).toMatchObject({
      ExpressionAttributeValues: {
        ":pk": "ORG#organization-id#THREAD#thread-id",
        ":prefix": "CONVERSATION-CHECKPOINT#",
        ":upper": "CONVERSATION-CHECKPOINT#0000000000000042#~#~",
      },
      Limit: 1,
      ScanIndexForward: false,
    });
  });

  test("paginates until it finds a newer user message", async () => {
    let calls = 0;
    const assistant = {
      data: { role: "assistant", sequence: 8 },
      itemType: "message",
    } as unknown as PlatformRecord;
    const user = {
      data: { role: "user", sequence: 9 },
      itemType: "message",
    } as unknown as PlatformRecord;
    const persistence = makeConversationPersistence(
      database({
        queryRecords: (_table, input) => {
          calls += 1;
          expect(input).toMatchObject({
            ConsistentRead: true,
            ExpressionAttributeValues: {
              ":lower": "MESSAGE#0000000000000007#~",
              ":pk": "ORG#organization-id#THREAD#thread-id",
              ":upper": "MESSAGE#~",
            },
            Limit: 100,
            ScanIndexForward: true,
          });
          return Promise.resolve(
            calls === 1
              ? {
                  items: [assistant],
                  lastEvaluatedKey: { pk: "thread", sk: "message-8" },
                }
              : { items: [user] },
          );
        },
      }),
    );

    expect(
      persistence.hasUserMessageAfter(
        { organizationId: "organization-id", threadId: "thread-id" },
        7,
      ),
    ).resolves.toBe(true);
    expect(calls).toBe(2);
  });

  test("loads a bounded chronological message range for checkpoint generation", async () => {
    let query: Readonly<Record<string, unknown>> | undefined;
    const older = { data: { sequence: 8 }, itemType: "message" } as unknown as PlatformRecord;
    const newer = { data: { sequence: 9 }, itemType: "message" } as unknown as PlatformRecord;
    const persistence = makeConversationPersistence(
      database({
        queryRecords: (_table, input) => {
          query = input;
          return Promise.resolve({ items: [older, newer] });
        },
      }),
    );

    expect(
      await persistence.messagesInSequenceRange(
        { organizationId: "organization-id", threadId: "thread-id" },
        { afterSequence: 7, limit: 512, throughSequence: 9 },
      ),
    ).toEqual([older, newer]);
    expect(query).toMatchObject({
      ExpressionAttributeValues: {
        ":lower": "MESSAGE#0000000000000008",
        ":upper": "MESSAGE#0000000000000009#~",
      },
      Limit: 512,
      ScanIndexForward: true,
    });
  });

  test("paginates past transient and replay-protected messages before bounding checkpoint input", async () => {
    let calls = 0;
    const transient = {
      data: {
        metadata: { deploymentsAiConversationVisibility: "transient" },
        sequence: 8,
      },
      itemType: "message",
    } as unknown as PlatformRecord;
    const visible = { data: { sequence: 9 }, itemType: "message" } as unknown as PlatformRecord;
    const protectedMessage = {
      data: {
        metadata: { deploymentsAiConversationReplay: "excluded" },
        sequence: 9,
      },
      itemType: "message",
    } as unknown as PlatformRecord;
    const persistence = makeConversationPersistence(
      database({
        queryRecords: () => {
          calls += 1;
          return Promise.resolve(
            calls === 1
              ? {
                  items: [transient],
                  lastEvaluatedKey: { pk: "thread", sk: "message-8" },
                }
              : calls === 2
                ? {
                    items: [protectedMessage],
                    lastEvaluatedKey: { pk: "thread", sk: "message-9-protected" },
                  }
                : { items: [visible] },
          );
        },
      }),
    );

    expect(
      await persistence.messagesInSequenceRange(
        { organizationId: "organization-id", threadId: "thread-id" },
        { afterSequence: 7, limit: 1, throughSequence: 9 },
      ),
    ).toEqual([visible]);
    expect(calls).toBe(3);
  });

  test("selects only failed or missing completed-run flushes after a partial checkpoint", async () => {
    const scope = {
      environmentId: "environment-id",
      organizationId: "organization-id",
      projectId: "project-id",
      threadId: "thread-id",
    };
    const threadPk = "ORG#organization-id#THREAD#thread-id";
    const runPk = (runId: string) => `ORG#organization-id#RUN#${runId}`;
    const record = <T extends PlatformRecord["itemType"]>(
      pk: string,
      sk: string,
      itemType: T,
      data: Record<string, unknown>,
    ) => ({ data, itemType, pk, sk }) as Extract<PlatformRecord, { readonly itemType: T }>;
    const recoverableRun = record(threadPk, "RUN#recoverable", "run", {
      ...scope,
      agentDeploymentId: "deployment-id",
      createdAt: "2026-09-05T00:00:00.000Z",
      id: "recoverable-run-id",
      idempotencyKey: "recoverable",
      responsePublication: "external",
      status: "completed",
      trigger: "chat",
      userMessageId: "message-8",
      userMessageSequence: 8,
    });
    const settledRun = record(threadPk, "RUN#settled", "run", {
      ...scope,
      agentDeploymentId: "deployment-id",
      createdAt: "2026-09-05T00:00:01.000Z",
      id: "settled-run-id",
      idempotencyKey: "settled",
      status: "completed",
      trigger: "api",
      userMessageId: "message-10",
      userMessageSequence: 10,
    });
    const publication = record(
      threadPk,
      "MESSAGE-PUBLICATION#recoverable-run-id",
      "message-publication",
      {
        ...scope,
        agentDeploymentId: "deployment-id",
        runId: "recoverable-run-id",
        status: "published",
      },
    );
    const records: PlatformRecord[] = [
      record(threadPk, "RUN-LOOKUP#recoverable-run-id", "run-lookup", {
        ...scope,
        idempotencyKey: "recoverable",
        runId: "recoverable-run-id",
      }),
      recoverableRun,
      record(
        runPk("recoverable-run-id"),
        "MEMORY-FLUSH#memory-flush%3Arecoverable-run-id",
        "memory-flush",
        {
          ...scope,
          runId: "recoverable-run-id",
          status: "failed",
        },
      ),
      publication,
      record(threadPk, "RUN-LOOKUP#settled-run-id", "run-lookup", {
        ...scope,
        idempotencyKey: "settled",
        runId: "settled-run-id",
      }),
      settledRun,
      record(
        runPk("settled-run-id"),
        "MEMORY-FLUSH#memory-flush%3Asettled-run-id",
        "memory-flush",
        {
          ...scope,
          runId: "settled-run-id",
          status: "succeeded",
        },
      ),
    ];
    const stored = new Map(records.map((value) => [`${value.pk}\n${value.sk}`, value]));
    const messages = [
      record(threadPk, "MESSAGE#0000000000000008#message-8", "message", {
        ...scope,
        id: "message-8",
        role: "user",
        runId: "recoverable-run-id",
        sequence: 8,
      }),
      record(threadPk, "MESSAGE#0000000000000010#message-10", "message", {
        ...scope,
        id: "message-10",
        role: "user",
        runId: "settled-run-id",
        sequence: 10,
      }),
    ];
    const persistence = makeConversationContinuityRecoveryPersistence(
      database({
        getRecord: (_table, requested) => {
          const value = stored.get(`${requested.pk}\n${requested.sk}`);
          return Promise.resolve(value ? value : undefined);
        },
        queryRecords: () => Promise.resolve({ items: messages }),
      }),
    );

    const candidates = await persistence.candidates({
      checkpoint: {
        data: { throughMessageCharacterOffset: 12_000, throughSequence: 8 },
      } as never,
      scope,
      throughSequence: 10,
    });

    expect(candidates).toEqual([
      {
        publication,
        run: recoverableRun,
      },
    ]);
  });

  test("guards every source thread while repairing checkpoint continuity", async () => {
    let transaction: readonly TransactionOperation[] = [];
    const thread = (id: string, version: number) =>
      ({
        data: { agentDeploymentId: `deployment-${id}`, id, version },
        itemType: "thread",
        pk: `thread-${id}`,
        sk: `thread-${id}`,
      }) as unknown as Extract<PlatformRecord, { readonly itemType: "thread" }>;
    const checkpoint = (id: string) =>
      ({
        data: { contentHash: `hash-${id}`, throughSequence: 8 },
        itemType: "conversation-checkpoint",
        pk: `checkpoint-${id}`,
        sk: `checkpoint-${id}`,
      }) as unknown as Extract<PlatformRecord, { readonly itemType: "conversation-checkpoint" }>;
    const sourceThread = thread("source", 10);
    const targetThread = thread("target", 12);
    const sourceCheckpoint = checkpoint("source");
    const targetCheckpoint = checkpoint("target");

    await makeConversationThreadContinuityPersistence(
      database({
        transactWrite: (operations) =>
          (async () => {
            transaction = operations;
          })(),
      }),
    ).saveCheckpointAtThreadVersions({
      checkpoint: checkpoint("repair"),
      sourceCheckpoints: [sourceCheckpoint, targetCheckpoint],
      threads: [sourceThread, targetThread],
    });

    expect(transaction).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expressionAttributeValues: expect.objectContaining({ ":version": 10 }),
          key: { pk: sourceThread.pk, sk: sourceThread.sk },
          kind: "condition-check",
        }),
        expect.objectContaining({
          expressionAttributeValues: expect.objectContaining({ ":version": 12 }),
          key: { pk: targetThread.pk, sk: targetThread.sk },
          kind: "condition-check",
        }),
      ]),
    );
  });
});
