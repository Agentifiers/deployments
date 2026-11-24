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
  inboxUsageMeterRecord,
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
const ATTACHMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FBC";
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
  it("reserves scheduled sends against the scheduled delivery-day quota", async () => {
    const memory = database([
      inboxDomainRecord(scope, domain()),
      inboxRecord(scope, inbox()),
      inboxPolicyRecord(scope, policy({ dailyOutboundMessageLimit: 1, warmupStage: "production" })),
    ]);
    const service = createDynamoAgentEmailApplicationService({
      createId: ids([
        MESSAGE_ID,
        THREAD_ID,
        EVENT_ID,
        USAGE_ID,
        BINDING_ID,
        SECOND_BINDING_ID,
        DRAFT_ID,
        ATTACHMENT_ID,
      ]),
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    await service.execute(
      "sendInboxMessage",
      invocation(
        {
          scheduledAt: "2026-07-26T12:00:00.000Z",
          subject: "Scheduled",
          to: ["first@example.com"],
        },
        { inboxId: INBOX_ID },
      ),
    );

    expect(
      memory.records.find((record) => record.itemType === "rate-limit-counter")?.data,
    ).toMatchObject({
      expiresAt: "2026-07-27T00:00:00.000Z",
      window: "2026-07-26",
    });
    expect(
      memory.queries.find(
        (query) =>
          (query.ExpressionAttributeValues as { readonly ":pk"?: string } | undefined)?.[":pk"] ===
          `ENV#${ENVIRONMENT_ID}#METRIC#agent_email.outbound_message`,
      )?.ExpressionAttributeValues,
    ).toMatchObject({
      ":from": "2026-07-26T00%3A00%3A00.000Z",
      ":to": "2026-07-26T23%3A59%3A59.999Z#\uffff",
    });
    const scheduledQuotaQueries = () =>
      memory.queries.filter(
        (query) =>
          (query.ExpressionAttributeValues as { readonly ":pk"?: string } | undefined)?.[":pk"] ===
            `ENV#${ENVIRONMENT_ID}#METRIC#agent_email.outbound_message` &&
          (query.ExpressionAttributeValues as { readonly ":from"?: string } | undefined)?.[
            ":from"
          ] === "2026-07-26T00%3A00%3A00.000Z",
      );
    expect(scheduledQuotaQueries()).toHaveLength(1);
    expect(
      service.execute(
        "sendInboxMessage",
        invocation(
          {
            scheduledAt: "2026-07-26T13:00:00.000Z",
            subject: "Second scheduled",
            to: ["second@example.com"],
          },
          { inboxId: INBOX_ID },
        ),
      ),
    ).rejects.toMatchObject({
      code: "daily_outbound_limit_exceeded",
      status: 409,
    });
    expect(scheduledQuotaQueries()).toHaveLength(1);
    expect(
      service.execute(
        "sendInboxMessage",
        invocation(
          {
            subject: "Immediate",
            to: ["second@example.com"],
          },
          { inboxId: INBOX_ID },
        ),
      ),
    ).resolves.toMatchObject({ status: "queued" });
    expect(
      memory.records
        .filter(
          (
            record,
          ): record is Extract<
            (typeof memory.records)[number],
            { readonly itemType: "meter-event" }
          > =>
            record.itemType === "meter-event" &&
            record.data.metric === "agent_email.outbound_message",
        )
        .map((record) => record.data.occurredAt)
        .toSorted(),
    ).toEqual([NOW, "2026-07-26T12:00:00.000Z"]);
  });

  it("rejects scheduled sends that are not later than the current time", async () => {
    const memory = database([
      inboxDomainRecord(scope, domain()),
      inboxRecord(scope, inbox()),
      inboxPolicyRecord(scope, policy({ warmupStage: "production" })),
    ]);
    const service = createDynamoAgentEmailApplicationService({
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute(
        "sendInboxMessage",
        invocation(
          {
            scheduledAt: NOW,
            subject: "Past schedule",
            to: ["first@example.com"],
          },
          { inboxId: INBOX_ID },
        ),
      ),
    ).rejects.toMatchObject({
      code: "scheduled_at_in_past",
      status: 400,
    });
    expect(memory.records.some((record) => record.itemType === "rate-limit-counter")).toBe(false);
  });

  it("rejects send acceptance when the effective SES placement is not ready", async () => {
    const memory = database([
      inboxDomainRecord(scope, domain()),
      inboxRecord(scope, inbox()),
      inboxPlacementRecord(scope, placement({ isDefault: true, status: "disabled" })),
      inboxPolicyRecord(scope, policy({ warmupStage: "production" })),
    ]);
    const service = createDynamoAgentEmailApplicationService({
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute(
        "sendInboxMessage",
        invocation(
          { subject: "Unavailable placement", to: ["recipient@example.com"] },
          { inboxId: INBOX_ID },
        ),
      ),
    ).rejects.toMatchObject({
      code: "placement_not_ready",
      status: 409,
    });
    expect(memory.records.some((record) => record.itemType === "inbox-message")).toBe(false);
  });

  it("persists the deterministic default policy before evaluating the first send", async () => {
    const memory = database([
      inboxDomainRecord(scope, domain()),
      inboxRecord(scope, inbox()),
      inboxPlacementRecord(scope, placement({ isDefault: true })),
    ]);
    const service = createDynamoAgentEmailApplicationService({
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute(
        "sendInboxMessage",
        invocation(
          { subject: "Default policy", to: ["recipient@example.com"] },
          { inboxId: INBOX_ID },
        ),
      ),
    ).rejects.toMatchObject({
      code: "recipient_not_verified",
      status: 409,
    });
    expect(memory.records.find((record) => record.itemType === "inbox-policy")).toMatchObject({
      data: {
        bounceRateThresholdBasisPoints: 500,
        complaintRateThresholdBasisPoints: 10,
        sendingStatus: "active",
      },
    });
  });

  it("rejects reversed usage export ranges before querying DynamoDB", async () => {
    const memory = database();
    const service = createDynamoAgentEmailApplicationService({
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute(
        "exportUsage",
        invocation({
          from: "2026-07-26T00:00:00.000Z",
          to: "2026-07-25T00:00:00.000Z",
        }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_usage_range",
      status: 400,
    });
    expect(memory.queries).toEqual([]);
  });

  it("rejects public usage ranges longer than 31 days before querying DynamoDB", async () => {
    const memory = database();
    const service = createDynamoAgentEmailApplicationService({
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });
    const from = "2026-06-01T00:00:00.000Z";
    const to = "2026-07-03T00:00:00.000Z";

    expect(
      service.execute("getUsage", {
        ...invocation(undefined),
        query: { from, to },
      }),
    ).rejects.toMatchObject({
      code: "invalid_usage_range",
      message: "Usage ranges cannot exceed 31 days.",
      status: 400,
    });
    expect(service.execute("exportUsage", invocation({ from, to }))).rejects.toMatchObject({
      code: "invalid_usage_range",
      message: "Usage ranges cannot exceed 31 days.",
      status: 400,
    });
    expect(memory.queries).toEqual([]);
  });

  it("bounds public usage scans and asks callers to narrow oversized results", async () => {
    const memory = database();
    const usageRecord = inboxUsageMeterRecord(scope, {
      createdAt: NOW,
      id: USAGE_ID,
      inboxId: INBOX_ID,
      kind: "inbound_message",
      organizationId: ORGANIZATION_ID,
      quantity: 1,
    });
    const queries: Record<string, unknown>[] = [];
    const saturatedDatabase: DynamoDatabaseService = {
      ...memory.service,
      queryRecords: async (_table, query) => {
        queries.push(query);
        return {
          items: Array.from({ length: 10_000 }, () => usageRecord),
          lastEvaluatedKey: {
            gsi2pk: usageRecord.gsi2pk,
            gsi2sk: usageRecord.gsi2sk,
          },
        };
      },
    };
    const service = createDynamoAgentEmailApplicationService({
      database: saturatedDatabase,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute("getUsage", {
        ...invocation(undefined),
        query: {
          from: "2026-07-24T12:00:00.000Z",
          to: NOW,
        },
      }),
    ).rejects.toMatchObject({
      code: "usage_result_limit_exceeded",
      message: "Usage results exceed 10000 records; request a narrower range or inbox.",
      status: 400,
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({
      ExpressionAttributeValues: {
        ":from": "2026-07-24T12%3A00%3A00.000Z",
        ":to": "2026-07-25T12%3A00%3A00.000Z#\uffff",
      },
      Limit: 10_001,
    });
  });

  it("applies the usage result cap after inbox filtering", async () => {
    const memory = database();
    const otherInboxUsage = inboxUsageMeterRecord(scope, {
      createdAt: NOW,
      id: STORED_USAGE_ID,
      inboxId: BINDING_ID,
      kind: "inbound_message",
      organizationId: ORGANIZATION_ID,
      quantity: 1,
    });
    const selectedInboxUsage = inboxUsageMeterRecord(scope, {
      createdAt: NOW,
      id: USAGE_ID,
      inboxId: INBOX_ID,
      kind: "inbound_message",
      organizationId: ORGANIZATION_ID,
      quantity: 3,
    });
    const queries: Record<string, unknown>[] = [];
    const saturatedDatabase: DynamoDatabaseService = {
      ...memory.service,
      queryRecords: async (_table, query) => {
        queries.push(query);
        const partition = (query.ExpressionAttributeValues as { readonly ":pk": string })[":pk"];
        if (!partition.endsWith("agent_email.inbound_message")) {
          return { items: [] };
        }
        if (query.ExclusiveStartKey) {
          return { items: [selectedInboxUsage] };
        }
        return {
          items: Array.from({ length: 10_000 }, () => otherInboxUsage),
          lastEvaluatedKey: {
            gsi2pk: otherInboxUsage.gsi2pk,
            gsi2sk: otherInboxUsage.gsi2sk,
          },
        };
      },
    };
    const service = createDynamoAgentEmailApplicationService({
      database: saturatedDatabase,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute("getUsage", {
        ...invocation(undefined),
        query: {
          from: "2026-07-24T12:00:00.000Z",
          inboxId: INBOX_ID,
          to: NOW,
        },
      }),
    ).resolves.toMatchObject({ inboundMessages: 3 });
    expect(
      queries.filter((query) =>
        (
          query.ExpressionAttributeValues as {
            readonly ":pk": string;
          }
        )[":pk"].endsWith("agent_email.inbound_message"),
      ),
    ).toHaveLength(2);
    expect(queries[0]).toMatchObject({
      FilterExpression: "#data.#dimensions.#inboxId = :inboxId",
    });
    expect(queries[0]).not.toHaveProperty("Limit");
  });
});
