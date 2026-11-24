import { describe, expect, test } from "bun:test";
import type { Ulid } from "@deployments-ai/db";
import { createRunRequestedHandler, runQueueMessageFromEvent } from "./run-dispatch.ts";

const id = (suffix: string) => `01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}` as Ulid;

function event() {
  return {
    detail: {
      aggregateId: id("5"),
      environmentId: id("3"),
      eventType: "run.requested",
      organizationId: id("1"),
      payload: {
        idempotencyKey: "request-123",
        runId: id("5"),
        spanId: "0123456789abcdef",
        threadId: id("4"),
        traceId: "0123456789abcdef0123456789abcdef",
        userMessageId: id("6"),
        userMessageSequence: 2,
      },
      projectId: id("2"),
    },
    "detail-type": "run.requested",
  } as const;
}

describe("run requested dispatcher", () => {
  test("reconstructs and enqueues the canonical agent run message", async () => {
    const enqueued: unknown[] = [];
    const handler = createRunRequestedHandler(async (input) => void enqueued.push(input));

    await handler(event());

    expect(enqueued).toEqual([
      {
        deduplicationId: id("5"),
        message: {
          environmentId: id("3"),
          idempotencyKey: "request-123",
          organizationId: id("1"),
          projectId: id("2"),
          runId: id("5"),
          spanId: "0123456789abcdef",
          threadId: id("4"),
          traceId: "0123456789abcdef0123456789abcdef",
          userMessageId: id("6"),
          userMessageSequence: 2,
        },
        messageGroupId: `${id("1")}:${id("2")}:${id("3")}:${id("4")}`,
      },
    ]);
  });

  test("uses a caller-stable dispatch ID to bypass stale FIFO deduplication", async () => {
    const enqueued: unknown[] = [];
    const handler = createRunRequestedHandler(async (input) => void enqueued.push(input));
    const dispatchId = id("7");

    await handler({
      ...event(),
      detail: {
        ...event().detail,
        aggregateId: id("8"),
        payload: { ...event().detail.payload, dispatchId },
      },
    });

    expect(enqueued).toEqual([
      expect.objectContaining({
        deduplicationId: dispatchId,
        message: expect.objectContaining({ runId: id("5") }),
      }),
    ]);
  });

  test("accepts legacy run aggregate events without an explicit payload run ID", () => {
    const { runId: _runId, ...payload } = event().detail.payload;
    expect(
      runQueueMessageFromEvent({
        ...event(),
        detail: { ...event().detail, payload },
      }).runId,
    ).toBe(id("5"));
  });

  test("rejects malformed or unrelated semantic events", () => {
    expect(() => runQueueMessageFromEvent({ ...event(), "detail-type": "run.completed" })).toThrow(
      "only run.requested",
    );
    expect(() =>
      runQueueMessageFromEvent({
        ...event(),
        detail: {
          ...event().detail,
          payload: { ...event().detail.payload, threadId: "invalid" },
        },
      }),
    ).toThrow("canonical ULID");
  });
});
