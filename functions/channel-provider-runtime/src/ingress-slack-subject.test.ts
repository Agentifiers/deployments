import { describe, expect, test } from "bun:test";
import { teamsBotFrameworkTokenVerifier } from "@deployments-ai/channel-adapters/teams";
import { endUserKeyDeriver } from "@deployments-ai/conversations";
import { controlFixtures } from "@deployments-ai/conversations/testing";
import {
  ChannelBindingRecord,
  makeDynamoDatabase,
  makeUniqueClaimRecord,
  tableForItemType,
  uniqueClaimRequirements,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { Schema } from "effect";
import { createHmac } from "node:crypto";
import { processChannelIngressQueueCommand } from "./ingress-consumer.ts";
import { channelIngressQueueDependencies } from "./ingress-consumer-main.ts";
import {
  channelIngressFlushQueueMessage,
  type ChannelIngressFlushSchedule,
  type ChannelIngressQueueMessageV1,
} from "./ingress-message.ts";
import { handleChannelIngressWith } from "./ingress.ts";

const END_USER_SUBJECTS = endUserKeyDeriver("channel-ingress-test-subject-key-0123456789");
const SIGNING_SECRET = "slack-signing-secret";
const TEAM = "T061EG9R6";
const APP = "A0APP0001";
const ALEX = "U0G9QF9C6";
const SAM = "U0SAM0001";

interface Settled {
  readonly code?: string | undefined;
  readonly endUserKey?: string | undefined;
  readonly kind: "refused" | "submitted";
  readonly threadId?: string | undefined;
}

function slackWorkspace() {
  const { deployment, release } = controlFixtures();
  const binding = Schema.decodeUnknownSync(ChannelBindingRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDefinitionId: deployment.data.agentDefinitionId,
        agentDeploymentId: deployment.data.id,
        channel: "slack",
        createdAt: deployment.data.createdAt,
        environmentId: deployment.data.environmentId,
        externalWorkspaceId: TEAM,
        id: "01ARZ3NDEKTSV4RRFFQ69G5F30" as Ulid,
        organizationId: deployment.data.organizationId,
        projectId: deployment.data.projectId,
        provider: "slack_edge",
        status: "active",
        updatedAt: deployment.data.createdAt,
        version: 0,
      },
      itemType: "channel-binding" as const,
    }),
  );
  const organization = withCanonicalRecordKeys({
    data: {
      createdAt: deployment.data.createdAt,
      id: deployment.data.organizationId,
      name: "Slack workspace",
      slug: "slack-workspace",
      status: "active" as const,
      updatedAt: deployment.data.createdAt,
      version: 1,
    },
    itemType: "organization" as const,
  });
  const fake = fakeDynamoDocumentClient();
  for (const record of [organization, deployment, release, binding] as PlatformRecord[]) {
    fake.put(tableForItemType(record.itemType), record);
    for (const requirement of uniqueClaimRequirements(record)) {
      fake.put("control", makeUniqueClaimRecord(requirement, deployment.data.createdAt));
    }
  }
  let clock = Date.now();
  let nextId = 0;
  const flushes: ChannelIngressFlushSchedule[] = [];
  const consumer = channelIngressQueueDependencies({
    attachments: {
      artifactBucket: "artifacts",
      extractor: {
        extract: async () => {
          throw new Error("Slack text bursts capture no attachments.");
        },
      },
      openObjectStore: async () => {
        throw new Error("Slack text bursts capture no attachments.");
      },
      readCredentialValues: async () => {
        throw new Error("Slack text bursts capture no attachments.");
      },
      transport: {},
    },
    database: makeDynamoDatabase(fake.client, {
      control: "control",
      events: "events",
      execution: "execution",
      usage: "usage",
    }),
    endUserSubjects: END_USER_SUBJECTS,
    enqueueFlush: async (flush) => void flushes.push(flush),
    enqueueRun: async () => {},
    generateId: async () =>
      `01ARZ3NDEKTSV4RRFFQ69H${String((nextId += 1)).padStart(4, "0")}` as Ulid,
    now: () => new Date(clock),
  });

  async function deliver(rawBody: string): Promise<Settled> {
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const enqueued: ChannelIngressQueueMessageV1[] = [];
    const accepted = await handleChannelIngressWith(
      {
        body: rawBody,
        headers: {
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`,
        },
        pathParameters: {
          bindingId: binding.data.id,
          environmentId: binding.data.environmentId,
          organizationId: binding.data.organizationId,
          provider: "slack_edge",
        },
      },
      {
        enqueue: async (message) => void enqueued.push(message),
        loadBinding: async () => binding,
        readCredentialValues: async () => ({ signingSecret: SIGNING_SECRET }),
        teamsTokenVerifier: teamsBotFrameworkTokenVerifier(),
      },
    );
    expect(accepted.statusCode).toBe(202);
    for (const message of enqueued) await processChannelIngressQueueCommand(message, consumer);
    clock += 60_000;
    const [flush, ...later] = flushes.splice(0);
    expect(later).toEqual([]);
    const outcome = await processChannelIngressQueueCommand(
      channelIngressFlushQueueMessage(flush!),
      consumer,
    );
    if (outcome.kind === "submitted") {
      return {
        endUserKey: outcome.result.thread.data.endUserKey,
        kind: outcome.kind,
        threadId: outcome.result.thread.data.id,
      };
    }
    if (outcome.kind === "refused") return { code: outcome.code, kind: outcome.kind };
    throw new Error(`The burst did not settle: ${outcome.kind}.`);
  }

  return { deliver, organizationId: deployment.data.organizationId };
}

function slashCommand(input: {
  readonly channel: string;
  readonly trigger: string;
  readonly user: string;
}) {
  return new URLSearchParams({
    api_app_id: APP,
    channel_id: input.channel,
    channel_name: "directmessage",
    command: "/ask",
    team_id: TEAM,
    text: "What is on my plan today?",
    trigger_id: input.trigger,
    user_id: input.user,
  }).toString();
}

function directMessage(input: {
  readonly channel: string;
  readonly ts: string;
  readonly user: string;
}) {
  return JSON.stringify({
    api_app_id: APP,
    event: {
      channel: input.channel,
      channel_type: "im",
      text: "And tomorrow?",
      ts: input.ts,
      type: "message",
      user: input.user,
    },
    event_id: `Ev${input.ts}`,
    team_id: TEAM,
    type: "event_callback",
  });
}

describe("Slack direct-message subjects", () => {
  test("a slash command and a later message in the app DM settle on one thread with the sender's subject", async () => {
    const { deliver, organizationId } = slackWorkspace();
    const subject = END_USER_SUBJECTS(organizationId, `channel:slack_edge:${TEAM}:${ALEX}`);

    const command = await deliver(
      slashCommand({ channel: "D024BE91L", trigger: "1.1", user: ALEX }),
    );
    const message = await deliver(
      directMessage({ channel: "D024BE91L", ts: "1721609700.000200", user: ALEX }),
    );

    expect(command).toEqual({
      endUserKey: subject,
      kind: "submitted",
      threadId: expect.any(String),
    });
    expect(message).toEqual({ endUserKey: subject, kind: "submitted", threadId: command.threadId });
  });

  test("a second person's command in a direct message between two people is refused without holding the route", async () => {
    const { deliver, organizationId } = slackWorkspace();
    const subject = END_USER_SUBJECTS(organizationId, `channel:slack_edge:${TEAM}:${ALEX}`);

    const first = await deliver(slashCommand({ channel: "D0PAIR001", trigger: "2.1", user: ALEX }));
    const other = await deliver(slashCommand({ channel: "D0PAIR001", trigger: "2.2", user: SAM }));
    const again = await deliver(slashCommand({ channel: "D0PAIR001", trigger: "2.3", user: ALEX }));

    expect(first).toEqual({ endUserKey: subject, kind: "submitted", threadId: expect.any(String) });
    expect(other).toEqual({ code: "end_user_mismatch", kind: "refused" });
    expect(again).toEqual({ endUserKey: subject, kind: "submitted", threadId: first.threadId });
  });
});
