import { describe, expect, test } from "bun:test";
import type { ChannelProvider, ExternalAgentChannel } from "@deployments-ai/channel-adapters";
import { endUserKeyDeriver, type SubmitConversationTurnInput } from "@deployments-ai/conversations";
import {
  AgentDeploymentRecord,
  ChannelBindingRecord,
  withCanonicalRecordKeys,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { processChannelIngress } from "./ingress-consumer.ts";
import { withoutAttachmentCapture } from "./ingress-consumer-test-support.ts";
import type { ChannelIngressQueueMessageV1 } from "./ingress.ts";

const END_USER_SUBJECTS = endUserKeyDeriver("channel-ingress-test-subject-key-0123456789");
const TIMESTAMP = "2026-07-25T12:00:00.000Z";
const id = (suffix: string) => `01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}` as Ulid;
const ORGANIZATION = id("3");

interface Conversation {
  readonly channel: ExternalAgentChannel;
  readonly externalChannelId: string;
  readonly externalThreadKey: string;
  readonly externalWorkspaceId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly provider: ChannelProvider;
  readonly senderId: string;
}

async function submittedTurn(conversation: Conversation) {
  const message: ChannelIngressQueueMessageV1 = {
    bindingId: id("1"),
    environmentId: id("2"),
    ingress: {
      channel: conversation.channel,
      content: "Please forget me.",
      externalChannelId: conversation.externalChannelId,
      externalMessageId: "message-1",
      externalThreadKey: conversation.externalThreadKey,
      ...(conversation.externalWorkspaceId
        ? { externalWorkspaceId: conversation.externalWorkspaceId }
        : {}),
      ...(conversation.metadata ? { metadata: conversation.metadata } : {}),
      provider: conversation.provider,
      sender: { id: conversation.senderId },
    },
    organizationId: ORGANIZATION,
    projectId: id("4"),
    receivedAt: TIMESTAMP,
    type: "channel.ingress",
    version: 1,
  };
  const binding = Schema.decodeUnknownSync(ChannelBindingRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDefinitionId: id("5"),
        agentDeploymentId: id("6"),
        channel: conversation.channel,
        createdAt: TIMESTAMP,
        environmentId: message.environmentId,
        ...(conversation.externalWorkspaceId
          ? { externalWorkspaceId: conversation.externalWorkspaceId }
          : {}),
        id: message.bindingId,
        organizationId: ORGANIZATION,
        projectId: message.projectId,
        provider: conversation.provider,
        status: "active",
        updatedAt: TIMESTAMP,
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
        createdAt: TIMESTAMP,
        currentState: "ready",
        desiredState: "running",
        environmentId: message.environmentId,
        id: id("6"),
        organizationId: ORGANIZATION,
        projectId: message.projectId,
        updatedAt: TIMESTAMP,
        version: 0,
      },
      itemType: "agent-deployment" as const,
    }),
  );
  let submitted: SubmitConversationTurnInput | undefined;
  await processChannelIngress(message, {
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
  return submitted!;
}

describe("channel end-user subjects", () => {
  test("single-party conversations carry the keyed platform-derived subject", async () => {
    for (const [conversation, endUserId] of [
      [
        {
          channel: "slack",
          externalChannelId: "D024BE91L",
          externalThreadKey: "slack:T061EG9R6:thread:D024BE91L",
          externalWorkspaceId: "T061EG9R6",
          metadata: { command: "/ask", slackEventType: "slash_command" },
          provider: "slack_edge",
          senderId: "U0G9QF9C6",
        },
        "channel:slack_edge:T061EG9R6:U0G9QF9C6",
      ],
      [
        {
          channel: "teams",
          externalChannelId: "a:1personal",
          externalThreadKey: "a:1personal",
          externalWorkspaceId: "tenant-1",
          metadata: { teamsConversationType: "personal" },
          provider: "teams_bot_framework",
          senderId: "29:user-1",
        },
        "channel:teams_bot_framework:tenant-1:29%3Auser-1",
      ],
      [
        {
          channel: "telegram",
          externalChannelId: "bot-1",
          externalThreadKey: "424242",
          externalWorkspaceId: "bot-1",
          provider: "telegram",
          senderId: "424242",
        },
        "channel:telegram:bot-1:424242",
      ],
      [
        {
          channel: "rcs",
          externalChannelId: "rcs-agent-1",
          externalThreadKey: "+16025550123",
          provider: "aws_end_user_messaging_rcs",
          senderId: "+16025550123",
        },
        "channel:aws_end_user_messaging_rcs:-:%2B16025550123",
      ],
    ] as const satisfies readonly (readonly [Conversation, string])[]) {
      const turn = await submittedTurn(conversation);

      expect({ channel: conversation.channel, endUserKey: turn.endUserKey }).toEqual({
        channel: conversation.channel,
        endUserKey: END_USER_SUBJECTS(ORGANIZATION, endUserId),
      });
    }
  });

  test("multi-party conversations carry no subject", async () => {
    for (const conversation of [
      {
        channel: "slack",
        externalChannelId: "C024BE91L",
        externalThreadKey: "slack:T061EG9R6:thread:C024BE91L",
        externalWorkspaceId: "T061EG9R6",
        metadata: { channelType: "channel" },
        provider: "slack_edge",
        senderId: "U0G9QF9C6",
      },
      {
        channel: "slack",
        externalChannelId: "G024BE91L",
        externalThreadKey: "slack:T061EG9R6:thread:G024BE91L",
        externalWorkspaceId: "T061EG9R6",
        metadata: { channelType: "mpim" },
        provider: "slack_edge",
        senderId: "U0G9QF9C6",
      },
      {
        channel: "teams",
        externalChannelId: "19:group@thread.v2",
        externalThreadKey: "19:group@thread.v2",
        externalWorkspaceId: "tenant-1",
        metadata: { teamsConversationType: "groupChat" },
        provider: "teams_bot_framework",
        senderId: "29:user-1",
      },
      {
        channel: "telegram",
        externalChannelId: "bot-1",
        externalThreadKey: "-1001234567890",
        externalWorkspaceId: "bot-1",
        provider: "telegram",
        senderId: "424242",
      },
    ] as const satisfies readonly Conversation[]) {
      const turn = await submittedTurn(conversation);

      expect({
        channel: conversation.channel,
        hasSubject: "endUserKey" in turn,
        threadId: turn.threadId,
      }).toEqual({ channel: conversation.channel, hasSubject: false, threadId: id("8") });
    }
  });
});
