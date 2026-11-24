import { testEndUserKeys } from "@deployments-ai/db/erasure-testing";
import {
  agentEmailTenantObjectPrefix,
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
const SECOND_BINDING_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB9";
const POLICY_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
const MESSAGE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB4";
const THREAD_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB5";
const USAGE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB6";
const STORED_USAGE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB7";
const NOW = "2026-07-25T12:00:00.000Z";

const scope = {
  environmentId: ENVIRONMENT_ID as Ulid,
  organizationId: ORGANIZATION_ID as Ulid,
  projectId: PROJECT_ID as Ulid,
};
const tenantPrefix = agentEmailTenantObjectPrefix(scope);

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
  it("externalizes large outbound bodies before the durable message write", async () => {
    const memory = database([
      inboxDomainRecord(scope, domain()),
      inboxRecord(scope, inbox()),
      inboxPolicyRecord(scope, policy({ warmupStage: "production" })),
    ]);
    const puts: string[] = [];
    const largeBody = "x".repeat(300 * 1024);
    const bodySha256 = createHash("sha256").update(largeBody).digest("hex");
    const service = createDynamoAgentEmailApplicationService({
      blobBucket: "agent-email",
      blobs: {
        delete: async () => {},
        get: async () => new Uint8Array(),
        put: async ({ key }) => {
          puts.push(key);
          return { created: true, versionId: "version-1" };
        },
        signedGetUrl: async () => "https://example.invalid",
      },
      createId: ids([MESSAGE_ID, THREAD_ID, EVENT_ID, USAGE_ID, STORED_USAGE_ID]),
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    const response = await service.execute(
      "sendInboxMessage",
      invocation(
        { subject: "Large", text: largeBody, to: ["user@example.com"] },
        { inboxId: INBOX_ID },
      ),
    );
    expect(response).toMatchObject({ id: MESSAGE_ID, subject: "Large" });
    expect(response).not.toHaveProperty("textBody");
    expect(memory.queries).not.toContainEqual(
      expect.objectContaining({
        ExpressionAttributeValues: expect.objectContaining({
          ":pk": `ORG#${ORGANIZATION_ID}#INBOX-MESSAGE#${MESSAGE_ID}`,
        }),
      }),
    );
    expect(puts).toEqual([`${tenantPrefix}/outbound-bodies/${MESSAGE_ID}/${bodySha256}/body.txt`]);
    expect(
      memory.records.find(
        (record) => record.itemType === "inbox-message" && record.data.id === MESSAGE_ID,
      ),
    ).toMatchObject({
      data: {
        textBodyRef: {
          bucket: "agent-email",
          byteSize: 300 * 1024,
          versionId: "version-1",
        },
        threadId: THREAD_ID,
      },
    });
    expect(memory.records.find((record) => record.itemType === "rate-limit-counter")).toMatchObject(
      {
        data: {
          count: 1,
          limitKey: "agent-email.outbound-message",
          organizationId: ORGANIZATION_ID,
          scopeId: ENVIRONMENT_ID,
          window: "2026-07-25",
        },
      },
    );
  });

  it("cleans up completed attachment uploads when a later upload fails", async () => {
    const memory = database([
      inboxDomainRecord(scope, domain()),
      inboxRecord(scope, inbox()),
      inboxPolicyRecord(scope, policy({ warmupStage: "production" })),
    ]);
    const deleted: {
      readonly key: string;
      readonly versionId?: string;
    }[] = [];
    let uploadCount = 0;
    const service = createDynamoAgentEmailApplicationService({
      blobBucket: "agent-email",
      blobs: {
        delete: async (key, _bucket, versionId) => {
          deleted.push({ key, ...(versionId ? { versionId } : {}) });
        },
        get: async () => new Uint8Array(),
        put: async () => {
          uploadCount += 1;
          if (uploadCount === 2) throw new Error("attachment upload failed");
          return { created: true, versionId: "attachment-version-1" };
        },
        signedGetUrl: async () => "https://example.invalid",
      },
      createId: ids([MESSAGE_ID, BINDING_ID, SECOND_BINDING_ID]),
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute(
        "sendInboxMessage",
        invocation(
          {
            attachments: [
              {
                contentBase64: Buffer.from("first").toString("base64"),
                contentType: "text/plain",
                fileName: "first.txt",
              },
              {
                contentBase64: Buffer.from("second").toString("base64"),
                contentType: "text/plain",
                fileName: "second.txt",
              },
            ],
            subject: "Attachments",
            to: ["user@example.com"],
          },
          { inboxId: INBOX_ID },
        ),
      ),
    ).rejects.toThrow("attachment upload failed");
    expect(deleted).toEqual([
      {
        key: `${tenantPrefix}/outbound/${MESSAGE_ID}/${BINDING_ID}`,
        versionId: "attachment-version-1",
      },
    ]);
  });

  it("cleans up newly uploaded content when durable message creation fails", async () => {
    const memory = database([
      inboxDomainRecord(scope, domain()),
      inboxRecord(scope, inbox()),
      inboxPolicyRecord(scope, policy({ warmupStage: "production" })),
    ]);
    const deleted: {
      readonly key: string;
      readonly versionId?: string;
    }[] = [];
    let uploadCount = 0;
    const service = createDynamoAgentEmailApplicationService({
      blobBucket: "agent-email",
      blobs: {
        delete: async (key, _bucket, versionId) => {
          deleted.push({ key, ...(versionId ? { versionId } : {}) });
        },
        get: async () => new Uint8Array(),
        put: async () => {
          uploadCount += 1;
          return { created: true, versionId: `version-${uploadCount}` };
        },
        signedGetUrl: async () => "https://example.invalid",
      },
      createId: ids([MESSAGE_ID, BINDING_ID, THREAD_ID, EVENT_ID, USAGE_ID, STORED_USAGE_ID]),
      database: {
        ...memory.service,
        transactWrite: async () => {
          throw new Error("DynamoDB unavailable");
        },
      },
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });
    const largeBody = "x".repeat(300 * 1024);
    const bodySha256 = createHash("sha256").update(largeBody).digest("hex");

    expect(
      service.execute(
        "sendInboxMessage",
        invocation(
          {
            attachments: [
              {
                contentBase64: Buffer.from("attachment").toString("base64"),
                contentType: "text/plain",
                fileName: "attachment.txt",
              },
            ],
            subject: "Durable failure",
            text: largeBody,
            to: ["user@example.com"],
          },
          { inboxId: INBOX_ID },
        ),
      ),
    ).rejects.toThrow("DynamoDB unavailable");
    expect(deleted).toEqual([
      {
        key: `${tenantPrefix}/outbound/${MESSAGE_ID}/${BINDING_ID}`,
        versionId: "version-1",
      },
      {
        key: `${tenantPrefix}/outbound-bodies/${MESSAGE_ID}/${bodySha256}/body.txt`,
        versionId: "version-2",
      },
    ]);
    expect(memory.records.some((record) => record.itemType === "inbox-message")).toBe(false);
  });

  it("preserves uploaded content when a timed-out transaction committed", async () => {
    const memory = database([
      inboxDomainRecord(scope, domain()),
      inboxRecord(scope, inbox()),
      inboxPolicyRecord(scope, policy({ warmupStage: "production" })),
    ]);
    const deleted: string[] = [];
    const committedTransactWrite = memory.service.transactWrite;
    const service = createDynamoAgentEmailApplicationService({
      blobBucket: "agent-email",
      blobs: {
        delete: async (key) => {
          deleted.push(key);
        },
        get: async () => new Uint8Array(),
        put: async () => ({ created: true, versionId: "stored-version" }),
        signedGetUrl: async () => "https://example.invalid",
      },
      createId: ids([MESSAGE_ID, BINDING_ID, THREAD_ID, EVENT_ID, USAGE_ID, STORED_USAGE_ID]),
      database: {
        ...memory.service,
        transactWrite: async (operations, clientRequestToken) => {
          await committedTransactWrite(operations, clientRequestToken);
          throw new Error("DynamoDB response timed out");
        },
      },
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute(
        "sendInboxMessage",
        invocation(
          {
            attachments: [
              {
                contentBase64: Buffer.from("attachment").toString("base64"),
                contentType: "text/plain",
                fileName: "attachment.txt",
              },
            ],
            subject: "Ambiguous commit",
            to: ["user@example.com"],
          },
          { inboxId: INBOX_ID },
        ),
      ),
    ).resolves.toMatchObject({ id: MESSAGE_ID });
    expect(deleted).toEqual([]);
    expect(
      memory.records.find(
        (record) => record.itemType === "inbox-message" && record.data.id === MESSAGE_ID,
      ),
    ).toBeDefined();
  });
});
