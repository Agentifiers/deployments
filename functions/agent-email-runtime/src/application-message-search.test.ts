import { testEndUserKeys } from "@deployments-ai/db/erasure-testing";
import {
  inboxDomainRecord,
  inboxMessageCreatedIndexRecord,
  inboxMessageRecord,
  inboxMessageThreadIndexRecord,
  inboxRecord,
  inboxThreadCreatedIndexRecord,
  inboxThreadRecord,
} from "@deployments-ai/db";
import { describe, expect, it } from "bun:test";
import { createDynamoAgentEmailApplicationService } from "./application-service.ts";
import {
  ORGANIZATION_ID,
  DOMAIN_ID,
  INBOX_ID,
  BINDING_ID,
  SECOND_BINDING_ID,
  MESSAGE_ID,
  THREAD_ID,
  NOW,
  scope,
  domain,
  inbox,
  message,
  database,
  invocation,
  ids,
} from "./application-service-test-support.ts";

describe("Dynamo-backed agent email application service", () => {
  it("maps malformed domains, local parts, and cursors to client errors", async () => {
    const memory = database([inboxDomainRecord(scope, domain()), inboxRecord(scope, inbox())]);
    const service = createDynamoAgentEmailApplicationService({
      createId: ids([MESSAGE_ID]),
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute("createDomain", invocation({ domain: "not a domain" })),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(
      service.execute(
        "createDomain",
        invocation({
          domain: ["a".repeat(63), "b".repeat(63), "c".repeat(51)].join("."),
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(
      service.execute("createInbox", invocation({ domainId: DOMAIN_ID, localPart: "two..dots" })),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(
      service.execute("listInboxes", {
        ...invocation(undefined),
        query: { cursor: "not-a-cursor" },
      }),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(
      service.execute("searchInboxMessages", invocation({ limit: -1 }, { inboxId: INBOX_ID })),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(
      service.execute("listInboxes", {
        ...invocation(undefined),
        query: { limit: 0 },
      }),
    ).rejects.toMatchObject({ code: "invalid_query", status: 400 });
    expect(
      service.execute("getInbox", invocation(undefined, { inboxId: "not-a-public-id" })),
    ).rejects.toMatchObject({ code: "invalid_path_parameter", status: 400 });
  });

  it("paginates messages by creation time when a deterministic draft ID is older", async () => {
    const earlier = {
      ...message(BINDING_ID, "earlier body"),
      createdAt: "2026-07-25T11:00:00.000Z",
      updatedAt: "2026-07-25T11:00:00.000Z",
    };
    const oldDraftSentLater = {
      ...message(MESSAGE_ID, "later body"),
      createdAt: "2026-07-25T13:00:00.000Z",
      updatedAt: "2026-07-25T13:00:00.000Z",
    };
    const memory = database([
      inboxDomainRecord(scope, domain()),
      inboxRecord(scope, inbox()),
      inboxMessageRecord(scope, earlier, []),
      inboxMessageCreatedIndexRecord(scope, earlier),
      inboxMessageRecord(scope, oldDraftSentLater, []),
      inboxMessageCreatedIndexRecord(scope, oldDraftSentLater),
    ]);
    const service = createDynamoAgentEmailApplicationService({
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    const result = (await service.execute("listInboxMessages", {
      ...invocation(undefined, { inboxId: INBOX_ID }),
      query: { limit: 1 },
    })) as {
      readonly items: readonly {
        readonly htmlBody?: string;
        readonly id: string;
        readonly textBody?: string;
      }[];
      readonly nextCursor?: string;
    };

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe(MESSAGE_ID);
    expect(result.items[0]).not.toHaveProperty("htmlBody");
    expect(result.items[0]).not.toHaveProperty("textBody");
    expect(result.nextCursor).toBeDefined();
    expect(
      memory.queries.find(
        (query) =>
          (query.ExpressionAttributeValues as { readonly ":sk"?: string } | undefined)?.[":sk"] ===
          "INBOX-MESSAGE-CREATED-INDEX#",
      ),
    ).toMatchObject({ Limit: 2, ScanIndexForward: false });
  });

  it("searches externalized messages by metadata without hydrating bodies", async () => {
    const { textBody: _textBody, ...summary } = message(MESSAGE_ID, "externalized");
    const storedMessage = inboxMessageRecord(scope, summary, [], {
      textBodyRef: {
        bucket: "agent-email",
        byteSize: 10 * 1024 * 1024,
        contentType: "text/plain",
        key: `bodies/${MESSAGE_ID}/body.txt`,
        sha256: "body-sha",
        versionId: "body-version",
      },
    });
    const memory = database([
      inboxRecord(scope, inbox()),
      storedMessage,
      inboxMessageCreatedIndexRecord(scope, summary),
    ]);
    const service = createDynamoAgentEmailApplicationService({
      blobs: {
        delete: async () => {},
        get: async () => {
          throw new Error("Metadata-only message search must not hydrate bodies.");
        },
        put: async () => {},
        signedGetUrl: async () => "https://example.invalid",
      },
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute(
        "searchInboxMessages",
        invocation({ from: "sender@example.com" }, { inboxId: INBOX_ID }),
      ),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ id: MESSAGE_ID })],
    });
  });

  it("bounds message-search body hydration and resumes at the last scanned message", async () => {
    const messages = [
      { createdAt: "2026-07-25T13:00:00.000Z", messageId: MESSAGE_ID },
      { createdAt: "2026-07-25T11:00:00.000Z", messageId: BINDING_ID },
    ].flatMap(({ createdAt, messageId }) => {
      const { textBody: _textBody, ...summary } = {
        ...message(messageId, "externalized"),
        createdAt,
        updatedAt: createdAt,
      };
      return [
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
        inboxMessageCreatedIndexRecord(scope, summary),
      ] as const;
    });
    const memory = database([inboxRecord(scope, inbox()), ...messages]);
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
      "searchInboxMessages",
      invocation({ limit: 2, query: "needle" }, { inboxId: INBOX_ID }),
    )) as {
      readonly items: readonly { readonly id: string }[];
      readonly nextCursor?: string;
    };
    expect(first.items.map((message) => message.id)).toEqual([MESSAGE_ID]);
    expect(first.nextCursor).toBeDefined();
    expect(blobGets).toEqual([`bodies/${MESSAGE_ID}/body.txt`]);

    const second = (await service.execute(
      "searchInboxMessages",
      invocation({ cursor: first.nextCursor, limit: 2, query: "needle" }, { inboxId: INBOX_ID }),
    )) as {
      readonly items: readonly { readonly id: string }[];
      readonly nextCursor?: string;
    };
    expect(second.items.map((message) => message.id)).toEqual([BINDING_ID]);
    expect(second.nextCursor).toBeUndefined();
    expect(blobGets).toEqual([`bodies/${MESSAGE_ID}/body.txt`, `bodies/${BINDING_ID}/body.txt`]);
  });

  it("paginates thread search without omitting matches in older threads", async () => {
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
        createdAt: summary.createdAt,
        id: threadId,
        inboxId: INBOX_ID,
        lastMessageAt: summary.createdAt,
        messageCount: 1,
        organizationId: ORGANIZATION_ID,
        participants: ["agent@agents.example.com", "sender@example.com"],
        subject: "Received",
        updatedAt: summary.updatedAt,
      };
      return [
        inboxThreadRecord(scope, thread, `thread-${threadId}`),
        inboxThreadCreatedIndexRecord(scope, thread),
        inboxMessageRecord(scope, summary, [], {
          textBodyRef: {
            bucket: "agent-email",
            byteSize: 6,
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
    let blobGets = 0;
    const service = createDynamoAgentEmailApplicationService({
      blobs: {
        delete: async () => {},
        get: async () => {
          blobGets += 1;
          return new TextEncoder().encode("needle");
        },
        put: async () => {},
        signedGetUrl: async () => "https://example.invalid",
      },
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute("listInboxThreads", {
        ...invocation(undefined, { inboxId: INBOX_ID }),
        query: { limit: 1 },
      }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ id: THREAD_ID })],
      nextCursor: expect.any(String),
    });

    const first = (await service.execute(
      "searchInboxThreads",
      invocation({ limit: 1, query: "needle" }, { inboxId: INBOX_ID }),
    )) as {
      readonly items: readonly { readonly id: string }[];
      readonly nextCursor?: string;
    };

    expect(first.items).toHaveLength(1);
    expect(blobGets).toBe(1);
    expect(first.nextCursor).toBeDefined();
    expect(
      memory.queries.find(
        (query) =>
          (query.ExpressionAttributeValues as { readonly ":sk"?: string } | undefined)?.[":sk"] ===
          "INBOX-THREAD-CREATED-INDEX#",
      ),
    ).toMatchObject({ Limit: 2, ScanIndexForward: false });

    const second = (await service.execute(
      "searchInboxThreads",
      invocation({ cursor: first.nextCursor, limit: 1, query: "needle" }, { inboxId: INBOX_ID }),
    )) as { readonly items: readonly { readonly id: string }[] };
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    expect(blobGets).toBe(2);
  });
});
