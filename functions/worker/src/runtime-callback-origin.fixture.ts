import {
  channelIngressMessageMetadata,
  decodeChannelIngressQueueMessage,
} from "@deployments-ai/channel-provider-runtime/ingress";
import {
  MessageRecord,
  RunRecord,
  withCanonicalRecordKeys,
  type RunInitiatingCaller,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { fixtures, id } from "./agent-run.fixture.ts";

export const SLACK_BINDING_ID = id(40);

/** Slack message events carry no sender display name. */
export const SLACK_THREAD_MESSAGE = {
  channel: "slack",
  content: "Can you set up a bot that triages support tickets?",
  externalAccountId: "A07BOTAPP01",
  externalChannelId: "C07QK3MV9",
  externalMessageId: "slack:T024BE7LD:C07QK3MV9:1729700123.000200",
  externalThreadKey: "slack:T024BE7LD:thread:C07QK3MV9:1729700000.000100",
  externalWorkspaceId: "T024BE7LD",
  provider: "slack_edge",
  sender: { id: "U02ADA1OVE" },
} as const;

export function channelIngressMetadata(
  ingress: Readonly<Record<string, unknown>>,
  bindingId: Ulid = SLACK_BINDING_ID,
) {
  const { run } = fixtures();
  return channelIngressMessageMetadata(
    decodeChannelIngressQueueMessage({
      bindingId,
      environmentId: run.data.environmentId,
      ingress,
      organizationId: run.data.organizationId,
      projectId: run.data.projectId,
      receivedAt: "2026-08-08T11:59:58.000Z",
      type: "channel.ingress",
      version: 1,
    }),
  );
}

export function runStartedBy(initiatingCaller: RunInitiatingCaller, trigger = "chat") {
  const { run, userMessage } = fixtures();
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...run.data,
        initiatingCaller,
        status: "running",
        trigger,
        userMessageId: userMessage.data.id,
        userMessageSequence: userMessage.data.sequence,
        version: 1,
      },
      itemType: "run" as const,
    }),
  );
}

export function promptWith(metadata?: Readonly<Record<string, unknown>>) {
  const { userMessage } = fixtures();
  return Schema.decodeUnknownSync(MessageRecord)(
    withCanonicalRecordKeys({
      data: { ...userMessage.data, ...(metadata ? { metadata } : {}) },
      itemType: "message" as const,
    }),
  );
}
