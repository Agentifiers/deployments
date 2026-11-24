import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import { ChannelDeliveryRecord, TeamsAgentStreamRecord } from "./runtime-work.ts";
import { withCanonicalRecordKeys } from "./index.ts";

const id = (suffix: string) =>
  Schema.decodeUnknownSync(Ulid)(`01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}`);

const base = {
  agentDeploymentId: id("8"),
  bindingId: id("2"),
  bindingVersion: 0,
  conversationId: "19:conversation@thread.v2",
  createdAt: "2026-08-11T12:00:00.000Z",
  environmentId: id("4"),
  id: id("1"),
  organizationId: id("5"),
  projectId: id("6"),
  recipientId: "29:user",
  runAttempt: 0,
  runClaimedAt: "2026-08-11T12:00:00.000Z",
  runExecutionVersion: 1,
  runId: id("1"),
  serviceUrl: "https://smba.trafficmanager.net/amer/",
  status: "starting",
  tenantId: "tenant-1",
  threadId: id("7"),
  updatedAt: "2026-08-11T12:00:00.000Z",
  version: 0,
};
const kmsRef = { credentialId: id("3"), generation: 1, store: "dynamodb-kms" as const };

describe("Teams agent stream record", () => {
  test("uses one durable run-scoped identity and round-trips", () => {
    const runId = id("1");
    const input = withCanonicalRecordKeys({
      data: {
        ...base,
        credentialRef: kmsRef,
        fallbackAllowed: false,
        status: "streaming" as const,
        streamId: "stream-1",
        streamStartedAt: "2026-08-11T12:00:01.000Z",
        updatedAt: "2026-08-11T12:00:01.000Z",
        version: 1,
      },
      itemType: "teams-agent-stream" as const,
    });
    const record = Schema.decodeUnknownSync(TeamsAgentStreamRecord)(input);

    expect(record.pk).toBe(`ORG#${id("5")}#RUN#${runId}`);
    expect(record.sk).toBe(`TEAMS-AGENT-STREAM#${runId}`);
    expect(record.data).toMatchObject({ status: "streaming", streamId: "stream-1" });
    expect(Schema.encodeSync(TeamsAgentStreamRecord)(record)).toEqual(input);
  });

  test("requires a pinned Dynamo KMS credential and explicit fallback safety", () => {
    const decode = (data: Record<string, unknown>) =>
      Schema.decodeUnknownSync(TeamsAgentStreamRecord)({
        data: { ...base, ...data },
        itemType: "teams-agent-stream",
        pk: "invalid",
        sk: "invalid",
      });
    expect(() =>
      decode({
        credentialRef: { arn: "arn:aws:secretsmanager:us-east-2:123:secret:teams" },
        fallbackAllowed: false,
      }),
    ).toThrow();
    expect(() => decode({ credentialRef: kmsRef })).toThrow();
  });

  test("accepts only known stream statuses", () => {
    for (const status of ["starting", "streaming", "paused", "stopped", "failed"]) {
      const record = Schema.decodeUnknownSync(TeamsAgentStreamRecord)(
        withCanonicalRecordKeys({
          data: { ...base, credentialRef: kmsRef, fallbackAllowed: true, status },
          itemType: "teams-agent-stream",
        } as never),
      );
      expect(record.data.status).toBe(status as never);
    }
    expect(() =>
      Schema.decodeUnknownSync(TeamsAgentStreamRecord)(
        withCanonicalRecordKeys({
          data: { ...base, credentialRef: kmsRef, fallbackAllowed: true, status: "done" },
          itemType: "teams-agent-stream",
        } as never),
      ),
    ).toThrow();
  });
});

describe("channel delivery stream fallback mode", () => {
  const delivery = (extra: Record<string, unknown>) =>
    Schema.decodeUnknownSync(ChannelDeliveryRecord)(
      withCanonicalRecordKeys({
        data: {
          attempts: 0,
          channel: "teams",
          contentPreview: "hi",
          createdAt: "2026-08-11T12:00:00.000Z",
          environmentId: id("4"),
          externalThreadKey: "19:conversation@thread.v2",
          id: id("9"),
          idempotencyKey: "key",
          organizationId: id("5"),
          projectId: id("6"),
          provider: "teams_bot_framework",
          runId: id("1"),
          status: "queued",
          threadId: id("7"),
          updatedAt: "2026-08-11T12:00:00.000Z",
          version: 0,
          ...extra,
        },
        itemType: "channel-delivery",
      } as never),
    );

  test("accepts Teams and Slack fallback modes and rejects unknown ones", () => {
    expect(
      delivery({
        deliveryMode: "teams-stream-fallback",
        teamsStreamRunClaimedAt: "2026-08-11T12:00:00.000Z",
      }).data,
    ).toMatchObject({
      deliveryMode: "teams-stream-fallback",
      teamsStreamRunClaimedAt: "2026-08-11T12:00:00.000Z",
    });
    expect(delivery({ deliveryMode: "slack-stream-fallback" }).data.deliveryMode).toBe(
      "slack-stream-fallback",
    );
    expect(() => delivery({ deliveryMode: "email-stream-fallback" })).toThrow();
  });
});
