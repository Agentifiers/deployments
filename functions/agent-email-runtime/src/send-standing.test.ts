import {
  inboxDomainRecord,
  inboxMessageRecord,
  inboxPlacementRecord,
  inboxPolicyRecord,
  inboxRecord,
  tableForItemType,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { erasureTestDatabase } from "@deployments-ai/db/erasure-testing";
import { organizationHolds } from "@deployments-ai/organization-admission/testing";
import { describe, expect, test } from "bun:test";
import {
  ENVIRONMENT_ID,
  INBOX_ID,
  ORGANIZATION_ID,
  PROJECT_ID,
  domain,
  inbox,
  policy,
  scope,
} from "./application-service-test-support.ts";
import { createAwsAgentEmailSendDependencies, handleAgentEmailSendQueue } from "./send-main.ts";

const MESSAGE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FC1" as Ulid;
const CREATED_AT = "2026-07-25T12:00:00.000Z";
const SEND_ENVIRONMENT = {
  AWS_REGION: "us-east-1",
  DEPLOYMENTS_AI_AGENT_EMAIL_BUCKET: "agent-email",
  DEPLOYMENTS_AI_AGENT_EMAIL_EVENTS_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/1/events",
  DEPLOYMENTS_AI_AGENT_EMAIL_SEND_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/1/send",
};

const records: readonly PlatformRecord[] = [
  withCanonicalRecordKeys({
    data: {
      createdAt: CREATED_AT,
      id: ENVIRONMENT_ID,
      kind: "production" as const,
      name: "Production",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      slug: "production",
      status: "active" as const,
      updatedAt: CREATED_AT,
      version: 0,
    },
    itemType: "environment" as const,
  }) as PlatformRecord,
  inboxRecord(scope, inbox()),
  inboxDomainRecord(scope, domain({ providerManaged: true })),
  inboxPolicyRecord(scope, policy({ warmupStage: "production" })),
  inboxPlacementRecord(scope, {
    createdAt: CREATED_AT,
    dedicatedPool: false,
    id: "01ARZ3NDEKTSV4RRFFQ69G5FC4",
    isDefault: true,
    name: "Primary",
    organizationId: ORGANIZATION_ID,
    provider: "ses",
    providerMetadata: { configurationSetName: "agent-email-primary" },
    region: "us-east-1",
    status: "active",
    updatedAt: CREATED_AT,
  }),
  inboxMessageRecord(
    scope,
    {
      attachments: [],
      bccAddresses: [],
      ccAddresses: [],
      createdAt: CREATED_AT,
      direction: "outbound",
      fromAddress: "agent@agents.example.com",
      id: MESSAGE_ID,
      inboxId: INBOX_ID,
      organizationId: ORGANIZATION_ID,
      references: [],
      replyToAddresses: [],
      reprocessCount: 0,
      status: "queued",
      subject: "Quarterly numbers",
      textBody: "Attached.",
      threadKey: "<thread@agents.example.com>",
      toAddresses: ["person@example.net"],
      updatedAt: CREATED_AT,
    },
    [],
  ),
];

describe("agent email sends of a suspended organization", () => {
  test("record the message as failed with organization_suspended and settle the queue message", async () => {
    const { database, fake } = erasureTestDatabase();
    for (const record of records) fake.put(tableForItemType(record.itemType), record);
    await organizationHolds(database, ORGANIZATION_ID).hold("payment");

    const result = await handleAgentEmailSendQueue(
      {
        Records: [
          {
            body: JSON.stringify({
              ...scope,
              inboxId: INBOX_ID,
              messageId: MESSAGE_ID,
              type: "agent-email-send",
            }),
            messageId: "sqs-send-1",
          },
        ],
      },
      createAwsAgentEmailSendDependencies(SEND_ENVIRONMENT, database),
    );
    const stored = await database.getRecord(
      "execution",
      { pk: `ORG#${ORGANIZATION_ID}#INBOX#${INBOX_ID}`, sk: `INBOX-MESSAGE#${MESSAGE_ID}` },
      true,
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(
      stored?.itemType === "inbox-message"
        ? {
            failureCode: stored.data.failureCode,
            failureReason: stored.data.failureReason,
            status: stored.data.status,
          }
        : stored,
    ).toEqual({
      failureCode: "organization_suspended",
      failureReason: "The organization is suspended.",
      status: "failed",
    });
  });
});
