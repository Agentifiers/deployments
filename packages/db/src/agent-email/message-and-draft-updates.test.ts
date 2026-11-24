import type {
  AgentEmailDomainEvent,
  AgentEmailDraftRecord,
  AgentEmailMessageRecord,
  AgentEmailPolicyRecord,
} from "@deployments-ai/agent-email";
import {
  type DynamoDatabaseService,
  type PlatformRecord,
  type QueryRecordsResult,
  type RecordKey,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { describe, expect, it } from "bun:test";

import { makeAgentEmailDynamoRepository } from "./persistence.ts";
import {
  inboxAttachmentRecord,
  inboxDraftRecord,
  inboxMessageRecord,
  inboxPolicyRecord,
} from "./record-mapping.ts";
import { makeSemanticEventRecord } from "../semantic-event-storage.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;
const INBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid;
const MESSAGE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0" as Ulid;
const THREAD_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB1" as Ulid;
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB2" as Ulid;

const DRAFT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB6" as Ulid;

const NOW = "2026-07-20T00:00:00.000Z";

function event(
  eventType: AgentEmailDomainEvent["eventType"],
  messageId: Ulid,
): AgentEmailDomainEvent {
  return {
    aggregateId: messageId,
    aggregateType: "agent_email",
    eventId: EVENT_ID,
    eventType,
    payload: {
      address: "agent@agents.example.com",
      direction: eventType === "agent-email.received" ? "inbound" : "outbound",
      fromAddress:
        eventType === "agent-email.received" ? "sender@example.com" : "agent@agents.example.com",
      inboxId: INBOX_ID,
      messageId,
      occurredAt: NOW,
      organizationId: ORGANIZATION_ID,
      status: eventType === "agent-email.received" ? "received" : "queued",
      subject: "Hello",
      toAddresses:
        eventType === "agent-email.received"
          ? ["agent@agents.example.com"]
          : ["recipient@example.com"],
      version: 2,
    },
    source: "deployments-ai.agent-email",
  };
}

function database(
  options: {
    readonly queryResults?: readonly QueryRecordsResult[];
    readonly records?: readonly PlatformRecord[];
    readonly queryResult?: QueryRecordsResult;
  } = {},
) {
  const transactions: readonly TransactionOperation[][] = [];
  const mutableTransactions = transactions as TransactionOperation[][];
  const mutableRecords = [...(options.records ?? [])];
  const queries: Record<string, unknown>[] = [];
  let queryIndex = 0;
  const service: DynamoDatabaseService = {
    deleteRecord: () => Promise.resolve(),
    getRecord: (_table, key: RecordKey) => {
      const found = mutableRecords.find((record) => record.pk === key.pk && record.sk === key.sk);
      return Promise.resolve(found ? found : undefined);
    },
    putRecord: () => Promise.resolve(),
    queryRecords: (table, query) => {
      queries.push(query);
      const configured = options.queryResults?.[queryIndex++] ?? options.queryResult;
      if (configured) return Promise.resolve(configured);
      if (table === "events") {
        const values = query.ExpressionAttributeValues as
          | { readonly ":pk"?: string; readonly ":sk"?: string }
          | undefined;
        return Promise.resolve({
          items: mutableRecords.filter(
            (record) =>
              record.itemType === "semantic-event" &&
              record.pk === values?.[":pk"] &&
              record.sk.startsWith(values?.[":sk"] ?? ""),
          ),
        });
      }
      if (query.IndexName === "gsi1" || query.IndexName === "gsi2") {
        const values = query.ExpressionAttributeValues as
          | { readonly ":pk"?: string; readonly ":sk"?: string }
          | undefined;
        const pkField = query.IndexName === "gsi1" ? "gsi1pk" : "gsi2pk";
        const skField = query.IndexName === "gsi1" ? "gsi1sk" : "gsi2sk";
        return Promise.resolve({
          items: mutableRecords.filter(
            (record) =>
              record[pkField] === values?.[":pk"] &&
              record[skField]?.startsWith(values?.[":sk"] ?? ""),
          ),
        });
      }
      const values = query.ExpressionAttributeValues as
        | { readonly ":pk"?: string; readonly ":sk"?: string }
        | undefined;
      return Promise.resolve({
        items: mutableRecords.filter(
          (record) => record.pk === values?.[":pk"] && record.sk.startsWith(values?.[":sk"] ?? ""),
        ),
      });
    },
    transactWrite: (operations) =>
      (async () => {
        mutableTransactions.push([...operations]);
        for (const operation of operations) {
          if (operation.kind === "condition-check") continue;
          const index = mutableRecords.findIndex(
            (record) => record.pk === operation.record.pk && record.sk === operation.record.sk,
          );
          if (operation.kind === "delete") {
            if (index >= 0) mutableRecords.splice(index, 1);
          } else if (index >= 0) {
            mutableRecords[index] = operation.record;
          } else {
            mutableRecords.push(operation.record);
          }
        }
      })(),
  };
  return { queries, service, transactions };
}

function message(textBody = "Hello agent"): AgentEmailMessageRecord {
  return {
    attachments: [],
    bccAddresses: [],
    ccAddresses: [],
    createdAt: NOW,
    direction: "inbound",
    fromAddress: "sender@example.com",
    id: MESSAGE_ID,
    inboxId: INBOX_ID,
    organizationId: ORGANIZATION_ID,
    receivedAt: NOW,
    references: [],
    replyToAddresses: [],
    reprocessCount: 0,
    status: "received",
    subject: "Hello",
    textBody,
    threadKey: "<message@example.com>",
    toAddresses: ["agent@agents.example.com"],
    updatedAt: NOW,
  };
}

function draft(status: AgentEmailDraftRecord["status"]): AgentEmailDraftRecord {
  return {
    bccAddresses: [],
    ccAddresses: [],
    createdAt: NOW,
    id: DRAFT_ID,
    inboxId: INBOX_ID,
    metadata: {},
    organizationId: ORGANIZATION_ID,
    sentMessageId: MESSAGE_ID,
    status,
    subject: "Hello",
    textBody: "Hello agent",
    toAddresses: ["recipient@example.com"],
    updatedAt: NOW,
  };
}

function policy(overrides: Partial<AgentEmailPolicyRecord> = {}): AgentEmailPolicyRecord {
  return {
    allowlist: [],
    blocklist: [],
    bounceRateThresholdBasisPoints: 500,
    complaintRateThresholdBasisPoints: 10,
    createdAt: NOW,
    dailyOutboundMessageLimit: 1_000,
    id: DRAFT_ID,
    maxAttachmentBytes: 4 * 1024 * 1024,
    maxRecipientsPerMessage: 47,
    organizationId: ORGANIZATION_ID,
    rawRetentionDays: 30,
    sendingStatus: "active",
    updatedAt: NOW,
    warmupStage: "production",
    ...overrides,
  };
}

describe("agent email DynamoDB reads and updates", () => {
  it("fails closed when a large body has not been externalized", async () => {
    const { service } = database();
    const repository = makeAgentEmailDynamoRepository(service, {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    });

    expect(
      repository.persistMessage({
        event: event("agent-email.received", MESSAGE_ID),
        message: message("x".repeat(300 * 1024)),
        usage: [],
      }),
    ).rejects.toThrow("Message bodies larger than 256 KiB must be stored in S3.");
  });

  it("preserves externalized body references and advances the event version on update", async () => {
    const previous = inboxMessageRecord(
      {
        environmentId: ENVIRONMENT_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
      },
      { ...message(), threadId: THREAD_ID },
      [],
      {
        rawReference: {
          bucket: "agent-email",
          byteSize: 512,
          contentType: "message/rfc822",
          key: `raw/${MESSAGE_ID}`,
          sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        },
        textBodyRef: {
          bucket: "agent-email",
          byteSize: 300 * 1024,
          contentType: "text/plain; charset=utf-8",
          key: `bodies/${MESSAGE_ID}/body.txt`,
          sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        },
      },
    );
    const receivedEvent = makeSemanticEventRecord({
      aggregateId: MESSAGE_ID,
      aggregateType: "agent_email",
      aggregateVersion: 1,
      environmentId: ENVIRONMENT_ID,
      eventId: DRAFT_ID,
      eventType: "agent-email.received",
      occurredAt: NOW,
      organizationId: ORGANIZATION_ID,
      payload: JSON.parse(
        JSON.stringify(event("agent-email.received", MESSAGE_ID).payload),
      ) as Readonly<Record<string, import("@deployments-ai/db").DynamoValue>>,
      projectId: PROJECT_ID,
    });
    const { service, transactions } = database({
      records: [previous, receivedEvent],
    });
    const repository = makeAgentEmailDynamoRepository(service, {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    });

    const { textBody: _textBody, ...messageWithoutInlineBody } = message();
    await repository.updateMessage(
      previous,
      { ...messageWithoutInlineBody, status: "delivered", threadId: THREAD_ID },
      event("agent-email.delivered", MESSAGE_ID),
    );

    const messagePut = transactions[0]?.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "inbox-message",
    );
    const semanticEvent = transactions[0]?.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "semantic-event",
    );
    expect(
      messagePut?.kind === "put" && messagePut.record.itemType === "inbox-message"
        ? messagePut.record.data.textBodyRef?.key
        : undefined,
    ).toBe(`bodies/${MESSAGE_ID}/body.txt`);
    expect(
      messagePut?.kind === "put" && messagePut.record.itemType === "inbox-message"
        ? messagePut.record.data.rawReference?.key
        : undefined,
    ).toBe(`raw/${MESSAGE_ID}`);
    expect(
      semanticEvent?.kind === "put" && semanticEvent.record.itemType === "semantic-event"
        ? semanticEvent.record.data.aggregateVersion
        : undefined,
    ).toBe(2);
  });

  it("replaces attachment storage records with the reprocessed message update", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const previous = inboxMessageRecord(scope, message(), []);
    const oldAttachment = inboxAttachmentRecord(
      scope,
      MESSAGE_ID,
      {
        bucket: "agent-email",
        byteSize: 3,
        contentType: "text/plain",
        disposition: "attachment",
        fileName: "old.txt",
        id: DRAFT_ID,
        key: `attachments/${MESSAGE_ID}/old`,
        sha256: "old-sha",
      },
      NOW,
      0,
    );
    const { queries, service, transactions } = database({
      records: [previous, oldAttachment],
    });
    const repository = makeAgentEmailDynamoRepository(service, scope);
    const replacement = {
      bucket: "agent-email",
      byteSize: 4,
      contentType: "text/plain",
      disposition: "attachment" as const,
      fileName: "new.txt",
      id: DRAFT_ID,
      key: `attachments/${MESSAGE_ID}/new`,
      sha256: "new-sha",
    };

    await repository.updateMessage(
      previous,
      {
        ...message(),
        attachments: [
          {
            byteSize: replacement.byteSize,
            contentType: replacement.contentType,
            disposition: replacement.disposition,
            fileName: replacement.fileName,
            id: replacement.id,
            messageId: MESSAGE_ID,
            sha256: replacement.sha256,
          },
        ],
        reprocessCount: 1,
      },
      event("agent-email.received", MESSAGE_ID),
      undefined,
      [replacement],
    );

    const attachmentOperations = transactions[0]?.filter(
      (operation) =>
        operation.kind !== "condition-check" && operation.record.itemType === "inbox-attachment",
    );
    expect(attachmentOperations).toHaveLength(1);
    expect(attachmentOperations?.[0]).toMatchObject({
      kind: "put",
      previousRecord: oldAttachment,
      record: {
        data: { fileName: "new.txt", storage: { key: replacement.key }, version: 1 },
      },
    });
    expect(
      queries.find(
        (query) =>
          (query.ExpressionAttributeValues as { readonly ":sk"?: string } | undefined)?.[":sk"] ===
          "INBOX-ATTACHMENT#",
      ),
    ).toMatchObject({ ConsistentRead: true });
  });

  it("advances an associated sent draft with terminal message outcomes", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    for (const outcome of [
      { draftStatus: "sent", messageStatus: "accepted" },
      { draftStatus: "failed", messageStatus: "failed" },
    ] as const) {
      const previousMessage = inboxMessageRecord(
        scope,
        {
          ...message(),
          direction: "outbound",
          draftId: DRAFT_ID,
          fromAddress: "agent@agents.example.com",
          status: "sending",
          toAddresses: ["recipient@example.com"],
        },
        [],
      );
      const previousDraft = inboxDraftRecord(scope, draft("queued"), []);
      const { service, transactions } = database({
        records: [previousMessage, previousDraft],
      });
      const repository = makeAgentEmailDynamoRepository(service, scope);

      await repository.updateMessage(
        previousMessage,
        {
          ...message(),
          direction: "outbound",
          draftId: DRAFT_ID,
          ...(outcome.messageStatus === "failed"
            ? { failureReason: "Amazon SES rejected the message." }
            : {}),
          fromAddress: "agent@agents.example.com",
          status: outcome.messageStatus,
          toAddresses: ["recipient@example.com"],
        },
        event(
          outcome.messageStatus === "failed" ? "agent-email.failed" : "agent-email.accepted",
          MESSAGE_ID,
        ),
      );

      expect(
        transactions[0]?.find(
          (operation) => operation.kind === "put" && operation.record.itemType === "inbox-draft",
        ),
      ).toMatchObject({
        kind: "put",
        record: {
          data: {
            sentMessageId: MESSAGE_ID,
            status: outcome.draftStatus,
          },
        },
      });
    }
  });

  it("recovers a failed draft and reputation count after an unknown send outcome", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const previousMessage = inboxMessageRecord(
      scope,
      {
        ...message(),
        direction: "outbound",
        draftId: DRAFT_ID,
        failureCode: "send_outcome_unknown",
        failureReason: "Amazon SES may have accepted the message.",
        fromAddress: "agent@agents.example.com",
        status: "failed",
        toAddresses: ["recipient@example.com"],
      },
      [],
    );
    const previousDraft = inboxDraftRecord(
      scope,
      {
        ...draft("failed"),
        failureReason: "Amazon SES may have accepted the message.",
      },
      [],
    );
    const persistedPolicy = inboxPolicyRecord(scope, policy());
    const { service, transactions } = database({
      records: [previousMessage, previousDraft, persistedPolicy],
    });
    const repository = makeAgentEmailDynamoRepository(service, scope);

    await repository.updateMessage(
      previousMessage,
      {
        ...message(),
        direction: "outbound",
        draftId: DRAFT_ID,
        fromAddress: "agent@agents.example.com",
        providerMessageId: "ses-message",
        status: "accepted",
        toAddresses: ["recipient@example.com"],
      },
      event("agent-email.accepted", MESSAGE_ID),
    );

    const draftPut = transactions[0]?.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "inbox-draft",
    );
    expect(
      draftPut?.kind === "put" && draftPut.record.itemType === "inbox-draft"
        ? draftPut.record.data
        : undefined,
    ).toMatchObject({
      sentMessageId: MESSAGE_ID,
      status: "sent",
    });
    expect(
      draftPut?.kind === "put" && draftPut.record.itemType === "inbox-draft"
        ? draftPut.record.data.failureReason
        : undefined,
    ).toBeUndefined();

    const policyPut = transactions[0]?.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "inbox-policy",
    );
    expect(
      policyPut?.kind === "put" && policyPut.record.itemType === "inbox-policy"
        ? policyPut.record.data.outboundOutcomeMessageCount
        : undefined,
    ).toBe(1);
  });
});
