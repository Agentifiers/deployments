import { endUserKeyDeriver } from "@deployments-ai/conversations";
import { describe, expect, test } from "bun:test";
import type { ChannelIngressQueueConsumerDependencies } from "./ingress-consumer.ts";
import {
  handleChannelIngressQueue,
  isChannelIngressQueueRuntime,
} from "./ingress-consumer-main.ts";
import { withoutAttachmentCapture } from "./ingress-consumer-test-support.ts";

const END_USER_SUBJECTS = endUserKeyDeriver("channel-ingress-test-subject-key-0123456789");

const flush = {
  bindingId: "01ARZ3NDEKTSV4RRFFQ69G0001",
  burstId: "a".repeat(64),
  dueAt: "2026-08-26T18:00:02.000Z",
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G0002",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G0003",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G0004",
  routeId: "b".repeat(64),
} as const;

describe("channel ingress queue handler", () => {
  test("reports only failed records while preserving an early flush trigger", async () => {
    const requeued: unknown[] = [];
    const runtime = {
      burstPersistence: {
        complete: async () => undefined,
        prepare: async () => ({
          dueAt: "2026-08-26T18:00:03.000Z",
          kind: "waiting" as const,
          waitFor: "quiet-window" as const,
        }),
        stage: async () => {
          throw new Error("not used");
        },
      },
      enqueueFlush: async (command) => {
        requeued.push(command);
      },
      ...withoutAttachmentCapture,
      endUserSubjects: END_USER_SUBJECTS,
      loadBinding: async () => {
        throw new Error("not used");
      },
      loadDeployment: async () => {
        throw new Error("not used");
      },
      resolveThreadId: async () => {
        throw new Error("not used");
      },
      submitTurn: async () => {
        throw new Error("not used");
      },
    } satisfies ChannelIngressQueueConsumerDependencies;

    const result = await handleChannelIngressQueue(
      {
        Records: [
          { body: "not-json", messageId: "invalid-record" },
          {
            body: JSON.stringify({ ...flush, type: "channel.ingress.flush", version: 1 }),
            messageId: "waiting-flush",
          },
        ],
      },
      runtime,
    );

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "invalid-record" }] });
    expect(requeued).toEqual([
      expect.objectContaining({
        ...flush,
        dueAt: "2026-08-26T18:00:03.000Z",
      }),
    ]);
  });

  test("does not treat the Lambda context as consumer runtime", () => {
    expect(
      isChannelIngressQueueRuntime({ awsRequestId: "id", functionName: "channel-command" }),
    ).toBe(false);
  });

  test("does not use the Lambda context as injected runtime", async () => {
    expect(
      handleChannelIngressQueue(
        { Records: [] },
        { awsRequestId: "id", functionName: "channel-command" },
      ),
    ).rejects.toThrow("DEPLOYMENTS_AI_AGENT_RUN_QUEUE_URL");
  });

  test("accepts an injected runtime that can load bindings", () => {
    expect(
      isChannelIngressQueueRuntime({
        loadBinding: async () => undefined,
      }),
    ).toBe(true);
  });
});
