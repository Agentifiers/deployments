import { testEndUserKeys } from "@deployments-ai/db/erasure-testing";
import {
  type AgentEmailDomainRecord,
  type AgentEmailInboxRecord,
  type AgentEmailMessageRecord,
  type AgentEmailPlacementRecord,
  type AgentEmailPolicyRecord,
} from "@deployments-ai/agent-email";
import {
  inboxDomainRecord,
  inboxMessageRecord,
  inboxPlacementRecord,
  inboxPolicyRecord,
  inboxRecord,
  inboxResourceLocatorRecord,
  type DynamoDatabaseService,
  type PlatformRecord,
  type RecordKey,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
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
  it("enforces raw retention when signing access and enqueueing reprocessing", async () => {
    const futureExpiry = "2026-07-25T12:01:30.000Z";
    const { textBody: _textBody, ...retainedMessage } = message(MESSAGE_ID, "retained");
    const retained = inboxMessageRecord(
      scope,
      {
        ...retainedMessage,
        rawRetentionExpiresAt: futureExpiry,
      },
      [],
      {
        rawReference: {
          bucket: "agent-email",
          byteSize: 100,
          contentType: "message/rfc822",
          key: `raw/${MESSAGE_ID}`,
          sha256: "raw-sha",
        },
        textBodyRef: {
          bucket: "agent-email",
          byteSize: 300 * 1024,
          contentType: "text/plain",
          key: `bodies/${MESSAGE_ID}/body.txt`,
          sha256: "body-sha",
          versionId: "body-version",
        },
      },
    );
    const expired = inboxMessageRecord(
      scope,
      {
        ...message(BINDING_ID, "expired"),
        rawRetentionExpiresAt: "2026-07-25T11:59:59.000Z",
      },
      [],
      {
        rawReference: {
          bucket: "agent-email",
          byteSize: 100,
          contentType: "message/rfc822",
          key: `raw/${BINDING_ID}`,
          sha256: "raw-sha",
        },
      },
    );
    const memory = database([retained, expired]);
    const signedTtls: number[] = [];
    const reprocessMessages: unknown[] = [];
    const reprocessIds: string[] = [];
    const service = createDynamoAgentEmailApplicationService({
      blobs: {
        delete: async () => {},
        get: async () => {
          throw new Error("reprocess response must not hydrate message bodies");
        },
        put: async () => {},
        signedGetUrl: async (_key, ttl) => {
          signedTtls.push(ttl);
          return "https://example.invalid/raw";
        },
      },
      database: memory.service,
      enqueueReprocess: async ({ message: queued, reprocessId }) => {
        reprocessMessages.push(queued);
        reprocessIds.push(reprocessId);
      },
      now: () => new Date(NOW),
      signedUrlTtlSeconds: 300,
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute("createRawMessageAccess", invocation(undefined, { messageId: MESSAGE_ID })),
    ).resolves.toMatchObject({ expiresAt: futureExpiry });
    expect(signedTtls).toEqual([90]);
    expect(
      service.execute("createRawMessageAccess", invocation(undefined, { messageId: BINDING_ID })),
    ).rejects.toMatchObject({ code: "raw_message_unavailable", status: 410 });
    expect(
      service.execute("reprocessRawMessage", invocation(undefined, { messageId: BINDING_ID })),
    ).rejects.toMatchObject({ code: "message_not_reprocessable", status: 409 });
    expect(
      service.execute("reprocessRawMessage", {
        ...invocation(undefined, { messageId: MESSAGE_ID }),
        idempotencyKey: "stable-reprocess-request",
      }),
    ).resolves.not.toHaveProperty("textBody");
    expect(reprocessMessages).toHaveLength(1);
    expect(reprocessMessages[0]).not.toHaveProperty("textBody");
    expect(reprocessIds).toEqual([
      createHash("sha256")
        .update(
          [
            ORGANIZATION_ID,
            PROJECT_ID,
            ENVIRONMENT_ID,
            MESSAGE_ID,
            "stable-reprocess-request",
          ].join("\u0000"),
        )
        .digest("hex"),
    ]);
  });

  it("threads direct sends that reference an existing inbox message", async () => {
    const original = {
      ...message(SECOND_BINDING_ID, "Original"),
      internetMessageId: "<original@example.com>",
      references: ["<root@example.com>"],
      threadId: THREAD_ID,
    };
    const memory = database([
      inboxDomainRecord(scope, domain()),
      inboxRecord(scope, inbox()),
      inboxMessageRecord(scope, original, []),
      inboxPolicyRecord(scope, policy({ warmupStage: "production" })),
    ]);
    const service = createDynamoAgentEmailApplicationService({
      createId: ids([MESSAGE_ID, EVENT_ID, USAGE_ID]),
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute(
        "sendInboxMessage",
        invocation(
          {
            replyToMessageId: SECOND_BINDING_ID,
            subject: "Re: Received",
            text: "Reply",
            to: ["sender@example.com"],
          },
          { inboxId: INBOX_ID },
        ),
      ),
    ).resolves.toMatchObject({
      inReplyTo: "<original@example.com>",
      references: ["<root@example.com>", "<original@example.com>"],
      threadId: THREAD_ID,
      threadKey: SECOND_BINDING_ID,
    });
  });

  it("returns the same durable message when a sent draft request is retried", async () => {
    const original = {
      ...message(SECOND_BINDING_ID, "Original"),
      internetMessageId: "<draft-original@example.com>",
      threadId: THREAD_ID,
    };
    const memory = database([
      inboxDomainRecord(scope, domain()),
      inboxRecord(scope, inbox()),
      inboxMessageRecord(scope, original, []),
      inboxPolicyRecord(scope, policy({ warmupStage: "production" })),
    ]);
    const service = createDynamoAgentEmailApplicationService({
      createId: ids([BINDING_ID, THREAD_ID, EVENT_ID, USAGE_ID]),
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });
    await service.execute(
      "createDraft",
      invocation(
        {
          replyToMessageId: SECOND_BINDING_ID,
          subject: "Draft",
          text: "Hello",
          to: ["user@example.com"],
        },
        { inboxId: INBOX_ID },
      ),
    );
    await service.execute(
      "submitDraft",
      invocation(undefined, { draftId: BINDING_ID, inboxId: INBOX_ID }),
    );
    await service.execute(
      "approveDraft",
      invocation(undefined, { draftId: BINDING_ID, inboxId: INBOX_ID }),
    );
    const first = await service.execute(
      "sendDraft",
      invocation(undefined, { draftId: BINDING_ID, inboxId: INBOX_ID }),
    );
    const retry = await service.execute(
      "sendDraft",
      invocation(undefined, { draftId: BINDING_ID, inboxId: INBOX_ID }),
    );

    expect(retry).toEqual(first);
    expect(first).toMatchObject({
      inReplyTo: "<draft-original@example.com>",
      references: ["<draft-original@example.com>"],
      threadId: THREAD_ID,
      threadKey: SECOND_BINDING_ID,
    });
    expect(memory.records.filter((record) => record.itemType === "inbox-message")).toHaveLength(2);
    expect(
      memory.transactions
        .flat()
        .some(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "inbox-draft" &&
            operation.record.data.sentMessageId === (first as { readonly id: string }).id,
        ),
    ).toBe(true);
  });

  it("edits a rejected draft and clears its previous review state", async () => {
    const memory = database([inboxDomainRecord(scope, domain()), inboxRecord(scope, inbox())]);
    const service = createDynamoAgentEmailApplicationService({
      createId: ids([DRAFT_ID]),
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });
    await service.execute(
      "createDraft",
      invocation(
        { subject: "Original", text: "Needs changes", to: ["user@example.com"] },
        { inboxId: INBOX_ID },
      ),
    );
    await service.execute(
      "submitDraft",
      invocation(undefined, { draftId: DRAFT_ID, inboxId: INBOX_ID }),
    );
    await service.execute(
      "rejectDraft",
      invocation(
        { reason: "Please revise the subject." },
        { draftId: DRAFT_ID, inboxId: INBOX_ID },
      ),
    );

    const edited = await service.execute(
      "updateDraft",
      invocation({ subject: "Revised" }, { draftId: DRAFT_ID, inboxId: INBOX_ID }),
    );
    expect(edited).toMatchObject({ id: DRAFT_ID, status: "draft", subject: "Revised" });
    expect(edited).not.toHaveProperty("failureReason");
    expect(edited).not.toHaveProperty("rejectedAt");
    const resubmitted = await service.execute(
      "submitDraft",
      invocation(undefined, { draftId: DRAFT_ID, inboxId: INBOX_ID }),
    );
    expect(resubmitted).toMatchObject({ id: DRAFT_ID, status: "pending_approval" });
    expect(resubmitted).not.toHaveProperty("failureReason");
    expect(resubmitted).not.toHaveProperty("rejectedAt");
  });

  it("rejects an approved draft without recipients before persisting send work", async () => {
    const memory = database([
      inboxDomainRecord(scope, domain()),
      inboxRecord(scope, inbox()),
      inboxPolicyRecord(scope, policy({ warmupStage: "production" })),
    ]);
    const service = createDynamoAgentEmailApplicationService({
      createId: ids([BINDING_ID, MESSAGE_ID]),
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });
    await service.execute(
      "createDraft",
      invocation({ subject: "Recipient pending", text: "Hello", to: [] }, { inboxId: INBOX_ID }),
    );
    await service.execute(
      "submitDraft",
      invocation(undefined, { draftId: BINDING_ID, inboxId: INBOX_ID }),
    );
    await service.execute(
      "approveDraft",
      invocation(undefined, { draftId: BINDING_ID, inboxId: INBOX_ID }),
    );

    expect(
      service.execute(
        "sendDraft",
        invocation(undefined, { draftId: BINDING_ID, inboxId: INBOX_ID }),
      ),
    ).rejects.toMatchObject({ code: "recipient_required", status: 400 });
    expect(memory.records.some((record) => record.itemType === "inbox-message")).toBe(false);
  });

  it("atomically makes a cancelled scheduled draft message unsendable", async () => {
    const memory = database([
      inboxDomainRecord(scope, domain()),
      inboxRecord(scope, inbox()),
      inboxPolicyRecord(scope, policy({ warmupStage: "production" })),
    ]);
    const service = createDynamoAgentEmailApplicationService({
      createId: ids([BINDING_ID, THREAD_ID, EVENT_ID, USAGE_ID]),
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });
    await service.execute(
      "createDraft",
      invocation(
        {
          clientId: "support-client",
          scheduledAt: "2026-07-26T12:00:00.000Z",
          subject: "Scheduled draft",
          text: "Hello",
          to: ["user@example.com"],
        },
        { inboxId: INBOX_ID },
      ),
    );
    await service.execute(
      "submitDraft",
      invocation(undefined, { draftId: BINDING_ID, inboxId: INBOX_ID }),
    );
    await service.execute(
      "approveDraft",
      invocation(undefined, { draftId: BINDING_ID, inboxId: INBOX_ID }),
    );
    const scheduled = (await service.execute(
      "sendDraft",
      invocation(undefined, { draftId: BINDING_ID, inboxId: INBOX_ID }),
    )) as { readonly id: string };

    expect(
      service.execute(
        "cancelDraft",
        invocation(undefined, { draftId: BINDING_ID, inboxId: INBOX_ID }),
      ),
    ).resolves.toMatchObject({ id: BINDING_ID, status: "cancelled" });
    expect(
      memory.records.find(
        (record) => record.itemType === "inbox-message" && record.data.id === scheduled.id,
      ),
    ).toMatchObject({
      data: {
        failureCode: "cancelled",
        status: "failed",
      },
    });
    expect(
      memory.records.find(
        (record) =>
          record.itemType === "rate-limit-counter" &&
          record.data.limitKey === "agent-email.outbound-message",
      ),
    ).toMatchObject({
      data: {
        count: 0,
        organizationId: ORGANIZATION_ID,
        version: 1,
        window: "2026-07-26",
      },
    });
    expect(
      memory.records.find(
        (record) =>
          record.itemType === "meter-event" &&
          record.data.dimensions.messageId === scheduled.id &&
          record.data.quantity === -1,
      ),
    ).toMatchObject({
      data: {
        dimensions: {
          clientId: "support-client",
          inboxId: INBOX_ID,
          messageId: scheduled.id,
        },
        metric: "agent_email.outbound_message",
        occurredAt: "2026-07-26T12:00:00.000Z",
        quantity: -1,
      },
    });
    expect(
      memory.transactions
        .at(-1)
        ?.flatMap((operation) => (operation.kind === "put" ? [operation.record.itemType] : [])),
    ).toEqual(["inbox-draft", "inbox-message", "rate-limit-counter", "meter-event"]);
  });
});
