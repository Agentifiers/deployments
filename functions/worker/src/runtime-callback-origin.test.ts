import { describe, expect, spyOn, test } from "bun:test";
import type { RunInitiatingCaller } from "@deployments-ai/db";
import { id } from "./agent-run.fixture.ts";
import { channelWorld, slackMessage } from "./agent-run-channel-ingress.fixture.ts";
import { channelOriginOf } from "./runtime-callback-origin.ts";
import {
  channelIngressMetadata,
  promptWith,
  runStartedBy,
  SLACK_BINDING_ID,
  SLACK_THREAD_MESSAGE,
} from "./runtime-callback-origin.fixture.ts";

const SLACK_INGRESS: RunInitiatingCaller = {
  sourceId: SLACK_BINDING_ID,
  sourceKind: "channel-binding",
  type: "ingress",
};
const TEAMS_BINDING_ID = id(41);
const TEAMS_CHANNEL_MESSAGE = {
  channel: "teams",
  content: "please review & ship @Reviewers",
  externalAccountId: "00000000-0000-4000-8000-000000000001",
  externalChannelId: "19:abc@thread.tacv2",
  externalMessageId: "teams:tenant-1:19:abc@thread.tacv2:1700000000001",
  externalThreadKey: "teams:tenant-1:thread:19:abc@thread.tacv2;messageid=1699999999999",
  externalWorkspaceId: "tenant-1",
  metadata: { teamsActivityId: "1700000000001", teamsConversationType: "channel" },
  provider: "teams_bot_framework",
  sender: { displayName: "Ada", id: "aad-user-1" },
};
const SLACK_ORIGIN = {
  channelBindingId: "01ARZ3NDEKTSV4RRFFQ69G0040",
  externalAccountId: "A07BOTAPP01",
  externalChannelId: "C07QK3MV9",
  externalMessageId: "slack:T024BE7LD:C07QK3MV9:1729700123.000200",
  externalThreadKey: "slack:T024BE7LD:thread:C07QK3MV9:1729700000.000100",
  externalWorkspaceId: "T024BE7LD",
  kind: "channel",
  provider: "slack_edge",
  sender: { id: "U02ADA1OVE" },
};

describe("channelOriginOf", () => {
  const cases: readonly {
    readonly name: string;
    readonly caller: RunInitiatingCaller;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly trigger?: string;
    readonly origin: unknown;
  }[] = [
    {
      caller: SLACK_INGRESS,
      metadata: channelIngressMetadata(SLACK_THREAD_MESSAGE),
      name: "a Slack message event names the binding and sender, with no display name to pass on",
      origin: SLACK_ORIGIN,
    },
    {
      caller: SLACK_INGRESS,
      metadata: channelIngressMetadata({
        ...SLACK_THREAD_MESSAGE,
        sender: { displayName: "ada", id: "U02ADA1OVE" },
      }),
      name: "a Slack slash command keeps the display name ingress read",
      origin: { ...SLACK_ORIGIN, sender: { displayName: "ada", id: "U02ADA1OVE" } },
    },
    {
      caller: { sourceId: TEAMS_BINDING_ID, sourceKind: "channel-binding", type: "ingress" },
      metadata: channelIngressMetadata(TEAMS_CHANNEL_MESSAGE, TEAMS_BINDING_ID),
      name: "a Teams channel message names the AAD sender",
      origin: {
        channelBindingId: "01ARZ3NDEKTSV4RRFFQ69G0041",
        externalAccountId: "00000000-0000-4000-8000-000000000001",
        externalChannelId: "19:abc@thread.tacv2",
        externalMessageId: "teams:tenant-1:19:abc@thread.tacv2:1700000000001",
        externalThreadKey: "teams:tenant-1:thread:19:abc@thread.tacv2;messageid=1699999999999",
        externalWorkspaceId: "tenant-1",
        kind: "channel",
        provider: "teams_bot_framework",
        sender: { displayName: "Ada", id: "aad-user-1" },
      },
    },
    {
      caller: { principalId: id(60), scopes: ["runs:write"], type: "principal" },
      metadata: channelIngressMetadata(SLACK_THREAD_MESSAGE),
      name: "a person's API run in a workspace they chose gets none, even with chat-shaped metadata",
      origin: undefined,
    },
    {
      caller: { apiCredentialId: id(61), serviceAccountId: id(62), type: "service-account" },
      metadata: channelIngressMetadata(SLACK_THREAD_MESSAGE),
      name: "a service account's run gets none",
      origin: undefined,
    },
    {
      caller: { apiCredentialId: id(61), serviceAccountId: id(62), type: "service-account" },
      name: "an API continuation of a chat thread gets none",
      origin: undefined,
    },
    {
      caller: { sourceId: id(42), sourceKind: "agent-email-binding", type: "ingress" },
      metadata: channelIngressMetadata(SLACK_THREAD_MESSAGE, id(42)),
      name: "email ingress gets none",
      origin: undefined,
    },
    {
      caller: SLACK_INGRESS,
      metadata: channelIngressMetadata(SLACK_THREAD_MESSAGE, id(43)),
      name: "a prompt from another binding gets none",
      origin: undefined,
    },
    {
      caller: SLACK_INGRESS,
      metadata: {
        ...channelIngressMetadata(SLACK_THREAD_MESSAGE),
        delegatedByRunId: id(70),
        sender: { id: "U0FORGED" },
      },
      name: "a run an agent delegated from a chat run gets none, even when the model copies chat metadata",
      origin: undefined,
      trigger: "api",
    },
  ];
  for (const { caller, metadata, name, origin, trigger } of cases) {
    test(name, () => {
      expect<unknown>(channelOriginOf(runStartedBy(caller, trigger), promptWith(metadata))).toEqual(
        origin,
      );
    });
  }

  test("a run whose prompt message is missing gets none", () => {
    expect(channelOriginOf(runStartedBy(SLACK_INGRESS), undefined)).toBeUndefined();
    expect<unknown>(
      channelOriginOf(
        runStartedBy(SLACK_INGRESS),
        promptWith(channelIngressMetadata(SLACK_THREAD_MESSAGE)),
      ),
    ).toEqual(SLACK_ORIGIN);
  });

  test("malformed channel metadata fails closed with a structured warning", () => {
    const { externalChannelId: _dropped, ...metadata } =
      channelIngressMetadata(SLACK_THREAD_MESSAGE);
    const warnings = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(channelOriginOf(runStartedBy(SLACK_INGRESS), promptWith(metadata))).toBeUndefined();
      expect(warnings.mock.calls).toEqual([
        [
          "Channel ingress metadata did not decode; the callback carries no origin.",
          {
            event: "callback_origin_malformed",
            messageId: "01ARZ3NDEKTSV4RRFFQ69G0009",
            runId: "01ARZ3NDEKTSV4RRFFQ69G0010",
          },
        ],
      ]);
    } finally {
      warnings.mockRestore();
    }
  });
});

describe("origin of Slack thread bursts", () => {
  const THREAD_ORIGIN = {
    channelBindingId: "01ARZ3NDEKTSV4RRFFQ69G0020",
    externalAccountId: "A0001",
    externalChannelId: "C0001",
    externalThreadKey: "slack:T0001:thread:C0001:1760000000.000001",
    externalWorkspaceId: "T0001",
    kind: "channel",
    provider: "slack_edge",
  };
  const inThread = (ts: string, text: string, user: string) => ({
    ...slackMessage(ts, text),
    channel: "C0001",
    channel_type: "channel",
    thread_ts: "1760000000.000001",
    user,
  });

  test("interleaved senders seal separate bursts, so each run's origin names its one sender", async () => {
    const world = channelWorld("slackChannel");
    await world.receiveBurst([
      inThread("1760000000.000100", "first from Ada", "U0001"),
      inThread("1760000000.000200", "a reply from Grace", "U0002"),
      inThread("1760000000.000300", "more from Ada", "U0001"),
    ]);

    const turns = await world.turns();
    expect<unknown>(turns.map(({ prompt, run }) => channelOriginOf(run!, prompt))).toEqual([
      {
        ...THREAD_ORIGIN,
        externalMessageId: "slack:T0001:C0001:1760000000.000100",
        sender: { id: "U0001" },
      },
      {
        ...THREAD_ORIGIN,
        externalMessageId: "slack:T0001:C0001:1760000000.000200",
        sender: { id: "U0002" },
      },
      {
        ...THREAD_ORIGIN,
        externalMessageId: "slack:T0001:C0001:1760000000.000300",
        sender: { id: "U0001" },
      },
    ]);
  });

  test("one sender's consecutive messages coalesce under that sender and a burst message id", async () => {
    const world = channelWorld("slackChannel");
    await world.receiveBurst([
      inThread("1760000000.000100", "make me a bot", "U0001"),
      inThread("1760000000.000200", "for support tickets", "U0001"),
      inThread("1760000000.000300", "and one for billing", "U0002"),
    ]);

    const turns = await world.turns();
    expect(turns.map(({ prompt }) => prompt?.data.body)).toEqual([
      "make me a bot\nfor support tickets",
      "and one for billing",
    ]);
    expect<unknown>(turns.map(({ prompt, run }) => channelOriginOf(run!, prompt))).toEqual([
      {
        ...THREAD_ORIGIN,
        externalMessageId: "burst:ec9360fb8a937a9ae1eb8ea81ad17e712c48834a1321d4e28f2addb89f2e7318",
        sender: { id: "U0001" },
      },
      {
        ...THREAD_ORIGIN,
        externalMessageId: "slack:T0001:C0001:1760000000.000300",
        sender: { id: "U0002" },
      },
    ]);
  });
});
