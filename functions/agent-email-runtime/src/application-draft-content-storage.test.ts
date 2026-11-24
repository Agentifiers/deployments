import { testEndUserKeys } from "@deployments-ai/db/erasure-testing";
import {
  type AgentEmailDomainRecord,
  type AgentEmailInboxRecord,
  type AgentEmailPlacementRecord,
  type AgentEmailPolicyRecord,
} from "@deployments-ai/agent-email";
import {
  inboxDomainRecord,
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
const POLICY_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
const MESSAGE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB4";
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
  it("stores edited large draft bodies under immutable content-addressed keys", async () => {
    const memory = database([
      inboxDomainRecord(scope, domain()),
      inboxRecord(scope, inbox()),
      inboxPolicyRecord(scope, policy({ warmupStage: "production" })),
    ]);
    const stored = new Map<string, Uint8Array>();
    const deleted: { readonly key: string; readonly versionId?: string }[] = [];
    const puts: string[] = [];
    const service = createDynamoAgentEmailApplicationService({
      blobBucket: "agent-email",
      blobs: {
        delete: async (key, _bucket, versionId) => {
          deleted.push({ key, ...(versionId ? { versionId } : {}) });
          stored.delete(key);
        },
        get: async (key) => stored.get(key) ?? new Uint8Array(),
        put: async ({ body, key }) => {
          puts.push(key);
          stored.set(key, body);
          return { created: true, versionId: `version-${puts.length}` };
        },
        signedGetUrl: async () => "https://example.invalid",
      },
      createId: ids([BINDING_ID]),
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });
    const firstBody = "a".repeat(300 * 1024);
    const secondBody = "b".repeat(300 * 1024);
    await service.execute(
      "createDraft",
      invocation(
        { subject: "Large draft", text: firstBody, to: ["user@example.com"] },
        { inboxId: INBOX_ID },
      ),
    );

    const response = await service.execute(
      "updateDraft",
      invocation({ text: secondBody }, { draftId: BINDING_ID, inboxId: INBOX_ID }),
    );
    expect(response).toMatchObject({ id: BINDING_ID });
    expect(response).not.toHaveProperty("textBody");
    expect(puts).toHaveLength(2);
    expect(puts[0]).not.toBe(puts[1]);
    expect(puts[0]).toContain(createHash("sha256").update(firstBody).digest("hex"));
    expect(puts[1]).toContain(createHash("sha256").update(secondBody).digest("hex"));
    expect(deleted).toEqual([{ key: puts[0] as string, versionId: "version-1" }]);
  });

  it("preserves an externalized draft body during a metadata-only edit", async () => {
    const memory = database([inboxDomainRecord(scope, domain()), inboxRecord(scope, inbox())]);
    const stored = new Map<string, { readonly body: Uint8Array; readonly versionId: string }>();
    const deleted: string[] = [];
    const service = createDynamoAgentEmailApplicationService({
      blobBucket: "agent-email",
      blobs: {
        delete: async (key) => {
          deleted.push(key);
          stored.delete(key);
        },
        get: async (key) => stored.get(key)?.body ?? new Uint8Array(),
        put: async ({ body, key }) => {
          const existing = stored.get(key);
          if (existing) return { created: false, versionId: existing.versionId };
          const saved = { body, versionId: "body-version" };
          stored.set(key, saved);
          return { created: true, versionId: saved.versionId };
        },
        signedGetUrl: async () => "https://example.invalid",
      },
      createId: ids([DRAFT_ID]),
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });
    const body = "external draft body ".repeat(20_000);

    await service.execute(
      "createDraft",
      invocation(
        { subject: "Original subject", text: body, to: ["user@example.com"] },
        { inboxId: INBOX_ID },
      ),
    );
    expect(
      service.execute(
        "updateDraft",
        invocation({ subject: "Updated subject" }, { draftId: DRAFT_ID, inboxId: INBOX_ID }),
      ),
    ).resolves.toMatchObject({ id: DRAFT_ID, subject: "Updated subject" });
    expect(
      service.execute(
        "submitDraft",
        invocation(undefined, { draftId: DRAFT_ID, inboxId: INBOX_ID }),
      ),
    ).resolves.toMatchObject({ id: DRAFT_ID, status: "pending_approval" });

    const savedDraft = memory.records.find(
      (record) => record.itemType === "inbox-draft" && record.data.id === DRAFT_ID,
    );
    expect(savedDraft).toMatchObject({
      data: {
        status: "pending_approval",
        subject: "Updated subject",
        textBodyRef: {
          versionId: "body-version",
        },
      },
    });
    const bodyKey =
      savedDraft?.itemType === "inbox-draft" ? savedDraft.data.textBodyRef?.key : undefined;
    expect(bodyKey ? new TextDecoder().decode(stored.get(bodyKey)?.body) : undefined).toBe(body);
    expect(deleted).toEqual([]);
  });

  it("scopes draft cleanup replay identities to the idempotency principal", async () => {
    const memory = database([inboxDomainRecord(scope, domain()), inboxRecord(scope, inbox())]);
    const stored = new Map<string, Uint8Array>();
    const puts: string[] = [];
    const service = createDynamoAgentEmailApplicationService({
      blobBucket: "agent-email",
      blobs: {
        delete: async (key) => {
          stored.delete(key);
        },
        get: async (key) => stored.get(key) ?? new Uint8Array(),
        put: async ({ body, key }) => {
          puts.push(key);
          stored.set(key, body);
          return { created: true, versionId: `version-${puts.length}` };
        },
        signedGetUrl: async () => "https://example.invalid",
      },
      createId: ids([BINDING_ID]),
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });
    await service.execute(
      "createDraft",
      invocation(
        {
          subject: "Principal cleanup",
          text: "a".repeat(300 * 1024),
          to: ["user@example.com"],
        },
        { inboxId: INBOX_ID },
      ),
    );
    const update = invocation(
      { text: "b".repeat(300 * 1024) },
      { draftId: BINDING_ID, inboxId: INBOX_ID },
    );
    await service.execute("updateDraft", {
      ...update,
      idempotencyKey: "shared-cleanup-key",
      identity: { ...update.identity, principalId: "admin-a" },
    });
    await service.execute("updateDraft", {
      ...update,
      body: { text: "c".repeat(300 * 1024) },
      idempotencyKey: "shared-cleanup-key",
      identity: { ...update.identity, principalId: "admin-b" },
    });

    expect(puts).toHaveLength(3);
    expect(puts[2]).toContain(
      createHash("sha256")
        .update("c".repeat(300 * 1024))
        .digest("hex"),
    );
  });

  it("retries durable superseded draft cleanup without rewriting the draft", async () => {
    const memory = database([inboxDomainRecord(scope, domain()), inboxRecord(scope, inbox())]);
    const stored = new Map<string, Uint8Array>();
    const puts: string[] = [];
    let deleteAttempts = 0;
    const service = createDynamoAgentEmailApplicationService({
      blobBucket: "agent-email",
      blobs: {
        delete: async (key) => {
          deleteAttempts += 1;
          if (deleteAttempts === 1) throw new Error("temporary S3 delete failure");
          stored.delete(key);
        },
        get: async (key) => stored.get(key) ?? new Uint8Array(),
        put: async ({ body, key }) => {
          puts.push(key);
          stored.set(key, body);
          return { created: true, versionId: `version-${puts.length}` };
        },
        signedGetUrl: async () => "https://example.invalid",
      },
      createId: ids([BINDING_ID]),
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });
    await service.execute(
      "createDraft",
      invocation(
        {
          subject: "Cleanup retry",
          text: "a".repeat(300 * 1024),
          to: ["user@example.com"],
        },
        { inboxId: INBOX_ID },
      ),
    );
    const updateInvocation = {
      ...invocation({ text: "b".repeat(300 * 1024) }, { draftId: BINDING_ID, inboxId: INBOX_ID }),
      idempotencyKey: "draft-cleanup-retry",
    };

    expect(service.execute("updateDraft", updateInvocation)).rejects.toThrow(
      "temporary S3 delete failure",
    );
    const committedDraft = memory.records.find(
      (record) => record.itemType === "inbox-draft" && record.data.id === BINDING_ID,
    );
    const versionAfterCommit =
      committedDraft?.itemType === "inbox-draft" ? committedDraft.data.version : undefined;
    expect(service.execute("updateDraft", updateInvocation)).resolves.toMatchObject({
      id: BINDING_ID,
    });

    expect(puts).toHaveLength(2);
    expect(deleteAttempts).toBe(2);
    expect(
      memory.records.find(
        (record) =>
          record.itemType === "inbox-content-cleanup" && record.data.resourceId === BINDING_ID,
      ),
    ).toMatchObject({ data: { status: "completed" } });
    const retriedDraft = memory.records.find(
      (record) => record.itemType === "inbox-draft" && record.data.id === BINDING_ID,
    );
    expect(retriedDraft?.itemType === "inbox-draft" ? retriedDraft.data.version : undefined).toBe(
      versionAfterCommit,
    );
  });

  it("does not let delayed cleanup delete a body reused by a later draft edit", async () => {
    const memory = database([inboxDomainRecord(scope, domain()), inboxRecord(scope, inbox())]);
    const stored = new Map<string, { readonly body: Uint8Array; readonly versionId: string }>();
    const puts: string[] = [];
    let deleteAttempts = 0;
    const service = createDynamoAgentEmailApplicationService({
      blobBucket: "agent-email",
      blobs: {
        delete: async (key) => {
          deleteAttempts += 1;
          if (deleteAttempts === 1) throw new Error("temporary S3 delete failure");
          stored.delete(key);
        },
        get: async (key) => {
          const value = stored.get(key);
          if (!value) throw new Error(`Missing draft body ${key}.`);
          return value.body;
        },
        put: async ({ body, key }) => {
          puts.push(key);
          const existing = stored.get(key);
          if (existing) return { created: false, versionId: existing.versionId };
          const saved = { body, versionId: `version-${puts.length}` };
          stored.set(key, saved);
          return { created: true, versionId: saved.versionId };
        },
        signedGetUrl: async () => "https://example.invalid",
      },
      createId: ids([BINDING_ID]),
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });
    const firstBody = "a".repeat(300 * 1024);
    const secondBody = "b".repeat(300 * 1024);
    await service.execute(
      "createDraft",
      invocation(
        { subject: "Cleanup race", text: firstBody, to: ["user@example.com"] },
        { inboxId: INBOX_ID },
      ),
    );
    const firstUpdate = {
      ...invocation({ text: secondBody }, { draftId: BINDING_ID, inboxId: INBOX_ID }),
      idempotencyKey: "cleanup-race-b",
    };
    expect(service.execute("updateDraft", firstUpdate)).rejects.toThrow(
      "temporary S3 delete failure",
    );
    await service.execute("updateDraft", {
      ...invocation({ text: firstBody }, { draftId: BINDING_ID, inboxId: INBOX_ID }),
      idempotencyKey: "cleanup-race-a",
    });
    expect(service.execute("updateDraft", firstUpdate)).resolves.toMatchObject({
      id: BINDING_ID,
    });

    expect(puts).toHaveLength(3);
    expect(puts[0]).not.toBe(puts[2]);
    expect(
      service.execute("getDraft", invocation(undefined, { draftId: BINDING_ID })),
    ).resolves.toMatchObject({ textBody: firstBody });
  });

  it("preserves a newly uploaded draft body when a timed-out write committed", async () => {
    const memory = database([inboxDomainRecord(scope, domain()), inboxRecord(scope, inbox())]);
    const deleted: string[] = [];
    const committedPutRecord = memory.service.putRecord;
    const service = createDynamoAgentEmailApplicationService({
      blobBucket: "agent-email",
      blobs: {
        delete: async (key) => {
          deleted.push(key);
        },
        get: async () => new Uint8Array(),
        put: async () => ({ created: true, versionId: "draft-version" }),
        signedGetUrl: async () => "https://example.invalid",
      },
      createId: ids([BINDING_ID]),
      database: {
        ...memory.service,
        putRecord: async (record, conditionExpression) => {
          await committedPutRecord(record, conditionExpression);
          throw new Error("DynamoDB response timed out");
        },
      },
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute(
        "createDraft",
        invocation(
          {
            subject: "Ambiguous draft",
            text: "x".repeat(300 * 1024),
            to: ["user@example.com"],
          },
          { inboxId: INBOX_ID },
        ),
      ),
    ).resolves.toMatchObject({ id: BINDING_ID });
    expect(deleted).toEqual([]);
    expect(
      memory.records.find(
        (record) => record.itemType === "inbox-draft" && record.data.id === BINDING_ID,
      ),
    ).toMatchObject({
      data: {
        textBodyRef: {
          versionId: "draft-version",
        },
      },
    });
  });
});
