import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { Schema } from "effect";
import { key } from "../keys.ts";
import { GovernanceOperationHistoryRecord } from "../records/governance.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import type { DynamoGovernanceContext } from "./dynamo-store.ts";
import { decodeRecord, operationFromRecord } from "./dynamo-store.ts";
import { batchGetAll } from "./inventory-resolution.ts";
import {
  GovernanceError,
  type GovernanceOperation,
  type GovernanceOperationListQuery,
  type GovernanceStore,
} from "./contracts.ts";

/** Bounds filtered reads so a sparse filter cannot fan out into an unbounded partition walk. */
const MAX_HISTORY_PHYSICAL_PAGES = 10;
const MAX_CURSOR_LENGTH = 1_024;
const OPERATION_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const HISTORY_SORT_PREFIX = `${key("GOVERNANCE-OPERATION-HISTORY")}#`;

type GovernanceOperationHistory = Extract<
  PlatformRecord,
  { readonly itemType: "governance-operation-history" }
>;

/**
 * Create-only history pointer for a newly created operation. Writers put it in the same
 * transaction that creates the operation (erasure) or makes it dispatch-ready (exports).
 */
export function governanceOperationHistoryRecord(operation: GovernanceOperation) {
  return Schema.decodeUnknownSync(GovernanceOperationHistoryRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: operation.createdAt,
        kind: operation.kind,
        operationId: operation.id,
        organizationId: operation.organizationId,
      },
      itemType: "governance-operation-history" as const,
    }),
  );
}

function invalidCursor() {
  return new GovernanceError("invalid_cursor", "The governance operation cursor is invalid.");
}

/**
 * Cursors carry only the position (creation time and operation ID). The query key is rebuilt for
 * the requested organization, so a cursor can never page into another organization's history.
 */
function historyStartKey(cursor: string, organizationId: string) {
  if (cursor.length > MAX_CURSOR_LENGTH) throw invalidCursor();
  let position: unknown;
  try {
    position = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  if (!position || typeof position !== "object" || Array.isArray(position)) throw invalidCursor();
  const { createdAt, id } = position as Readonly<Record<string, unknown>>;
  if (
    Object.keys(position).length !== 2 ||
    typeof createdAt !== "string" ||
    typeof id !== "string" ||
    !OPERATION_ID.test(id) ||
    !Number.isFinite(Date.parse(createdAt)) ||
    new Date(Date.parse(createdAt)).toISOString() !== createdAt
  ) {
    throw invalidCursor();
  }
  return {
    pk: key("ORG", organizationId),
    sk: key("GOVERNANCE-OPERATION-HISTORY", createdAt, id),
  };
}

function historyCursor(lastEvaluatedKey: Record<string, unknown>) {
  const sortKey = lastEvaluatedKey.sk;
  if (typeof sortKey !== "string") throw new Error("Governance history page key is malformed.");
  const [, createdAt, id] = sortKey.split("#").map((part) => decodeURIComponent(part));
  return Buffer.from(JSON.stringify({ createdAt, id })).toString("base64url");
}

export function makeGovernanceOperationHistory(context: DynamoGovernanceContext) {
  const { client, tableNames } = context;

  async function operationsFor(organizationId: string, entries: GovernanceOperationHistory[]) {
    const items = await batchGetAll(context, {
      [tableNames.control]: {
        ConsistentRead: true,
        Keys: entries.map((entry) => ({
          pk: key("ORG", organizationId),
          sk: key("GOVERNANCE-OPERATION", entry.data.operationId),
        })),
      },
    });
    const operations = new Map<string, GovernanceOperation>();
    for (const item of items) {
      const record = await decodeRecord(item);
      if (
        record.itemType === "governance-operation" &&
        record.data.organizationId === organizationId
      ) {
        operations.set(record.data.id, operationFromRecord(record));
      }
    }
    return operations;
  }

  return {
    async listOperations(query: GovernanceOperationListQuery) {
      const items: GovernanceOperation[] = [];
      let exclusiveStartKey: Record<string, unknown> | undefined = query.cursor
        ? historyStartKey(query.cursor, query.organizationId)
        : undefined;
      let physicalPages = 0;
      do {
        const result = await client.send(
          new QueryCommand({
            ConsistentRead: true,
            ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
            ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
            ExpressionAttributeValues: {
              ":pk": key("ORG", query.organizationId),
              ":prefix": HISTORY_SORT_PREFIX,
            },
            KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
            // Each physical page reads at most the remaining slots, so the continuation key is
            // never past an unreturned match.
            Limit: query.limit - items.length,
            ScanIndexForward: false,
            TableName: tableNames.control,
          }),
        );
        const entries: GovernanceOperationHistory[] = [];
        for (const item of result.Items ?? []) {
          const record = await decodeRecord(item);
          if (
            record.itemType === "governance-operation-history" &&
            record.data.organizationId === query.organizationId &&
            (query.kind === undefined || record.data.kind === query.kind)
          ) {
            entries.push(record);
          }
        }
        const operations =
          entries.length > 0 ? await operationsFor(query.organizationId, entries) : new Map();
        for (const entry of entries) {
          // Retention may already have removed an operation whose pointer is still listed.
          const operation = operations.get(entry.data.operationId);
          if (operation && (query.status === undefined || operation.status === query.status)) {
            items.push(operation);
          }
        }
        exclusiveStartKey = result.LastEvaluatedKey;
        physicalPages += 1;
      } while (
        items.length < query.limit &&
        exclusiveStartKey &&
        physicalPages < MAX_HISTORY_PHYSICAL_PAGES
      );
      return {
        ...(exclusiveStartKey ? { cursor: historyCursor(exclusiveStartKey) } : {}),
        items,
      };
    },
  } satisfies Pick<GovernanceStore, "listOperations">;
}
