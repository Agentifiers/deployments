import type {
  AgentEmailDomainEvent,
  AgentEmailInboxBindingRecord,
  AgentEmailInboxRecord,
  AgentEmailMessageRecord,
  AgentEmailPlacementRecord,
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
  inboxBindingRecord,
  inboxMessageRecord,
  inboxPlacementRecord,
  inboxPolicyRecord,
  inboxRecord,
} from "./record-mapping.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;
const INBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid;
const DOMAIN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ" as Ulid;
const MESSAGE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0" as Ulid;
const THREAD_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB1" as Ulid;
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB2" as Ulid;

const OTHER_PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB5" as Ulid;
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

function binding(status: AgentEmailInboxBindingRecord["status"]): AgentEmailInboxBindingRecord {
  return {
    bindingType: "external",
    createdAt: NOW,
    externalId: "disabled-target",
    id: DRAFT_ID,
    inboxId: INBOX_ID,
    metadata: {},
    organizationId: ORGANIZATION_ID,
    status,
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

function placement(isDefault: boolean): AgentEmailPlacementRecord {
  return {
    createdAt: NOW,
    dedicatedPool: false,
    id: MESSAGE_ID,
    isDefault,
    name: "Primary",
    organizationId: ORGANIZATION_ID,
    provider: "ses",
    providerMetadata: {},
    region: "us-east-1",
    status: "active",
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
  it("archives a disabled binding without deleting a released uniqueness claim", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const previous = inboxBindingRecord(scope, binding("disabled"));
    const { service, transactions } = database({ records: [previous] });
    const repository = makeAgentEmailDynamoRepository(service, scope);

    expect(repository.archiveBinding(DRAFT_ID, NOW)).resolves.toMatchObject({
      data: { status: "archived" },
    });
    expect(
      transactions[0]?.flatMap((operation) =>
        operation.kind === "put" ? [operation.record.itemType] : [],
      ),
    ).toEqual(["inbox-binding"]);
  });

  it("uses the environment-scoped claim when promoting a default placement", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const previous = inboxPlacementRecord(scope, placement(false));
    const { service, transactions } = database({ records: [previous] });
    const repository = makeAgentEmailDynamoRepository(service, scope);

    await repository.updatePlacement(placement(true));

    const claim = transactions[0]?.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "unique-claim",
    );
    expect(
      claim?.kind === "put" && claim.record.itemType === "unique-claim"
        ? claim.record.data.namespace
        : undefined,
    ).toBe(
      `organization:${ORGANIZATION_ID}:project:${PROJECT_ID}:environment:${ENVIRONMENT_ID}:default-inbox-placement`,
    );
  });

  it("filters sibling project records from scoped reads", async () => {
    const scopedRecord = inboxRecord(
      {
        environmentId: ENVIRONMENT_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
      },
      inbox(),
    );
    const siblingRecord = inboxRecord(
      {
        environmentId: ENVIRONMENT_ID,
        organizationId: ORGANIZATION_ID,
        projectId: OTHER_PROJECT_ID,
      },
      inbox(),
    );
    const { service } = database({
      queryResult: { items: [scopedRecord, siblingRecord] },
      records: [siblingRecord],
    });
    const repository = makeAgentEmailDynamoRepository(service, {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    });

    expect(await repository.listInboxes()).toEqual([scopedRecord]);
    expect(await repository.getInbox(INBOX_ID)).toBeUndefined();
  });

  it("preserves inbox placement during ordinary updates", async () => {
    const placementId = "01ARZ3NDEKTSV4RRFFQ69G5FB9" as Ulid;
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const previous = inboxRecord(scope, inbox(), placementId);
    const { service, transactions } = database({ records: [previous] });
    const repository = makeAgentEmailDynamoRepository(service, scope);

    await repository.updateInbox(
      { ...inbox(), name: "Updated inbox" },
      { ...inboxCreatedEvent(), eventType: "agent-email.inbox-updated" },
    );

    const inboxPut = transactions[0]?.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "inbox",
    );
    expect(
      inboxPut?.kind === "put" && inboxPut.record.itemType === "inbox"
        ? inboxPut.record.data.placementId
        : undefined,
    ).toBe(placementId);
  });

  it("returns the current inbox when the same update event is retried", async () => {
    const placementId = "01ARZ3NDEKTSV4RRFFQ69G5FB9" as Ulid;
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const previous = inboxRecord(scope, inbox(), placementId);
    const { service, transactions } = database({ records: [previous] });
    const repository = makeAgentEmailDynamoRepository(service, scope);
    const updateEvent = {
      ...inboxCreatedEvent(),
      eventType: "agent-email.inbox-updated" as const,
    };
    const updatedInbox = { ...inbox(), name: "Updated inbox" };

    const first = await repository.updateInbox(updatedInbox, updateEvent);
    const retry = await repository.updateInbox(updatedInbox, updateEvent);

    expect(retry).toEqual(first);
    expect(transactions).toHaveLength(1);
  });

  it("returns the committed message when an update is retried with a stale record", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const previous = inboxMessageRecord(scope, message(), []);
    const { service, transactions } = database({ records: [previous] });
    const repository = makeAgentEmailDynamoRepository(service, scope);
    const updateEvent = event("agent-email.received", MESSAGE_ID);
    const first = await repository.updateMessage(
      previous,
      { ...message(), subject: "Committed subject" },
      updateEvent,
    );
    const retry = await repository.updateMessage(
      previous,
      { ...message(), subject: "Different retry input" },
      updateEvent,
    );

    expect(retry).toEqual(first);
    expect(transactions).toHaveLength(1);
  });

  it("includes caller prerequisites in the message update transaction", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const previous = inboxMessageRecord(scope, message(), []);
    const { service, transactions } = database({ records: [previous] });
    const repository = makeAgentEmailDynamoRepository(service, scope);
    const prerequisite = {
      conditionExpression: "#data.#version = :version",
      expressionAttributeNames: { "#data": "data", "#version": "version" },
      expressionAttributeValues: { ":version": 3 },
      key: { pk: "policy-pk", sk: "policy-sk" },
      kind: "condition-check" as const,
      table: "control" as const,
    };

    await repository.updateMessage(
      previous,
      { ...message(), subject: "Updated subject" },
      event("agent-email.received", MESSAGE_ID),
      undefined,
      undefined,
      undefined,
      [prerequisite],
    );

    expect(transactions[0]).toContainEqual(prerequisite);
  });

  it("stores an inbox-scoped alias when SES reports an outbound Internet Message-ID", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const outbound = {
      ...message(),
      direction: "outbound" as const,
      fromAddress: "agent@agents.example.com",
      status: "accepted" as const,
      threadId: THREAD_ID,
      toAddresses: ["recipient@example.com"],
    };
    const previous = inboxMessageRecord(scope, outbound, []);
    const { service, transactions } = database({ records: [previous] });
    const repository = makeAgentEmailDynamoRepository(service, scope);

    await repository.updateMessage(
      previous,
      {
        ...outbound,
        deliveredAt: NOW,
        internetMessageId: "<outbound@example.com>",
        status: "delivered",
      },
      event("agent-email.delivered", MESSAGE_ID),
    );

    const aliasPut = transactions[0]?.find(
      (operation) =>
        operation.kind === "put" && operation.record.itemType === "inbox-message-thread-alias",
    );
    expect(
      aliasPut?.kind === "put" && aliasPut.record.itemType === "inbox-message-thread-alias"
        ? aliasPut.record.data
        : undefined,
    ).toMatchObject({
      inboxId: INBOX_ID,
      internetMessageId: "<outbound@example.com>",
      messageId: MESSAGE_ID,
      threadId: THREAD_ID,
    });
  });

  it("counts direct bounces and atomically pauses a policy at its threshold", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const outbound = {
      ...message(),
      direction: "outbound" as const,
      fromAddress: "agent@agents.example.com",
      status: "queued" as const,
      threadId: THREAD_ID,
      toAddresses: ["recipient@example.com"],
    };
    const previous = inboxMessageRecord(scope, outbound, []);
    const persistedPolicy = inboxPolicyRecord(scope, policy());
    const { service, transactions } = database({
      records: [previous, persistedPolicy],
    });
    const repository = makeAgentEmailDynamoRepository(service, scope);

    await repository.updateMessage(
      previous,
      { ...outbound, status: "bounced", updatedAt: "2026-07-20T01:00:00.000Z" },
      event("agent-email.bounced", MESSAGE_ID),
    );

    const policyPut = transactions[0]?.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "inbox-policy",
    );
    expect(
      policyPut?.kind === "put" && policyPut.record.itemType === "inbox-policy"
        ? policyPut.record.data
        : undefined,
    ).toMatchObject({
      bounceMessageCount: 1,
      complaintMessageCount: 0,
      outboundOutcomeMessageCount: 1,
      sendingStatus: "paused",
      sendingStatusReason:
        "Outbound sending paused after the configured bounce-rate threshold was reached.",
    });
    expect(policyPut?.kind === "put" ? policyPut.previousRecord : undefined).toEqual(
      persistedPolicy,
    );
  });

  it("clears inbox placement when explicitly detached", async () => {
    const placementId = "01ARZ3NDEKTSV4RRFFQ69G5FB9" as Ulid;
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const previous = inboxRecord(scope, inbox(), placementId);
    const { service, transactions } = database({ records: [previous] });
    const repository = makeAgentEmailDynamoRepository(service, scope);

    await repository.updateInbox(
      { ...inbox(), name: "Default placement" },
      { ...inboxCreatedEvent(), eventType: "agent-email.inbox-updated" },
      null,
    );

    const inboxPut = transactions[0]?.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "inbox",
    );
    expect(
      inboxPut?.kind === "put" && inboxPut.record.itemType === "inbox"
        ? inboxPut.record.data.placementId
        : undefined,
    ).toBeUndefined();
  });
});
