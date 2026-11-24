import {
  ChannelDeliveryLookupRecord,
  ChannelDeliveryRecord,
  SlackAgentStreamRecord,
  tableForItemType,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TableName,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";

import type { ChannelDeliveryDependencies } from "./delivery.ts";

const id = (suffix: string) => `01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}` as Ulid;
export const timestamp = "2026-07-25T12:00:00.000Z";

function memoryDatabase(initial: readonly PlatformRecord[]) {
  const records = new Map<string, PlatformRecord>();
  const transactionInputs: TransactionOperation[][] = [];
  const recordKey = (table: TableName, pk: string, sk: string) => `${table}\0${pk}\0${sk}`;
  const put = (record: PlatformRecord) =>
    records.set(recordKey(tableForItemType(record.itemType), record.pk, record.sk), record);
  initial.forEach(put);
  const database: DynamoDatabaseService = {
    deleteRecord: async (record) => {
      records.delete(recordKey(tableForItemType(record.itemType), record.pk, record.sk));
    },
    getRecord: async (table, key) => records.get(recordKey(table, key.pk, key.sk)),
    putRecord: async (record) => void put(record),
    queryRecords: async () => ({ items: [] }),
    transactWrite: async (operations: readonly TransactionOperation[]) => {
      transactionInputs.push([...operations]);
      for (const operation of operations) {
        if (operation.kind === "condition-check") {
          const current = records.get(
            recordKey(operation.table, operation.key.pk, operation.key.sk),
          );
          const values = operation.expressionAttributeValues;
          if (
            values?.[":failed"] === "failed" &&
            (current?.itemType !== "slack-agent-stream" ||
              current.data.status !== "failed" ||
              !current.data.fallbackAllowed ||
              current.data.version !== values[":version"])
          ) {
            throw new Error("simulated Slack fallback stream conflict");
          }
          continue;
        }
        const record = operation.record;
        const key = recordKey(tableForItemType(record.itemType), record.pk, record.sk);
        if ("previousRecord" in operation && operation.previousRecord) {
          const previous = records.get(key);
          if (
            !previous ||
            (previous.data as { readonly version?: number }).version !==
              (operation.previousRecord.data as { readonly version?: number }).version
          ) {
            throw new Error("simulated optimistic conflict");
          }
        }
        if (operation.kind === "delete") records.delete(key);
        else records.set(key, record);
      }
    },
  };
  return { database, records, transactionInputs };
}

export type MemoryDatabase = ReturnType<typeof memoryDatabase>;

export function fixture(
  status: "failed" | "queued" | "sending" | "sent" = "queued",
  payload: unknown = { chat_id: "123", text: "Deployment complete." },
  provider: "aws_end_user_messaging_rcs" | "telegram" = "telegram",
) {
  const scope = {
    environmentId: id("3"),
    organizationId: id("1"),
    projectId: id("2"),
  };
  const credentialRef = { credentialId: id("8"), generation: 1, store: "dynamodb-kms" as const };
  const delivery = Schema.decodeUnknownSync(ChannelDeliveryRecord)(
    withCanonicalRecordKeys({
      data: {
        ...scope,
        attempts: status === "queued" ? 0 : 1,
        bindingId: id("4"),
        channel: provider === "aws_end_user_messaging_rcs" ? "rcs" : "telegram",
        contentPreview: "Deployment complete.",
        createdAt: timestamp,
        credentialRef,
        externalThreadKey: "telegram:chat:123",
        ...(status === "failed" ? { failedAt: timestamp } : {}),
        id: id("5"),
        idempotencyKey: "delivery-1",
        provider,
        providerPayload: payload,
        ...(status === "sent" ? { sentAt: timestamp } : {}),
        status,
        threadId: id("6"),
        runId: id("7"),
        updatedAt: timestamp,
        version: status === "queued" ? 0 : 1,
      },
      itemType: "channel-delivery" as const,
    }),
  );
  const lookup = Schema.decodeUnknownSync(ChannelDeliveryLookupRecord)(
    withCanonicalRecordKeys({
      data: {
        ...scope,
        createdAt: timestamp,
        deliveryId: delivery.data.id,
        idempotencyKey: delivery.data.idempotencyKey,
        runId: delivery.data.runId,
        threadId: delivery.data.threadId,
      },
      itemType: "channel-delivery-lookup" as const,
    }),
  );
  const memory = memoryDatabase([delivery, lookup]);
  const message = {
    deliveryId: delivery.data.id,
    runId: delivery.data.runId,
    ...scope,
  };
  const event = {
    Records: [{ body: JSON.stringify(message), messageId: "queue-message-1" }],
  };
  let generatedId = 20;
  let milliseconds = Date.parse(timestamp) + 1_000;
  const dependencies: ChannelDeliveryDependencies = {
    database: memory.database,
    generateId: async () => id(String(generatedId++)),
    now: () => new Date(milliseconds++),
    readCredential: async () => ({ botToken: "telegram-token" }),
  };
  return { dependencies, delivery, event, memory };
}

export function persistedDelivery(memory: ReturnType<typeof memoryDatabase>) {
  return [...memory.records.values()].find(
    (record): record is Extract<PlatformRecord, { readonly itemType: "channel-delivery" }> =>
      record.itemType === "channel-delivery",
  );
}

export function addStoppedSlackStream(
  memory: ReturnType<typeof memoryDatabase>,
  delivery: Extract<PlatformRecord, { readonly itemType: "channel-delivery" }>,
) {
  const record = Schema.decodeUnknownSync(SlackAgentStreamRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: id("9"),
        bindingId: delivery.data.bindingId!,
        bindingVersion: 0,
        channelId: "C1",
        createdAt: timestamp,
        credentialRef: delivery.data.credentialRef as Extract<
          NonNullable<typeof delivery.data.credentialRef>,
          { readonly store: "dynamodb-kms" }
        >,
        environmentId: delivery.data.environmentId,
        fallbackAllowed: false,
        id: delivery.data.runId,
        organizationId: delivery.data.organizationId,
        projectId: delivery.data.projectId,
        recipientTeamId: "T1",
        recipientUserId: "U1",
        runAttempt: 0,
        runClaimedAt: timestamp,
        runExecutionVersion: 1,
        runId: delivery.data.runId,
        status: "stopped" as const,
        streamTs: "1721609601.000001",
        threadId: delivery.data.threadId,
        threadTs: "1721609600.123456",
        updatedAt: timestamp,
        version: 2,
      },
      itemType: "slack-agent-stream" as const,
    }),
  );
  memory.records.set(`${tableForItemType(record.itemType)}\0${record.pk}\0${record.sk}`, record);
  return record;
}
