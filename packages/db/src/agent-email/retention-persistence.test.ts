import type { AgentEmailDomainEvent, AgentEmailMessageRecord } from "@deployments-ai/agent-email";
import {
  DatabaseError,
  type DynamoDatabaseService,
  type PlatformRecord,
  type QueryRecordsResult,
  type RecordKey,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { describe, expect, it } from "bun:test";

import { makeAgentEmailDynamoRepository, purgeExpiredAgentEmailRawObjects } from "./persistence.ts";
import { inboxMessageRecord } from "./record-mapping.ts";
import { makeSemanticEventRecord } from "../semantic-event-storage.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;
const INBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid;
const SECOND_INBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB7" as Ulid;
const MESSAGE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0" as Ulid;
const SECOND_MESSAGE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB8" as Ulid;
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

describe("agent email DynamoDB retention", () => {
  it("purges expired raw objects and removes the sparse retention index", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const expired = inboxMessageRecord(
      scope,
      {
        ...message(),
        rawRetentionExpiresAt: "2026-07-19T00:00:00.000Z",
      },
      [],
      {
        rawReference: {
          bucket: "agent-email",
          byteSize: 100,
          contentType: "message/rfc822",
          key: `raw/${MESSAGE_ID}`,
          sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
          versionId: "raw-version-1",
        },
      },
    );
    expect(expired.gsi1pk).toBe(
      `INBOX-RAW-RETENTION#${ORGANIZATION_ID}#${PROJECT_ID}#${ENVIRONMENT_ID}`,
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
      queryResults: [{ items: [expired] }, { items: [receivedEvent] }],
      records: [expired, receivedEvent],
    });
    const repository = makeAgentEmailDynamoRepository(service, scope);
    const deleted: {
      readonly bucket?: string;
      readonly key: string;
      readonly versionId?: string;
    }[] = [];

    const result = await purgeExpiredAgentEmailRawObjects(
      repository,
      {
        delete: async (key, bucket, versionId) => {
          deleted.push({
            ...(bucket ? { bucket } : {}),
            key,
            ...(versionId ? { versionId } : {}),
          });
        },
        get: async () => new Uint8Array(),
        put: async () => {},
        signedGetUrl: async () => "https://example.invalid",
      },
      {
        createEventId: () => EVENT_ID,
        now: new Date("2026-07-20T00:00:00.000Z"),
      },
    );

    expect(result).toEqual({ purged: 1 });
    expect(deleted).toEqual([
      { bucket: "agent-email", key: `raw/${MESSAGE_ID}`, versionId: "raw-version-1" },
    ]);
    const claimed = transactions[0]?.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "inbox-message",
    );
    expect(
      claimed?.kind === "put" && claimed.record.itemType === "inbox-message"
        ? {
            rawPurgeClaimedAt: claimed.record.data.rawPurgeClaimedAt,
            rawPurgeClaimKey: claimed.record.data.rawPurgeClaimKey,
          }
        : undefined,
    ).toEqual({
      rawPurgeClaimedAt: "2026-07-20T00:00:00.000Z",
      rawPurgeClaimKey: `raw/${MESSAGE_ID}`,
    });
    const updated = transactions
      .at(-1)
      ?.find(
        (operation) => operation.kind === "put" && operation.record.itemType === "inbox-message",
      );
    expect(
      updated?.kind === "put" && updated.record.itemType === "inbox-message"
        ? {
            gsi1pk: updated.record.gsi1pk,
            rawPurgedAt: updated.record.data.rawPurgedAt,
            rawReference: updated.record.data.rawReference,
          }
        : undefined,
    ).toEqual({
      gsi1pk: undefined,
      rawPurgedAt: "2026-07-20T00:00:00.000Z",
      rawReference: undefined,
    });
    const rawPurgedEvent = transactions
      .at(-1)
      ?.find(
        (operation) =>
          operation.kind === "put" &&
          operation.record.itemType === "semantic-event" &&
          operation.record.data.eventType === "agent-email.raw-purged",
      );
    expect(
      rawPurgedEvent?.kind === "put" && rawPurgedEvent.record.itemType === "semantic-event"
        ? rawPurgedEvent.record.data.aggregateVersion
        : undefined,
    ).toBe(2);
  });

  it("purges message-scoped routed objects without scanning every live raw reference", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const rawReference = {
      bucket: "agent-email",
      byteSize: 100,
      contentType: "message/rfc822",
      key: `raw/${MESSAGE_ID}`,
      sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    };
    const expired = inboxMessageRecord(
      scope,
      { ...message(), rawRetentionExpiresAt: "2026-07-19T00:00:00.000Z" },
      [],
      { rawReference },
    );
    const retained = inboxMessageRecord(
      scope,
      {
        ...message(),
        id: SECOND_MESSAGE_ID,
        inboxId: SECOND_INBOX_ID,
        rawRetentionExpiresAt: "2026-08-19T00:00:00.000Z",
      },
      [],
      { rawReference: { ...rawReference, key: `raw/${SECOND_MESSAGE_ID}` } },
    );
    const { queries, service } = database({
      queryResult: { items: [expired, retained] },
      records: [expired, retained],
    });
    const deleted: string[] = [];

    expect(
      purgeExpiredAgentEmailRawObjects(
        makeAgentEmailDynamoRepository(service, scope),
        {
          delete: async (key) => {
            deleted.push(key);
          },
          get: async () => new Uint8Array(),
          put: async () => {},
          signedGetUrl: async () => "https://example.invalid",
        },
        { createEventId: () => EVENT_ID, now: new Date(NOW) },
      ),
    ).resolves.toEqual({ purged: 1 });
    expect(deleted).toEqual([`raw/${MESSAGE_ID}`]);
    expect(
      queries.some((query) =>
        (query.ExpressionAttributeValues as { readonly ":sk"?: string } | undefined)?.[
          ":sk"
        ]?.startsWith("9999-12-31"),
      ),
    ).toBe(false);
  });

  it("treats raw purge finalization as complete when another worker already finalized it", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const purged = inboxMessageRecord(
      scope,
      {
        ...message(),
        rawPurgedAt: NOW,
        rawRetentionExpiresAt: "2026-07-19T00:00:00.000Z",
      },
      [],
    );
    const { service, transactions } = database({ records: [purged] });
    const repository = makeAgentEmailDynamoRepository(service, scope);

    const result = await repository.finalizeRawPurge(
      INBOX_ID,
      MESSAGE_ID,
      NOW,
      "stale-fingerprint",
      `raw/${MESSAGE_ID}`,
      NOW,
      event("agent-email.received", MESSAGE_ID),
    );

    expect(result).toEqual(purged);
    expect(transactions).toHaveLength(0);
  });

  it("recovers when another worker wins the raw purge finalization transaction", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const expired = inboxMessageRecord(
      scope,
      { ...message(), rawRetentionExpiresAt: "2026-07-19T00:00:00.000Z" },
      [],
      {
        rawReference: {
          bucket: "agent-email",
          byteSize: 100,
          contentType: "message/rfc822",
          key: `raw/${MESSAGE_ID}`,
          sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        },
      },
    );
    const base = database({ records: [expired] });
    const firstRepository = makeAgentEmailDynamoRepository(base.service, scope);
    const claimed = await firstRepository.claimRawPurge(expired, NOW);
    expect(claimed).toBeDefined();
    const purged = inboxMessageRecord(
      scope,
      {
        ...message(),
        rawPurgedAt: NOW,
        rawRetentionExpiresAt: "2026-07-19T00:00:00.000Z",
      },
      [],
    );
    let reads = 0;
    const racingService: DynamoDatabaseService = {
      ...base.service,
      getRecord: () => Promise.resolve((reads++ === 0 ? claimed! : purged) as PlatformRecord),
      transactWrite: () =>
        Promise.reject(
          new DatabaseError({
            cause: "conditional transaction lost",
            message: "Concurrent raw purge finalization won the transaction.",
            operation: "transact-write",
            table: "multiple",
          }),
        ),
    };
    const repository = makeAgentEmailDynamoRepository(racingService, scope);

    const result = await repository.finalizeRawPurge(
      INBOX_ID,
      MESSAGE_ID,
      claimed!.data.rawPurgeClaimedAt!,
      claimed!.data.rawPurgeClaimFingerprint!,
      claimed!.data.rawPurgeClaimKey!,
      NOW,
      event("agent-email.received", MESSAGE_ID),
    );

    expect(result).toEqual(purged);
    expect(reads).toBe(2);
  });

  it("stops expired-raw pagination once the requested batch is full", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const expired = inboxMessageRecord(
      scope,
      { ...message(), rawRetentionExpiresAt: "2026-07-19T00:00:00.000Z" },
      [],
      {
        rawReference: {
          bucket: "agent-email",
          byteSize: 100,
          contentType: "message/rfc822",
          key: `raw/${MESSAGE_ID}`,
          sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        },
      },
    );
    const { queries, service } = database({
      queryResults: [
        { items: [expired], lastEvaluatedKey: { gsi1pk: "next", gsi1sk: "next" } },
        { items: [expired] },
      ],
    });
    const repository = makeAgentEmailDynamoRepository(service, scope);

    expect(await repository.listExpiredRawMessages("2026-07-20T00:00:00.000Z", 1)).toEqual([
      expired,
    ]);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.Limit).toBe(1);
  });

  it("treats a stale retention-index row for an already purged message as a skip", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const stale = inboxMessageRecord(
      scope,
      { ...message(), rawRetentionExpiresAt: "2026-07-19T00:00:00.000Z" },
      [],
      {
        rawReference: {
          bucket: "agent-email",
          byteSize: 100,
          contentType: "message/rfc822",
          key: `raw/${MESSAGE_ID}`,
          sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        },
      },
    );
    const current = inboxMessageRecord(
      scope,
      {
        ...message(),
        rawPurgedAt: "2026-07-20T00:00:00.000Z",
        rawRetentionExpiresAt: "2026-07-19T00:00:00.000Z",
      },
      [],
    );
    const { service, transactions } = database({
      queryResult: { items: [stale] },
      records: [current],
    });
    const repository = makeAgentEmailDynamoRepository(service, scope);
    const deleted: string[] = [];

    expect(
      purgeExpiredAgentEmailRawObjects(
        repository,
        {
          delete: async (key) => {
            deleted.push(key);
          },
          get: async () => new Uint8Array(),
          put: async () => {},
          signedGetUrl: async () => "https://example.invalid",
        },
        { createEventId: () => EVENT_ID, now: new Date("2026-07-20T00:00:00.000Z") },
      ),
    ).resolves.toEqual({ purged: 0 });
    expect(deleted).toEqual([]);
    expect(transactions).toHaveLength(0);
  });

  it("rejects raw-reference replacement while a retention purge is claimed", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const expired = inboxMessageRecord(
      scope,
      { ...message(), rawRetentionExpiresAt: "2026-07-19T00:00:00.000Z" },
      [],
      {
        rawReference: {
          bucket: "agent-email",
          byteSize: 100,
          contentType: "message/rfc822",
          key: `raw/${MESSAGE_ID}`,
          sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        },
      },
    );
    const { service } = database({ records: [expired] });
    const repository = makeAgentEmailDynamoRepository(service, scope);
    const claimed = await repository.claimRawPurge(expired, "2026-07-20T00:00:00.000Z");
    expect(claimed).toBeDefined();

    expect(
      repository.updateMessage(
        claimed!,
        { ...message(), threadId: THREAD_ID },
        event("agent-email.received", MESSAGE_ID),
        {
          rawReference: {
            bucket: "agent-email",
            byteSize: 200,
            contentType: "message/rfc822",
            key: `raw/${MESSAGE_ID}`,
            sha256: "60303ae22b9988617223d7b81264ff2647f34b4521603d72e5b5ebf00c7a77a5",
          },
        },
      ),
    ).rejects.toThrow("Raw references cannot change while a retention purge is claimed.");

    expect(
      repository.updateMessage(
        claimed!,
        {
          ...message(),
          rawRetentionExpiresAt: "2026-08-20T00:00:00.000Z",
          threadId: THREAD_ID,
        },
        event("agent-email.received", MESSAGE_ID),
      ),
    ).rejects.toThrow("Raw retention cannot change while a retention purge is claimed.");
  });
});
