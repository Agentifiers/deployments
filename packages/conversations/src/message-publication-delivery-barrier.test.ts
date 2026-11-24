import { describe, expect, test } from "bun:test";
import { ThreadRecord, withCanonicalRecordKeys } from "@deployments-ai/db";
import { Schema } from "effect";
import type { ThreadStreamEvent } from "@deployments-ai/streaming";
import {
  controlFixtures,
  deploymentId,
  environmentId,
  idGenerator,
  memoryDatabase,
  now,
  organizationId,
  projectId,
  releaseId,
} from "./conversation-control.fixture.ts";
import { createConversationService, createConversationMessagePublicationService } from "./index.ts";
import {
  threadId,
  fixture,
  recordOfType,
  currentThread,
  put,
  input,
  history,
} from "./message-publication.fixture.ts";

describe("delivered automation message publication", () => {
  test("appends a confirmed delivery before accepting the next inbound turn", async () => {
    const records = fixture("schedule");
    const controls = controlFixtures();
    const memory = memoryDatabase([
      controls.deployment,
      controls.release,
      records.thread,
      records.run,
      records.sourceMessage,
    ]);
    const appended: ThreadStreamEvent[] = [];
    const publication = createConversationMessagePublicationService({
      appendThreadEvent: async (event) => void appended.push(event),
      database: memory.database,
      generateId: idGenerator(20),
      now: () => now,
    });
    const command = input(records, "i'll remind you now");
    await publication.reserve(command);
    const result = await publication.publish({ ...command, thread: currentThread(memory) });
    const conversations = createConversationService({
      appendThreadEvent: async (event) => void appended.push(event),
      database: memory.database,
      enqueueRun: async () => {},
      generateId: idGenerator(8),
      now: () => now,
    });
    const inbound = await conversations.submitTurn({
      actor: { type: "system" },
      agentDeploymentId: deploymentId,
      agentReleaseId: releaseId,
      content: "thanks",
      environmentId,
      idempotencyKey: "inbound-after-publication",
      organizationId,
      projectId,
      threadId,
    });
    const visible = await history(memory);

    expect(result.message.data.sequence).toBe(6);
    expect(inbound.message.data.sequence).toBe(9);
    expect(visible.items.map((message) => message.data.body)).toEqual([
      "i'll remind you now",
      "thanks",
    ]);
    expect(appended.map((event) => event.eventType)).toEqual([
      "assistant-message.finalized",
      "user-message.accepted",
    ]);
    expect(
      appended.map((event) => (event.payload as { readonly sequence: number }).sequence),
    ).toEqual([6, 9]);
    expect(currentThread(memory).data.version).toBe(9);
  });

  test("blocks new turns while a publication owns the thread ordering barrier", async () => {
    const records = fixture("schedule");
    const controls = controlFixtures();
    const memory = memoryDatabase([
      controls.deployment,
      controls.release,
      records.thread,
      records.run,
      records.sourceMessage,
    ]);
    const publication = createConversationMessagePublicationService({
      database: memory.database,
      generateId: idGenerator(20),
      now: () => now,
    });
    await publication.reserve(input(records, "i'll remind you now"));
    const conversations = createConversationService({
      database: memory.database,
      enqueueRun: async () => {},
      generateId: idGenerator(8),
      now: () => now,
    });

    expect(
      conversations.submitTurn({
        actor: { type: "system" },
        agentDeploymentId: deploymentId,
        agentReleaseId: releaseId,
        content: "thanks",
        environmentId,
        idempotencyKey: "inbound-during-publication",
        organizationId,
        projectId,
        threadId,
      }),
    ).rejects.toMatchObject({ code: "publication_busy" });
    expect(currentThread(memory).data.version).toBe(6);
  });

  test("keeps an unresolved delivery barrier valid across delayed queue retries", async () => {
    const records = fixture("schedule");
    const memory = memoryDatabase([records.thread, records.run, records.sourceMessage]);
    let currentTime = now;
    const service = createConversationMessagePublicationService({
      database: memory.database,
      generateId: idGenerator(20),
      now: () => currentTime,
    });
    const command = input(records, "still trying to deliver this reminder");
    await service.reserve(command);

    currentTime = new Date(now.getTime() + 24 * 60 * 60 * 1_000);

    expect(service.reserve(command)).resolves.toMatchObject({ created: false });
    expect(recordOfType(memory, "runtime-lease")?.data.expiresAt).toBe("9999-12-31T23:59:59.999Z");
  });

  test("keeps a released uncertain delivery invisible and removes its barrier", async () => {
    const records = fixture();
    const memory = memoryDatabase([records.thread, records.run, records.sourceMessage]);
    const service = createConversationMessagePublicationService({
      appendThreadEvent: async () => {},
      database: memory.database,
      generateId: idGenerator(20),
      now: () => now,
    });
    const command = input(records);
    await service.reserve(command);

    const released = await service.release({ ...command, thread: currentThread(memory) });
    const replayed = await service.release({ ...command, thread: currentThread(memory) });

    expect(released.changed).toBe(true);
    expect(released.publication.data.status).toBe("released");
    expect(replayed.changed).toBe(false);
    expect((await history(memory)).items).toEqual([]);
    expect(recordOfType(memory, "runtime-lease")).toBeUndefined();
    expect(memory.transactions).toHaveLength(2);
    expect(service.publish({ ...command, thread: currentThread(memory) })).rejects.toMatchObject({
      code: "publication_released",
    });
  });

  test("requires a reservation before confirmation", async () => {
    const records = fixture();
    const memory = memoryDatabase([records.thread, records.run, records.sourceMessage]);
    const service = createConversationMessagePublicationService({
      database: memory.database,
      generateId: idGenerator(20),
    });

    expect(service.publish(input(records))).rejects.toMatchObject({
      code: "publication_unavailable",
    });
    expect(memory.transactions).toEqual([]);
  });

  test("distinguishes a missing release reservation from a committed publication", async () => {
    const records = fixture();
    const memory = memoryDatabase([records.thread, records.run, records.sourceMessage]);
    const service = createConversationMessagePublicationService({
      database: memory.database,
      generateId: idGenerator(20),
      now: () => now,
    });
    const command = input(records, "delivery state must remain explicit");

    expect(service.release(command)).rejects.toMatchObject({
      code: "publication_not_reserved",
    });
    await service.reserve(command);
    expect(service.publish({ ...command, thread: currentThread(memory) })).rejects.toMatchObject({
      code: "stream_unavailable",
    });
    expect(recordOfType(memory, "message-publication")?.data.status).toBe("committed");
    expect(service.release({ ...command, thread: currentThread(memory) })).rejects.toMatchObject({
      code: "publication_unavailable",
    });
  });

  test("confirms a reserved delivery even if the thread is archived afterward", async () => {
    const records = fixture();
    const memory = memoryDatabase([records.thread, records.run, records.sourceMessage]);
    const service = createConversationMessagePublicationService({
      appendThreadEvent: async () => {},
      database: memory.database,
      generateId: idGenerator(20),
      now: () => now,
    });
    const command = input(records, "delivered before archive");
    await service.reserve(command);
    const reservedThread = currentThread(memory);
    const archived = Schema.decodeUnknownSync(ThreadRecord)(
      withCanonicalRecordKeys({
        ...reservedThread,
        data: {
          ...reservedThread.data,
          archived: true,
          version: reservedThread.data.version + 1,
        },
      }),
    );
    put(memory, archived);

    expect(service.publish({ ...command, thread: archived })).resolves.toMatchObject({
      created: true,
      message: { data: { body: "delivered before archive", sequence: 6 } },
    });
    expect(currentThread(memory).data.archived).toBe(true);
  });
});
