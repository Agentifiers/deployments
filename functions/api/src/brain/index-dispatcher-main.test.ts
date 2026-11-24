import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SendMessageBatchCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  BrainIndexJobRecord,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
} from "@deployments-ai/db";
import { Schema } from "effect";
import {
  brainIndexEventDetail,
  brainIndexMessageGroup,
  brainIndexQueueMessage,
  dispatchDueBrainIndexJobs,
  handleBrainIndexSemanticEvent,
} from "./index-dispatcher-main.ts";

const event = {
  eventId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  payload: {
    documentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    indexJobIdempotencyKey: "01ARZ3NDEKTSV4RRFFQ69G5FAX:3:index",
  },
};

describe("Brain index dispatch", () => {
  let previousQueueUrl: string | undefined;
  beforeEach(() => {
    previousQueueUrl = process.env.DEPLOYMENTS_AI_BRAIN_INDEX_QUEUE_URL;
    process.env.DEPLOYMENTS_AI_BRAIN_INDEX_QUEUE_URL = "https://sqs.example/brain-index.fifo";
  });
  afterEach(() => {
    if (previousQueueUrl === undefined) delete process.env.DEPLOYMENTS_AI_BRAIN_INDEX_QUEUE_URL;
    else process.env.DEPLOYMENTS_AI_BRAIN_INDEX_QUEUE_URL = previousQueueUrl;
  });

  test("creates a deterministic per-document FIFO lane", () => {
    const message = brainIndexQueueMessage(event);
    expect(brainIndexMessageGroup(message)).toHaveLength(64);
    expect(brainIndexMessageGroup(message)).toBe(brainIndexMessageGroup({ ...message }));
  });

  test("dispatches the canonical durable job identity", async () => {
    const commands: SendMessageCommand[] = [];
    await handleBrainIndexSemanticEvent(event, {
      send: async (command) => {
        commands.push(command as unknown as SendMessageCommand);
        return {} as never;
      },
    });
    expect(commands[0]?.input).toMatchObject({
      MessageDeduplicationId: event.eventId,
      MessageGroupId: brainIndexMessageGroup(brainIndexQueueMessage(event)),
      QueueUrl: "https://sqs.example/brain-index.fifo",
    });
    expect(JSON.parse(commands[0]!.input.MessageBody!)).toEqual(brainIndexQueueMessage(event));
  });

  test("unwraps the EventBridge detail envelope before semantic dispatch", () => {
    expect(brainIndexEventDetail({ detail: event })).toBe(event);
  });

  test("rejects semantic events without their transactionally-created job identity", () => {
    expect(() => brainIndexQueueMessage({ organizationId: event.organizationId })).toThrow(
      "documentId",
    );
  });

  test("redelivers an expired running job from its strongly re-read lease", async () => {
    const job = Schema.decodeUnknownSync(BrainIndexJobRecord)(
      withCanonicalRecordKeys({
        data: {
          attempt: 1,
          brainId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
          components: [],
          createdAt: "2026-07-31T11:00:00.000Z",
          documentId: event.payload.documentId,
          documentVersionId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
          embeddingProfileId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
          expectedProjectionGeneration: 1,
          id: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
          idempotencyKey: event.payload.indexJobIdempotencyKey,
          leaseExpiresAt: "2026-07-31T11:59:00.000Z",
          leaseOwner: "expired-worker",
          nextDueAt: "2026-07-31T11:00:00.000Z",
          operation: "index" as const,
          organizationId: event.organizationId,
          placementGeneration: 1,
          priority: 0,
          provider: "aws-native" as const,
          schemaGeneration: 1,
          sourceId: "01ARZ3NDEKTSV4RRFFQ69G5FB2",
          startedAt: "2026-07-31T11:30:00.000Z",
          status: "running" as const,
          targetId: "01ARZ3NDEKTSV4RRFFQ69G5FB3",
          updatedAt: "2026-07-31T11:30:00.000Z",
          version: 1,
        },
        itemType: "brain-index-job" as const,
      }),
    );
    const database = {
      getRecord: () => Promise.resolve(job),
      queryRecords: (
        _table: unknown,
        input: { ExpressionAttributeValues?: Record<string, unknown> },
      ) =>
        Promise.resolve({
          items: input.ExpressionAttributeValues?.[":pk"] === job.gsi1pk ? [job] : [],
        }),
    } as unknown as DynamoDatabaseService;
    const commands: SendMessageBatchCommand[] = [];

    expect(
      dispatchDueBrainIndexJobs(database, new Date("2026-07-31T12:00:00.000Z"), {
        send: async (command) => {
          commands.push(command as unknown as SendMessageBatchCommand);
          return {} as never;
        },
      }),
    ).resolves.toEqual({ dispatched: 1 });
    expect(JSON.parse(commands[0]!.input.Entries![0]!.MessageBody!)).toEqual({
      documentId: event.payload.documentId,
      idempotencyKey: event.payload.indexJobIdempotencyKey,
      organizationId: event.organizationId,
    });
  });
});
