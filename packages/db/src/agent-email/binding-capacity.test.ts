import type { AgentEmailInboxRecord } from "@deployments-ai/agent-email";
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
import { inboxBindingRecord, inboxRecord } from "./record-mapping.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;
const INBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid;
const DOMAIN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ" as Ulid;
const MESSAGE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0" as Ulid;
const THREAD_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB1" as Ulid;
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

describe("agent email DynamoDB creation", () => {
  it("paginates size-limited active binding queries before enforcing the count bound", async () => {
    const bindingScope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const first = inboxBindingRecord(bindingScope, {
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
    const second = inboxBindingRecord(bindingScope, {
      agentDeploymentId: THREAD_ID,
      bindingType: "platform_agent",
      createdAt: NOW,
      externalId: EVENT_ID,
      id: USAGE_ID,
      inboxId: INBOX_ID,
      metadata: {},
      organizationId: ORGANIZATION_ID,
      status: "active",
      updatedAt: NOW,
    });
    const paginationKey = { gsi1pk: first.gsi1pk!, gsi1sk: first.gsi1sk! };
    const { queries, service } = database({
      queryResults: [{ items: [first], lastEvaluatedKey: paginationKey }, { items: [second] }],
      records: [inboxRecord(bindingScope, inbox(), undefined, 2), first, second],
    });
    const repository = makeAgentEmailDynamoRepository(service, bindingScope);

    expect(repository.listActivePlatformBindingsForInbox(INBOX_ID)).resolves.toEqual([
      first,
      second,
    ]);
    expect(queries).toHaveLength(2);
    expect(queries[1]).toMatchObject({
      ExclusiveStartKey: paginationKey,
      Limit: 101,
    });
  });

  it("retries an active binding index that has not caught up with the inbox count", async () => {
    const bindingScope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const binding = inboxBindingRecord(bindingScope, {
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
    const storedInbox = inboxRecord(bindingScope, inbox(), undefined, 1);
    const { queries, reads, service } = database({
      queryResults: [{ items: [] }, { items: [binding] }],
      records: [storedInbox, binding],
    });
    const repository = makeAgentEmailDynamoRepository(service, bindingScope);

    expect(repository.listActivePlatformBindingsForInbox(INBOX_ID)).resolves.toEqual([binding]);
    expect(queries).toHaveLength(2);
    expect(reads.every((read) => read.consistentRead === true)).toBe(true);
  });

  it("strongly verifies and ignores an archived binding still present in the active index", async () => {
    const bindingScope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const activeIndexEntry = inboxBindingRecord(bindingScope, {
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
    const archivedBinding = inboxBindingRecord(bindingScope, {
      agentDeploymentId: MESSAGE_ID,
      bindingType: "platform_agent",
      createdAt: NOW,
      externalId: SECOND_INBOX_ID,
      id: ATTACHMENT_ID,
      inboxId: INBOX_ID,
      metadata: {},
      organizationId: ORGANIZATION_ID,
      status: "archived",
      updatedAt: "2026-07-20T00:01:00.000Z",
    });
    const storedInbox = inboxRecord(bindingScope, inbox(), undefined, 0);
    const { queries, reads, service } = database({
      queryResults: [{ items: [activeIndexEntry] }],
      records: [storedInbox, archivedBinding],
    });
    const repository = makeAgentEmailDynamoRepository(service, bindingScope);

    expect(repository.listActivePlatformBindingsForInbox(INBOX_ID)).resolves.toEqual([]);
    expect(queries).toHaveLength(1);
    expect(reads.every((read) => read.consistentRead === true)).toBe(true);
  });

  it("accepts a complete verified result with stale extra active-index rows", async () => {
    const bindingScope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const bindings = Array.from({ length: 100 }, (_, index) =>
      inboxBindingRecord(bindingScope, {
        agentDeploymentId: MESSAGE_ID,
        bindingType: "platform_agent",
        createdAt: NOW,
        externalId: SECOND_INBOX_ID,
        id: String(index).padStart(26, "0") as Ulid,
        inboxId: INBOX_ID,
        metadata: {},
        organizationId: ORGANIZATION_ID,
        status: "active",
        updatedAt: NOW,
      }),
    );
    const staleIndexEntries = Array.from({ length: 2 }, (_, index) =>
      inboxBindingRecord(bindingScope, {
        agentDeploymentId: MESSAGE_ID,
        bindingType: "platform_agent",
        createdAt: NOW,
        externalId: SECOND_INBOX_ID,
        id: String(100 + index).padStart(26, "0") as Ulid,
        inboxId: INBOX_ID,
        metadata: {},
        organizationId: ORGANIZATION_ID,
        status: "active",
        updatedAt: NOW,
      }),
    );
    const archivedBindings = staleIndexEntries.map((entry) =>
      inboxBindingRecord(bindingScope, {
        agentDeploymentId: MESSAGE_ID,
        bindingType: "platform_agent",
        createdAt: NOW,
        externalId: SECOND_INBOX_ID,
        id: entry.data.id,
        inboxId: INBOX_ID,
        metadata: {},
        organizationId: ORGANIZATION_ID,
        status: "archived",
        updatedAt: "2026-07-20T00:01:00.000Z",
      }),
    );
    const paginationKey = {
      gsi1pk: staleIndexEntries[1]!.gsi1pk!,
      gsi1sk: staleIndexEntries[1]!.gsi1sk!,
    };
    const { queries, service } = database({
      queryResults: [
        {
          items: [...bindings.slice(0, 99), ...staleIndexEntries],
          lastEvaluatedKey: paginationKey,
        },
        { items: bindings.slice(99) },
      ],
      records: [
        inboxRecord(bindingScope, inbox(), undefined, 100),
        ...bindings,
        ...archivedBindings,
      ],
    });
    const repository = makeAgentEmailDynamoRepository(service, bindingScope);

    expect(repository.listActivePlatformBindingsForInbox(INBOX_ID)).resolves.toEqual(bindings);
    expect(queries).toHaveLength(2);
  });

  it("rejects an authoritative active binding count that exceeds the bound", async () => {
    const bindingScope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const { queries, service } = database({
      records: [inboxRecord(bindingScope, inbox(), undefined, 101)],
    });
    const repository = makeAgentEmailDynamoRepository(service, bindingScope);

    expect(repository.listActivePlatformBindingsForInbox(INBOX_ID)).rejects.toThrow(
      "exceeds the active platform-agent binding limit of 100",
    );
    expect(queries).toHaveLength(0);
  });
});
