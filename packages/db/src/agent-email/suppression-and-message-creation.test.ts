import type {
  AgentEmailDraftRecord,
  AgentEmailDomainEvent,
  AgentEmailInboxRecord,
  AgentEmailMessageRecord,
  AgentEmailThreadRecord,
} from "@deployments-ai/agent-email";
import {
  decodePlatformRecord,
  makeUniqueClaimRecord,
  type DynamoDatabaseService,
  type PlatformRecord,
  type QueryRecordsResult,
  type RecordKey,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { createHash } from "node:crypto";
import { prepareDynamoTransactionOperations } from "../dynamo-database.ts";
import { makeSemanticEventRecord } from "../semantic-event-storage.ts";
import { testEndUserKeys } from "../thread-erasure/erasure-test-support.ts";
import { makeAgentEmailDynamoRepository } from "./persistence.ts";
import {
  inboxDraftRecord,
  inboxMessageRecord,
  inboxMessageThreadAliasRecord,
} from "./record-mapping.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;
const INBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid;
const DOMAIN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ" as Ulid;
const MESSAGE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0" as Ulid;
const THREAD_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB1" as Ulid;
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB2" as Ulid;
const USAGE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB3" as Ulid;
const ATTACHMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB4" as Ulid;

const SECOND_INBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB8" as Ulid;
const NOW = "2026-07-20T00:00:00.000Z";

function testUlid(index: number) {
  return `01ARZ3NDEKTSV4RRFFQ69${String(index).padStart(5, "0")}` as Ulid;
}

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

function inboxCreatedEvent(): AgentEmailDomainEvent {
  return {
    aggregateId: INBOX_ID,
    aggregateType: "agent_email",
    eventId: EVENT_ID,
    eventType: "agent-email.inbox-created",
    payload: {
      occurredAt: NOW,
      organizationId: ORGANIZATION_ID,
      resourceId: INBOX_ID,
      resourceType: "inbox",
      status: "active",
      version: 1,
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
  const reads: Array<{
    readonly consistentRead: boolean | undefined;
    readonly key: RecordKey;
  }> = [];
  let queryIndex = 0;
  const service: DynamoDatabaseService = {
    deleteRecord: () => Promise.resolve(),
    getRecord: (_table, key: RecordKey, consistentRead) => {
      reads.push({ consistentRead, key });
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
  return { queries, reads, service, transactions };
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

async function expectCanonical(operations: readonly TransactionOperation[]) {
  for (const operation of operations) {
    if (operation.kind === "condition-check") continue;
    await Effect.runPromise(decodePlatformRecord(operation.record));
  }
}

describe("agent email DynamoDB creation", () => {
  it("creates and removes environment and organization suppression claims", async () => {
    const { queries, service, transactions } = database();
    const repository = makeAgentEmailDynamoRepository(
      service,
      {
        environmentId: ENVIRONMENT_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
      },
      testEndUserKeys,
    );

    await repository.createSuppression({
      address: "Recipient@Example.com",
      createdAt: NOW,
      id: ATTACHMENT_ID,
      organizationId: ORGANIZATION_ID,
      reason: "manual",
    });
    expect(repository.listOrganizationSuppressions()).resolves.toMatchObject([
      { data: { address: "Recipient@Example.com", status: "active" } },
    ]);
    expect(queries.at(-1)).toMatchObject({
      ExpressionAttributeValues: {
        ":pk": `ORG#${ORGANIZATION_ID}`,
        ":sk": "INBOX-SUPPRESSION#",
      },
      IndexName: "gsi1",
    });
    expect(repository.removeSuppression(ATTACHMENT_ID, NOW)).resolves.toBe(true);

    expect(transactions).toHaveLength(2);
    const createClaims = transactions[0]?.filter(
      (operation) => operation.kind === "put" && operation.record.itemType === "unique-claim",
    );
    const removeClaims = transactions[1]?.filter(
      (operation) => operation.kind === "delete" && operation.record.itemType === "unique-claim",
    );
    expect(
      createClaims?.map((operation) =>
        operation.kind === "put" && operation.record.itemType === "unique-claim"
          ? {
              namespace: operation.record.data.namespace,
              value: operation.record.data.value,
            }
          : undefined,
      ),
    ).toEqual([
      {
        namespace: `organization:${ORGANIZATION_ID}:project:${PROJECT_ID}:environment:${ENVIRONMENT_ID}:inbox-suppression`,
        value: createHash("sha256").update("recipient@example.com").digest("hex"),
      },
      {
        namespace: `organization:${ORGANIZATION_ID}:inbox-suppression-address:${createHash("sha256").update("recipient@example.com").digest("hex")}`,
        value: `${ENVIRONMENT_ID}:${ATTACHMENT_ID}`,
      },
    ]);
    expect(removeClaims).toHaveLength(2);
    const removed = transactions[1]?.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "inbox-suppression",
    );
    expect(
      removed?.kind === "put" && removed.record.itemType === "inbox-suppression"
        ? removed.record.data.status
        : undefined,
    ).toBe("removed");
  });

  it("checks sibling organization suppressions through a strongly consistent claim partition", async () => {
    const emailHash = createHash("sha256").update("recipient@example.com").digest("hex");
    const namespace = `organization:${ORGANIZATION_ID}:inbox-suppression-address:${emailHash}`;
    const siblingClaim = makeUniqueClaimRecord(
      {
        namespace,
        ownerId: USAGE_ID,
        ownerItemType: "inbox-suppression",
        ownerPk: `ORG#${ORGANIZATION_ID}#ENV#${ENVIRONMENT_ID}`,
        ownerSk: `INBOX-SUPPRESSION#${USAGE_ID}`,
        ownerTable: "control",
        value: `${ENVIRONMENT_ID}:${USAGE_ID}`,
      },
      NOW,
    ) as Extract<PlatformRecord, { readonly itemType: "unique-claim" }>;
    const { queries, service } = database({ queryResult: { items: [siblingClaim] } });
    const repository = makeAgentEmailDynamoRepository(
      service,
      {
        environmentId: ENVIRONMENT_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
      },
      testEndUserKeys,
    );

    expect(
      repository.hasOtherActiveOrganizationSuppression("Recipient@Example.com", ATTACHMENT_ID),
    ).resolves.toBe(true);
    expect(queries).toEqual([
      expect.objectContaining({
        ConsistentRead: true,
        ExpressionAttributeValues: {
          ":pk": siblingClaim.pk,
          ":sk": "VALUE#",
        },
      }),
    ]);
  });

  it("creates an inbox, global address claim, and semantic event atomically", async () => {
    const { service, transactions } = database();
    const repository = makeAgentEmailDynamoRepository(
      service,
      {
        environmentId: ENVIRONMENT_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
      },
      testEndUserKeys,
    );
    await repository.createInbox(inbox(), inboxCreatedEvent());

    expect(transactions).toHaveLength(1);
    expect(
      transactions[0]?.flatMap((operation) =>
        operation.kind === "condition-check" ? [] : [operation.record.itemType],
      ),
    ).toEqual(["inbox", "inbox-control-created-index", "unique-claim", "semantic-event"]);
    const semanticEvent = transactions[0]?.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "semantic-event",
    );
    expect(
      semanticEvent?.kind === "put" && semanticEvent.record.itemType === "semantic-event"
        ? semanticEvent.record.data.aggregateVersion
        : undefined,
    ).toBe(1);
    await expectCanonical(transactions[0] ?? []);
  });

  it("returns the committed inbox when the same create event is retried", async () => {
    const { service, transactions } = database();
    const repository = makeAgentEmailDynamoRepository(
      service,
      {
        environmentId: ENVIRONMENT_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
      },
      testEndUserKeys,
    );
    const first = await repository.createInbox(inbox(), inboxCreatedEvent());
    const retry = await repository.createInbox(
      { ...inbox(), name: "Changed retry input" },
      inboxCreatedEvent(),
    );

    expect(retry).toEqual(first);
    expect(transactions).toHaveLength(1);
  });

  it("persists a message, thread, attachment, usage, and event in one transaction", async () => {
    const { service, transactions } = database();
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
      attachments: [
        {
          bucket: "agent-email",
          byteSize: 4,
          contentType: "text/plain",
          disposition: "attachment",
          fileName: "note.txt",
          id: ATTACHMENT_ID,
          key: `attachments/${MESSAGE_ID}/note.txt`,
          sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        },
      ],
      event: event("agent-email.received", MESSAGE_ID),
      message: {
        ...message(),
        internetMessageId: " <message@example.com> ",
      },
      thread: thread(),
      usage: [
        {
          createdAt: NOW,
          id: USAGE_ID,
          inboxId: INBOX_ID,
          kind: "inbound_message",
          messageId: MESSAGE_ID,
          organizationId: ORGANIZATION_ID,
          quantity: 1,
        },
      ],
    });

    expect(
      transactions.map((operations) =>
        operations.map((operation) =>
          operation.kind === "condition-check" ? "condition-check" : operation.record.itemType,
        ),
      ),
    ).toEqual([
      ["end-user-inbox-mail"],
      ["end-user-inbox-mail"],
      [
        "inbox-message",
        "inbox-message-created-index",
        "inbox-resource-locator",
        "inbox-message-thread-index",
        "inbox-message-thread-alias",
        "inbox-thread",
        "inbox-thread-created-index",
        "inbox-attachment",
        "meter-event",
        "semantic-event",
      ],
    ]);
    expect(
      transactions
        .at(-1)
        ?.flatMap((operation) =>
          operation.kind === "condition-check" ? [] : [operation.record.itemType],
        ),
    ).toEqual([
      "inbox-message",
      "inbox-message-created-index",
      "inbox-resource-locator",
      "inbox-message-thread-index",
      "inbox-message-thread-alias",
      "inbox-thread",
      "inbox-thread-created-index",
      "inbox-attachment",
      "meter-event",
      "semantic-event",
    ]);
    const persistedMessage = transactions
      .at(-1)
      ?.find(
        (operation) => operation.kind === "put" && operation.record.itemType === "inbox-message",
      );
    expect(
      persistedMessage?.kind === "put" && persistedMessage.record.itemType === "inbox-message"
        ? persistedMessage.record.data.threadId
        : undefined,
    ).toBe(THREAD_ID);
    const threadAlias = transactions
      .at(-1)
      ?.find(
        (operation) =>
          operation.kind === "put" && operation.record.itemType === "inbox-message-thread-alias",
      );
    expect(threadAlias).toMatchObject({
      conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      record: {
        data: {
          inboxId: INBOX_ID,
          internetMessageId: "<message@example.com>",
          messageId: MESSAGE_ID,
          threadId: THREAD_ID,
        },
      },
    });
    await expectCanonical(transactions.at(-1) ?? []);
  });

  it("keeps the maximum supported message below the expanded DynamoDB transaction limit", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const approvedDraft: AgentEmailDraftRecord = {
      approvedAt: NOW,
      bccAddresses: [],
      ccAddresses: [],
      createdAt: NOW,
      id: testUlid(1),
      inboxId: INBOX_ID,
      metadata: {},
      organizationId: ORGANIZATION_ID,
      status: "approved",
      subject: "Hello",
      textBody: "Draft body",
      toAddresses: ["recipient@example.com"],
      updatedAt: NOW,
    };
    const previousDraft = inboxDraftRecord(scope, approvedDraft, []);
    const previousEvent = makeSemanticEventRecord({
      aggregateId: MESSAGE_ID,
      aggregateType: "agent_email",
      aggregateVersion: 1,
      environmentId: ENVIRONMENT_ID,
      eventId: testUlid(300),
      eventType: "agent-email.received",
      occurredAt: NOW,
      organizationId: ORGANIZATION_ID,
      payload: {},
      projectId: PROJECT_ID,
    });
    const { service, transactions } = database({ records: [previousEvent] });
    const repository = makeAgentEmailDynamoRepository(service, scope, testEndUserKeys);

    await repository.persistMessage({
      attachments: Array.from({ length: 35 }, (_, index) => ({
        bucket: "agent-email",
        byteSize: 4,
        contentType: "text/plain",
        disposition: "attachment" as const,
        fileName: `attachment-${index}.txt`,
        id: testUlid(100 + index),
        key: `attachments/${MESSAGE_ID}/${index}`,
        sha256: createHash("sha256").update(String(index)).digest("hex"),
      })),
      dailyQuota: {
        expiresAt: "2026-07-21T00:00:00.000Z",
        limit: 100,
        observedUsage: 0,
        window: "2026-07-20",
      },
      draftTransition: {
        next: { ...approvedDraft, sentMessageId: MESSAGE_ID, status: "sent" },
        previous: previousDraft,
      },
      event: event("agent-email.received", MESSAGE_ID),
      message: { ...message(), internetMessageId: "<maximum@example.com>" },
      thread: thread(),
      usage: ["inbound_message", "attachment_bytes", "stored_bytes"].map((kind, index) => ({
        createdAt: NOW,
        id: testUlid(200 + index),
        inboxId: INBOX_ID,
        kind: kind as "attachment_bytes" | "inbound_message" | "stored_bytes",
        messageId: MESSAGE_ID,
        organizationId: ORGANIZATION_ID,
        quantity: 1,
      })),
    });

    const expanded = await prepareDynamoTransactionOperations(transactions.at(-1) ?? []);
    expect(expanded).toHaveLength(99);
    expect(expanded.length).toBeLessThanOrEqual(100);
  });

  it("reuses an existing RFC Message-ID alias assigned to the same thread", async () => {
    const bindingScope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const alias = inboxMessageThreadAliasRecord(bindingScope, {
      createdAt: NOW,
      id: MESSAGE_ID,
      inboxId: INBOX_ID,
      internetMessageId: "<message@example.com>",
      threadId: THREAD_ID,
    });
    const { service, transactions } = database({ records: [alias] });
    const repository = makeAgentEmailDynamoRepository(service, bindingScope, testEndUserKeys);

    await repository.persistMessage({
      event: event("agent-email.received", SECOND_INBOX_ID),
      message: {
        ...message(),
        id: SECOND_INBOX_ID,
        internetMessageId: "<message@example.com>",
        threadId: THREAD_ID,
      },
      usage: [],
    });

    expect(transactions).toHaveLength(3);
    expect(
      transactions
        .at(-1)
        ?.some(
          (operation) =>
            operation.kind === "put" && operation.record.itemType === "inbox-message-thread-alias",
        ),
    ).toBe(false);
  });

  it("returns an already committed message without rebuilding its tokenized transaction", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const existing = inboxMessageRecord(
      scope,
      {
        ...message(),
        threadId: THREAD_ID,
      },
      [],
    );
    const { service, transactions } = database({ records: [existing] });
    const repository = makeAgentEmailDynamoRepository(service, scope, testEndUserKeys);

    const result = await repository.persistMessage({
      event: event("agent-email.received", MESSAGE_ID),
      message: message(),
      thread: thread(),
      usage: [],
    });

    expect(result).toEqual(existing);
    expect(transactions).toHaveLength(0);
  });
});
