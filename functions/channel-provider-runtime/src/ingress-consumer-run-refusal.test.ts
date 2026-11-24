import { describe, expect, test } from "bun:test";
import { ConversationError, endUserKeyDeriver } from "@deployments-ai/conversations";
import {
  AgentDeploymentRecord,
  ChannelBindingRecord,
  withCanonicalRecordKeys,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import {
  processChannelIngressQueueCommand,
  type ChannelIngressQueueConsumerDependencies,
} from "./ingress-consumer.ts";
import { withoutAttachmentCapture } from "./ingress-consumer-test-support.ts";
import type { ChannelIngressQueueMessageV1 } from "./ingress.ts";

const END_USER_SUBJECTS = endUserKeyDeriver("channel-ingress-test-subject-key-0123456789");

const id = (suffix: string) => `01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}` as Ulid;
const timestamp = "2026-07-25T12:00:00.000Z";

const message: ChannelIngressQueueMessageV1 = {
  bindingId: id("1"),
  environmentId: id("2"),
  ingress: {
    channel: "telegram",
    content: "Review the latest update.",
    externalAccountId: "account-1",
    externalChannelId: "bot-1",
    externalMessageId: "message-1",
    externalThreadKey: "chat-1",
    externalWorkspaceId: "bot-1",
    provider: "telegram",
    sender: { displayName: "Sender", id: "sender-1" },
  },
  organizationId: id("3"),
  projectId: id("4"),
  receivedAt: timestamp,
  type: "channel.ingress",
  version: 1,
};

const binding = Schema.decodeUnknownSync(ChannelBindingRecord)(
  withCanonicalRecordKeys({
    data: {
      agentDefinitionId: id("5"),
      agentDeploymentId: id("6"),
      channel: "telegram",
      createdAt: timestamp,
      environmentId: message.environmentId,
      externalAccountId: "account-1",
      externalChannelId: "bot-1",
      externalThreadKey: "chat-1",
      externalWorkspaceId: "bot-1",
      id: message.bindingId,
      organizationId: message.organizationId,
      projectId: message.projectId,
      provider: "telegram",
      status: "active",
      updatedAt: timestamp,
      version: 0,
    },
    itemType: "channel-binding" as const,
  }),
);

const deployment = Schema.decodeUnknownSync(AgentDeploymentRecord)(
  withCanonicalRecordKeys({
    data: {
      agentDefinitionId: id("5"),
      agentReleaseId: id("7"),
      createdAt: timestamp,
      currentState: "ready",
      desiredState: "running",
      environmentId: message.environmentId,
      id: id("6"),
      organizationId: message.organizationId,
      projectId: message.projectId,
      updatedAt: timestamp,
      version: 0,
    },
    itemType: "agent-deployment" as const,
  }),
);

const flush = {
  bindingId: message.bindingId,
  burstId: "a".repeat(64),
  dueAt: "2026-07-25T12:00:03.500Z",
  environmentId: message.environmentId,
  organizationId: message.organizationId,
  projectId: message.projectId,
  routeId: "b".repeat(64),
} as const;

function runtime(submitError: Error) {
  const payloads: unknown[] = [];
  const completed: unknown[] = [];
  const dependencies = {
    burstPersistence: {
      complete: async (value) => void completed.push(value),
      prepare: async () => ({
        burstId: flush.burstId,
        kind: "ready" as const,
        payloads: payloads as never,
        routeId: flush.routeId,
        sourceMessageIds: [message.ingress.externalMessageId],
        throughSequence: 0,
      }),
      stage: async (input) => {
        payloads.push(input.payload);
        return {
          burstId: flush.burstId,
          duplicate: false,
          flushes: [flush],
          routeId: flush.routeId,
        };
      },
    },
    enqueueFlush: async () => undefined,
    ...withoutAttachmentCapture,
    endUserSubjects: END_USER_SUBJECTS,
    loadBinding: async () => binding,
    loadDeployment: async () => deployment,
    resolveThreadId: async () => id("8"),
    submitTurn: async () => {
      throw submitError;
    },
  } satisfies ChannelIngressQueueConsumerDependencies;
  return { completed, dependencies };
}

describe("channel ingress run refusals", () => {
  for (const [code, detail] of [
    ["budget_exhausted", 'Budget "Org monthly" (01ARZ3NDEKTSV4RRFFQ69G0099) is exhausted.'],
    [
      "organization_suspended",
      "The organization is suspended; new runs are refused until every hold is released.",
    ],
  ] as const) {
    test(`drops a burst refused with ${code} instead of redelivering it`, async () => {
      const { completed, dependencies } = runtime(new ConversationError(code, detail));
      await processChannelIngressQueueCommand(message, dependencies);

      expect(
        processChannelIngressQueueCommand(
          { ...flush, type: "channel.ingress.flush", version: 1 },
          dependencies,
        ),
      ).resolves.toEqual({ code, detail, kind: "refused" });
      expect(completed).toEqual([expect.objectContaining(flush)]);
    });
  }

  for (const code of ["write_failed", "organization_standing_unavailable"]) {
    test(`leaves a ${code} submission failure retryable`, async () => {
      const { completed, dependencies } = runtime(
        new ConversationError(code, "The turn could not be admitted."),
      );
      await processChannelIngressQueueCommand(message, dependencies);

      expect(
        processChannelIngressQueueCommand(
          { ...flush, type: "channel.ingress.flush", version: 1 },
          dependencies,
        ),
      ).rejects.toMatchObject({ code });
      expect(completed).toEqual([]);
    });
  }
});
