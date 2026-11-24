import { testEndUserKeys } from "@deployments-ai/db/erasure-testing";
import {
  type AgentEmailDomainRecord,
  type AgentEmailInboxRecord,
  type AgentEmailPlacementRecord,
  type AgentEmailPolicyRecord,
} from "@deployments-ai/agent-email";
import { deterministicAgentEmailUlid } from "@deployments-ai/agent-email/aws";
import {
  inboxBindingRecord,
  inboxControlCreatedIndexRecord,
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
import type { AgentEmailApiInvocation } from "./api-handler.ts";
import { createDynamoAgentEmailApplicationService } from "./application-service.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const DOMAIN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const INBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const BINDING_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const SECOND_BINDING_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB9";
const DEPLOYMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
const DEFINITION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB8";
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
  it("creates, reads, lists, and archives inbox bindings in the authenticated environment", async () => {
    const memory = database([inboxDomainRecord(scope, domain()), inboxRecord(scope, inbox())]);
    const service = createDynamoAgentEmailApplicationService({
      createId: ids([BINDING_ID, SECOND_BINDING_ID]),
      database: memory.service,
      now: () => new Date(NOW),
      validateAgentDeployment: async () => ({
        agentDefinitionId: DEFINITION_ID,
      }),
      endUserKeys: testEndUserKeys,
    });

    const created = await service.execute(
      "createBinding",
      invocation(
        {
          agentDeploymentId: DEPLOYMENT_ID,
          bindingType: "platform_agent",
          metadata: { purpose: "support" },
        },
        { inboxId: INBOX_ID },
      ),
    );
    expect(created).toMatchObject({
      agentDeploymentId: DEPLOYMENT_ID,
      externalId: DEFINITION_ID,
      id: BINDING_ID,
      inboxId: INBOX_ID,
      status: "active",
    });

    expect(
      service.execute("getBinding", invocation(undefined, { bindingId: BINDING_ID })),
    ).resolves.toMatchObject({ id: BINDING_ID, status: "active" });
    expect(
      service.execute("listBindings", invocation(undefined, { inboxId: INBOX_ID })),
    ).resolves.toMatchObject({ items: [{ id: BINDING_ID }] });
    expect(
      service.execute("deleteBinding", invocation(undefined, { bindingId: BINDING_ID })),
    ).resolves.toMatchObject({ id: BINDING_ID, status: "archived" });
    expect(
      service.execute("listBindings", invocation(undefined, { inboxId: INBOX_ID })),
    ).resolves.toEqual({ items: [] });
    expect(memory.records.some((record) => record.itemType === "unique-claim")).toBe(false);
    expect(
      service.execute(
        "createBinding",
        invocation(
          {
            agentDeploymentId: DEPLOYMENT_ID,
            bindingType: "platform_agent",
          },
          { inboxId: INBOX_ID },
        ),
      ),
    ).resolves.toMatchObject({ id: SECOND_BINDING_ID, status: "active" });
    const storedInbox = memory.records.find(
      (record): record is Extract<PlatformRecord, { readonly itemType: "inbox" }> =>
        record.itemType === "inbox" && record.data.id === INBOX_ID,
    );
    expect(storedInbox?.data.activePlatformBindingCount).toBe(1);
  });

  it("bounds active platform-agent bindings for one inbox", async () => {
    const countedInbox = inboxRecord(scope, inbox(), undefined, 100);
    const memory = database([inboxDomainRecord(scope, domain()), countedInbox]);
    const service = createDynamoAgentEmailApplicationService({
      createId: ids([BINDING_ID]),
      database: memory.service,
      now: () => new Date(NOW),
      validateAgentDeployment: async () => ({
        agentDefinitionId: DEFINITION_ID,
      }),
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute(
        "createBinding",
        invocation(
          {
            agentDeploymentId: DEPLOYMENT_ID,
            bindingType: "platform_agent",
          },
          { inboxId: INBOX_ID },
        ),
      ),
    ).rejects.toMatchObject({ code: "binding_limit_exceeded", status: 409 });
    expect(memory.transactions).toEqual([]);
  });

  it("advances bounded list cursors through resources removed by endpoint filters", async () => {
    const laterOtherInboxBinding = inboxBindingRecord(scope, {
      bindingType: "external",
      createdAt: "2026-07-25T13:00:00.000Z",
      externalId: "other",
      id: SECOND_BINDING_ID,
      inboxId: DRAFT_ID,
      metadata: {},
      organizationId: ORGANIZATION_ID,
      status: "active",
      updatedAt: "2026-07-25T13:00:00.000Z",
    });
    const earlierTargetBinding = inboxBindingRecord(scope, {
      bindingType: "external",
      createdAt: "2026-07-25T11:00:00.000Z",
      externalId: "target",
      id: BINDING_ID,
      inboxId: INBOX_ID,
      metadata: {},
      organizationId: ORGANIZATION_ID,
      status: "active",
      updatedAt: "2026-07-25T11:00:00.000Z",
    });
    const memory = database([
      inboxRecord(scope, inbox()),
      laterOtherInboxBinding,
      inboxControlCreatedIndexRecord(scope, "inbox-binding", laterOtherInboxBinding),
      earlierTargetBinding,
      inboxControlCreatedIndexRecord(scope, "inbox-binding", earlierTargetBinding),
    ]);
    const service = createDynamoAgentEmailApplicationService({
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    const first = (await service.execute("listBindings", {
      ...invocation(undefined, { inboxId: INBOX_ID }),
      query: { limit: 1 },
    })) as { readonly items: readonly unknown[]; readonly nextCursor?: string };
    expect(first.items).toEqual([]);
    expect(first.nextCursor).toBeString();
    if (!first.nextCursor) throw new Error("Expected a cursor for the filtered first page.");

    const second = await service.execute("listBindings", {
      ...invocation(undefined, { inboxId: INBOX_ID }),
      query: { cursor: first.nextCursor, limit: 1 },
    });
    expect(second).toEqual({
      items: [expect.objectContaining({ id: BINDING_ID })],
    });
    expect(
      memory.queries.filter(
        (query) =>
          (query.ExpressionAttributeValues as { readonly ":sk"?: string } | undefined)?.[":sk"] ===
          "INBOX-CONTROL-CREATED-INDEX#inbox-binding#",
      ),
    ).toEqual([
      expect.objectContaining({ Limit: 2, ScanIndexForward: false }),
      expect.objectContaining({ Limit: 2, ScanIndexForward: false }),
    ]);
  });

  it("rejects a platform binding whose supplied definition identity disagrees with deployment", async () => {
    const memory = database([inboxDomainRecord(scope, domain()), inboxRecord(scope, inbox())]);
    const service = createDynamoAgentEmailApplicationService({
      createId: ids([BINDING_ID]),
      database: memory.service,
      now: () => new Date(NOW),
      validateAgentDeployment: async () => ({
        agentDefinitionId: DEFINITION_ID,
      }),
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute(
        "createBinding",
        invocation(
          {
            agentDeploymentId: DEPLOYMENT_ID,
            bindingType: "platform_agent",
            externalId: DEPLOYMENT_ID,
          },
          { inboxId: INBOX_ID },
        ),
      ),
    ).rejects.toMatchObject({ code: "agent_definition_mismatch", status: 400 });
  });

  it("creates a default policy and applies bounded partial updates without erasing defaults", async () => {
    const memory = database();
    const service = createDynamoAgentEmailApplicationService({
      createId: ids([]),
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });
    const environmentPolicyId = deterministicAgentEmailUlid(
      "1970-01-01T00:00:00.000Z",
      "environment-policy-v1",
      ORGANIZATION_ID,
      PROJECT_ID,
      ENVIRONMENT_ID,
    );

    expect(
      service.execute(
        "updatePolicy",
        invocation({
          allowlist: ["approved@example.com"],
          blocklist: ["blocked@example.com"],
          dailyOutboundMessageLimit: 2_500,
          rawRetentionDays: 45,
          warmupStage: "production",
        }),
      ),
    ).resolves.toMatchObject({
      allowlist: ["approved@example.com"],
      blocklist: ["blocked@example.com"],
      bounceRateThresholdBasisPoints: 500,
      dailyOutboundMessageLimit: 2_500,
      id: environmentPolicyId,
      rawRetentionDays: 45,
      sendingStatus: "active",
      warmupStage: "production",
      warmupStartedAt: NOW,
    });
    expect(service.execute("getPolicy", invocation(undefined))).resolves.toMatchObject({
      dailyOutboundMessageLimit: 2_500,
      rawRetentionDays: 45,
      warmupStage: "production",
    });
  });

  it("provisions a pending custom domain before refreshing its provider identity", async () => {
    const memory = database([
      inboxPlacementRecord(scope, placement({ isDefault: true, status: "active" })),
    ]);
    let provisioned = 0;
    let refreshed = 0;
    const service = createDynamoAgentEmailApplicationService({
      createId: ids([DOMAIN_ID, EVENT_ID, MESSAGE_ID]),
      database: memory.service,
      domainProvisioner: {
        provision: async (candidate) => {
          provisioned += 1;
          return { ...candidate, status: "verified", verifiedAt: NOW };
        },
        refresh: async (candidate) => {
          refreshed += 1;
          return candidate;
        },
        revoke: async (candidate) => candidate,
      },
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });
    await service.execute("createDomain", invocation({ domain: "custom.example.com" }));

    expect(
      service.execute("refreshDomain", invocation(undefined, { domainId: DOMAIN_ID })),
    ).resolves.toMatchObject({
      id: DOMAIN_ID,
      placementId: MESSAGE_ID,
      status: "verified",
    });
    expect({ provisioned, refreshed }).toEqual({
      provisioned: 1,
      refreshed: 0,
    });
  });

  it("enforces recipient, attachment, and daily policy limits before durable send work", async () => {
    const base = [inboxDomainRecord(scope, domain()), inboxRecord(scope, inbox())] as const;
    const recipientService = createDynamoAgentEmailApplicationService({
      database: database([
        ...base,
        inboxPolicyRecord(scope, policy({ maxRecipientsPerMessage: 1 })),
      ]).service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });
    expect(
      recipientService.execute(
        "sendInboxMessage",
        invocation(
          {
            cc: ["second@example.com"],
            subject: "Too many",
            to: ["first@example.com"],
          },
          { inboxId: INBOX_ID },
        ),
      ),
    ).rejects.toMatchObject({ code: "recipient_limit_exceeded", status: 409 });

    const attachmentService = createDynamoAgentEmailApplicationService({
      database: database([...base, inboxPolicyRecord(scope, policy({ maxAttachmentBytes: 0 }))])
        .service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });
    expect(
      attachmentService.execute(
        "sendInboxMessage",
        invocation(
          {
            attachments: [
              {
                contentBase64: "YQ==",
                contentType: "text/plain",
                fileName: "a.txt",
              },
            ],
            subject: "Too large",
            to: ["first@example.com"],
          },
          { inboxId: INBOX_ID },
        ),
      ),
    ).rejects.toMatchObject({ code: "attachment_limit_exceeded", status: 409 });

    const dailyService = createDynamoAgentEmailApplicationService({
      database: database([
        ...base,
        inboxPolicyRecord(
          scope,
          policy({ dailyOutboundMessageLimit: 0, warmupStage: "production" }),
        ),
      ]).service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });
    expect(
      dailyService.execute(
        "sendInboxMessage",
        invocation(
          {
            scheduledAt: "2026-07-26T12:00:00.000Z",
            subject: "Scheduled",
            to: ["first@example.com"],
          },
          { inboxId: INBOX_ID },
        ),
      ),
    ).rejects.toMatchObject({
      code: "daily_outbound_limit_exceeded",
      status: 409,
    });
  });
});
