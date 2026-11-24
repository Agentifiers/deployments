import type { PersistAgentEmailMessageInput } from "../agent-email/persistence-context.ts";
import { makeAgentEmailDynamoRepository } from "../agent-email/persistence.ts";
import type { DynamoDatabaseService } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import type { MessageSource } from "../records/conversations.ts";
import type { FakeDynamoDocumentClient } from "../testing/dynamo-document-client.fixture.ts";
import { CREATED_AT, SCOPE, testEndUserKeys, testId } from "./erasure-test-support.ts";

export const INBOX_ID = testId("N1");
export const INBOX_ADDRESS = "support@agents.example.com";

export function seedInbox(
  fake: FakeDynamoDocumentClient,
  inboxId = INBOX_ID,
  address = INBOX_ADDRESS,
) {
  fake.put(
    "control",
    withCanonicalRecordKeys({
      data: {
        ...SCOPE,
        address,
        createdAt: CREATED_AT,
        domainId: testId("N0"),
        id: inboxId,
        localPart: address.split("@")[0]!,
        metadata: {},
        status: "active" as const,
        updatedAt: CREATED_AT,
        version: 1,
      },
      itemType: "inbox" as const,
    }),
  );
}

export function mailRepository(database: DynamoDatabaseService) {
  return makeAgentEmailDynamoRepository(database, SCOPE, testEndUserKeys);
}

export interface TestMail {
  readonly bcc?: readonly string[];
  readonly cc?: readonly string[];
  readonly createdAt: string;
  readonly direction?: "inbound" | "outbound";
  readonly from: string;
  readonly id: Ulid;
  readonly inboxId?: Ulid;
  readonly inboxThreadId: Ulid;
  readonly subject?: string;
  readonly to: readonly string[];
}

export function mailInput(mail: TestMail): PersistAgentEmailMessageInput {
  const inboxId = mail.inboxId ?? INBOX_ID;
  const direction = mail.direction ?? "inbound";
  const subject = mail.subject ?? "Order status";
  return {
    event: {
      aggregateId: mail.id,
      aggregateType: "agent_email",
      eventId: `${mail.id.slice(0, 20)}EVNT${mail.id.slice(24)}`,
      eventType: direction === "inbound" ? "agent-email.received" : "agent-email.send-requested",
      payload: {
        address: INBOX_ADDRESS,
        direction,
        fromAddress: mail.from,
        inboxId,
        messageId: mail.id,
        occurredAt: mail.createdAt,
        organizationId: SCOPE.organizationId,
        status: direction === "inbound" ? "received" : "queued",
        subject,
        toAddresses: [...mail.to],
        version: 2,
      },
      source: "deployments-ai.agent-email",
    },
    message: {
      attachments: [],
      bccAddresses: [...(mail.bcc ?? [])],
      ccAddresses: [...(mail.cc ?? [])],
      createdAt: mail.createdAt,
      direction,
      fromAddress: mail.from,
      id: mail.id,
      inboxId,
      internetMessageId: `<${mail.id}@mail.example.com>`,
      organizationId: SCOPE.organizationId,
      references: [],
      replyToAddresses: [],
      reprocessCount: 0,
      status: direction === "inbound" ? "received" : "queued",
      subject,
      textBody: `Body of ${mail.id}`,
      threadId: mail.inboxThreadId,
      threadKey: `<${mail.inboxThreadId}@mail.example.com>`,
      toAddresses: [...mail.to],
      updatedAt: mail.createdAt,
    },
    thread: {
      createdAt: mail.createdAt,
      id: mail.inboxThreadId,
      inboxId,
      lastMessageAt: mail.createdAt,
      messageCount: 1,
      organizationId: SCOPE.organizationId,
      participants: [mail.from, ...mail.to, ...(mail.cc ?? [])],
      subject,
      updatedAt: mail.createdAt,
    },
    usage: [],
  };
}

export function mailSource(mail: TestMail): MessageSource {
  return {
    inboxId: mail.inboxId ?? INBOX_ID,
    inboxMessageCreatedAt: mail.createdAt,
    inboxMessageId: mail.id,
    inboxThreadId: mail.inboxThreadId,
    kind: "agent-email",
  };
}

export function sourcedMessageRecord(
  threadId: Ulid,
  id: Ulid,
  sequence: number,
  source: MessageSource,
) {
  return withCanonicalRecordKeys({
    data: {
      ...SCOPE,
      body: "An email arrived.",
      contentHash: "sha256:email",
      createdAt: CREATED_AT,
      id,
      role: "user" as const,
      sequence,
      source,
      threadId,
    },
    itemType: "message" as const,
  }) as Extract<PlatformRecord, { readonly itemType: "message" }>;
}
