import type {
  TeamsConnectorClient,
  TeamsOutboundActivity,
} from "@deployments-ai/channel-adapters/teams";
import {
  ChannelBindingRecord,
  MessageRecord,
  RunRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { fixtures, id, inMemoryDatabase, workerDependencies } from "./agent-run.fixture.ts";

export const TEAMS_TENANT_ID = "tenant-1";
export const TEAMS_CONVERSATION_ID = "a:personal-chat-1";
export const TEAMS_SERVICE_URL = "https://smba.trafficmanager.net/amer/";
export const TEAMS_CREDENTIALS = {
  appId: "00000000-0000-4000-8000-000000000001",
  appPassword: "bot-secret",
  appTenantId: TEAMS_TENANT_ID,
};

export interface TeamsConnectorCall {
  readonly activity: TeamsOutboundActivity;
  readonly activityId?: string;
  readonly conversationId: string;
  readonly method: "send" | "update";
  readonly serviceUrl: string;
}

export function teamsFixture(
  options: {
    readonly authorizedBindingMetadata?: Readonly<Record<string, unknown>>;
    readonly bindingMetadata?: Readonly<Record<string, unknown>>;
    readonly conversationType?: "channel" | "groupChat" | "personal";
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
  const conversationType = options.conversationType ?? "personal";
  const conversationId =
    conversationType === "personal"
      ? TEAMS_CONVERSATION_ID
      : conversationType === "groupChat"
        ? "19:group-chat-1@thread.v2"
        : "19:general@thread.tacv2;messageid=1700000000001";
  const baseConversationId = conversationId.split(";messageid=")[0]!;
  const userMessage = Schema.decodeUnknownSync(MessageRecord)(
    withCanonicalRecordKeys({
      data: {
        ...fixture.userMessage.data,
        metadata: {
          bindingId,
          externalChannelId: baseConversationId,
          externalMessageId: `teams:${TEAMS_TENANT_ID}:${baseConversationId}:1700000000001`,
          externalThreadKey: `teams:${TEAMS_TENANT_ID}:thread:${conversationId}`,
          externalWorkspaceId: TEAMS_TENANT_ID,
          provider: "teams_bot_framework",
          providerMetadata: {
            teamsActivityId: "1700000000001",
            teamsConversationType: conversationType,
            teamsFromId: "29:user-1",
            teamsServiceUrl: TEAMS_SERVICE_URL,
          },
          ...(options.externalPublication ? { routeId: "a".repeat(64), throughSequence: 0 } : {}),
          sender: { id: "aad-user-1" },
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
        channel: "teams",
        createdAt: fixture.run.data.createdAt,
        credentialRef,
        environmentId: fixture.run.data.environmentId,
        externalChannelId: baseConversationId,
        externalWorkspaceId: TEAMS_TENANT_ID,
        id: bindingId,
        ...(options.bindingMetadata ? { metadata: options.bindingMetadata } : {}),
        organizationId: fixture.run.data.organizationId,
        projectId: fixture.run.data.projectId,
        provider: "teams_bot_framework",
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
  const clock = { offsetMs: 0 };
  const baseNow = base.dependencies.now!;
  const calls: TeamsConnectorCall[] = [];
  const waiters: { readonly count: number; readonly resolve: () => void }[] = [];
  const record = (call: TeamsConnectorCall) => {
    calls.push(call);
    for (const waiter of waiters.filter((candidate) => calls.length >= candidate.count)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  };
  /** Connector failures to inject, keyed by the zero-based index of the recorded call. */
  const failures = new Map<number, unknown>();
  let streams = 0;
  const teamsAgentStream: Pick<TeamsConnectorClient, "sendActivity" | "updateActivity"> = {
    sendActivity: async (input) => {
      record({
        activity: input.activity,
        conversationId: input.conversationId,
        method: "send",
        serviceUrl: input.serviceUrl,
      });
      if (failures.has(calls.length - 1)) throw failures.get(calls.length - 1);
      const streamInfo = input.activity.entities?.find((entity) => entity.type === "streaminfo");
      if (streamInfo?.streamType === "informative" && streamInfo.streamId === undefined) {
        streams += 1;
        return { id: `stream-${String(streams)}` };
      }
      return {};
    },
    updateActivity: async (input) => {
      record({
        activity: input.activity,
        activityId: input.activityId,
        conversationId: input.conversationId,
        method: "update",
        serviceUrl: input.serviceUrl,
      });
      if (failures.has(calls.length - 1)) throw failures.get(calls.length - 1);
    },
  };
  const dependencies = {
    ...base.dependencies,
    now: () => new Date(baseNow().getTime() + clock.offsetMs),
    readChannelCredential: async () => TEAMS_CREDENTIALS,
    teamsAgentStream,
  };
  return {
    calls,
    clock,
    dependencies,
    events: base.events,
    failures,
    fixture,
    memory,
    queue: fixture.queue,
    run,
    userMessage,
    /** Resolves once the connector has received `count` requests in total. */
    waitForCalls: (count: number) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      if (calls.length >= count) resolve();
      else waiters.push({ count, resolve });
      return promise;
    },
  };
}

export function teamsStreamRecord(memory: ReturnType<typeof inMemoryDatabase>) {
  return [...memory.records.values()].find(
    (record): record is Extract<PlatformRecord, { readonly itemType: "teams-agent-stream" }> =>
      record.itemType === "teams-agent-stream",
  );
}

export function teamsDeliveries(memory: ReturnType<typeof inMemoryDatabase>) {
  return [...memory.records.values()].filter(
    (record): record is Extract<PlatformRecord, { readonly itemType: "channel-delivery" }> =>
      record.itemType === "channel-delivery",
  );
}

export function terminalRun(
  run: Extract<PlatformRecord, { readonly itemType: "run" }>,
  status: "canceled" | "completed" | "failed",
) {
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...run.data,
        completedAt: "2026-07-22T00:00:10.000Z",
        status,
        updatedAt: "2026-07-22T00:00:10.000Z",
        version: run.data.version + 1,
      },
      itemType: "run" as const,
    }),
  );
}
