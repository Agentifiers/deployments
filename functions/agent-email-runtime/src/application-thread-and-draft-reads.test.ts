import { testEndUserKeys } from "@deployments-ai/db/erasure-testing";
import {
  type AgentEmailDomainRecord,
  type AgentEmailDraftRecord,
  type AgentEmailInboxRecord,
  type AgentEmailMessageRecord,
  type AgentEmailPlacementRecord,
  type AgentEmailPolicyRecord,
} from "@deployments-ai/agent-email";
import {
  inboxDomainRecord,
  inboxDraftCreatedIndexRecord,
  inboxDraftRecord,
  inboxMessageRecord,
  inboxMessageThreadIndexRecord,
  inboxPlacementRecord,
  inboxPolicyRecord,
  inboxRecord,
  inboxResourceLocatorRecord,
  inboxThreadCreatedIndexRecord,
  inboxThreadRecord,
  type DynamoDatabaseService,
  type PlatformRecord,
  type RecordKey,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { describe, expect, it } from "bun:test";
import type { AgentEmailApiInvocation } from "./api-handler.ts";
import { createDynamoAgentEmailApplicationService } from "./application-service.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const DOMAIN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const INBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const BINDING_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const SECOND_BINDING_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB9";
const POLICY_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
const MESSAGE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB4";
const THREAD_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB5";
const USAGE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB6";
const STORED_USAGE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB7";
const DRAFT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FBB";
const NOW = "2026-07-25T12:00:00.000Z";

const scope = {
  environmentId: ENVIRONMENT_ID as Ulid,
  organizationId: ORGANIZATION_ID as Ulid,
  projectId: PROJECT_ID as Ulid,
};

function domain(overrides: Partial<AgentEmailDomainRecord> = {}): AgentEmailDomainRecord {
  return {
    createdAt: NOW,
    dnsRecords: [],
    domain: "agents.example.com",
    id: DOMAIN_ID,
    mailFromDomain: "bounce.agents.example.com",
    organizationId: ORGANIZATION_ID,
    providerManaged: false,
    providerMetadata: {},
    status: "verified",
    updatedAt: NOW,
    verifiedAt: NOW,
    ...overrides,
  };
}

function inbox(): AgentEmailInboxRecord {
  return {
    address: "agent@agents.example.com",
    createdAt: NOW,
    domainId: DOMAIN_ID,
    id: INBOX_ID,
    localPart: "agent",
    metadata: {},
    organizationId: ORGANIZATION_ID,
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
    id: POLICY_ID,
    maxAttachmentBytes: 4 * 1024 * 1024,
    maxRecipientsPerMessage: 47,
    organizationId: ORGANIZATION_ID,
    rawRetentionDays: 30,
    sendingStatus: "active",
    updatedAt: NOW,
    warmupStage: "sandbox",
    warmupStartedAt: NOW,
    ...overrides,
  };
}

function message(id: string, textBody: string): AgentEmailMessageRecord {
  return {
    attachments: [],
    bccAddresses: [],
    ccAddresses: [],
    createdAt: NOW,
    direction: "inbound",
    fromAddress: "sender@example.com",
    id,
    inboxId: INBOX_ID,
    organizationId: ORGANIZATION_ID,
    receivedAt: NOW,
    references: [],
    replyToAddresses: [],
    reprocessCount: 0,
    status: "received",
    subject: "Received",
    textBody,
    threadKey: id,
    toAddresses: ["agent@agents.example.com"],
    updatedAt: NOW,
  };
}

function draft(): AgentEmailDraftRecord {
  return {
    bccAddresses: [],
    ccAddresses: [],
    createdAt: NOW,
    id: DRAFT_ID,
    inboxId: INBOX_ID,
    metadata: {},
    organizationId: ORGANIZATION_ID,
    status: "draft",
    subject: "Draft",
    textBody: "Draft body",
    toAddresses: ["recipient@example.com"],
    updatedAt: NOW,
  };
}

function placement(overrides: Partial<AgentEmailPlacementRecord> = {}): AgentEmailPlacementRecord {
  return {
    createdAt: NOW,
    dedicatedPool: false,
    id: MESSAGE_ID,
    isDefault: false,
    name: "Primary",
    organizationId: ORGANIZATION_ID,
    provider: "ses",
    providerMetadata: { configurationSetName: "agent-email-primary" },
    region: "us-east-1",
    status: "active",
    updatedAt: NOW,
    ...overrides,
  };
}

function database(initial: readonly PlatformRecord[] = []) {
  const effectiveInitial =
    initial.some((record) => record.itemType === "inbox-policy") &&
    !initial.some((record) => record.itemType === "inbox-placement")
      ? [...initial, inboxPlacementRecord(scope, placement({ isDefault: true }))]
      : initial;
  const locatorRecords = effectiveInitial.flatMap((record) => {
    if (record.itemType === "inbox-message") {
      return [
        inboxResourceLocatorRecord(scope, {
          createdAt: record.data.createdAt,
          id: record.data.id,
          inboxId: record.data.inboxId,
          resourceType: "message",
        }),
      ];
    }
    if (record.itemType === "inbox-draft") {
      return [
        inboxResourceLocatorRecord(scope, {
          createdAt: record.data.createdAt,
          id: record.data.id,
          inboxId: record.data.inboxId,
          resourceType: "draft",
        }),
      ];
    }
    return [];
  });
  const records = [...effectiveInitial, ...locatorRecords];
  const gets: RecordKey[] = [];
  const queries: Record<string, unknown>[] = [];
  const transactions: TransactionOperation[][] = [];
  const service: DynamoDatabaseService = {
    deleteRecord: async (selected) => {
      const index = records.findIndex(
        (record) => record.pk === selected.pk && record.sk === selected.sk,
      );
      if (index >= 0) records.splice(index, 1);
    },
    getRecord: async (_table, key: RecordKey) => {
      gets.push(key);
      const found = records.find((record) => record.pk === key.pk && record.sk === key.sk);
      return found;
    },
    putRecord: async (record) => {
      const index = records.findIndex(
        (candidate) => candidate.pk === record.pk && candidate.sk === record.sk,
      );
      if (index >= 0) records[index] = record;
      else records.push(record);
    },
    queryRecords: async (_table, query) => {
      queries.push(query);
      const values = query.ExpressionAttributeValues as
        | { readonly ":pk"?: string; readonly ":sk"?: string }
        | undefined;
      const index =
        query.IndexName === "gsi1" ? "gsi1" : query.IndexName === "gsi2" ? "gsi2" : "base";
      const partitionField: "gsi1pk" | "gsi2pk" | "pk" =
        index === "gsi1" ? "gsi1pk" : index === "gsi2" ? "gsi2pk" : "pk";
      const sortField: "gsi1sk" | "gsi2sk" | "sk" =
        index === "gsi1" ? "gsi1sk" : index === "gsi2" ? "gsi2sk" : "sk";
      let items = records
        .filter(
          (record) =>
            record[partitionField] === values?.[":pk"] &&
            record[sortField]?.startsWith(values?.[":sk"] ?? ""),
        )
        .toSorted((left, right) => String(left[sortField]).localeCompare(String(right[sortField])));
      if (query.ScanIndexForward === false) items = items.toReversed();
      if (query.ExclusiveStartKey) {
        const cursor = query.ExclusiveStartKey[sortField];
        const cursorIndex = items.findIndex((record) => record[sortField] === cursor);
        if (cursorIndex >= 0) items = items.slice(cursorIndex + 1);
      }
      const limit = query.Limit ?? items.length;
      return {
        items: items.slice(0, limit),
        ...(items.length > limit
          ? {
              lastEvaluatedKey: {
                pk: items[limit - 1]!.pk,
                sk: items[limit - 1]!.sk,
              },
            }
          : {}),
      };
    },
    transactWrite: async (operations) => {
      transactions.push([...operations]);
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        const index = records.findIndex(
          (record) => record.pk === operation.record.pk && record.sk === operation.record.sk,
        );
        if (operation.kind === "delete") {
          if (index >= 0) records.splice(index, 1);
        } else if (index >= 0) {
          records[index] = operation.record;
        } else {
          records.push(operation.record);
        }
      }
    },
  };
  return { gets, queries, records, service, transactions };
}

function invocation(
  body: Readonly<Record<string, unknown>> | undefined,
  parameters: Readonly<Record<string, string>> = {},
): AgentEmailApiInvocation {
  return {
    body,
    identity: {
      permissions: ["agent-email:*"],
      principalId: "test-principal",
      scope,
    },
    parameters,
    query: {},
    scope,
  };
}

function ids(values: readonly string[]) {
  let index = 0;
  return () => values[index++] ?? EVENT_ID;
}

describe("Dynamo-backed agent email application service", () => {
  it("bounds thread-search body hydration and resumes within the current thread", async () => {
    const threads = [
      {
        createdAt: "2026-07-25T13:00:00.000Z",
        messageId: BINDING_ID,
        threadId: THREAD_ID,
      },
      {
        createdAt: "2026-07-25T11:00:00.000Z",
        messageId: MESSAGE_ID,
        threadId: SECOND_BINDING_ID,
      },
    ].flatMap(({ createdAt, messageId, threadId }) => {
      const { textBody: _textBody, ...summary } = {
        ...message(messageId, "externalized"),
        createdAt,
        threadId,
        updatedAt: createdAt,
      };
      const thread = {
        createdAt,
        id: threadId,
        inboxId: INBOX_ID,
        lastMessageAt: createdAt,
        messageCount: 1,
        organizationId: ORGANIZATION_ID,
        participants: ["agent@agents.example.com", "sender@example.com"],
        subject: "Received",
        updatedAt: createdAt,
      };
      return [
        inboxThreadRecord(scope, thread, `thread-${threadId}`),
        inboxThreadCreatedIndexRecord(scope, thread),
        inboxMessageRecord(scope, summary, [], {
          textBodyRef: {
            bucket: "agent-email",
            byteSize: 10 * 1024 * 1024,
            contentType: "text/plain",
            key: `bodies/${messageId}/body.txt`,
            sha256: "body-sha",
            versionId: "body-version",
          },
        }),
        inboxMessageThreadIndexRecord(scope, summary),
      ] as const;
    });
    const memory = database([inboxRecord(scope, inbox()), ...threads]);
    const blobGets: string[] = [];
    const service = createDynamoAgentEmailApplicationService({
      blobs: {
        delete: async () => {},
        get: async (key) => {
          blobGets.push(key);
          return new TextEncoder().encode("needle");
        },
        put: async () => {},
        signedGetUrl: async () => "https://example.invalid",
      },
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    const first = (await service.execute(
      "searchInboxThreads",
      invocation({ limit: 2, query: "needle" }, { inboxId: INBOX_ID }),
    )) as {
      readonly items: readonly { readonly id: string }[];
      readonly nextCursor?: string;
    };
    expect(first.items.map((thread) => thread.id)).toEqual([THREAD_ID]);
    expect(first.nextCursor).toBeDefined();
    expect(blobGets).toEqual([`bodies/${BINDING_ID}/body.txt`]);

    const second = (await service.execute(
      "searchInboxThreads",
      invocation({ cursor: first.nextCursor, limit: 2, query: "needle" }, { inboxId: INBOX_ID }),
    )) as {
      readonly items: readonly { readonly id: string }[];
      readonly nextCursor?: string;
    };
    expect(second.items.map((thread) => thread.id)).toEqual([SECOND_BINDING_ID]);
    expect(second.nextCursor).toBeUndefined();
    expect(blobGets).toEqual([`bodies/${BINDING_ID}/body.txt`, `bodies/${MESSAGE_ID}/body.txt`]);
  });

  it("paginates thread detail through the transactional thread-message index", async () => {
    const earlier = {
      ...message(BINDING_ID, "earlier body"),
      createdAt: "2026-07-25T11:00:00.000Z",
      threadId: THREAD_ID,
      updatedAt: "2026-07-25T11:00:00.000Z",
    };
    const later = {
      ...message(MESSAGE_ID, "later body"),
      createdAt: "2026-07-25T13:00:00.000Z",
      threadId: THREAD_ID,
      updatedAt: "2026-07-25T13:00:00.000Z",
    };
    const memory = database([
      inboxRecord(scope, inbox()),
      inboxThreadRecord(
        scope,
        {
          createdAt: earlier.createdAt,
          id: THREAD_ID,
          inboxId: INBOX_ID,
          lastMessageAt: later.createdAt,
          messageCount: 2,
          organizationId: ORGANIZATION_ID,
          participants: ["agent@agents.example.com", "sender@example.com"],
          subject: "Received",
          updatedAt: later.updatedAt,
        },
        "thread-key",
      ),
      inboxMessageRecord(scope, earlier, []),
      inboxMessageThreadIndexRecord(scope, earlier),
      inboxMessageRecord(scope, later, []),
      inboxMessageThreadIndexRecord(scope, later),
    ]);
    const service = createDynamoAgentEmailApplicationService({
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    const result = (await service.execute("getInboxThread", {
      ...invocation(undefined, { inboxId: INBOX_ID, threadId: THREAD_ID }),
      query: { limit: 1 },
    })) as {
      readonly messages: readonly {
        readonly id: string;
        readonly textBody?: string;
      }[];
      readonly nextCursor?: string;
    };

    expect(result.messages).toEqual([expect.objectContaining({ id: MESSAGE_ID })]);
    expect(result.messages[0]).not.toHaveProperty("textBody");
    expect(result.nextCursor).toBeDefined();
    expect(
      memory.queries.find(
        (query) =>
          (query.ExpressionAttributeValues as { readonly ":pk"?: string } | undefined)?.[":pk"] ===
          `ORG#${ORGANIZATION_ID}#THREAD#${THREAD_ID}`,
      ),
    ).toMatchObject({
      ConsistentRead: true,
      Limit: 2,
      ScanIndexForward: false,
    });
  });

  it("lists live drafts past a retained index whose parent was removed", async () => {
    const liveDraft = {
      ...draft(),
      createdAt: "2026-07-25T11:00:00.000Z",
      updatedAt: "2026-07-25T11:00:00.000Z",
    };
    const removedDraft = {
      ...draft(),
      createdAt: "2026-07-25T13:00:00.000Z",
      id: EVENT_ID,
      updatedAt: "2026-07-25T13:00:00.000Z",
    };
    const memory = database([
      inboxRecord(scope, inbox()),
      inboxDraftCreatedIndexRecord(scope, removedDraft),
      inboxDraftRecord(scope, liveDraft, []),
      inboxDraftCreatedIndexRecord(scope, liveDraft),
    ]);
    const service = createDynamoAgentEmailApplicationService({
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute("listInboxDrafts", {
        ...invocation(undefined, { inboxId: INBOX_ID }),
        query: { limit: 1 },
      }),
    ).resolves.toEqual({
      items: [expect.objectContaining({ id: DRAFT_ID })],
    });
  });

  it("lists draft summaries without loading bodies and hydrates draft detail", async () => {
    const { textBody: _textBody, ...draftSummary } = draft();
    const storedDraft = inboxDraftRecord(scope, draftSummary, [], {
      textBodyRef: {
        bucket: "agent-email",
        byteSize: 300 * 1024,
        contentType: "text/plain",
        key: `bodies/${DRAFT_ID}/body.txt`,
        sha256: "body-sha",
        versionId: "body-version",
      },
    });
    const memory = database([
      inboxRecord(scope, inbox()),
      storedDraft,
      inboxDraftCreatedIndexRecord(scope, draftSummary),
    ]);
    const blobGets: string[] = [];
    const service = createDynamoAgentEmailApplicationService({
      blobs: {
        delete: async () => {},
        get: async (key) => {
          blobGets.push(key);
          return new TextEncoder().encode("Externalized draft body");
        },
        put: async () => {},
        signedGetUrl: async () => "https://example.invalid",
      },
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    const listed = (await service.execute(
      "listInboxDrafts",
      invocation(undefined, { inboxId: INBOX_ID }),
    )) as {
      readonly items: readonly {
        readonly htmlBody?: string;
        readonly id: string;
        readonly textBody?: string;
      }[];
    };
    expect(listed.items).toEqual([expect.objectContaining({ id: DRAFT_ID })]);
    expect(listed.items[0]).not.toHaveProperty("htmlBody");
    expect(listed.items[0]).not.toHaveProperty("textBody");
    expect(blobGets).toEqual([]);
    expect(
      service.execute("getDraft", invocation(undefined, { draftId: DRAFT_ID })),
    ).resolves.toMatchObject({ textBody: "Externalized draft body" });
    expect(blobGets).toEqual([`bodies/${DRAFT_ID}/body.txt`]);
  });

  it("hydrates externalized bodies for message detail responses", async () => {
    const { textBody: _textBody, ...messageSummary } = message(MESSAGE_ID, "externalized");
    const storedMessage = inboxMessageRecord(scope, messageSummary, [], {
      textBodyRef: {
        bucket: "agent-email",
        byteSize: 5 * 1024 * 1024,
        contentType: "text/plain",
        key: `bodies/${MESSAGE_ID}/body.txt`,
        sha256: "body-sha",
        versionId: "body-version",
      },
    });
    const service = createDynamoAgentEmailApplicationService({
      blobs: {
        delete: async () => {},
        get: async () => new TextEncoder().encode("Externalized message body"),
        put: async () => {},
        signedGetUrl: async () => "https://example.invalid",
      },
      database: database([storedMessage]).service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute("getMessage", invocation(undefined, { messageId: MESSAGE_ID })),
    ).resolves.toMatchObject({ textBody: "Externalized message body" });
  });

  it("hydrates an externalized message body when forwarding the original", async () => {
    const originalBody = "Externalized original body";
    const { textBody: _textBody, ...messageSummary } = message(SECOND_BINDING_ID, "externalized");
    const storedMessage = inboxMessageRecord(scope, messageSummary, [], {
      textBodyRef: {
        bucket: "agent-email",
        byteSize: 300 * 1024,
        contentType: "text/plain",
        key: `bodies/${SECOND_BINDING_ID}/body.txt`,
        sha256: "body-sha",
        versionId: "body-version",
      },
    });
    const memory = database([
      inboxDomainRecord(scope, domain()),
      inboxRecord(scope, inbox()),
      storedMessage,
      inboxPolicyRecord(scope, policy({ warmupStage: "production" })),
    ]);
    const blobReads: string[] = [];
    const service = createDynamoAgentEmailApplicationService({
      blobs: {
        delete: async () => {},
        get: async (key) => {
          blobReads.push(key);
          return new TextEncoder().encode(originalBody);
        },
        put: async () => {},
        signedGetUrl: async () => "https://example.invalid",
      },
      createId: ids([MESSAGE_ID, THREAD_ID, EVENT_ID, USAGE_ID, STORED_USAGE_ID]),
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute(
        "forwardMessage",
        invocation({ to: ["recipient@example.com"] }, { messageId: SECOND_BINDING_ID }),
      ),
    ).resolves.toMatchObject({ id: MESSAGE_ID });
    expect(blobReads).toEqual([`bodies/${SECOND_BINDING_ID}/body.txt`]);
    expect(
      memory.records.find(
        (record) => record.itemType === "inbox-message" && record.data.id === MESSAGE_ID,
      ),
    ).toMatchObject({
      data: {
        htmlBody: expect.stringContaining(originalBody),
        textBody: expect.stringContaining(originalBody),
      },
    });
  });

  it("rejects noncanonical usage query timestamps before deriving defaults", async () => {
    const memory = database();
    const service = createDynamoAgentEmailApplicationService({
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    for (const to of ["not-a-timestamp", "2026-07-25T05:00:00.000-07:00"]) {
      expect(
        service.execute("getUsage", {
          ...invocation(undefined),
          query: { to },
        }),
      ).rejects.toMatchObject({
        code: "invalid_usage_range",
        status: 400,
      });
    }
    expect(memory.queries).toEqual([]);
  });
});
