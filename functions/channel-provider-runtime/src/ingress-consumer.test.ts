import { endUserKeyDeriver } from "@deployments-ai/conversations";
import { describe, expect, test } from "bun:test";
import { channelProviders, type ExternalAgentChannel } from "@deployments-ai/channel-adapters";
import {
  AgentDeploymentRecord,
  ChannelBindingRecord,
  withCanonicalRecordKeys,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import {
  channelIngressIdempotencyKey,
  decodeChannelIngressQueueMessage,
  processChannelIngress,
  processChannelIngressQueueCommand,
  type ChannelIngressConsumerDependencies,
  type ChannelIngressQueueConsumerDependencies,
} from "./ingress-consumer.ts";
import { withoutAttachmentCapture } from "./ingress-consumer-test-support.ts";
import {
  CHANNEL_INGRESS_QUIET_WINDOW_MAX_RESCHEDULES,
  type ChannelIngressQueueMessageV1,
} from "./ingress.ts";

const END_USER_SUBJECTS = endUserKeyDeriver("channel-ingress-test-subject-key-0123456789");

const id = (suffix: string) => `01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}` as Ulid;

const CHANNEL_PROVIDER_CASES = (
  [
    "slack",
    "imessage",
    "sms",
    "rcs",
    "teams",
    "telegram",
  ] as const satisfies readonly ExternalAgentChannel[]
).flatMap((channel) => channelProviders(channel).map((provider) => ({ channel, provider })));

const message: ChannelIngressQueueMessageV1 = {
  bindingId: id("1"),
  environmentId: id("2"),
  ingress: {
    attachments: [
      {
        contentType: "image/jpeg",
        fileName: "photo.jpg",
        kind: "image",
        url: "s3://vertical-rcs-media/inbound/photo.jpg",
      },
    ],
    channel: "telegram",
    content: "Review the latest update.",
    externalAccountId: "account-1",
    externalChannelId: "bot-1",
    externalMessageId: "message-1",
    externalThreadKey: "chat-1",
    externalWorkspaceId: "bot-1",
    provider: "telegram",
    metadata: { providerEvent: "media" },
    sender: { displayName: "Sender", id: "sender-1" },
  },
  organizationId: id("3"),
  projectId: id("4"),
  receivedAt: "2026-07-25T12:00:00.000Z",
  type: "channel.ingress",
  version: 1,
};

function records() {
  const timestamp = "2026-07-25T12:00:00.000Z";
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
  return { binding, deployment };
}

describe("channel ingress command consumer", () => {
  for (const provider of CHANNEL_PROVIDER_CASES) {
    test(`submits one ${provider.provider}/${provider.channel} turn containing every staged source message`, async () => {
      const { binding, deployment } = records();
      const scopedBinding = {
        ...binding,
        data: {
          ...binding.data,
          channel: provider.channel,
          ...(provider.channel === "slack"
            ? { externalWorkspaceId: "workspace-1" }
            : provider.provider === "aws_end_user_messaging_rcs"
              ? { externalWorkspaceId: undefined }
              : {}),
          provider: provider.provider,
        },
      } as typeof binding;
      const sourceMessages = ["first note", "second note", "final note"].map((content, index) => ({
        ...message,
        ingress: {
          ...message.ingress,
          channel: provider.channel,
          content,
          executor: "external",
          externalMessageId: `message-${index + 1}`,
          ...(provider.channel === "slack"
            ? {
                externalWorkspaceId: "workspace-1",
                metadata: {
                  messageTs: `170000000${index}.000100`,
                  slackEventType: "message",
                },
              }
            : provider.provider === "aws_end_user_messaging_rcs"
              ? { externalWorkspaceId: undefined, metadata: undefined }
              : provider.channel === "teams"
                ? {
                    metadata: {
                      teamsActivityId: `activity-${index + 1}`,
                      teamsConversationType: "channel",
                      teamsMentionIds: ["tag-1", "tag-1"],
                      teamsServiceUrl: "https://smba.trafficmanager.net/teams/",
                      unsupportedField: "dropped",
                    },
                  }
                : { metadata: undefined }),
          provider: provider.provider,
        },
        receivedAt: `2026-07-25T12:00:0${index}.000Z`,
      }));
      const payloads: unknown[] = [];
      const scheduledFlushes: unknown[] = [];
      const completedFlushes: unknown[] = [];
      const submitted: Parameters<ChannelIngressConsumerDependencies["submitTurn"]>[0][] = [];
      const flush = {
        bindingId: message.bindingId,
        burstId: "a".repeat(64),
        dueAt: "2026-07-25T12:00:03.500Z",
        environmentId: message.environmentId,
        organizationId: message.organizationId,
        projectId: message.projectId,
        routeId: "b".repeat(64),
      } as const;
      const runtime = {
        burstPersistence: {
          complete: async (completed) => {
            completedFlushes.push(completed);
          },
          prepare: async () => ({
            burstId: flush.burstId,
            kind: "ready" as const,
            payloads: payloads as never,
            routeId: flush.routeId,
            sourceMessageIds: sourceMessages.map(({ ingress }) => ingress.externalMessageId),
            throughSequence: 2,
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
        enqueueFlush: async (scheduled) => {
          scheduledFlushes.push(scheduled);
        },
        ...withoutAttachmentCapture,
        endUserSubjects: END_USER_SUBJECTS,
        loadBinding: async () => scopedBinding,
        loadDeployment: async () => deployment,
        resolveThreadId: async () => id("8"),
        submitTurn: async (input) => {
          submitted.push(input);
          return { run: { data: { id: id("9") } } } as never;
        },
      } satisfies ChannelIngressQueueConsumerDependencies;

      for (const source of sourceMessages) {
        await processChannelIngressQueueCommand(source, runtime);
      }
      await processChannelIngressQueueCommand(
        { ...flush, type: "channel.ingress.flush", version: 1 },
        runtime,
      );

      expect(scheduledFlushes).toHaveLength(3);
      expect(completedFlushes).toEqual([expect.objectContaining(flush)]);
      expect(submitted).toHaveLength(1);
      expect(submitted[0]).toMatchObject({
        channel: provider.channel,
        content: "first note\nsecond note\nfinal note",
        executor: "external",
        initiatingCaller: { sourceId: id("1"), sourceKind: "channel-binding", type: "ingress" },
        messageMetadata: {
          provider: provider.provider,
          routeId: flush.routeId,
          sourceMessageCount: 3,
          sourceMessageIds: ["message-1", "message-2", "message-3"],
          throughSequence: 2,
        },
        responsePublication: "external",
      });
      if (provider.channel === "slack") {
        expect(submitted[0]?.messageMetadata).toMatchObject({
          providerMetadata: { messageTs: "1700000002.000100" },
        });
      }
      if (provider.channel === "teams") {
        expect(submitted[0]?.messageMetadata?.providerMetadata).toEqual({
          teamsActivityId: "activity-3",
          teamsConversationType: "channel",
          teamsMentionIds: ["tag-1"],
          teamsServiceUrl: "https://smba.trafficmanager.net/teams/",
        });
      }
    });
  }

  test("scopes source-message idempotency to the complete conversation route", () => {
    expect(channelIngressIdempotencyKey({ ...message })).toBe(
      channelIngressIdempotencyKey(message),
    );
    expect(
      channelIngressIdempotencyKey({
        ...message,
        ingress: {
          ...message.ingress,
          externalMessageId: "1",
          externalThreadKey: "chat-2",
        },
      }),
    ).not.toBe(
      channelIngressIdempotencyKey({
        ...message,
        ingress: {
          ...message.ingress,
          externalMessageId: "1",
          externalThreadKey: "chat-1",
        },
      }),
    );
    expect(
      channelIngressIdempotencyKey({
        ...message,
        ingress: {
          ...message.ingress,
          externalMessageId: "1",
          externalThreadKey: "chat-1",
          externalWorkspaceId: "workspace-2",
        },
      }),
    ).not.toBe(
      channelIngressIdempotencyKey({
        ...message,
        ingress: {
          ...message.ingress,
          externalMessageId: "1",
          externalThreadKey: "chat-1",
          externalWorkspaceId: "workspace-1",
        },
      }),
    );
    const sameSource = {
      ...message,
      ingress: { ...message.ingress, externalMessageId: "shared-source-id" },
    };
    const routeVariants = [
      sameSource,
      { ...sameSource, bindingId: id("9") },
      {
        ...sameSource,
        ingress: { ...sameSource.ingress, externalAccountId: "account-2" },
      },
      { ...sameSource, ingress: { ...sameSource.ingress, executor: "external" } },
      {
        ...sameSource,
        ingress: {
          ...sameSource.ingress,
          channel: "rcs" as const,
          externalWorkspaceId: undefined,
          provider: "aws_end_user_messaging_rcs" as const,
        },
      },
    ];
    expect(new Set(routeVariants.map(channelIngressIdempotencyKey)).size).toBe(
      routeVariants.length,
    );
  });

  test("revalidates the pinned binding and submits one canonical chat turn", async () => {
    const { binding, deployment } = records();
    let submitted: Parameters<ChannelIngressConsumerDependencies["submitTurn"]>[0] | undefined;
    const result = await processChannelIngress(message, {
      ...withoutAttachmentCapture,
      endUserSubjects: END_USER_SUBJECTS,
      loadBinding: async () => binding,
      loadDeployment: async () => deployment,
      resolveThreadId: async () => id("8"),
      submitTurn: async (input) => {
        submitted = input;
        return { run: { data: { id: id("9") } } } as never;
      },
    });

    expect(result).toMatchObject({
      omittedAttachments: [],
      result: { run: { data: { id: id("9") } } },
      skippedAttachments: [],
    });
    expect(submitted).toMatchObject({
      actor: { type: "system" },
      agentDeploymentId: id("6"),
      channel: "telegram",
      createThreadIfMissing: true,
      externalThreadKey: "chat-1",
      idempotencyKey: channelIngressIdempotencyKey(message),
      initiatingCaller: { sourceId: id("1"), sourceKind: "channel-binding", type: "ingress" },
      threadId: id("8"),
      trigger: "chat",
    });
    // Release selection (primary or canary candidate) happens inside submitTurn.
    expect(submitted).not.toHaveProperty("agentReleaseId");
    expect(submitted?.messageMetadata).toMatchObject({
      attachments: [
        {
          fileName: "photo.jpg",
          url: "s3://vertical-rcs-media/inbound/photo.jpg",
        },
      ],
      bindingId: id("1"),
      externalMessageId: "message-1",
      externalWorkspaceId: "bot-1",
      sender: { id: "sender-1" },
      source: "channel-ingress",
    });
    expect(submitted?.messageMetadata).not.toHaveProperty("receivedAt");
    expect(submitted?.messageMetadata).not.toHaveProperty("providerMetadata");
  });

  test("retains only normalized RCS attachments and provider metadata", () => {
    const decoded = decodeChannelIngressQueueMessage({
      ...message,
      ingress: {
        ...message.ingress,
        attachments: [
          {
            artifactId: "01ARZ3NDEKTSV4RRFFQ69G0009",
            contentType: "image/jpeg",
            fileName: "photo.jpg",
            kind: "image",
            rawProviderFile: { secret: "discard" },
            sha256: "a".repeat(64),
            url: "s3://vertical-rcs-media/inbound/photo.jpg",
          },
        ],
        channel: "rcs",
        metadata: {
          awsRcs: {
            eventType: "MEDIA",
            fileName: "photo.jpg",
            rawPayload: { secret: "discard" },
          },
          awsRcsNotification: {
            destinationNumber: "agent-1",
            eventType: "MEDIA",
            rawEnvelope: { secret: "discard" },
          },
          rawWebhook: { secret: "discard" },
        },
        provider: "aws_end_user_messaging_rcs",
      },
    });

    expect(decoded.ingress.attachments).toEqual([
      {
        contentType: "image/jpeg",
        fileName: "photo.jpg",
        kind: "image",
        url: "s3://vertical-rcs-media/inbound/photo.jpg",
      },
    ]);
    expect(decoded.ingress.metadata).toEqual({
      awsRcs: { eventType: "MEDIA", fileName: "photo.jpg" },
      awsRcsNotification: { destinationNumber: "agent-1", eventType: "MEDIA" },
    });
  });

  test("retains only Slack stream-routing metadata", () => {
    const decoded = decodeChannelIngressQueueMessage({
      ...message,
      ingress: {
        ...message.ingress,
        channel: "slack",
        metadata: {
          channelType: "channel",
          messageTs: "1721609600.123456",
          rawEnvelope: { token: "discard" },
          slackEventId: "E1",
          slackEventType: "app_mention",
          slackUserGroupMentionIds: ["S123ABC", "S456DEF", "S123ABC"],
        },
        provider: "slack_edge",
      },
    });

    expect(decoded.ingress.metadata).toEqual({
      channelType: "channel",
      messageTs: "1721609600.123456",
      slackEventId: "E1",
      slackEventType: "app_mention",
      slackUserGroupMentionIds: ["S123ABC", "S456DEF"],
    });
  });

  test("rejects ingress from a different external workspace than the binding", async () => {
    const { binding } = records();
    const workspaceBinding = {
      ...binding,
      data: { ...binding.data, externalWorkspaceId: "workspace-1" },
    };
    expect(
      processChannelIngress(
        {
          ...message,
          ingress: { ...message.ingress, externalWorkspaceId: "workspace-2" },
        },
        {
          ...withoutAttachmentCapture,
          endUserSubjects: END_USER_SUBJECTS,
          loadBinding: async () => workspaceBinding,
          loadDeployment: async () => {
            throw new Error("must not load deployment");
          },
          resolveThreadId: async () => {
            throw new Error("must not resolve thread");
          },
          submitTurn: async () => {
            throw new Error("must not submit");
          },
        },
      ),
    ).rejects.toThrow("does not match the current binding");
  });

  test("rejects ingress from a different external thread than the binding", async () => {
    const { binding } = records();
    expect(
      processChannelIngress(
        {
          ...message,
          ingress: { ...message.ingress, externalThreadKey: "chat-2" },
        },
        {
          ...withoutAttachmentCapture,
          endUserSubjects: END_USER_SUBJECTS,
          loadBinding: async () => binding,
          loadDeployment: async () => {
            throw new Error("must not load deployment");
          },
          resolveThreadId: async () => {
            throw new Error("must not resolve thread");
          },
          submitTurn: async () => {
            throw new Error("must not submit");
          },
        },
      ),
    ).rejects.toThrow("does not match the current binding");
  });

  test("rejects tenant-scoped providers without a workspace pin", async () => {
    const { binding } = records();
    const { externalWorkspaceId: _externalWorkspaceId, ...unpinnedData } = binding.data;
    const unpinned = { ...binding, data: unpinnedData };
    expect(
      processChannelIngress(message, {
        ...withoutAttachmentCapture,
        endUserSubjects: END_USER_SUBJECTS,
        loadBinding: async () => unpinned,
        loadDeployment: async () => {
          throw new Error("must not load deployment");
        },
        resolveThreadId: async () => {
          throw new Error("must not resolve thread");
        },
        submitTurn: async () => {
          throw new Error("must not submit");
        },
      }),
    ).rejects.toThrow("does not match the current binding");
  });

  test("rejects unversioned messages and stale binding scope", async () => {
    expect(() =>
      decodeChannelIngressQueueMessage({ ...message, type: undefined, version: undefined }),
    ).toThrow("version is unsupported");
    expect(() =>
      decodeChannelIngressQueueMessage({
        ...message,
        ingress: { ...message.ingress, provider: undefined },
      }),
    ).toThrow("provider is required");
    const { binding, deployment } = records();
    expect(
      processChannelIngress(message, {
        ...withoutAttachmentCapture,
        endUserSubjects: END_USER_SUBJECTS,
        loadBinding: async () => ({
          ...binding,
          data: { ...binding.data, projectId: id("99") },
        }),
        loadDeployment: async () => deployment,
        resolveThreadId: async () => id("8"),
        submitTurn: async () => {
          throw new Error("must not submit");
        },
      }),
    ).rejects.toThrow("does not match queue scope");
  });

  test("retains a flush trigger when a newer source extends the quiet window", async () => {
    const dueAt = "2026-07-25T12:00:05.000Z";
    const flush = {
      bindingId: message.bindingId,
      burstId: "a".repeat(64),
      dueAt: "2026-07-25T12:00:03.500Z",
      environmentId: message.environmentId,
      organizationId: message.organizationId,
      projectId: message.projectId,
      routeId: "b".repeat(64),
      type: "channel.ingress.flush" as const,
      version: 1 as const,
    };
    const rescheduled: unknown[] = [];

    expect(
      processChannelIngressQueueCommand(flush, {
        burstPersistence: {
          complete: async () => undefined,
          prepare: async () => ({
            dueAt,
            kind: "waiting" as const,
            waitFor: "quiet-window" as const,
          }),
          stage: async () => {
            throw new Error("must not stage");
          },
        },
        enqueueFlush: async (value) => {
          rescheduled.push(value);
        },
        ...withoutAttachmentCapture,
        endUserSubjects: END_USER_SUBJECTS,
        loadBinding: async () => {
          throw new Error("must not load a binding");
        },
        loadDeployment: async () => {
          throw new Error("must not load a deployment");
        },
        resolveThreadId: async () => {
          throw new Error("must not resolve a thread");
        },
        submitTurn: async () => {
          throw new Error("must not submit");
        },
      }),
    ).resolves.toEqual({ dueAt, kind: "waiting", waitFor: "quiet-window" });
    expect(rescheduled).toEqual([expect.objectContaining({ ...flush, dueAt, rescheduleCount: 1 })]);
  });

  test("stops replacing a quiet-window flush after its durable reschedule budget", async () => {
    const flush = {
      bindingId: message.bindingId,
      burstId: "a".repeat(64),
      dueAt: "2026-07-25T12:00:03.500Z",
      environmentId: message.environmentId,
      organizationId: message.organizationId,
      projectId: message.projectId,
      rescheduleCount: CHANNEL_INGRESS_QUIET_WINDOW_MAX_RESCHEDULES,
      routeId: "b".repeat(64),
      type: "channel.ingress.flush" as const,
      version: 1 as const,
    };
    const enqueueFlush = async () => {
      throw new Error("must not replace an exhausted flush");
    };

    expect(
      processChannelIngressQueueCommand(flush, {
        burstPersistence: {
          complete: async () => undefined,
          prepare: async () => ({
            dueAt: "2026-07-25T12:00:04.500Z",
            kind: "waiting" as const,
            waitFor: "quiet-window" as const,
          }),
          stage: async () => {
            throw new Error("must not stage");
          },
        },
        enqueueFlush,
        ...withoutAttachmentCapture,
        endUserSubjects: END_USER_SUBJECTS,
        loadBinding: async () => {
          throw new Error("must not load a binding");
        },
        loadDeployment: async () => {
          throw new Error("must not load a deployment");
        },
        resolveThreadId: async () => {
          throw new Error("must not resolve a thread");
        },
        submitTurn: async () => {
          throw new Error("must not submit");
        },
      }),
    ).rejects.toThrow("reschedule budget");
  });

  test("retains predecessor waits after the quiet-window reschedule budget", async () => {
    const dueAt = "2026-07-25T12:00:04.500Z";
    const flush = {
      bindingId: message.bindingId,
      burstId: "a".repeat(64),
      dueAt: "2026-07-25T12:00:03.500Z",
      environmentId: message.environmentId,
      organizationId: message.organizationId,
      projectId: message.projectId,
      rescheduleCount: CHANNEL_INGRESS_QUIET_WINDOW_MAX_RESCHEDULES,
      routeId: "b".repeat(64),
      type: "channel.ingress.flush" as const,
      version: 1 as const,
    };
    const rescheduled: unknown[] = [];

    expect(
      processChannelIngressQueueCommand(flush, {
        burstPersistence: {
          complete: async () => undefined,
          prepare: async () => ({
            dueAt,
            kind: "waiting" as const,
            waitFor: "predecessor" as const,
          }),
          stage: async () => {
            throw new Error("must not stage");
          },
        },
        enqueueFlush: async (value) => {
          rescheduled.push(value);
        },
        ...withoutAttachmentCapture,
        endUserSubjects: END_USER_SUBJECTS,
        loadBinding: async () => {
          throw new Error("must not load a binding");
        },
        loadDeployment: async () => {
          throw new Error("must not load a deployment");
        },
        resolveThreadId: async () => {
          throw new Error("must not resolve a thread");
        },
        submitTurn: async () => {
          throw new Error("must not submit");
        },
      }),
    ).resolves.toEqual({ dueAt, kind: "waiting", waitFor: "predecessor" });
    expect(rescheduled).toEqual([
      expect.objectContaining({
        ...flush,
        dueAt,
        rescheduleCount: CHANNEL_INGRESS_QUIET_WINDOW_MAX_RESCHEDULES,
      }),
    ]);
  });
});
