import {
  ChannelBindingRecord,
  MessageRecord,
  RunRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { fixtures, id, inMemoryDatabase, workerDependencies } from "./agent-run.fixture.ts";

export function slackFixture(
  options: {
    readonly authorizedBindingMetadata?: Readonly<Record<string, unknown>>;
    readonly bindingMetadata?: Readonly<Record<string, unknown>>;
    /** Models a channel-ingress burst whose response is published only after delivery. */
    readonly externalPublication?: boolean;
  } = {},
) {
  const fixture = fixtures();
  const bindingId = id(70);
  const credentialRef = {
    credentialId: id(71),
    generation: 1,
    store: "dynamodb-kms" as const,
  };
  const userMessage = Schema.decodeUnknownSync(MessageRecord)(
    withCanonicalRecordKeys({
      data: {
        ...fixture.userMessage.data,
        metadata: {
          bindingId,
          externalChannelId: "C1",
          externalMessageId: "slack:T1:C1:1721609600.123456",
          externalThreadKey: "slack:T1:thread:C1:1721609600.123456",
          externalWorkspaceId: "T1",
          provider: "slack_edge",
          providerMetadata: {
            channelType: "channel",
            messageTs: "1721609600.123456",
            slackEventType: "app_mention",
          },
          ...(options.externalPublication ? { routeId: "a".repeat(64), throughSequence: 0 } : {}),
          sender: { id: "U1" },
          source: "channel-ingress",
        },
      },
      itemType: "message" as const,
    }),
  );
  const run = Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...fixture.run.data,
        ...(options.externalPublication ? { responsePublication: "external" } : {}),
        trigger: "chat",
        userMessageId: userMessage.data.id,
        userMessageSequence: userMessage.data.sequence,
      },
      itemType: "run" as const,
    }),
  );
  const binding = Schema.decodeUnknownSync(ChannelBindingRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDefinitionId: fixture.release.data.agentDefinitionId,
        agentDeploymentId: fixture.deployment.data.id,
        channel: "slack",
        createdAt: fixture.run.data.createdAt,
        credentialRef,
        environmentId: fixture.run.data.environmentId,
        externalChannelId: "C1",
        externalWorkspaceId: "T1",
        id: bindingId,
        ...(options.bindingMetadata ? { metadata: options.bindingMetadata } : {}),
        organizationId: fixture.run.data.organizationId,
        projectId: fixture.run.data.projectId,
        provider: "slack_edge",
        status: "active",
        updatedAt: fixture.run.data.updatedAt,
        version: 0,
      },
      itemType: "channel-binding" as const,
    }),
  );
  const authorizedBinding = options.authorizedBindingMetadata
    ? Schema.decodeUnknownSync(ChannelBindingRecord)(
        withCanonicalRecordKeys({
          data: {
            ...binding.data,
            metadata: options.authorizedBindingMetadata,
            updatedAt: "2026-07-22T00:00:01.000Z",
            version: binding.data.version + 1,
          },
          itemType: "channel-binding" as const,
        }),
      )
    : undefined;
  const memory = inMemoryDatabase(
    [fixture.release, fixture.deployment, fixture.thread, userMessage, run, binding],
    authorizedBinding ? { replaceRecordAfterAgentStreamWrite: authorizedBinding } : {},
  );
  const base = workerDependencies(memory.database);
  const calls: { readonly method: string; readonly payload: unknown }[] = [];
  const dependencies = {
    ...base.dependencies,
    readChannelCredential: async () => ({ accessToken: "xoxb-token" }),
    slackAgentStream: {
      append: async (_token: string, payload: unknown) =>
        void calls.push({ method: "append", payload }),
      start: async (_token: string, payload: unknown) => {
        calls.push({ method: "start", payload });
        return { ts: "1721609601.000001" };
      },
      stop: async (_token: string, payload: unknown) =>
        void calls.push({ method: "stop", payload }),
      update: async (_token: string, payload: unknown) =>
        void calls.push({ method: "update", payload }),
    },
  };
  return {
    calls,
    dependencies,
    events: base.events,
    fixture,
    memory,
    queue: fixture.queue,
    run,
    userMessage,
  };
}

export function streamRecord(memory: ReturnType<typeof inMemoryDatabase>) {
  return [...memory.records.values()].find(
    (record): record is Extract<PlatformRecord, { readonly itemType: "slack-agent-stream" }> =>
      record.itemType === "slack-agent-stream",
  );
}
