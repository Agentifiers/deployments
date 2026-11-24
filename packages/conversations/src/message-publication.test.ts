import { describe, expect, test } from "bun:test";
import {
  MessageRecord,
  RunRecord,
  ThreadRecord,
  conversationMessageIsNonReplayable,
  conversationMessageIsTransient,
  nonReplayableConversationMessageMetadata,
  transientConversationMessageMetadata,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import { idGenerator, ids, memoryDatabase, now } from "./conversation-control.fixture.ts";
import { createConversationMessagePublicationService } from "./index.ts";
import {
  threadId,
  runId,
  sourceMessageId,
  fixture,
  externalFixture,
  newerUserMessage,
  recordOfType,
  currentThread,
  put,
  input,
  history,
} from "./message-publication.fixture.ts";

describe("delivered automation message publication", () => {
  test("publishes a completed external reactive run through the confirmation protocol", async () => {
    const records = externalFixture();
    const memory = memoryDatabase([records.thread, records.run, records.sourceMessage]);
    const service = createConversationMessagePublicationService({
      appendThreadEvent: async () => {},
      database: memory.database,
      generateId: idGenerator(20),
      now: () => now,
    });
    const command = input(records, "Got it — that changes the plan.");

    expect(service.reserve(command)).resolves.toMatchObject({ created: true });
    expect(service.publish({ ...command, thread: currentThread(memory) })).resolves.toMatchObject({
      created: true,
      message: { data: { body: command.content, role: "assistant" } },
    });
  });

  test("rejects an external reactive draft after a newer user message exists", async () => {
    const records = externalFixture();
    const user = newerUserMessage(records);
    const latestThread = Schema.decodeUnknownSync(ThreadRecord)(
      withCanonicalRecordKeys({
        ...records.thread,
        data: { ...records.thread.data, version: user.data.sequence },
      }),
    );
    const memory = memoryDatabase([latestThread, records.run, records.sourceMessage, user]);
    const service = createConversationMessagePublicationService({
      database: memory.database,
      generateId: idGenerator(20),
      now: () => now,
    });

    expect(service.reserve({ ...input(records), thread: latestThread })).rejects.toMatchObject({
      code: "publication_superseded",
    });
    expect(recordOfType(memory, "message-publication")).toBeUndefined();
  });

  test("rechecks newer user input after a reservation CAS race", async () => {
    const records = externalFixture();
    const user = newerUserMessage(records);
    const latestThread = Schema.decodeUnknownSync(ThreadRecord)(
      withCanonicalRecordKeys({
        ...records.thread,
        data: { ...records.thread.data, version: user.data.sequence },
      }),
    );
    const memory = memoryDatabase([records.thread, records.run, records.sourceMessage]);
    const transactWrite = memory.database.transactWrite;
    let injected = false;
    const service = createConversationMessagePublicationService({
      database: {
        ...memory.database,
        transactWrite: async (operations, token, signal) => {
          if (
            !injected &&
            operations.some(
              (operation) =>
                operation.kind === "put" && operation.record.itemType === "message-publication",
            )
          ) {
            injected = true;
            await memory.database.putRecord(latestThread);
            await memory.database.putRecord(user);
            throw new Error("simulated thread compare-and-swap conflict");
          }
          return transactWrite(operations, token, signal);
        },
      },
      generateId: idGenerator(20),
      now: () => now,
    });

    expect(service.reserve(input(records))).rejects.toMatchObject({
      code: "publication_superseded",
    });
    expect(recordOfType(memory, "message-publication")).toBeUndefined();
  });

  test("reserves invisibly, publishes once after delivery, and replays idempotently", async () => {
    const records = fixture();
    const memory = memoryDatabase([records.thread, records.run, records.sourceMessage]);
    const appended: unknown[] = [];
    const service = createConversationMessagePublicationService({
      appendThreadEvent: async (event) => void appended.push(event),
      database: memory.database,
      generateId: idGenerator(20),
      now: () => now,
    });
    const command = input(records);

    const reserved = await service.reserve(command);
    const replayedReservation = await service.reserve(command);

    expect(reserved.created).toBe(true);
    expect(replayedReservation.created).toBe(false);
    expect(reserved.publication.data).toMatchObject({
      messageSequence: 6,
      runId,
      sourceMessageId,
      status: "reserved",
      threadId,
    });
    expect(history(memory)).rejects.toMatchObject({ code: "publication_busy" });
    expect(appended).toEqual([]);
    expect(recordOfType(memory, "runtime-lease")?.data.owner).toBe(
      `message-publication/${reserved.publication.data.id}`,
    );

    const published = await service.publish({ ...command, thread: currentThread(memory) });
    const replayed = await service.publish({ ...command, thread: currentThread(memory) });

    expect(published.created).toBe(true);
    expect(replayed.created).toBe(false);
    expect(replayed.message.data.id).toBe(published.message.data.id);
    expect(memory.transactions).toHaveLength(3);
    expect(published.message.data).toMatchObject({
      body: command.content,
      role: "assistant",
      runId,
      sequence: 6,
      threadId,
    });
    expect(conversationMessageIsTransient(records.sourceMessage.data.metadata)).toBe(true);
    expect(conversationMessageIsTransient(published.message.data.metadata)).toBe(false);
    expect(published.message.data.metadata).toMatchObject({
      deploymentsAiDeliveryPublication: {
        kind: "confirmed-external-delivery",
        sourceMessageId,
        sourceMessageSequence: 5,
        sourceRunId: runId,
      },
    });
    expect((await history(memory)).items.map((message) => message.data.id)).toEqual([
      published.message.data.id,
    ]);
    expect(appended).toHaveLength(1);
    expect(recordOfType(memory, "runtime-lease")).toBeUndefined();
    expect(recordOfType(memory, "message-publication")?.data.status).toBe("published");
    expect(
      service.publish({
        ...command,
        idempotencyKey: "different-key-for-the-same-run",
        thread: currentThread(memory),
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  test("retains the committed barrier when no durable stream appender is configured", async () => {
    const records = fixture("schedule");
    const memory = memoryDatabase([records.thread, records.run, records.sourceMessage]);
    const service = createConversationMessagePublicationService({
      database: memory.database,
      generateId: idGenerator(20),
      now: () => now,
    });
    const command = input(records, "delivery needs its canonical stream event");
    await service.reserve(command);

    expect(service.publish({ ...command, thread: currentThread(memory) })).rejects.toMatchObject({
      code: "stream_unavailable",
    });
    expect(recordOfType(memory, "message-publication")?.data.status).toBe("committed");
    expect(recordOfType(memory, "runtime-lease")).toBeDefined();
  });

  test("retries stream publication without duplicating durable state", async () => {
    const records = fixture("schedule");
    const memory = memoryDatabase([records.thread, records.run, records.sourceMessage]);
    let appendAttempts = 0;
    const service = createConversationMessagePublicationService({
      appendThreadEvent: async () => {
        appendAttempts += 1;
        expect(recordOfType(memory, "runtime-lease")).toBeDefined();
        if (appendAttempts === 1) throw new Error("stream unavailable");
      },
      database: memory.database,
      generateId: idGenerator(20),
      now: () => now,
    });
    const command = input(records, "you asked me to remind you");
    await service.reserve(command);

    expect(service.publish({ ...command, thread: currentThread(memory) })).rejects.toMatchObject({
      code: "stream_unavailable",
    });
    expect(recordOfType(memory, "runtime-lease")).toBeDefined();
    expect(recordOfType(memory, "message-publication")?.data.status).toBe("committed");
    expect(service.release({ ...command, thread: currentThread(memory) })).rejects.toMatchObject({
      code: "publication_unavailable",
    });
    expect(service.publish({ ...command, thread: currentThread(memory) })).resolves.toMatchObject({
      created: false,
    });

    expect(memory.transactions).toHaveLength(3);
    expect(appendAttempts).toBe(2);
    expect((await history(memory)).items).toHaveLength(1);
    expect(recordOfType(memory, "runtime-lease")).toBeUndefined();
    expect(recordOfType(memory, "message-publication")?.data.status).toBe("published");
  });

  test("rejects unstreamable content before reserving conversation state", async () => {
    const records = fixture();
    const memory = memoryDatabase([records.thread, records.run, records.sourceMessage]);
    const service = createConversationMessagePublicationService({
      database: memory.database,
      generateId: idGenerator(20),
      now: () => now,
    });

    expect(service.reserve(input(records, "\u0000".repeat(180_000)))).rejects.toMatchObject({
      code: "message_too_large",
    });
    expect(memory.transactions).toEqual([]);
    expect(recordOfType(memory, "runtime-lease")).toBeUndefined();
    expect(recordOfType(memory, "message-publication")).toBeUndefined();
  });

  test("retains only the safe reference for replay-protected Brain output", async () => {
    const records = fixture();
    const safeReference =
      "Brain-derived content is available only through the authenticated private artifact API.";
    const protectedSource = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        ...records.sourceMessage,
        data: {
          ...records.sourceMessage.data,
          body: safeReference,
          contentHash: createHash("sha256").update(safeReference).digest("hex"),
          metadata: transientConversationMessageMetadata(
            nonReplayableConversationMessageMetadata({
              brainPublicationArtifactId: ids[39]!,
              kind: "brain-private-publication-link",
            }),
          ),
        },
      }),
    );
    const memory = memoryDatabase([records.thread, records.run, protectedSource]);
    const appended: unknown[] = [];
    const service = createConversationMessagePublicationService({
      appendThreadEvent: async (event) => void appended.push(event),
      database: memory.database,
      generateId: idGenerator(20),
      now: () => now,
    });
    const protectedContent = "The memory-grounded private answer sent to the user.";
    const command = input({ ...records, sourceMessage: protectedSource }, protectedContent);

    await service.reserve(command);
    const result = await service.publish({ ...command, thread: currentThread(memory) });

    expect(result.message.data.body).toBe(safeReference);
    expect(result.message.data.body).not.toContain(protectedContent);
    expect(conversationMessageIsNonReplayable(result.message.data.metadata)).toBe(true);
    expect(JSON.stringify(memory.transactions)).not.toContain(protectedContent);
    expect(JSON.stringify(appended)).not.toContain(protectedContent);
    expect((await history(memory)).items.map((message) => message.data.body)).toEqual([
      safeReference,
    ]);
  });

  test("serializes multiple confirmed automation deliveries", async () => {
    const firstRecords = fixture();
    const memory = memoryDatabase([
      firstRecords.thread,
      firstRecords.run,
      firstRecords.sourceMessage,
    ]);
    const service = createConversationMessagePublicationService({
      appendThreadEvent: async () => {},
      database: memory.database,
      generateId: idGenerator(20),
      now: () => now,
    });
    const firstCommand = input(firstRecords, "first delivered automation");
    await service.reserve(firstCommand);
    const first = await service.publish({ ...firstCommand, thread: currentThread(memory) });

    const threadAfterSecondRun = Schema.decodeUnknownSync(ThreadRecord)(
      withCanonicalRecordKeys({
        ...currentThread(memory),
        data: { ...currentThread(memory).data, version: currentThread(memory).data.version + 1 },
      }),
    );
    const secondRun = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        ...firstRecords.run,
        data: {
          ...firstRecords.run.data,
          id: ids[15]!,
          idempotencyKey: "second-automation-run",
        },
      }),
    );
    const secondSource = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: {
          ...firstRecords.sourceMessage.data,
          body: "second generated automation",
          contentHash: createHash("sha256").update("second generated automation").digest("hex"),
          id: ids[16]!,
          runId: secondRun.data.id,
          sequence: threadAfterSecondRun.data.version,
          streamEventId: ids[17]!,
        },
        itemType: "message" as const,
      }),
    );
    put(memory, threadAfterSecondRun, secondRun, secondSource);
    const secondRecords = {
      run: secondRun,
      sourceMessage: secondSource,
      thread: threadAfterSecondRun,
    };
    const secondCommand = {
      ...input(secondRecords, "second delivered automation"),
      idempotencyKey: "second-publication",
    };
    await service.reserve(secondCommand);
    const second = await service.publish({ ...secondCommand, thread: currentThread(memory) });

    expect([first.message.data.sequence, second.message.data.sequence]).toEqual([6, 10]);
    expect((await history(memory)).items.map((message) => message.data.body)).toEqual([
      "first delivered automation",
      "second delivered automation",
    ]);
    expect(memory.transactions).toHaveLength(6);
  });

  test("rejects visible, reactive, and newly archived sources before reservation", async () => {
    const heartbeat = fixture();
    const visibleSource = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        ...heartbeat.sourceMessage,
        data: { ...heartbeat.sourceMessage.data, metadata: {} },
      }),
    );
    const visibleMemory = memoryDatabase([heartbeat.thread, heartbeat.run, visibleSource]);
    const visibleService = createConversationMessagePublicationService({
      database: visibleMemory.database,
      generateId: idGenerator(20),
    });
    expect(
      visibleService.reserve(input({ ...heartbeat, sourceMessage: visibleSource })),
    ).rejects.toMatchObject({ code: "publication_unavailable" });

    const reactive = fixture("api");
    const reactiveMemory = memoryDatabase([reactive.thread, reactive.run, reactive.sourceMessage]);
    const reactiveService = createConversationMessagePublicationService({
      database: reactiveMemory.database,
      generateId: idGenerator(20),
    });
    expect(reactiveService.reserve(input(reactive))).rejects.toMatchObject({
      code: "publication_unavailable",
    });

    const archivedThread = Schema.decodeUnknownSync(ThreadRecord)(
      withCanonicalRecordKeys({
        ...heartbeat.thread,
        data: { ...heartbeat.thread.data, archived: true, version: 6 },
      }),
    );
    const archivedMemory = memoryDatabase([archivedThread, heartbeat.run, heartbeat.sourceMessage]);
    const archivedService = createConversationMessagePublicationService({
      database: archivedMemory.database,
      generateId: idGenerator(20),
    });
    expect(
      archivedService.reserve(input({ ...heartbeat, thread: archivedThread })),
    ).rejects.toMatchObject({ code: "thread_archived" });

    expect(visibleMemory.transactions).toEqual([]);
    expect(reactiveMemory.transactions).toEqual([]);
    expect(archivedMemory.transactions).toEqual([]);
  });
});
