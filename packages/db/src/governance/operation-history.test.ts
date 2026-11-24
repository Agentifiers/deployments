import { describe, expect, test } from "bun:test";
import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { key } from "../keys.ts";
import type { GovernanceOperation } from "./contracts.ts";
import { makeDynamoGovernanceStore, operationRecord } from "./dynamo-store.ts";
import { governanceOperationHistoryRecord } from "./operation-history.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAT";
const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const GRANT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAG";
const TABLES = { control: "control", events: "events", execution: "execution", usage: "usage" };

function operation(
  id: string,
  kind: GovernanceOperation["kind"],
  status: GovernanceOperation["status"],
  createdAt: string,
  organizationId = ORGANIZATION_ID,
): GovernanceOperation {
  return {
    createdAt,
    id,
    idempotencyKey: `request-${id}`,
    kind,
    organizationId,
    requestedByPrincipalId: PRINCIPAL_ID,
    status,
    updatedAt: createdAt,
    version: 1,
  };
}

/** Minimal control-table double: base-table prefix queries, item gets and consistent batch gets. */
function controlTable(items: readonly Record<string, unknown>[]) {
  const transactions: TransactWriteCommand[] = [];
  const client = {
    send: async (command: unknown) => {
      if (command instanceof TransactWriteCommand) {
        transactions.push(command);
        return {};
      }
      if (command instanceof GetCommand) {
        const wanted = command.input.Key;
        return { Item: items.find((item) => item.pk === wanted?.pk && item.sk === wanted?.sk) };
      }
      if (command instanceof BatchGetCommand) {
        const request = command.input.RequestItems?.control;
        const keys = request?.Keys ?? [];
        return {
          Responses: {
            control: items.filter((item) =>
              keys.some((wanted) => wanted.pk === item.pk && wanted.sk === item.sk),
            ),
          },
        };
      }
      if (command instanceof QueryCommand) {
        const input = command.input;
        const values = input.ExpressionAttributeValues ?? {};
        const ascending = items
          .filter(
            (item) =>
              item.pk === values[":pk"] && String(item.sk).startsWith(String(values[":prefix"])),
          )
          .toSorted((left, right) => String(left.sk).localeCompare(String(right.sk)));
        const ordered = input.ScanIndexForward === false ? ascending.toReversed() : ascending;
        const start = input.ExclusiveStartKey
          ? ordered.findIndex((item) => item.sk === input.ExclusiveStartKey?.sk) + 1
          : 0;
        const page = ordered.slice(start, start + (input.Limit ?? ordered.length));
        const last = page.at(-1);
        return {
          Items: page,
          ...(last && start + page.length < ordered.length
            ? { LastEvaluatedKey: { pk: last.pk, sk: last.sk } }
            : {}),
        };
      }
      throw new Error("Unexpected DynamoDB command.");
    },
  } as unknown as DynamoDBDocumentClient;
  return { client, transactions };
}

function stored(operations: readonly GovernanceOperation[]) {
  return operations.flatMap((entry) => [
    operationRecord(entry) as unknown as Record<string, unknown>,
    governanceOperationHistoryRecord(entry) as unknown as Record<string, unknown>,
  ]);
}

const firstExport = operation(
  "01ARZ3NDEKTSV4RRFFQ69G5FA1",
  "tenant-export",
  "failed",
  "2026-08-21T12:00:00.000Z",
);
const auditExport = operation(
  "01ARZ3NDEKTSV4RRFFQ69G5FA2",
  "audit-export",
  "pending",
  "2026-08-21T12:01:00.000Z",
);
const erasure = operation(
  "01ARZ3NDEKTSV4RRFFQ69G5FA3",
  "tenant-erasure",
  "running",
  "2026-08-21T12:02:00.000Z",
);
const secondExport = operation(
  "01ARZ3NDEKTSV4RRFFQ69G5FA4",
  "tenant-export",
  "pending",
  "2026-08-21T12:03:00.000Z",
);
const foreignExport = operation(
  "01ARZ3NDEKTSV4RRFFQ69G5FA5",
  "tenant-export",
  "pending",
  "2026-08-21T12:04:00.000Z",
  OTHER_ORGANIZATION_ID,
);

describe("governance operation history", () => {
  test("lists every kind newest first, filters, and pages without leaking other tenants", async () => {
    const { client } = controlTable(
      stored([firstExport, auditExport, erasure, secondExport, foreignExport]),
    );
    const store = makeDynamoGovernanceStore(client, TABLES);
    const ids = (page: { readonly items: readonly GovernanceOperation[] }) =>
      page.items.map((item) => item.id);

    expect(ids(await store.listOperations({ limit: 50, organizationId: ORGANIZATION_ID }))).toEqual(
      [secondExport.id, erasure.id, auditExport.id, firstExport.id],
    );
    expect(
      ids(
        await store.listOperations({
          kind: "tenant-export",
          limit: 50,
          organizationId: ORGANIZATION_ID,
        }),
      ),
    ).toEqual([secondExport.id, firstExport.id]);
    expect(
      ids(
        await store.listOperations({
          limit: 50,
          organizationId: ORGANIZATION_ID,
          status: "pending",
        }),
      ),
    ).toEqual([secondExport.id, auditExport.id]);

    const firstPage = await store.listOperations({ limit: 3, organizationId: ORGANIZATION_ID });
    expect(ids(firstPage)).toEqual([secondExport.id, erasure.id, auditExport.id]);
    expect(firstPage.cursor).toBeString();
    const secondPage = await store.listOperations({
      cursor: firstPage.cursor!,
      limit: 3,
      organizationId: ORGANIZATION_ID,
    });
    expect(ids(secondPage)).toEqual([firstExport.id]);
    expect(secondPage.cursor).toBeUndefined();

    // A cursor carries only a position; replayed against another tenant it stays in that tenant.
    const replayed = await store.listOperations({
      cursor: firstPage.cursor!,
      limit: 3,
      organizationId: OTHER_ORGANIZATION_ID,
    });
    expect(replayed.items.every((item) => item.organizationId === OTHER_ORGANIZATION_ID)).toBe(
      true,
    );
  });

  test("skips pointers whose operation retention already removed and rejects forged cursors", async () => {
    const { client } = controlTable([
      ...stored([secondExport]),
      governanceOperationHistoryRecord(firstExport) as unknown as Record<string, unknown>,
    ]);
    const store = makeDynamoGovernanceStore(client, TABLES);

    expect(
      (await store.listOperations({ limit: 50, organizationId: ORGANIZATION_ID })).items.map(
        (item) => item.id,
      ),
    ).toEqual([secondExport.id]);
    for (const cursor of [
      "not-json",
      Buffer.from(JSON.stringify({ createdAt: "yesterday", id: firstExport.id })).toString(
        "base64url",
      ),
      Buffer.from(
        JSON.stringify({ createdAt: firstExport.createdAt, id: firstExport.id, pk: "ORG#x" }),
      ).toString("base64url"),
    ]) {
      expect(
        store.listOperations({ cursor, limit: 10, organizationId: ORGANIZATION_ID }),
      ).rejects.toMatchObject({ code: "invalid_cursor" });
    }
  });

  test("creates an erasure with its history pointer and request audit in one transaction", async () => {
    const { client, transactions } = controlTable([]);
    const store = makeDynamoGovernanceStore(client, TABLES, {
      generateId: () => "01ARZ3NDEKTSV4RRFFQ69G5FA9",
    });

    await store.createOperation(erasure);

    expect(transactions).toHaveLength(1);
    const puts = (transactions[0]?.input.TransactItems ?? []).flatMap((item) =>
      item.Put ? [item.Put] : [],
    );
    expect(puts.map((put) => [put.TableName, put.Item?.itemType])).toEqual([
      ["control", "governance-operation"],
      ["control", "governance-tenant-record"],
      ["control", "governance-operation-history"],
      ["control", "governance-tenant-record"],
      ["events", "audit-event"],
      ["control", "governance-tenant-record"],
    ]);
    expect(puts.find((put) => put.Item?.itemType === "audit-event")?.Item).toMatchObject({
      data: {
        action: "tenant-erasure.requested",
        actor: { id: PRINCIPAL_ID, type: "principal" },
        eventId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
        resourceId: erasure.id,
        resourceType: "governance-operation",
      },
      pk: key("ORG", ORGANIZATION_ID),
    });
  });

  test("audits a retention policy revision in the policy transaction", async () => {
    const { client, transactions } = controlTable([]);
    const store = makeDynamoGovernanceStore(client, TABLES, {
      generateId: () => "01ARZ3NDEKTSV4RRFFQ69G5FA8",
    });

    await store.putRetentionPolicy(
      {
        artifacts: 30,
        audit: 400,
        createdAt: "2026-08-21T12:00:00.000Z",
        events: 90,
        messages: 365,
        organizationId: ORGANIZATION_ID,
        runs: 365,
        threads: 365,
        updatedAt: "2026-08-21T13:00:00.000Z",
        updatedByPrincipalId: PRINCIPAL_ID,
        version: 2,
      },
      1,
    );

    const audit = transactions[0]?.input.TransactItems?.find(
      (item) => item.Put?.Item?.itemType === "audit-event",
    )?.Put;
    expect(audit).toMatchObject({
      ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      Item: {
        data: {
          action: "retention-policy.updated",
          changes: { artifacts: 30, audit: 400, version: 2 },
          occurredAt: "2026-08-21T13:00:00.000Z",
          resourceType: "retention-policy",
        },
      },
      TableName: "events",
    });
  });

  test("names the operator access on the audits of requests and policy changes made under it", async () => {
    const { client, transactions } = controlTable([]);
    const store = makeDynamoGovernanceStore(client, TABLES, {
      generateId: () => "01ARZ3NDEKTSV4RRFFQ69G5FA7",
    });

    await store.createOperation(erasure, GRANT_ID);
    await store.putRetentionPolicy(
      {
        artifacts: 30,
        audit: 400,
        createdAt: "2026-08-21T12:00:00.000Z",
        events: 90,
        messages: 365,
        organizationId: ORGANIZATION_ID,
        runs: 365,
        threads: 365,
        updatedAt: "2026-08-21T13:00:00.000Z",
        updatedByPrincipalId: PRINCIPAL_ID,
        version: 1,
      },
      undefined,
      undefined,
      GRANT_ID,
    );

    const actors = transactions.map(
      (transaction) =>
        transaction.input.TransactItems?.find((item) => item.Put?.Item?.itemType === "audit-event")
          ?.Put?.Item?.data.actor,
    );
    expect(actors).toEqual([
      { id: PRINCIPAL_ID, operatorAccessGrantId: GRANT_ID, type: "principal" },
      { id: PRINCIPAL_ID, operatorAccessGrantId: GRANT_ID, type: "principal" },
    ]);
  });
});
