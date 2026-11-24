import { describe, expect, test } from "bun:test";
import { channelProviders, type ExternalAgentChannel } from "@deployments-ai/channel-adapters";
import type { Ulid } from "@deployments-ai/db";
import {
  acceptChannelIngressMessage,
  awsRcsForwardingIdentityMatches,
  channelIngressErrorResponse,
  channelIngressQueueMessage,
  channelIngressQueueTransport,
  type ChannelIngressQueueMessageV1,
} from "./ingress.ts";
import { SlackEventsApiError } from "@deployments-ai/channel-adapters/slack";

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

describe("channel ingress queue message", () => {
  test("durably stages a source before publishing it to the route FIFO", async () => {
    const calls: string[] = [];
    const source = channelIngressQueueMessage(
      {
        data: {
          environmentId: id("2"),
          id: id("1"),
          organizationId: id("3"),
          projectId: id("4"),
        },
      },
      {
        channel: "telegram",
        content: "First short note.",
        externalChannelId: "bot-1",
        externalMessageId: "message-1",
        externalThreadKey: "thread-1",
        provider: "telegram",
        sender: { id: "sender-1" },
      },
      "2026-07-25T12:00:00.000Z",
    );

    await acceptChannelIngressMessage(source, {
      enqueueSource: async () => {
        calls.push("enqueue");
      },
      stageSource: async () => {
        calls.push("stage");
      },
    });

    expect(calls).toEqual(["stage", "enqueue"]);
  });

  test("does not publish a source whose durable acceptance failed", async () => {
    let enqueued = false;
    const source = channelIngressQueueMessage(
      {
        data: {
          environmentId: id("2"),
          id: id("1"),
          organizationId: id("3"),
          projectId: id("4"),
        },
      },
      {
        channel: "telegram",
        content: "First short note.",
        externalChannelId: "bot-1",
        externalMessageId: "message-1",
        externalThreadKey: "thread-1",
        provider: "telegram",
        sender: { id: "sender-1" },
      },
      "2026-07-25T12:00:00.000Z",
    );

    expect(
      acceptChannelIngressMessage(source, {
        enqueueSource: async () => {
          enqueued = true;
        },
        stageSource: async () => {
          throw new Error("temporary persistence failure");
        },
      }),
    ).rejects.toThrow("temporary persistence failure");
    expect(enqueued).toBe(false);
  });

  test("returns a Slack-specific authentication failure for a rejected signature", () => {
    expect(channelIngressErrorResponse(new SlackEventsApiError(401, "invalid"))).toEqual({
      body: '{"error":"invalid_signature"}',
      headers: { "content-type": "application/json" },
      statusCode: 401,
    });
    expect(channelIngressErrorResponse(new Error("malformed"))).toMatchObject({
      body: '{"error":"invalid_request"}',
      statusCode: 400,
    });
  });

  test("creates a versioned command with binding scope and receipt time", () => {
    const ingress: ChannelIngressQueueMessageV1["ingress"] = {
      channel: "telegram",
      content: "Review the latest update.",
      externalAccountId: "account-1",
      externalChannelId: "bot-1",
      externalMessageId: "message-1",
      externalThreadKey: "chat-1",
      provider: "telegram",
      sender: { displayName: "Sender", id: "sender-1" },
    };

    expect(
      channelIngressQueueMessage(
        {
          data: {
            environmentId: id("2"),
            id: id("1"),
            organizationId: id("3"),
            projectId: id("4"),
          },
        },
        ingress,
        "2026-07-25T12:00:00.000Z",
      ),
    ).toEqual({
      bindingId: id("1"),
      environmentId: id("2"),
      ingress,
      organizationId: id("3"),
      projectId: id("4"),
      receivedAt: "2026-07-25T12:00:00.000Z",
      type: "channel.ingress",
      version: 1,
    });
  });

  for (const { channel, provider } of CHANNEL_PROVIDER_CASES) {
    test(`orders ${provider}/${channel} ingress by exact conversation route`, () => {
      const first = channelIngressQueueMessage(
        {
          data: {
            environmentId: id("2"),
            id: id("1"),
            organizationId: id("3"),
            projectId: id("4"),
          },
        },
        {
          channel,
          content: "First short note.",
          externalChannelId: "channel-1",
          externalMessageId: "message-1",
          externalThreadKey: "thread-1",
          ...(channel === "slack" || channel === "teams"
            ? { externalWorkspaceId: "workspace-1" }
            : {}),
          provider,
          sender: { id: "sender-1" },
        },
        "2026-07-25T12:00:00.000Z",
      );
      const second = {
        ...first,
        ingress: {
          ...first.ingress,
          content: "Second short note.",
          externalMessageId: "message-2",
        },
        receivedAt: "2026-07-25T12:00:00.250Z",
      };
      const retry = { ...first, receivedAt: "2026-07-25T12:00:01.000Z" };
      const anotherThread = {
        ...second,
        ingress: { ...second.ingress, externalThreadKey: "thread-2" },
      };

      const firstTransport = channelIngressQueueTransport(first);
      const secondTransport = channelIngressQueueTransport(second);
      expect(secondTransport.MessageGroupId).toBe(firstTransport.MessageGroupId);
      expect(secondTransport.MessageDeduplicationId).not.toBe(
        firstTransport.MessageDeduplicationId,
      );
      expect(channelIngressQueueTransport(retry).MessageDeduplicationId).toBe(
        firstTransport.MessageDeduplicationId,
      );
      expect(channelIngressQueueTransport(anotherThread).MessageGroupId).not.toBe(
        firstTransport.MessageGroupId,
      );
    });
  }

  test("pins signed RCS forwarding metadata to the binding and origination identity", () => {
    const notification = {
      deploymentsAiBindingId: id("1"),
      deploymentsAiEventType: "TEXT",
      deploymentsAiOriginationIdentity:
        "arn:aws:sms-voice:us-east-2:123456789012:rcs-agent/agent-1",
    };
    expect(
      awsRcsForwardingIdentityMatches(
        notification,
        id("1"),
        notification.deploymentsAiOriginationIdentity,
      ),
    ).toBe(true);
    expect(
      awsRcsForwardingIdentityMatches(
        { ...notification, deploymentsAiBindingId: id("2") },
        id("1"),
        notification.deploymentsAiOriginationIdentity,
      ),
    ).toBe(false);
    expect(awsRcsForwardingIdentityMatches(notification, id("1"), "different-agent")).toBe(false);
    expect(
      awsRcsForwardingIdentityMatches(
        { ...notification, deploymentsAiEventType: "FORGED" },
        id("1"),
        notification.deploymentsAiOriginationIdentity,
      ),
    ).toBe(false);
  });
});
