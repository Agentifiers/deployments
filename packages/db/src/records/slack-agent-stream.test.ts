import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import { SlackAgentStreamRecord } from "./runtime-work.ts";
import { withCanonicalRecordKeys } from "./index.ts";

const id = (suffix: string) =>
  Schema.decodeUnknownSync(Ulid)(`01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}`);

describe("Slack agent stream record", () => {
  test("uses one durable run-scoped identity", () => {
    const runId = id("1");
    const record = Schema.decodeUnknownSync(SlackAgentStreamRecord)(
      withCanonicalRecordKeys({
        data: {
          agentDeploymentId: id("8"),
          bindingId: id("2"),
          bindingVersion: 0,
          channelId: "C1",
          createdAt: "2026-08-11T12:00:00.000Z",
          credentialRef: {
            credentialId: id("3"),
            generation: 1,
            store: "dynamodb-kms" as const,
          },
          environmentId: id("4"),
          fallbackAllowed: false,
          id: runId,
          organizationId: id("5"),
          projectId: id("6"),
          recipientTeamId: "T1",
          recipientUserId: "U1",
          runAttempt: 0,
          runClaimedAt: "2026-08-11T12:00:00.000Z",
          runExecutionVersion: 1,
          runId,
          status: "streaming" as const,
          streamTs: "1721609601.000001",
          threadId: id("7"),
          threadTs: "1721609600.123456",
          updatedAt: "2026-08-11T12:00:01.000Z",
          version: 1,
        },
        itemType: "slack-agent-stream" as const,
      }),
    );

    expect(record.pk).toBe(`ORG#${id("5")}#RUN#${runId}`);
    expect(record.sk).toBe(`SLACK-AGENT-STREAM#${runId}`);
    expect(record.data).toMatchObject({
      fallbackAllowed: false,
      status: "streaming",
      streamTs: "1721609601.000001",
    });
  });

  test("requires a pinned Dynamo KMS credential and explicit fallback safety", () => {
    const base = {
      agentDeploymentId: id("8"),
      bindingId: id("2"),
      bindingVersion: 0,
      channelId: "C1",
      createdAt: "2026-08-11T12:00:00.000Z",
      environmentId: id("4"),
      id: id("1"),
      organizationId: id("5"),
      projectId: id("6"),
      recipientTeamId: "T1",
      recipientUserId: "U1",
      runAttempt: 0,
      runClaimedAt: "2026-08-11T12:00:00.000Z",
      runExecutionVersion: 1,
      runId: id("1"),
      status: "starting",
      threadId: id("7"),
      threadTs: "1721609600.123456",
      updatedAt: "2026-08-11T12:00:00.000Z",
      version: 0,
    };

    expect(() =>
      Schema.decodeUnknownSync(SlackAgentStreamRecord)({
        data: {
          ...base,
          credentialRef: { arn: "arn:aws:secretsmanager:us-east-2:123:secret:slack" },
          fallbackAllowed: false,
        },
        itemType: "slack-agent-stream",
        pk: "invalid",
        sk: "invalid",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(SlackAgentStreamRecord)({
        data: {
          ...base,
          credentialRef: { credentialId: id("3"), generation: 1, store: "dynamodb-kms" },
        },
        itemType: "slack-agent-stream",
        pk: "invalid",
        sk: "invalid",
      }),
    ).toThrow();
  });
});
