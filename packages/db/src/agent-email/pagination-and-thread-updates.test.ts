import type {
  AgentEmailDomainEvent,
  AgentEmailDraftRecord,
  AgentEmailInboxRecord,
  AgentEmailMessageRecord,
  AgentEmailThreadRecord,
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

import { testEndUserKeys } from "../thread-erasure/erasure-test-support.ts";
import { makeAgentEmailDynamoRepository } from "./persistence.ts";
import {
  inboxControlCreatedIndexRecord,
  inboxDraftCreatedIndexRecord,
  inboxDraftRecord,
  inboxRecord,
  inboxThreadRecord,
} from "./record-mapping.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;
const INBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid;
const DOMAIN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ" as Ulid;
const MESSAGE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0" as Ulid;
const THREAD_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB1" as Ulid;
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB2" as Ulid;

const DRAFT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB6" as Ulid;

const SECOND_INBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB8" as Ulid;
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
      return Promise.resolve({ items: [] });
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

function inbox(id: Ulid = INBOX_ID): AgentEmailInboxRecord {
  return {
    address: id === INBOX_ID ? "agent@agents.example.com" : "second@agents.example.com",
    createdAt: NOW,
    domainId: DOMAIN_ID,
    id,
    localPart: id === INBOX_ID ? "agent" : "second",
    metadata: {},
    organizationId: ORGANIZATION_ID,
    status: "active",
    updatedAt: NOW,
  };
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

function thread(messageCount = 1): AgentEmailThreadRecord {
  return {
    createdAt: NOW,
    id: THREAD_ID,
    inboxId: INBOX_ID,
    lastMessageAt: NOW,
    messageCount,
    organizationId: ORGANIZATION_ID,
    participants: ["agent@agents.example.com", "sender@example.com"],
    subject: "Hello",
    updatedAt: NOW,
  };
}

describe("agent email DynamoDB reads and updates", () => {
  it("reads every DynamoDB page for list operations", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const first = inboxRecord(scope, inbox());
    const second = inboxRecord(scope, inbox(SECOND_INBOX_ID));
    const { service } = database({
      queryResults: [
        {
          items: [first],
          lastEvaluatedKey: { gsi2pk: "next", gsi2sk: "next" },
        },
        { items: [second] },
      ],
    });
    const repository = makeAgentEmailDynamoRepository(service, scope, testEndUserKeys);

    expect(await repository.listInboxes()).toEqual([first, second]);
  });

  it("bounds creation-ordered control and draft list pages", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const laterInbox = inboxRecord(scope, {
      ...inbox(INBOX_ID),
      createdAt: "2026-07-20T02:00:00.000Z",
      updatedAt: "2026-07-20T02:00:00.000Z",
    });
    const earlierInbox = inboxRecord(scope, {
      ...inbox(SECOND_INBOX_ID),
      createdAt: "2026-07-20T01:00:00.000Z",
      updatedAt: "2026-07-20T01:00:00.000Z",
    });
    const laterDraft = inboxDraftRecord(
      scope,
      {
        ...draft("draft"),
        createdAt: "2026-07-20T02:00:00.000Z",
        updatedAt: "2026-07-20T02:00:00.000Z",
      },
      [],
    );
    const earlierDraft = inboxDraftRecord(
      scope,
      {
        ...draft("draft"),
        createdAt: "2026-07-20T01:00:00.000Z",
        id: EVENT_ID,
        updatedAt: "2026-07-20T01:00:00.000Z",
      },
      [],
    );
    const laterInboxIndex = inboxControlCreatedIndexRecord(scope, "inbox", laterInbox);
    const earlierInboxIndex = inboxControlCreatedIndexRecord(scope, "inbox", earlierInbox);
    const laterDraftIndex = inboxDraftCreatedIndexRecord(scope, laterDraft.data);
    const earlierDraftIndex = inboxDraftCreatedIndexRecord(scope, earlierDraft.data);
    const { queries, service } = database({
      queryResults: [
        { items: [laterInboxIndex, earlierInboxIndex] },
        { items: [laterDraftIndex, earlierDraftIndex] },
      ],
      records: [laterInbox, earlierInbox, laterDraft, earlierDraft],
    });
    const repository = makeAgentEmailDynamoRepository(service, scope, testEndUserKeys);

    const inboxPage = await repository.listInboxesPage({ limit: 1 });
    const draftPage = await repository.listDraftsPage(INBOX_ID, { limit: 1 });

    expect(inboxPage.items.map((record) => record.data.id)).toEqual([INBOX_ID]);
    expect(inboxPage.hasMore).toBe(true);
    expect(inboxPage.scannedThrough?.data.id).toBe(INBOX_ID);
    expect(draftPage.items.map((record) => record.data.id)).toEqual([DRAFT_ID]);
    expect(draftPage.hasMore).toBe(true);
    expect(draftPage.scannedThrough?.data.id).toBe(DRAFT_ID);
    expect(queries).toEqual([
      expect.objectContaining({
        ConsistentRead: true,
        ExpressionAttributeValues: {
          ":pk": `ORG#${ORGANIZATION_ID}#ENV#${ENVIRONMENT_ID}`,
          ":sk": "INBOX-CONTROL-CREATED-INDEX#inbox#",
        },
        Limit: 2,
        ScanIndexForward: false,
      }),
      expect.objectContaining({
        ConsistentRead: true,
        ExpressionAttributeValues: {
          ":pk": `ORG#${ORGANIZATION_ID}#INBOX#${INBOX_ID}`,
          ":sk": "INBOX-DRAFT-CREATED-INDEX#",
        },
        Limit: 2,
        ScanIndexForward: false,
      }),
    ]);
  });

  it("scans past a retained draft index after governance removes its parent", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const removedDraft = inboxDraftRecord(
      scope,
      {
        ...draft("draft"),
        createdAt: "2026-07-20T02:00:00.000Z",
        updatedAt: "2026-07-20T02:00:00.000Z",
      },
      [],
    );
    const removedIndex = inboxDraftCreatedIndexRecord(scope, removedDraft.data);
    const liveDraft = inboxDraftRecord(
      scope,
      {
        ...draft("draft"),
        createdAt: "2026-07-20T01:00:00.000Z",
        id: EVENT_ID,
        updatedAt: "2026-07-20T01:00:00.000Z",
      },
      [],
    );
    const liveIndex = inboxDraftCreatedIndexRecord(scope, liveDraft.data);
    const { service } = database({
      queryResults: [{ items: [removedIndex, liveIndex] }],
      records: [liveDraft],
    });
    const repository = makeAgentEmailDynamoRepository(service, scope, testEndUserKeys);

    expect(repository.listDraftsPage(INBOX_ID, { limit: 1 })).resolves.toMatchObject({
      hasMore: false,
      items: [liveDraft],
      scannedThrough: liveIndex,
    });
  });

  it("updates an existing thread in the same message transaction", async () => {
    const previousThread = inboxThreadRecord(
      {
        environmentId: ENVIRONMENT_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
      },
      {
        ...thread(3),
        lastMessageAt: "2026-07-20T10:00:00.000Z",
        participants: ["agent@agents.example.com", "first@example.com"],
        subject: "Earlier subject",
        updatedAt: "2026-07-20T10:00:00.000Z",
      },
      "<message@example.com>",
    );
    const { service, transactions } = database({ records: [previousThread] });
    const repository = makeAgentEmailDynamoRepository(
      service,
      {
        environmentId: ENVIRONMENT_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
      },
      testEndUserKeys,
    );

    await repository.persistMessage({
      event: event("agent-email.received", MESSAGE_ID),
      message: message(),
      thread: {
        ...thread(2),
        participants: ["agent@agents.example.com", "sender@example.com"],
      },
      usage: [],
    });

    const threadPut = transactions
      .at(-1)
      ?.find(
        (operation) => operation.kind === "put" && operation.record.itemType === "inbox-thread",
      );
    expect(threadPut?.kind === "put" ? threadPut.previousRecord : undefined).toEqual(
      previousThread,
    );
    expect(
      threadPut?.kind === "put" && threadPut.record.itemType === "inbox-thread"
        ? threadPut.record.data.version
        : undefined,
    ).toBe(1);
    expect(
      threadPut?.kind === "put" && threadPut.record.itemType === "inbox-thread"
        ? threadPut.record.data.messageCount
        : undefined,
    ).toBe(4);
    expect(
      threadPut?.kind === "put" && threadPut.record.itemType === "inbox-thread"
        ? threadPut.record.data.participants
        : undefined,
    ).toEqual(["agent@agents.example.com", "first@example.com", "sender@example.com"]);
  });

  it("bounds accumulated thread participants while retaining the latest message participants", async () => {
    const previousThread = inboxThreadRecord(
      {
        environmentId: ENVIRONMENT_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
      },
      {
        ...thread(300),
        participants: Array.from(
          { length: 400 },
          (_, index) => `historical-${index}-${"x".repeat(280)}@example.com`,
        ),
      },
      "<message@example.com>",
    );
    const { service, transactions } = database({ records: [previousThread] });
    const repository = makeAgentEmailDynamoRepository(
      service,
      {
        environmentId: ENVIRONMENT_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
      },
      testEndUserKeys,
    );

    await repository.persistMessage({
      event: event("agent-email.received", MESSAGE_ID),
      message: message(),
      thread: {
        ...thread(1),
        participants: ["agent@agents.example.com", "latest@example.com"],
      },
      usage: [],
    });

    const threadPut = transactions
      .at(-1)
      ?.find(
        (operation) => operation.kind === "put" && operation.record.itemType === "inbox-thread",
      );
    const participants =
      threadPut?.kind === "put" && threadPut.record.itemType === "inbox-thread"
        ? threadPut.record.data.participants
        : [];
    expect(participants.length).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(JSON.stringify(participants), "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(participants).toContain("agent@agents.example.com");
    expect(participants).toContain("latest@example.com");
  });
});
