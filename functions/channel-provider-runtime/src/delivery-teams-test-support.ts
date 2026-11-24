import { teamsConnectorClient } from "@deployments-ai/channel-adapters/teams";
import {
  ChannelDeliveryRecord,
  TeamsAgentStreamRecord,
  tableForItemType,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";

import type { Delivery } from "./delivery-contract.ts";
import { fixture, timestamp, type MemoryDatabase } from "./delivery-test-support.ts";
import type { QueueEventLike } from "./runtime.ts";

type TeamsStream = Extract<PlatformRecord, { readonly itemType: "teams-agent-stream" }>;

const id = (suffix: string) => `01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}` as Ulid;

export const TEAMS_APP_ID = "00000000-0000-4000-8000-000000000001";
export const TEAMS_CONVERSATION_ID = "19:abc@thread.tacv2;messageid=1699999999999";
export const teamsPayload = {
  conversationId: TEAMS_CONVERSATION_ID,
  serviceUrl: "https://smba.trafficmanager.net/amer/",
  text: "**Rex**\n\nDeployment complete.",
};

export interface RecordedTeamsRequest {
  readonly authorization: string | undefined;
  readonly body: string;
  readonly method: string;
  readonly url: string;
}

/**
 * Bot Framework token endpoint plus Bot Connector served from queued responses (defaults: a
 * one-hour bot token and `201 { id: "activity-1" }`). Thrown responses simulate transport failures.
 */
export function fakeTeamsBotConnector() {
  const requests: RecordedTeamsRequest[] = [];
  const queued = { activity: [] as (() => Response)[], token: [] as (() => Response)[] };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push({
      authorization: new Headers(init?.headers).get("authorization") ?? undefined,
      body: typeof init?.body === "string" ? init.body : "",
      method: init?.method ?? "GET",
      url,
    });
    if (url.startsWith("https://login.microsoftonline.com/")) {
      return (
        queued.token.shift()?.() ?? Response.json({ access_token: "bot-token", expires_in: 3_600 })
      );
    }
    return queued.activity.shift()?.() ?? Response.json({ id: "activity-1" }, { status: 201 });
  }) as typeof fetch;
  return {
    activityRequests: () => requests.filter((request) => request.url.includes("/v3/")),
    fetch: fetchImpl,
    queued,
    requests,
  };
}

export function teamsDeliveryFixture(data: Partial<Delivery["data"]> = {}) {
  const test = fixture("queued", teamsPayload, "telegram");
  const delivery = Schema.decodeUnknownSync(ChannelDeliveryRecord)(
    withCanonicalRecordKeys({
      ...test.delivery,
      data: {
        ...test.delivery.data,
        channel: "teams",
        externalThreadKey: `teams:tenant-1:thread:${TEAMS_CONVERSATION_ID}`,
        provider: "teams_bot_framework",
        ...data,
      },
    }),
  );
  test.memory.records.set(`execution\0${delivery.pk}\0${delivery.sk}`, delivery);
  const connector = fakeTeamsBotConnector();
  return {
    ...test,
    connector,
    delivery,
    dependencies: {
      ...test.dependencies,
      readCredential: async () => ({
        appId: TEAMS_APP_ID,
        appPassword: "app-password",
        appTenantId: "home-tenant",
      }),
      teamsConnector: teamsConnectorClient({ fetch: connector.fetch }),
    },
  };
}

export function finalReceive(event: QueueEventLike): QueueEventLike {
  return {
    Records: event.Records.map((record) => ({
      ...record,
      attributes: { ApproximateReceiveCount: "4" },
    })),
  };
}

export function addTeamsStream(
  memory: MemoryDatabase,
  delivery: Delivery,
  data: Partial<TeamsStream["data"]> = {},
) {
  const record = Schema.decodeUnknownSync(TeamsAgentStreamRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: id("9"),
        bindingId: delivery.data.bindingId!,
        bindingVersion: 0,
        conversationId: TEAMS_CONVERSATION_ID,
        createdAt: timestamp,
        credentialRef: delivery.data.credentialRef as Extract<
          NonNullable<typeof delivery.data.credentialRef>,
          { readonly store: "dynamodb-kms" }
        >,
        environmentId: delivery.data.environmentId,
        fallbackAllowed: false,
        id: delivery.data.runId,
        organizationId: delivery.data.organizationId,
        projectId: delivery.data.projectId,
        recipientId: "29:user-1",
        runAttempt: 0,
        runClaimedAt: timestamp,
        runExecutionVersion: 1,
        runId: delivery.data.runId,
        serviceUrl: teamsPayload.serviceUrl,
        status: "stopped" as const,
        streamId: "stream-1",
        streamStartedAt: timestamp,
        tenantId: "tenant-1",
        threadId: delivery.data.threadId,
        updatedAt: timestamp,
        version: 2,
        ...data,
      },
      itemType: "teams-agent-stream" as const,
    }),
  );
  memory.records.set(`${tableForItemType(record.itemType)}\0${record.pk}\0${record.sk}`, record);
  return record;
}

export function persistedTeamsStream(memory: MemoryDatabase) {
  return [...memory.records.values()].find(
    (record): record is TeamsStream => record.itemType === "teams-agent-stream",
  );
}
