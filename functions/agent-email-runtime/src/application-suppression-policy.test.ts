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
  inboxSuppressionRecord,
  makeUniqueClaimRecord,
  type DynamoDatabaseService,
  type PlatformRecord,
  type RecordKey,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type { AgentEmailApiInvocation, AgentEmailApiOperation } from "./api-handler.ts";
import {
  agentEmailCsvCell,
  createDynamoAgentEmailApplicationService,
} from "./application-service.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const DOMAIN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const INBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const POLICY_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
const MESSAGE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB4";
const SUPPRESSION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FBA";
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
  it("rejects every outbound operation targeting an active suppression", async () => {
    const memory = database([
      inboxDomainRecord(scope, domain()),
      inboxRecord(scope, inbox()),
      inboxPolicyRecord(scope, policy({ warmupStage: "production" })),
    ]);
    const service = createDynamoAgentEmailApplicationService({
      createId: ids([SUPPRESSION_ID]),
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });
    await service.execute(
      "createSuppression",
      invocation({ address: "blocked@example.com", reason: "manual" }),
    );

    expect(
      service.execute(
        "sendInboxMessage",
        invocation(
          {
            cc: ["BLOCKED@example.com"],
            subject: "Suppressed",
            to: ["allowed@example.com"],
          },
          { inboxId: INBOX_ID },
        ),
      ),
    ).rejects.toMatchObject({ code: "recipient_suppressed", status: 409 });
    expect(memory.records.some((record) => record.itemType === "inbox-message")).toBe(false);
  });

  it("removes a provider suppression only after SES reconciliation succeeds", async () => {
    const sourceMessage = {
      ...message(MESSAGE_ID, "outbound"),
      direction: "outbound" as const,
      fromAddress: "agent@agents.example.com",
      status: "bounced" as const,
      toAddresses: ["blocked@example.com"],
    };
    const suppression = inboxSuppressionRecord(
      scope,
      {
        address: "blocked@example.com",
        createdAt: NOW,
        id: SUPPRESSION_ID,
        organizationId: ORGANIZATION_ID,
        reason: "bounce",
        sourceMessageId: MESSAGE_ID,
      },
      createHash("sha256").update("blocked@example.com").digest("hex"),
    );
    const claim = makeUniqueClaimRecord(
      {
        namespace: `organization:${ORGANIZATION_ID}:project:${PROJECT_ID}:environment:${ENVIRONMENT_ID}:inbox-suppression`,
        ownerId: SUPPRESSION_ID as Ulid,
        ownerItemType: "inbox-suppression",
        ownerPk: suppression.pk,
        ownerSk: suppression.sk,
        ownerTable: "control",
        value: suppression.data.emailHash,
      },
      NOW,
    ) as unknown as PlatformRecord;
    const memory = database([
      inboxDomainRecord(scope, domain()),
      inboxRecord(scope, inbox()),
      inboxMessageRecord(scope, sourceMessage, []),
      suppression,
      claim,
    ]);
    const synchronized: string[] = [];
    const service = createDynamoAgentEmailApplicationService({
      database: memory.service,
      now: () => new Date(NOW),
      syncProviderSuppression: async (request) => {
        synchronized.push(request.suppression.address);
        expect(request).toMatchObject({
          message: { id: MESSAGE_ID },
          removed: true,
          suppression: { id: SUPPRESSION_ID, reason: "bounce" },
        });
      },
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute(
        "removeSuppression",
        invocation(undefined, { suppressionId: SUPPRESSION_ID }),
      ),
    ).resolves.toMatchObject({ id: SUPPRESSION_ID });
    expect(synchronized).toEqual(["blocked@example.com"]);
    expect(
      memory.records.find(
        (record) => record.itemType === "inbox-suppression" && record.data.id === SUPPRESSION_ID,
      ),
    ).toMatchObject({ data: { status: "removed" } });
  });

  it("keeps a provider suppression active when SES reconciliation fails", async () => {
    const sourceMessage = {
      ...message(MESSAGE_ID, "outbound"),
      direction: "outbound" as const,
      fromAddress: "agent@agents.example.com",
      status: "bounced" as const,
      toAddresses: ["blocked@example.com"],
    };
    const suppression = inboxSuppressionRecord(
      scope,
      {
        address: "blocked@example.com",
        createdAt: NOW,
        id: SUPPRESSION_ID,
        organizationId: ORGANIZATION_ID,
        reason: "bounce",
        sourceMessageId: MESSAGE_ID,
      },
      createHash("sha256").update("blocked@example.com").digest("hex"),
    );
    const claim = makeUniqueClaimRecord(
      {
        namespace: `organization:${ORGANIZATION_ID}:project:${PROJECT_ID}:environment:${ENVIRONMENT_ID}:inbox-suppression`,
        ownerId: SUPPRESSION_ID as Ulid,
        ownerItemType: "inbox-suppression",
        ownerPk: suppression.pk,
        ownerSk: suppression.sk,
        ownerTable: "control",
        value: suppression.data.emailHash,
      },
      NOW,
    ) as unknown as PlatformRecord;
    const memory = database([
      inboxDomainRecord(scope, domain()),
      inboxRecord(scope, inbox()),
      inboxMessageRecord(scope, sourceMessage, []),
      suppression,
      claim,
    ]);
    const service = createDynamoAgentEmailApplicationService({
      database: memory.service,
      now: () => new Date(NOW),
      syncProviderSuppression: async () => {
        throw new Error("SES unavailable");
      },
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute(
        "removeSuppression",
        invocation(undefined, { suppressionId: SUPPRESSION_ID }),
      ),
    ).rejects.toThrow("SES unavailable");
    expect(
      memory.records.find(
        (record) => record.itemType === "inbox-suppression" && record.data.id === SUPPRESSION_ID,
      ),
    ).toMatchObject({ data: { status: "active" } });
  });

  it("rejects outbound work after the inbox domain is revoked", async () => {
    const memory = database([
      inboxDomainRecord(scope, domain({ status: "revoked" })),
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
        invocation({ subject: "Revoked domain", to: ["user@example.com"] }, { inboxId: INBOX_ID }),
      ),
    ).rejects.toMatchObject({ code: "domain_not_verified", status: 409 });
    expect(memory.records.some((record) => record.itemType === "inbox-message")).toBe(false);
  });

  it("does not apply suppressions created in sibling environments", async () => {
    const blockedAddress = "sibling-blocked@example.com";
    const suppressionClaim = makeUniqueClaimRecord(
      {
        namespace: `organization:${ORGANIZATION_ID}:project:${PROJECT_ID}:environment:01ARZ3NDEKTSV4RRFFQ69G5FBB:inbox-suppression`,
        ownerId: SUPPRESSION_ID as Ulid,
        ownerItemType: "inbox-suppression",
        ownerPk: `ORG#${ORGANIZATION_ID}#ENV#01ARZ3NDEKTSV4RRFFQ69G5FBB`,
        ownerSk: `INBOX-SUPPRESSION#${SUPPRESSION_ID}`,
        ownerTable: "control",
        value: createHash("sha256").update(blockedAddress).digest("hex"),
      },
      NOW,
    ) as unknown as PlatformRecord;
    const memory = database([
      inboxDomainRecord(scope, domain()),
      inboxRecord(scope, inbox()),
      inboxPolicyRecord(scope, policy({ warmupStage: "production" })),
      suppressionClaim,
    ]);
    const service = createDynamoAgentEmailApplicationService({
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute(
        "sendInboxMessage",
        invocation({ subject: "Suppressed", to: [blockedAddress] }, { inboxId: INBOX_ID }),
      ),
    ).resolves.toMatchObject({ status: "queued" });
    expect(memory.records.some((record) => record.itemType === "inbox-message")).toBe(true);
  });

  it("neutralizes spreadsheet formulas in CSV export cells", () => {
    expect(agentEmailCsvCell('=HYPERLINK("https://example.invalid")')).toBe(
      '"\'=HYPERLINK(""https://example.invalid"")"',
    );
    expect(agentEmailCsvCell('customer",=CMD()')).toBe('"customer"",=CMD()"');
    expect(agentEmailCsvCell("\n=CMD()")).toBe('"\'\n=CMD()"');
    expect(agentEmailCsvCell("normal")).toBe('"normal"');
  });

  it.each([["refreshDomain", undefined, { domainId: DOMAIN_ID }]] as const)(
    "fails closed when production provider composition for %s is absent",
    async (operation, body, parameters) => {
      const memory = database([inboxDomainRecord(scope, domain()), inboxRecord(scope, inbox())]);
      const service = createDynamoAgentEmailApplicationService({
        database: memory.service,
        now: () => new Date(NOW),
        endUserKeys: testEndUserKeys,
      });

      expect(
        service.execute(operation as AgentEmailApiOperation, invocation(body, parameters)),
      ).rejects.toMatchObject({ status: 503 });
    },
  );
});
