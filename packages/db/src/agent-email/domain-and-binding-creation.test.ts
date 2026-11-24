import type {
  AgentEmailDomainEvent,
  AgentEmailDomainRecord,
  AgentEmailInboxRecord,
  AgentEmailPlacementRecord,
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

import { makeAgentEmailDynamoRepository } from "./persistence.ts";
import { inboxDomainRecord, inboxRecord } from "./record-mapping.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;
const INBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid;
const DOMAIN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ" as Ulid;
const MESSAGE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0" as Ulid;
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB2" as Ulid;
const USAGE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB3" as Ulid;
const ATTACHMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB4" as Ulid;

const SECOND_INBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB8" as Ulid;
const NOW = "2026-07-20T00:00:00.000Z";

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
  const reads: Array<{
    readonly consistentRead: boolean | undefined;
    readonly key: RecordKey;
  }> = [];
  let queryIndex = 0;
  const service: DynamoDatabaseService = {
    deleteRecord: () => Promise.resolve(),
    getRecord: (_table, key: RecordKey, consistentRead) => {
      reads.push({ consistentRead, key });
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
  return { queries, reads, service, transactions };
}

function inbox(id: Ulid = INBOX_ID): AgentEmailInboxRecord {
  return {
    address: id === INBOX_ID ? "agent@agents.example.com" : "second@agents.example.com",
    createdAt: NOW,
    domainId: DOMAIN_ID,
    id,
    localPart: id === INBOX_ID ? "agent" : "second",
    metadata: {},
    organizationId: ORGANIZATION_ID,
    status: "active",
    updatedAt: NOW,
  };
}

function domain(providerManaged = false): AgentEmailDomainRecord {
  return {
    createdAt: NOW,
    dnsRecords: [],
    domain: "mail.example.com",
    id: DOMAIN_ID,
    mailFromDomain: "bounce.mail.example.com",
    organizationId: ORGANIZATION_ID,
    providerManaged,
    providerMetadata: {},
    status: "pending",
    updatedAt: NOW,
  };
}

function domainCreatedEvent(): AgentEmailDomainEvent {
  return {
    aggregateId: DOMAIN_ID,
    aggregateType: "agent_email",
    eventId: EVENT_ID,
    eventType: "agent-email.domain-created",
    payload: {
      occurredAt: NOW,
      organizationId: ORGANIZATION_ID,
      resourceId: DOMAIN_ID,
      resourceType: "domain",
      status: "pending",
      version: 1,
    },
    source: "deployments-ai.agent-email",
  };
}

function domainUpdatedEvent(
  status: AgentEmailDomainRecord["status"],
  eventId: Ulid,
): AgentEmailDomainEvent {
  return {
    aggregateId: DOMAIN_ID,
    aggregateType: "agent_email",
    eventId,
    eventType: "agent-email.domain-updated",
    payload: {
      occurredAt: NOW,
      organizationId: ORGANIZATION_ID,
      resourceId: DOMAIN_ID,
      resourceType: "domain",
      status,
      version: 1,
    },
    source: "deployments-ai.agent-email",
  };
}

function placement(isDefault: boolean): AgentEmailPlacementRecord {
  return {
    createdAt: NOW,
    dedicatedPool: false,
    id: MESSAGE_ID,
    isDefault,
    name: "Primary",
    organizationId: ORGANIZATION_ID,
    provider: "ses",
    providerMetadata: {},
    region: "us-east-1",
    status: "active",
    updatedAt: NOW,
  };
}

describe("agent email DynamoDB creation", () => {
  it("reserves a pending custom domain only within its environment", async () => {
    const { service, transactions } = database();
    const repository = makeAgentEmailDynamoRepository(service, {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    });

    await repository.createDomain(domain(), domainCreatedEvent());

    const claim = transactions[0]?.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "unique-claim",
    );
    expect(
      claim?.kind === "put" && claim.record.itemType === "unique-claim"
        ? {
            namespace: claim.record.data.namespace,
            value: claim.record.data.value,
          }
        : undefined,
    ).toEqual({
      namespace: `organization:${ORGANIZATION_ID}:project:${PROJECT_ID}:environment:${ENVIRONMENT_ID}:inbox-domain`,
      value: "mail.example.com",
    });
  });

  it("claims a custom domain on first verification and releases it on revocation", async () => {
    const previous = inboxDomainRecord(
      {
        environmentId: ENVIRONMENT_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
      },
      domain(),
    );
    const { service, transactions } = database({ records: [previous] });
    const repository = makeAgentEmailDynamoRepository(service, {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    });

    await repository.updateDomain(
      { ...domain(), status: "verified", verifiedAt: NOW },
      domainUpdatedEvent("verified", EVENT_ID),
    );
    await repository.updateDomain(
      { ...domain(), status: "revoked", verifiedAt: NOW },
      domainUpdatedEvent("revoked", USAGE_ID),
    );

    const claimed = transactions[0]?.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "unique-claim",
    );
    expect(
      claimed?.kind === "put" && claimed.record.itemType === "unique-claim"
        ? {
            namespace: claimed.record.data.namespace,
            value: claimed.record.data.value,
          }
        : undefined,
    ).toEqual({
      namespace: "inbox-domain",
      value: "mail.example.com",
    });
    expect(
      transactions[1]?.some(
        (operation) => operation.kind === "delete" && operation.record.itemType === "unique-claim",
      ),
    ).toBe(true);
  });

  it("allows provider-managed hosted domains to be shared by environments", async () => {
    const { service, transactions } = database();
    const repository = makeAgentEmailDynamoRepository(service, {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    });

    await repository.createDomain(domain(true), domainCreatedEvent());

    expect(
      transactions[0]?.some(
        (operation) => operation.kind === "put" && operation.record.itemType === "unique-claim",
      ),
    ).toBe(false);
  });

  it("scopes default placement claims to the environment", async () => {
    const { service, transactions } = database();
    const repository = makeAgentEmailDynamoRepository(service, {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    });

    await repository.createPlacement(placement(true));

    const claim = transactions[0]?.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "unique-claim",
    );
    expect(
      claim?.kind === "put" && claim.record.itemType === "unique-claim"
        ? claim.record.data.namespace
        : undefined,
    ).toBe(
      `organization:${ORGANIZATION_ID}:project:${PROJECT_ID}:environment:${ENVIRONMENT_ID}:default-inbox-placement`,
    );
  });

  it("creates an inbox binding with a singular external-ID claim", async () => {
    const { queries, service, transactions } = database({
      records: [
        inboxRecord(
          { environmentId: ENVIRONMENT_ID, organizationId: ORGANIZATION_ID, projectId: PROJECT_ID },
          inbox(),
        ),
      ],
    });
    const repository = makeAgentEmailDynamoRepository(service, {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    });

    await repository.createBinding({
      agentDeploymentId: MESSAGE_ID,
      bindingType: "platform_agent",
      createdAt: NOW,
      externalId: SECOND_INBOX_ID,
      id: ATTACHMENT_ID,
      inboxId: INBOX_ID,
      metadata: {},
      organizationId: ORGANIZATION_ID,
      status: "active",
      updatedAt: NOW,
    });

    expect(transactions).toHaveLength(1);
    expect(
      transactions[0]?.flatMap((operation) =>
        operation.kind === "condition-check" ? [] : [operation.record.itemType],
      ),
    ).toEqual(["inbox-binding", "inbox", "inbox-control-created-index", "unique-claim"]);
    const claim = transactions[0]?.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "unique-claim",
    );
    expect(
      claim?.kind === "put" && claim.record.itemType === "unique-claim"
        ? claim.record.data.namespace
        : undefined,
    ).toBe(
      `organization:${ORGANIZATION_ID}:project:${PROJECT_ID}:environment:${ENVIRONMENT_ID}:inbox-binding:platform_agent`,
    );
    const binding = transactions[0]?.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "inbox-binding",
    );
    expect(
      binding?.kind === "put" && binding.record.itemType === "inbox-binding"
        ? binding.record.data
        : undefined,
    ).toMatchObject({
      agentDefinitionId: SECOND_INBOX_ID,
      agentDeploymentId: MESSAGE_ID,
      status: "active",
    });
    const updatedInbox = transactions[0]?.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "inbox",
    );
    expect(
      updatedInbox?.kind === "put" && updatedInbox.record.itemType === "inbox"
        ? updatedInbox.record.data.activePlatformBindingCount
        : undefined,
    ).toBe(1);
    expect(updatedInbox?.kind === "put" ? updatedInbox.previousRecord?.itemType : undefined).toBe(
      "inbox",
    );
    expect(repository.listActivePlatformBindingsForInbox(INBOX_ID)).resolves.toHaveLength(1);
    expect(queries.at(-1)).toMatchObject({
      ExpressionAttributeValues: {
        ":pk": `ENV#${ENVIRONMENT_ID}#INBOX#${INBOX_ID}#BINDINGS`,
        ":sk": "INBOX-BINDING#active#platform_agent#",
      },
      IndexName: "gsi1",
      Limit: 101,
    });
  });
});
