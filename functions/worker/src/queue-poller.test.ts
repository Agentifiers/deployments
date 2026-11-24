import { describe, expect, it, spyOn } from "bun:test";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
  type ReceiveMessageCommandInput,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { RuntimeToolPreparationRetryableError } from "@deployments-ai/agent-runtime";
import {
  fifoQueueRecord,
  fixtures,
  inMemoryDatabase,
  workerDependencies,
} from "./agent-run.fixture.ts";
import { processAgentRunQueueDelivery, type AgentRunQueueDisposition } from "./queue.ts";
import { createAgentRunQueuePoller } from "./queue-poller.ts";
import type { AgentRunWorkerDependencies } from "./types.ts";
import { createWorkerDrain } from "./worker-drain.ts";

const QUEUE_URL = "https://sqs.us-east-2.amazonaws.com/123456789012/agent-runtime.fifo";

function message(messageId: string, messageGroupId: string): Message {
  return {
    Attributes: { ApproximateReceiveCount: "1", MessageGroupId: messageGroupId },
    Body: "{}",
    MessageId: messageId,
    ReceiptHandle: `receipt-${messageId}`,
  };
}

/**
 * Fake SQS: each receive takes the next scripted step; with the script exhausted a receive
 * long-polls until the host drains and then returns nothing. Deletes and visibility changes are
 * recorded as events.
 */
function fakeSqs(script: (() => Promise<readonly Message[]>)[], idle: Promise<void>) {
  const receives: ReceiveMessageCommandInput[] = [];
  const events: string[] = [];
  const messageId = (receiptHandle: string | undefined) => receiptHandle!.replace("receipt-", "");
  const client = {
    send: async (command: unknown) => {
      if (command instanceof ReceiveMessageCommand) {
        receives.push(command.input);
        const step = script.shift();
        if (!step) {
          await idle;
          return { Messages: [] };
        }
        return { Messages: [...(await step())] };
      }
      if (command instanceof DeleteMessageCommand) {
        events.push(`delete:${messageId(command.input.ReceiptHandle)}`);
        return {};
      }
      if (command instanceof ChangeMessageVisibilityCommand) {
        events.push(
          `visibility:${messageId(command.input.ReceiptHandle)}:${command.input.VisibilityTimeout}`,
        );
        return {};
      }
      throw new Error("Unexpected SQS command.");
    },
  } as unknown as Pick<SQSClient, "send">;
  return { client, events, receives };
}

function testDrain() {
  return createWorkerDrain({ schedule: () => () => undefined, timeoutMs: 100_000 });
}

/** One event-loop turn: every pending promise continuation runs, no wall-clock delay. */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await turn();
  }
  throw new Error("Condition was not reached.");
}

/** Lets the poller run to quiescence before asserting that something did not happen. */
async function quiesce() {
  for (let attempt = 0; attempt < 20; attempt += 1) await turn();
}

describe("agent run queue poller", () => {
  it("runs the head of each message group and hands the rest of the group straight back", async () => {
    const drain = testDrain();
    const sqs = fakeSqs(
      [
        async () => [
          message("a1", "g1"),
          message("b1", "g2"),
          message("a2", "g1"),
          message("a3", "g1"),
        ],
        // SQS withholds g1's next message until its head is deleted.
        async () => {
          await headBlocked.promise;
          await until(() => sqs.events.includes("delete:a1"));
          return [message("a2", "g1")];
        },
      ],
      drain.started,
    );
    const started: string[] = [];
    const headBlocked = Promise.withResolvers<void>();
    const poller = createAgentRunQueuePoller({
      client: sqs.client,
      drain,
      maxConcurrentRuns: 8,
      processRecord: async (record): Promise<AgentRunQueueDisposition> => {
        started.push(record.messageId);
        if (record.messageId === "a1") await headBlocked.promise;
        return "processed";
      },
      queueUrl: QUEUE_URL,
    });

    const running = poller.run();
    await until(() => sqs.events.includes("delete:b1") && sqs.receives.length === 2);

    expect(started).toEqual(["a1", "b1"]);
    expect(sqs.events.toSorted()).toEqual(["delete:b1", "visibility:a2:0", "visibility:a3:0"]);
    expect(poller.inFlightRuns()).toBe(1);

    headBlocked.resolve();
    await until(() => sqs.events.includes("delete:a2"));
    drain.start();
    await running;

    expect(started).toEqual(["a1", "b1", "a2"]);
    expect(sqs.events.indexOf("delete:a1")).toBeLessThan(sqs.events.indexOf("delete:a2"));
    expect(poller.inFlightRuns()).toBe(0);
  });

  it("deletes only processed deliveries and keeps returned ones for redelivery", async () => {
    const drain = testDrain();
    const sqs = fakeSqs([async () => [message("ok", "g1"), message("retry", "g2")]], drain.started);
    const poller = createAgentRunQueuePoller({
      client: sqs.client,
      drain,
      maxConcurrentRuns: 8,
      processRecord: async (record) => (record.messageId === "ok" ? "processed" : "returned"),
      queueUrl: QUEUE_URL,
    });

    const running = poller.run();
    await until(() => sqs.receives.length === 2);
    await quiesce();
    drain.start();
    await running;

    expect(sqs.events).toEqual(["delete:ok"]);
  });

  it("receives only while run slots are free and asks for no more than the free slots", async () => {
    const drain = testDrain();
    const sqs = fakeSqs([async () => [message("m1", "g1"), message("m2", "g2")]], drain.started);
    const gates = new Map([
      ["m1", Promise.withResolvers<void>()],
      ["m2", Promise.withResolvers<void>()],
    ]);
    const poller = createAgentRunQueuePoller({
      client: sqs.client,
      drain,
      maxConcurrentRuns: 2,
      processRecord: async (record) => {
        await gates.get(record.messageId)!.promise;
        return "processed";
      },
      queueUrl: QUEUE_URL,
    });

    const running = poller.run();
    await until(() => poller.inFlightRuns() === 2);
    await quiesce();

    expect(sqs.receives).toEqual([
      {
        MaxNumberOfMessages: 2,
        MessageSystemAttributeNames: ["MessageGroupId", "ApproximateReceiveCount"],
        QueueUrl: QUEUE_URL,
        ReceiveRequestAttemptId: expect.any(String),
        WaitTimeSeconds: 20,
      },
    ]);

    gates.get("m1")!.resolve();
    await until(() => sqs.receives.length === 2);
    expect(sqs.receives[1]?.MaxNumberOfMessages).toBe(1);

    drain.start();
    gates.get("m2")!.resolve();
    await running;
    expect(sqs.receives).toHaveLength(2);
  });

  it("stops receiving on drain, finishes in-flight runs, and hands back late deliveries", async () => {
    const drain = testDrain();
    const lateDelivery = Promise.withResolvers<readonly Message[]>();
    const sqs = fakeSqs(
      [async () => [message("busy", "g1")], async () => lateDelivery.promise],
      drain.started,
    );
    const busy = Promise.withResolvers<void>();
    const handedBack: string[] = [];
    const poller = createAgentRunQueuePoller({
      client: sqs.client,
      drain,
      maxConcurrentRuns: 4,
      processRecord: async (record, draining) => {
        if (draining()) {
          handedBack.push(record.messageId);
          return "returned";
        }
        await busy.promise;
        return "processed";
      },
      queueUrl: QUEUE_URL,
    });

    let finished = false;
    const running = poller.run().then(() => {
      finished = true;
    });
    await until(() => sqs.receives.length === 2);
    drain.start();
    lateDelivery.resolve([message("late", "g2")]);
    await quiesce();

    expect(finished).toBe(false);
    expect(handedBack).toEqual(["late"]);

    busy.resolve();
    await running;
    expect(sqs.receives).toHaveLength(2);
    expect(sqs.events).toEqual(["delete:busy"]);
    expect(poller.inFlightRuns()).toBe(0);
  });

  it("backs off failed receives from 1 s to 30 s and retries with the same attempt ID", async () => {
    const drain = testDrain();
    const failure = async (): Promise<readonly Message[]> => {
      throw new Error("SQS unavailable");
    };
    const sqs = fakeSqs(
      [...Array.from({ length: 7 }, () => failure), async () => [], failure],
      drain.started,
    );
    const delays: number[] = [];
    let attempts = 0;
    const poller = createAgentRunQueuePoller({
      client: sqs.client,
      drain,
      generateAttemptId: () => `attempt-${++attempts}`,
      maxConcurrentRuns: 4,
      processRecord: async () => "processed",
      queueUrl: QUEUE_URL,
      sleep: async (delayMs) => void delays.push(delayMs),
    });

    const running = poller.run();
    await until(() => sqs.receives.length === 10);
    drain.start();
    await running;

    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 1_000]);
    expect(sqs.receives.map((input) => input.ReceiveRequestAttemptId)).toEqual([
      ...Array.from({ length: 8 }, () => "attempt-1"),
      "attempt-2",
      "attempt-2",
    ]);
  });

  it("refuses a queue URL that is not a FIFO queue", () => {
    expect(() =>
      createAgentRunQueuePoller({
        client: fakeSqs([], Promise.resolve()).client,
        drain: testDrain(),
        maxConcurrentRuns: 4,
        processRecord: async () => "processed",
        queueUrl: "https://sqs.us-east-2.amazonaws.com/123456789012/agent-runtime",
      }),
    ).toThrow("must target a FIFO queue");
  });
});

describe("agent run queue delivery", () => {
  it("hands a delivery back for immediate redelivery while the host drains", async () => {
    const retries: [string, number][] = [];
    const dependencies = {
      retryQueueMessage: async (
        delivery: { readonly messageId: string },
        _message: unknown,
        seconds: number,
      ) => void retries.push([delivery.messageId, seconds]),
    } as unknown as AgentRunWorkerDependencies;

    const disposition = await processAgentRunQueueDelivery(
      { body: "{}", messageGroupId: "g1", messageId: "first", receiptHandle: "r1" },
      dependencies,
      () => true,
    );

    expect(disposition).toBe("returned");
    expect(retries).toEqual([["first", 0]]);
  });

  it("logs a retryable runtime failure's class, persisted reason, and cause classes without cause messages", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const base = workerDependencies(memory.database);
    const retries: [string, number][] = [];
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      enqueueRun: async () => undefined,
      retryQueueMessage: async (delivery, _message, seconds) =>
        void retries.push([delivery.messageId, seconds]),
      runtime: {
        generateAssistantMessage: async () => {
          throw new RuntimeToolPreparationRetryableError(
            "web.scrape",
            new Error("Egress proxy denied tenant-private.example.com."),
          );
        },
      },
    };
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const info = spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const disposition = await processAgentRunQueueDelivery(
        fifoQueueRecord(fixture.queue, "delivery-1", "receipt-1"),
        dependencies,
      );

      expect(disposition).toBe("returned");
      expect(retries).toEqual([["delivery-1", 60]]);
      const persistedReason = [...memory.records.values()].flatMap((record) =>
        record.itemType === "timeline-event" && record.data.eventType === "run.retry-scheduled"
          ? [record.data.data?.reason]
          : [],
      );
      expect(persistedReason).toEqual([
        "Tool web.scrape preparation failed before provider dispatch.",
      ]);
      const outcome = warn.mock.calls.find(
        ([line]) => line === "Agent run queue record processed.",
      );
      expect(outcome?.[1]).toMatchObject({
        action: "requeued",
        failure: {
          causeTypes: ["Error"],
          message: persistedReason[0],
          type: "RuntimeToolPreparationRetryableError",
        },
        messageId: "delivery-1",
        runId: fixture.run.data.id,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("tenant-private.example.com");
      expect(info.mock.calls.some(([line]) => line === "Agent run queue record processed.")).toBe(
        false,
      );
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });
});
