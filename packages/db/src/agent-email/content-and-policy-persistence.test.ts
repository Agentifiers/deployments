import type {
  AgentEmailDomainEvent,
  AgentEmailDomainRecord,
  AgentEmailDraftRecord,
  AgentEmailMessageRecord,
  AgentEmailPlacementRecord,
  AgentEmailPolicyRecord,
  AgentEmailProviderTenantRecord,
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
  inboxDomainRecord,
  inboxDraftRecord,
  inboxMessageRecord,
  inboxPlacementRecord,
  inboxPolicyRecord,
  inboxProviderTenantRecord,
} from "./record-mapping.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;
const INBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid;
const MESSAGE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0" as Ulid;
const THREAD_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB1" as Ulid;
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB2" as Ulid;

const DRAFT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB6" as Ulid;
const POLICY_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB7" as Ulid;
const SECOND_INBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB8" as Ulid;
const SECOND_ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB9" as Ulid;
const SECOND_PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FBA" as Ulid;
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

function draft(subject = "Draft"): AgentEmailDraftRecord {
  return {
    bccAddresses: [],
    ccAddresses: [],
    createdAt: NOW,
    id: DRAFT_ID,
    inboxId: INBOX_ID,
    metadata: {},
    organizationId: ORGANIZATION_ID,
    status: "draft",
    subject,
    textBody: "Draft body",
    toAddresses: ["recipient@example.com"],
    updatedAt: NOW,
  };
}

describe("agent email DynamoDB content and policy", () => {
  it("lists pending content cleanups without an invalid empty sort-key prefix", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const { queries, service } = database();
    const repository = makeAgentEmailDynamoRepository(service, scope, testEndUserKeys);

    expect(repository.listPendingContentCleanups(25)).resolves.toEqual([]);
    expect(queries).toEqual([
      {
        ExpressionAttributeNames: { "#pk": "gsi1pk" },
        ExpressionAttributeValues: {
          ":pk": `INBOX-CONTENT-CLEANUP#${ORGANIZATION_ID}#${PROJECT_ID}#${ENVIRONMENT_ID}`,
        },
        IndexName: "gsi1",
        KeyConditionExpression: "#pk = :pk",
        Limit: 25,
      },
    ]);
  });

  it("lists tenant identity resources across sibling environments in the organization", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const siblingScope = {
      environmentId: SECOND_ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: SECOND_PROJECT_ID,
    };
    const domain = (id: Ulid, name: string): AgentEmailDomainRecord => ({
      createdAt: NOW,
      dnsRecords: [],
      domain: name,
      id,
      mailFromDomain: `bounce.${name}`,
      organizationId: ORGANIZATION_ID,
      providerManaged: false,
      providerMetadata: {},
      status: "verified",
      updatedAt: NOW,
      verifiedAt: NOW,
    });
    const placement = (id: Ulid, name: string): AgentEmailPlacementRecord => ({
      createdAt: NOW,
      dedicatedPool: false,
      id,
      isDefault: true,
      name,
      organizationId: ORGANIZATION_ID,
      provider: "ses",
      providerMetadata: {},
      region: "us-east-1",
      status: "active",
      updatedAt: NOW,
    });
    const currentDomain = inboxDomainRecord(scope, domain(DRAFT_ID, "current.agents.example.com"));
    const siblingDomain = inboxDomainRecord(
      siblingScope,
      domain(POLICY_ID, "sibling.agents.example.com"),
    );
    const currentPlacement = inboxPlacementRecord(scope, placement(INBOX_ID, "Current placement"));
    const siblingPlacement = inboxPlacementRecord(
      siblingScope,
      placement(SECOND_INBOX_ID, "Sibling placement"),
    );
    const memory = database({
      records: [currentDomain, siblingDomain, currentPlacement, siblingPlacement],
    });
    const repository = makeAgentEmailDynamoRepository(memory.service, scope, testEndUserKeys);

    expect(repository.listDomains()).resolves.toEqual([currentDomain]);
    expect(repository.listPlacements()).resolves.toEqual([currentPlacement]);
    expect(repository.listOrganizationDomains()).resolves.toEqual([currentDomain, siblingDomain]);
    expect(repository.listOrganizationPlacements()).resolves.toEqual([
      currentPlacement,
      siblingPlacement,
    ]);
  });

  it("can clear raw references and replace externalized bodies during message updates", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const { textBody: _textBody, ...messageWithoutText } = message();
    const previous = inboxMessageRecord(scope, { ...messageWithoutText, threadId: THREAD_ID }, [], {
      rawReference: {
        bucket: "agent-email",
        byteSize: 512,
        contentType: "message/rfc822",
        key: `raw/${MESSAGE_ID}`,
        sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      },
      textBodyRef: {
        bucket: "agent-email",
        byteSize: 1024,
        contentType: "text/plain; charset=utf-8",
        key: `bodies/${MESSAGE_ID}/body.txt`,
        sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      },
    });
    const { service, transactions } = database();
    const repository = makeAgentEmailDynamoRepository(service, scope, testEndUserKeys);

    await repository.updateMessage(
      previous,
      {
        ...messageWithoutText,
        rawPurgedAt: NOW,
        textBody: "Reprocessed inline body",
        threadId: THREAD_ID,
      },
      event("agent-email.received", MESSAGE_ID),
      { rawReference: null },
    );

    const messagePut = transactions[0]?.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "inbox-message",
    );
    expect(
      messagePut?.kind === "put" && messagePut.record.itemType === "inbox-message"
        ? messagePut.record.data.rawReference
        : undefined,
    ).toBeUndefined();
    expect(
      messagePut?.kind === "put" && messagePut.record.itemType === "inbox-message"
        ? messagePut.record.data.textBodyRef
        : undefined,
    ).toBeUndefined();
    expect(
      messagePut?.kind === "put" && messagePut.record.itemType === "inbox-message"
        ? messagePut.record.data.textBody
        : undefined,
    ).toBe("Reprocessed inline body");
  });

  it("rejects a purged message that still retains its raw reference", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const previous = inboxMessageRecord(
      scope,
      { ...message(), rawRetentionExpiresAt: "2026-07-21T00:00:00.000Z" },
      [],
      {
        rawReference: {
          bucket: "agent-email",
          byteSize: 512,
          contentType: "message/rfc822",
          key: `raw/${MESSAGE_ID}`,
          sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        },
      },
    );
    const { service } = database();
    const repository = makeAgentEmailDynamoRepository(service, scope, testEndUserKeys);

    expect(
      repository.updateMessage(
        previous,
        { ...message(), rawPurgedAt: NOW },
        event("agent-email.raw-purged", MESSAGE_ID),
      ),
    ).rejects.toThrow("Purged messages cannot retain a raw reference.");
  });

  it("rejects oversized inline bodies during message updates", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const previous = inboxMessageRecord(
      scope,
      {
        ...message(),
        threadId: THREAD_ID,
      },
      [],
    );
    const { service } = database();
    const repository = makeAgentEmailDynamoRepository(service, scope, testEndUserKeys);

    expect(
      repository.updateMessage(
        previous,
        { ...message("x".repeat(300 * 1024)), threadId: THREAD_ID },
        event("agent-email.received", MESSAGE_ID),
      ),
    ).rejects.toThrow("Message bodies larger than 256 KiB must be stored in S3.");
  });

  it("uses the strongly consistent draft aggregate key before updating", async () => {
    const previous = inboxDraftRecord(
      {
        environmentId: ENVIRONMENT_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
      },
      draft(),
      [],
    );
    const { service, transactions } = database({ records: [previous] });
    const repository = makeAgentEmailDynamoRepository(
      service,
      {
        environmentId: ENVIRONMENT_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
      },
      testEndUserKeys,
    );

    await repository.putDraft(draft("Updated draft"));

    const draftPut = transactions[0]?.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "inbox-draft",
    );
    expect(draftPut?.kind === "put" ? draftPut.previousRecord : undefined).toEqual(previous);
    expect(
      draftPut?.kind === "put" && draftPut.record.itemType === "inbox-draft"
        ? draftPut.record.data.version
        : undefined,
    ).toBe(1);
  });

  it("creates a draft and its creation index atomically", async () => {
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

    await repository.putDraft(draft());

    expect(
      transactions
        .at(-1)
        ?.flatMap((operation) =>
          operation.kind === "condition-check" ? [] : [operation.record.itemType],
        ),
    ).toEqual(["inbox-draft", "inbox-draft-created-index", "inbox-resource-locator"]);
  });

  it("persists recipient verification requirements during warmup", () => {
    const policy: AgentEmailPolicyRecord = {
      bounceRateThresholdBasisPoints: 500,
      complaintRateThresholdBasisPoints: 100,
      createdAt: NOW,
      dailyOutboundMessageLimit: 100,
      id: POLICY_ID,
      maxAttachmentBytes: 3 * 1024 * 1024,
      maxRecipientsPerMessage: 1,
      organizationId: ORGANIZATION_ID,
      rawRetentionDays: 7,
      sendingStatus: "active",
      updatedAt: NOW,
      warmupStage: "sandbox",
    };
    const record = inboxPolicyRecord(
      {
        environmentId: ENVIRONMENT_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
      },
      policy,
    );
    expect(record.data.requireRecipientVerification).toBe(true);
  });

  it("preserves policy recipient rules when updating unrelated fields", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const policy: AgentEmailPolicyRecord = {
      allowlist: ["allowed@example.com"],
      blocklist: ["blocked@example.com"],
      bounceRateThresholdBasisPoints: 500,
      complaintRateThresholdBasisPoints: 100,
      createdAt: NOW,
      dailyOutboundMessageLimit: 100,
      id: POLICY_ID,
      maxAttachmentBytes: 3 * 1024 * 1024,
      maxRecipientsPerMessage: 1,
      organizationId: ORGANIZATION_ID,
      rawRetentionDays: 7,
      sendingStatus: "active",
      updatedAt: NOW,
      warmupStage: "sandbox",
    };
    const previous = inboxPolicyRecord(scope, policy, undefined, {
      bounceMessageCount: 2,
      complaintMessageCount: 1,
      outboundOutcomeMessageCount: 50,
    });
    const { service, transactions } = database({ records: [previous] });
    const repository = makeAgentEmailDynamoRepository(service, scope, testEndUserKeys);
    const { allowlist: _allowlist, blocklist: _blocklist, ...policyWithoutRules } = policy;

    await repository.putPolicy(policyWithoutRules);

    const policyPut = transactions[0]?.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "inbox-policy",
    );
    expect(
      policyPut?.kind === "put" && policyPut.record.itemType === "inbox-policy"
        ? policyPut.record.data.allowlist
        : undefined,
    ).toEqual(["allowed@example.com"]);
    expect(
      policyPut?.kind === "put" && policyPut.record.itemType === "inbox-policy"
        ? policyPut.record.data.blocklist
        : undefined,
    ).toEqual(["blocked@example.com"]);
    expect(
      policyPut?.kind === "put" && policyPut.record.itemType === "inbox-policy"
        ? {
            bounceMessageCount: policyPut.record.data.bounceMessageCount,
            complaintMessageCount: policyPut.record.data.complaintMessageCount,
            outboundOutcomeMessageCount: policyPut.record.data.outboundOutcomeMessageCount,
          }
        : undefined,
    ).toEqual({
      bounceMessageCount: 2,
      complaintMessageCount: 1,
      outboundOutcomeMessageCount: 50,
    });
  });

  it("preserves inbox-scoped policy bindings unless explicitly cleared", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const policy: AgentEmailPolicyRecord = {
      bounceRateThresholdBasisPoints: 500,
      complaintRateThresholdBasisPoints: 100,
      createdAt: NOW,
      dailyOutboundMessageLimit: 100,
      id: POLICY_ID,
      maxAttachmentBytes: 3 * 1024 * 1024,
      maxRecipientsPerMessage: 1,
      organizationId: ORGANIZATION_ID,
      rawRetentionDays: 7,
      sendingStatus: "active",
      updatedAt: NOW,
      warmupStage: "sandbox",
    };
    const previous = inboxPolicyRecord(scope, policy, INBOX_ID);
    const { service, transactions } = database({ records: [previous] });
    const repository = makeAgentEmailDynamoRepository(service, scope, testEndUserKeys);

    await repository.putPolicy(policy);

    const policyPut = transactions[0]?.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "inbox-policy",
    );
    expect(
      policyPut?.kind === "put" && policyPut.record.itemType === "inbox-policy"
        ? policyPut.record.data.inboxId
        : undefined,
    ).toBe(INBOX_ID);
  });

  it("rejects oversized inline drafts before DynamoDB", async () => {
    const { service } = database();
    const repository = makeAgentEmailDynamoRepository(
      service,
      {
        environmentId: ENVIRONMENT_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
      },
      testEndUserKeys,
    );

    expect(repository.putDraft({ ...draft(), textBody: "x".repeat(300 * 1024) })).rejects.toThrow(
      "Draft bodies larger than 256 KiB must be stored in S3.",
    );
  });

  it("replaces stale draft body references when inline content is edited", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const { textBody: _textBody, ...draftWithoutText } = draft();
    const previous = inboxDraftRecord(scope, draftWithoutText, [], {
      textBodyRef: {
        bucket: "agent-email",
        byteSize: 1024,
        contentType: "text/plain; charset=utf-8",
        key: `drafts/${DRAFT_ID}/body.txt`,
        sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      },
    });
    const { service, transactions } = database({ records: [previous] });
    const repository = makeAgentEmailDynamoRepository(service, scope, testEndUserKeys);

    await repository.putDraft({ ...draft(), textBody: "Edited inline body" });

    const draftPut = transactions[0]?.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "inbox-draft",
    );
    expect(
      draftPut?.kind === "put" && draftPut.record.itemType === "inbox-draft"
        ? draftPut.record.data.textBody
        : undefined,
    ).toBe("Edited inline body");
    expect(
      draftPut?.kind === "put" && draftPut.record.itemType === "inbox-draft"
        ? draftPut.record.data.textBodyRef
        : undefined,
    ).toBeUndefined();
  });

  it("rejects message and thread records from different inboxes", async () => {
    const { service } = database();
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
      repository.persistMessage({
        event: event("agent-email.received", MESSAGE_ID),
        message: message(),
        thread: { ...thread(), inboxId: SECOND_INBOX_ID },
        usage: [],
      }),
    ).rejects.toThrow("Message and thread must belong to the same inbox.");
  });

  it("updates current provider tenant records in organization scope", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const tenant: AgentEmailProviderTenantRecord = {
      createdAt: NOW,
      id: INBOX_ID,
      organizationId: ORGANIZATION_ID,
      provider: "ses",
      providerMetadata: {},
      providerName: "agent-inboxes-tenant",
      region: "us-east-2",
      sendingStatus: "provisioning",
      suppressedReasons: ["bounce", "complaint"],
      suppressionScope: "tenant",
      updatedAt: NOW,
    };
    const { service, transactions } = database({
      records: [inboxProviderTenantRecord(scope, tenant)],
    });
    const repository = makeAgentEmailDynamoRepository(service, scope, testEndUserKeys);

    await repository.updateProviderTenant({
      ...tenant,
      sendingStatus: "enabled",
    });

    expect(transactions).toHaveLength(1);
    const updated = transactions[0]?.find(
      (operation) =>
        operation.kind === "put" && operation.record.itemType === "inbox-provider-tenant",
    );
    expect(
      updated?.kind === "put" && updated.record.itemType === "inbox-provider-tenant"
        ? updated.record.data.sendingStatus
        : undefined,
    ).toBe("enabled");
    expect(
      transactions[0]?.some(
        (operation) => operation.kind === "put" && operation.record.itemType === "unique-claim",
      ),
    ).toBe(false);
  });
});
