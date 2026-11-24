import { marshall } from "@aws-sdk/util-dynamodb";
import { describe, expect, it } from "bun:test";
import { agentEmailSendRequestFromStreamRecord } from "./stream-record-decoding.ts";
import type { Ulid } from "../ids.ts";
import { makeSemanticEventRecord } from "../semantic-event-storage.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;
const INBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid;
const MESSAGE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ" as Ulid;

function streamRecord(eventType = "agent-email.send-requested") {
  return {
    dynamodb: {
      NewImage: marshall(
        makeSemanticEventRecord({
          aggregateId: MESSAGE_ID,
          aggregateType: "agent_email",
          aggregateVersion: 1,
          environmentId: ENVIRONMENT_ID,
          eventId: "01ARZ3NDEKTSV4RRFFQ69G5FB0" as Ulid,
          eventType,
          occurredAt: "2026-07-27T00:00:00.000Z",
          organizationId: ORGANIZATION_ID,
          payload: { inboxId: INBOX_ID, messageId: MESSAGE_ID },
          projectId: PROJECT_ID,
        }),
      ),
      SequenceNumber: "123456789",
    },
    eventID: "event-id",
    eventName: "INSERT",
  };
}

describe("agent email DynamoDB stream record decoding", () => {
  it("decodes a canonical send-requested semantic event", async () => {
    expect(agentEmailSendRequestFromStreamRecord(streamRecord())).resolves.toEqual({
      environmentId: ENVIRONMENT_ID,
      inboxId: INBOX_ID,
      messageId: MESSAGE_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      type: "agent-email-send",
    });
  });

  it("ignores unrelated canonical semantic events", async () => {
    expect(
      agentEmailSendRequestFromStreamRecord(streamRecord("agent-email.delivered")),
    ).resolves.toBeUndefined();
  });
});
