import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDatabaseService, TableNames } from "../client-types.ts";
import { makeDynamoDatabase } from "../dynamo-database.ts";
import {
  makeDynamoGovernanceContext,
  operationFromRecord,
  type DynamoGovernanceStoreOptions,
} from "../governance/dynamo-store.ts";
import { makeIdGenerator } from "../ids.ts";
import { key } from "../keys.ts";
import { tableForItemType } from "../records/index.ts";
import type { ConversationErasureRequests, ConversationErasureStore } from "./contracts.ts";
import { listThreadInventoryPage } from "./inventory.ts";
import { fenceItem, finalizeOperation, listItems, planEndUserItems, replaceItem } from "./items.ts";
import { listMailItems, planConversationMail } from "./mail-planning.ts";
import {
  finishInboxMessage,
  prepareInboxDraftErasure,
  prepareInboxMessageErasure,
  readRetentionCleanups,
  replaceMailItem,
  settleInboxThread,
  sweepInboxThread,
} from "./mail-sweep.ts";
import { parseUlid, readOperationRecord } from "./operations.ts";
import {
  readThreadTombstone,
  requestEndUserErasure,
  requestThreadErasure,
  type ErasureRequestContext,
} from "./requests.ts";

function erasureRequests(context: ErasureRequestContext): ConversationErasureRequests {
  return {
    async getOperation(organizationId, operationId) {
      const record = await readOperationRecord(context.database, organizationId, operationId);
      return record ? operationFromRecord(record) : undefined;
    },
    async isOrganizationInboxAddress(organizationId, address) {
      const claim = await context.database.getRecord("control", {
        pk: key("UNIQUE", "inbox-address"),
        sk: key("VALUE", address.trim().toLowerCase()),
      });
      if (claim?.itemType !== "unique-claim" || claim.data.ownerItemType !== "inbox") return false;
      const inbox = await context.database.getRecord(claim.data.ownerTable, {
        pk: claim.data.ownerPk,
        sk: claim.data.ownerSk,
      });
      return inbox?.itemType === "inbox" && inbox.data.organizationId === organizationId;
    },
    requestEndUserErasure: (input) => requestEndUserErasure(context, input),
    requestThreadErasure: (input) => requestThreadErasure(context, input),
  };
}

export function makeConversationErasureRequests(
  database: DynamoDatabaseService,
  options: { readonly generateId?: () => string; readonly now?: () => Date } = {},
): ConversationErasureRequests {
  const ids = makeIdGenerator();
  const generateId = options.generateId ?? (() => ids.generate());
  return erasureRequests({
    database,
    generateId: () => parseUlid(generateId()),
    now: options.now ?? (() => new Date()),
  });
}

export function makeConversationErasureStore(
  client: DynamoDBDocumentClient,
  tableNames: TableNames,
  options: DynamoGovernanceStoreOptions = {},
): ConversationErasureStore {
  const governance = makeDynamoGovernanceContext(client, tableNames, options);
  const database = makeDynamoDatabase(client, tableNames);
  const context = {
    database,
    generateId: () => parseUlid(governance.generateId()),
    now: governance.now,
  };
  return {
    ...erasureRequests(context),
    fenceItem: (operation, item) => fenceItem(context, operation, item),
    finalize: (operation) => finalizeOperation(context, operation),
    getThreadTombstone: (organizationId, threadId) =>
      readThreadTombstone(database, organizationId, threadId),
    async revokeStreamSessions(sessions) {
      let revoked = 0;
      for (const { record } of sessions) {
        if (record.itemType !== "stream-session" || !("store" in record.data.credentialRef)) {
          continue;
        }
        const entry = await database.getRecord("control", {
          pk: key("ORG", record.data.organizationId, "ENV", record.data.environmentId),
          sk: key("CREDENTIAL-VAULT-ENTRY", record.data.credentialRef.credentialId),
        });
        if (entry?.itemType !== "credential-vault-entry") continue;
        await database.transactWrite([{ kind: "delete", record: entry }]);
        revoked += 1;
      }
      return revoked;
    },
    async listIngressRouteRecords(organizationId, ingressRouteId) {
      const records = [];
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await database.queryRecords("execution", {
          ConsistentRead: true,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          ExpressionAttributeNames: { "#pk": "pk" },
          ExpressionAttributeValues: { ":pk": key("ORG", organizationId, "ROUTE", ingressRouteId) },
          KeyConditionExpression: "#pk = :pk",
        });
        records.push(
          ...page.items.map((record) => ({ record, table: tableForItemType(record.itemType) })),
        );
        exclusiveStartKey = page.lastEvaluatedKey;
      } while (exclusiveStartKey);
      return records;
    },
    listItems: (operation) => listItems(database, operation),
    listThreadRecords: (organizationId, threadId, cursor) =>
      listThreadInventoryPage(governance, organizationId, threadId, cursor),
    planEndUserItems: (operation) => planEndUserItems(context, operation),
    replaceItem: (item, changes) =>
      replaceItem(database, item, changes, governance.now().toISOString()),
    async planConversationMail(operation, item) {
      await planConversationMail(context, operation, item);
      const now = governance.now().toISOString();
      return replaceItem(database, item, { mailPlannedAt: now }, now);
    },
    listMailItems: (operation) => listMailItems(database, operation),
    replaceMailItem: (item, changes) =>
      replaceMailItem(database, item, changes, governance.now().toISOString()),
    sweepInboxThread: (operation, item) => sweepInboxThread(context, operation, item),
    prepareInboxMessageErasure: (operation, message) =>
      prepareInboxMessageErasure(context, operation, message),
    prepareInboxDraftErasure: (item) => prepareInboxDraftErasure(context, item),
    finishInboxMessage: (item, message) =>
      finishInboxMessage(database, item, message, governance.now().toISOString()),
    settleInboxThread: (item) => settleInboxThread(context, item),
    readRetentionCleanups: (organizationId, ids) =>
      readRetentionCleanups(database, organizationId, ids),
  };
}
