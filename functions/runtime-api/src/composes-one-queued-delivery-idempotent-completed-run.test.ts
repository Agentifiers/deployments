import {
  ChannelBindingRecord,
  CredentialVaultEntryRecord,
  RunLookupRecord,
  RunRecord,
  WorkspaceRecord,
  tableForItemType,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TableName,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  archiveChannelBinding,
  composeChannelDelivery,
  createChannelBinding,
  loadChannelDelivery,
  publicDelivery,
  updateChannelBinding,
  verifyChannelBinding,
} from "./channels.ts";
import type { RuntimeApiDependencies, RuntimeApiPrincipal } from "./runtime-support.ts";

const ids = Array.from(
  { length: 40 },
  (_, index) => `01ARZ3NDEKTSV4RRFFQ69G6F${String(index).padStart(2, "0")}`,
) as Ulid[];
const timestamp = "2026-07-25T12:00:00.000Z";

function memoryDatabase(initial: readonly PlatformRecord[]) {
  const records = new Map<string, PlatformRecord>();
  const transactions: TransactionOperation[][] = [];
  const recordKey = (table: TableName, pk: string, sk: string) => `${table}\0${pk}\0${sk}`;
  const put = (record: PlatformRecord) =>
    records.set(recordKey(tableForItemType(record.itemType), record.pk, record.sk), record);
  initial.forEach(put);

  const database: DynamoDatabaseService = {
    deleteRecord: async (record) => {
      records.delete(recordKey(tableForItemType(record.itemType), record.pk, record.sk));
    },
    getRecord: async (table, key) => {
      const record = records.get(recordKey(table, key.pk, key.sk));
      return record;
    },
    putRecord: async (record) => void put(record),
    queryRecords: async (table, input) => {
      const values = input.ExpressionAttributeValues as
        | Readonly<Record<string, unknown>>
        | undefined;
      const pk = values?.[":pk"];
      const prefix = values?.[":prefix"];
      return {
        items: [...records.values()].filter(
          (record) =>
            tableForItemType(record.itemType) === table &&
            (typeof pk !== "string" || record.pk === pk) &&
            (typeof prefix !== "string" || record.sk.startsWith(prefix)),
        ),
      };
    },
    transactWrite: async (operations: readonly TransactionOperation[]) => {
      transactions.push([...operations]);
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        const record = operation.record;
        const key = recordKey(tableForItemType(record.itemType), record.pk, record.sk);
        if (operation.conditionExpression?.includes("attribute_not_exists") && records.has(key)) {
          throw new Error("simulated create conflict");
        }
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
  return { database, put, records, transactions };
}

function fixture() {
  const scope = { environmentId: ids[2]!, organizationId: ids[0]!, projectId: ids[1]! };
  const deployment = withCanonicalRecordKeys({
    data: {
      ...scope,
      agentDefinitionId: ids[3]!,
      agentReleaseId: ids[4]!,
      createdAt: timestamp,
      currentState: "ready" as const,
      desiredState: "running" as const,
      id: ids[5]!,
      updatedAt: timestamp,
      version: 0,
    },
    itemType: "agent-deployment" as const,
  }) as Extract<PlatformRecord, { readonly itemType: "agent-deployment" }>;
  const memory = memoryDatabase([deployment]);
  let generatedId = 20;
  const dependencies = {
    database: memory.database,
    generateId: async () => ids[generatedId++]!,
    now: () => new Date(timestamp),
  } as unknown as RuntimeApiDependencies;
  const principal = { credential: {}, scope, serviceAccount: {} } as RuntimeApiPrincipal;
  const createInput = {
    agentDefinitionId: ids[3]!,
    agentDeploymentId: ids[5]!,
    channel: "telegram",
    externalChannelId: "telegram-bot",
    externalThreadKey: "telegram:chat:123",
    externalWorkspaceId: "telegram-bot",
    idempotencyKey: "binding-1",
    provider: "telegram",
  } as const;
  return { createInput, dependencies, memory, principal, scope };
}

function workspaceRecord(
  scope: { readonly environmentId: Ulid; readonly organizationId: Ulid; readonly projectId: Ulid },
  workspaceId: Ulid,
  status: "active" | "archived" = "active",
) {
  return Schema.decodeUnknownSync(WorkspaceRecord)(
    withCanonicalRecordKeys({
      data: {
        ...scope,
        createdAt: timestamp,
        id: workspaceId,
        name: "Channel workspace",
        slug: `channel-${workspaceId.toLowerCase()}`,
        status,
        updatedAt: timestamp,
        version: status === "active" ? 0 : 1,
      },
      itemType: "workspace" as const,
    }),
  );
}

function attachCredential(
  value: Awaited<ReturnType<typeof createChannelBinding>>,
  memory: ReturnType<typeof memoryDatabase>,
  scope: { readonly environmentId: Ulid; readonly organizationId: Ulid; readonly projectId: Ulid },
  expiresAt?: string,
) {
  const credentialRecord = withCanonicalRecordKeys({
    data: {
      ...scope,
      algorithm: "AES-256-GCM" as const,
      authTag: "auth-tag",
      ciphertext: "ciphertext",
      createdAt: timestamp,
      encryptedDataKey: "encrypted-data-key",
      encryptionContextHash: "context-hash",
      ...(expiresAt ? { expiresAt } : {}),
      generation: 1,
      id: ids[6]!,
      iv: "initialization-vector",
      kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/test",
      ownerId: value.data.id,
      ownerType: "channel-binding" as const,
      purpose: "channel-runtime",
      status: "active" as const,
      updatedAt: timestamp,
      version: 0,
    },
    itemType: "credential-vault-entry" as const,
    ...(expiresAt ? { ttl: Math.floor(Date.parse(expiresAt) / 1_000) } : {}),
  });
  // Effect 4 beta wraps present optional fields while running envelope refinements, so mirror the
  // production vault writer, which persists this already-canonical record without decoding again.
  const credential = expiresAt
    ? (credentialRecord as typeof CredentialVaultEntryRecord.Type)
    : Schema.decodeUnknownSync(CredentialVaultEntryRecord)(credentialRecord);
  const binding = Schema.decodeUnknownSync(ChannelBindingRecord)(
    withCanonicalRecordKeys({
      data: {
        ...value.data,
        credentialRef: {
          credentialId: credential.data.id,
          generation: credential.data.generation,
          store: "dynamodb-kms" as const,
        },
        version: value.data.version + 1,
      },
      itemType: "channel-binding" as const,
    }),
  );
  memory.put(credential);
  memory.put(binding);
  return binding;
}

describe("runtime channel bindings", () => {
  test("composes one queued delivery for an idempotent completed-run response", async () => {
    const { createInput, dependencies, memory, principal, scope } = fixture();
    const created = await createChannelBinding(principal, createInput, dependencies);
    attachCredential(created, memory, scope);
    const verified = await verifyChannelBinding(principal, created.data.id, dependencies);
    const run = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...scope,
          agentDeploymentId: ids[5]!,
          agentReleaseId: ids[4]!,
          attempt: 1,
          captureMode: "metadata-only" as const,
          completedAt: timestamp,
          createdAt: timestamp,
          executor: "hosted",
          id: ids[8]!,
          idempotencyKey: "run-1",
          priority: 1,
          redactionPolicyVersion: 1 as const,
          schemaVersion: 1 as const,
          spanId: "0123456789abcdef",
          status: "completed" as const,
          threadId: ids[9]!,
          trigger: "chat" as const,
          traceId: "0123456789abcdef0123456789abcdef",
          updatedAt: timestamp,
          version: 2,
        },
        itemType: "run" as const,
      }),
    );
    memory.put(run);
    memory.put(
      Schema.decodeUnknownSync(RunLookupRecord)(
        withCanonicalRecordKeys({
          data: {
            ...scope,
            createdAt: run.data.createdAt,
            idempotencyKey: run.data.idempotencyKey,
            runId: run.data.id,
            threadId: run.data.threadId,
          },
          itemType: "run-lookup" as const,
        }),
      ),
    );
    const input = {
      content: "x".repeat(4_097),
      externalThreadKey: "telegram:chat:123",
      idempotencyKey: "delivery-1",
      runId: run.data.id,
      threadId: run.data.threadId,
    };

    const first = await composeChannelDelivery(principal, verified.data.id, input, dependencies);
    const replay = await composeChannelDelivery(principal, verified.data.id, input, dependencies);

    expect(first.duplicate).toBe(false);
    expect(replay.duplicate).toBe(true);
    expect(replay.delivery.data.id).toBe(first.delivery.data.id);
    expect(publicDelivery(first.delivery)).not.toHaveProperty("requestHash");
    expect(publicDelivery(first.delivery)).not.toHaveProperty("credentialRef");
    expect(publicDelivery(first.delivery)).not.toHaveProperty("providerPayload");
    expect(first.delivery.data).toMatchObject({
      credentialRef: verified.data.credentialRef,
      providerPayload: expect.any(Array),
    });
    const deliveryTransaction = memory.transactions.find((operations) =>
      operations.some(
        (operation) =>
          operation.kind === "put" &&
          operation.record.itemType === "channel-delivery" &&
          operation.record.data.id === first.delivery.data.id,
      ),
    );
    expect(deliveryTransaction).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expressionAttributeValues: {
            ":active": "active",
            ":version": verified.data.version,
          },
          kind: "condition-check",
          table: "control",
        }),
      ]),
    );
    expect(
      composeChannelDelivery(
        principal,
        verified.data.id,
        { ...input, content: "Different response" },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect(
      [...memory.records.values()].filter((record) => record.itemType === "channel-delivery"),
    ).toHaveLength(1);
    expect(
      [...memory.records.values()].filter(
        (record) => record.itemType === "channel-delivery-lookup",
      ),
    ).toHaveLength(1);
    expect(
      [...memory.records.values()].filter(
        (record) =>
          record.itemType === "semantic-event" &&
          record.data.eventType === "channel.delivery.queued",
      ),
    ).toHaveLength(1);
    const queued = [...memory.records.values()].find(
      (record): record is Extract<PlatformRecord, { readonly itemType: "semantic-event" }> =>
        record.itemType === "semantic-event" && record.data.eventType === "channel.delivery.queued",
    );
    expect(queued?.data.payload).toEqual({
      channelBindingId: verified.data.id,
      deliveryId: first.delivery.data.id,
      provider: "telegram",
      runId: input.runId,
      status: "queued",
    });

    let queries = 0;
    const directLookupDependencies = {
      ...dependencies,
      database: {
        ...memory.database,
        queryRecords: () => {
          queries += 1;
          return Promise.reject(new Error("delivery lookup must not query"));
        },
      },
    } as RuntimeApiDependencies;
    expect(
      (
        await loadChannelDelivery(
          principal,
          run.data.id,
          first.delivery.data.id,
          directLookupDependencies,
        )
      ).data.id,
    ).toBe(first.delivery.data.id);
    expect(queries).toBe(0);
    expect(
      composeChannelDelivery(
        principal,
        verified.data.id,
        { ...input, content: "x".repeat(40_001), idempotencyKey: "too-long" },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });

    const unrelatedRun = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...run.data,
          agentDeploymentId: ids[10]!,
          id: ids[11]!,
          idempotencyKey: "unrelated-run",
          threadId: ids[12]!,
        },
        itemType: "run" as const,
      }),
    );
    memory.put(unrelatedRun);
    memory.put(
      Schema.decodeUnknownSync(RunLookupRecord)(
        withCanonicalRecordKeys({
          data: {
            ...scope,
            createdAt: unrelatedRun.data.createdAt,
            idempotencyKey: unrelatedRun.data.idempotencyKey,
            runId: unrelatedRun.data.id,
            threadId: unrelatedRun.data.threadId,
          },
          itemType: "run-lookup" as const,
        }),
      ),
    );
    expect(
      composeChannelDelivery(
        principal,
        verified.data.id,
        {
          ...input,
          idempotencyKey: "unrelated-delivery",
          runId: unrelatedRun.data.id,
          threadId: unrelatedRun.data.threadId,
        },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "run_binding_mismatch", status: 409 });

    await updateChannelBinding(
      principal,
      verified.data.id,
      { externalChannelId: null },
      dependencies,
    );
    const verifiedTelegramWithoutExternalChannel = await verifyChannelBinding(
      principal,
      verified.data.id,
      dependencies,
    );
    const telegramWithoutExternalChannel = await composeChannelDelivery(
      principal,
      verified.data.id,
      { ...input, idempotencyKey: "telegram-without-external-channel" },
      dependencies,
    );
    expect(telegramWithoutExternalChannel.duplicate).toBe(false);

    const incompleteAwsRcsBinding = await createChannelBinding(
      principal,
      {
        agentDefinitionId: createInput.agentDefinitionId,
        agentDeploymentId: createInput.agentDeploymentId,
        channel: "rcs",
        externalThreadKey: "+16025550123",
        idempotencyKey: "aws-rcs-binding-without-identity",
        provider: "aws_end_user_messaging_rcs",
      },
      dependencies,
    );
    attachCredential(incompleteAwsRcsBinding, memory, scope);
    expect(
      verifyChannelBinding(principal, incompleteAwsRcsBinding.data.id, dependencies),
    ).rejects.toMatchObject({ code: "binding_incomplete", status: 409 });

    const largeContent = "😀".repeat(40_000);
    const largeDelivery = await composeChannelDelivery(
      principal,
      verifiedTelegramWithoutExternalChannel.data.id,
      { ...input, content: largeContent, idempotencyKey: "telegram-large-delivery" },
      dependencies,
    );
    const largePayload = largeDelivery.delivery.data.providerPayload as readonly {
      readonly text: string;
    }[];
    expect(largePayload.map((part) => part.text).join("")).toBe(largeContent);
    expect(largePayload.every((part) => Array.from(part.text).length <= 4_096)).toBe(true);

    const workspaceId = ids[13]!;
    memory.put(workspaceRecord(scope, workspaceId));
    const workspaceBinding = Schema.decodeUnknownSync(ChannelBindingRecord)(
      withCanonicalRecordKeys({
        data: {
          ...verifiedTelegramWithoutExternalChannel.data,
          workspaceId,
        },
        itemType: "channel-binding" as const,
      }),
    );
    memory.put(workspaceBinding);
    expect(
      composeChannelDelivery(
        principal,
        workspaceBinding.data.id,
        { ...input, idempotencyKey: "workspace-mismatch" },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "run_binding_mismatch", status: 409 });

    await archiveChannelBinding(principal, verified.data.id, dependencies);
    const replayAfterArchive = await composeChannelDelivery(
      principal,
      verified.data.id,
      input,
      dependencies,
    );
    expect(replayAfterArchive).toMatchObject({
      delivery: { data: { id: first.delivery.data.id } },
      duplicate: true,
    });
  });
});
