import {
  ChannelBindingRecord,
  CredentialVaultEntryRecord,
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
  createChannelBinding,
  publicBinding,
  slackThreadTs,
  updateChannelBinding,
  verifyChannelBinding,
} from "./channels.ts";
import type { RuntimeApiDependencies, RuntimeApiPrincipal } from "./runtime-support.ts";

const ids = Array.from(
  { length: 30 },
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
  const principal = {
    credential: {},
    scope,
    serviceAccount: { data: { id: ids[19]! } },
  } as RuntimeApiPrincipal;
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
  test("distinguishes Slack root routes from threaded routes", () => {
    expect(slackThreadTs("slack:T1:thread:C1")).toBeUndefined();
    expect(slackThreadTs("slack:T1:thread:C1:1.2")).toBe("1.2");
    expect(slackThreadTs("slack:T1:shared:thread:C1")).toBeUndefined();
    expect(slackThreadTs("slack:T1:shared:thread:C1:1.3")).toBe("1.3");
  });

  test("creates disabled compatible bindings and keeps credentials private", async () => {
    const { createInput, dependencies, memory, principal, scope } = fixture();
    const created = await createChannelBinding(principal, createInput, dependencies);
    const replay = await createChannelBinding(principal, createInput, dependencies);

    expect(created.data.status).toBe("disabled");
    expect(replay.data.id).toBe(created.data.id);
    expect(publicBinding(created)).toMatchObject({
      credentialAttached: false,
      object: "channel-binding",
      status: "disabled",
    });
    expect(publicBinding(created)).not.toHaveProperty("credentialRef");
    expect(publicBinding(created)).not.toHaveProperty("creationHash");
    expect(created.data.creationHash).toMatch(/^[a-f0-9]{64}$/u);

    expect(
      createChannelBinding(
        principal,
        { ...createInput, externalChannelId: "different-bot" },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });

    expect(
      createChannelBinding(
        principal,
        { ...createInput, channel: "slack", idempotencyKey: "incompatible" },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "invalid_channel_provider", status: 400 });
    expect(
      createChannelBinding(
        principal,
        { ...createInput, agentDefinitionId: ids[7]!, idempotencyKey: "wrong-agent" },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "deployment_unavailable", status: 409 });
    expect(
      createChannelBinding(
        principal,
        { ...createInput, externalThreadKey: "x".repeat(1_025), idempotencyKey: "oversized" },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(
      createChannelBinding(
        principal,
        { ...createInput, idempotencyKey: "invalid-metadata", metadata: [] },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(
      createChannelBinding(
        principal,
        {
          ...createInput,
          idempotencyKey: "oversized-metadata",
          metadata: { payload: "x".repeat(32 * 1_024) },
        },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });

    const workspaceId = ids[13]!;
    memory.put(workspaceRecord(scope, workspaceId, "archived"));
    expect(
      createChannelBinding(
        principal,
        {
          ...createInput,
          idempotencyKey: "archived-workspace-binding",
          workspaceId,
        },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "workspace_unavailable", status: 409 });
    memory.put(workspaceRecord(scope, workspaceId));
    const workspaceBinding = await createChannelBinding(
      principal,
      {
        ...createInput,
        idempotencyKey: "workspace-binding",
        workspaceId,
      },
      dependencies,
    );
    expect(workspaceBinding.data.workspaceId).toBe(workspaceId);
    const workspaceTransaction = memory.transactions.find((operations) =>
      operations.some(
        (operation) =>
          operation.kind === "put" &&
          operation.record.itemType === "channel-binding" &&
          operation.record.data.id === workspaceBinding.data.id,
      ),
    );
    expect(workspaceTransaction).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expressionAttributeValues: { ":active": "active", ":version": 0 },
          key: {
            pk: workspaceRecord(scope, workspaceId).pk,
            sk: workspaceRecord(scope, workspaceId).sk,
          },
          kind: "condition-check",
          table: "control",
        }),
      ]),
    );
    attachCredential(workspaceBinding, memory, scope);
    memory.put(workspaceRecord(scope, workspaceId, "archived"));
    expect(
      verifyChannelBinding(principal, workspaceBinding.data.id, dependencies),
    ).rejects.toMatchObject({ code: "workspace_unavailable", status: 409 });
  });

  test("normalizes metadata for creation replays and validates nullable updates", async () => {
    const { createInput, dependencies, principal } = fixture();
    const created = await createChannelBinding(
      principal,
      {
        ...createInput,
        metadata: { nested: { a: 1, b: true }, tags: ["one", "two"] },
      },
      dependencies,
    );
    const replay = await createChannelBinding(
      principal,
      {
        ...createInput,
        metadata: { tags: ["one", "two"], nested: { b: true, a: 1 } },
      },
      dependencies,
    );
    expect(replay.data.id).toBe(created.data.id);

    expect(
      updateChannelBinding(principal, created.data.id, { metadata: "invalid" }, dependencies),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(
      updateChannelBinding(principal, created.data.id, { metadata: [] }, dependencies),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(
      updateChannelBinding(
        principal,
        created.data.id,
        { metadata: { payload: "x".repeat(32 * 1_024) } },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });

    const cleared = await updateChannelBinding(
      principal,
      created.data.id,
      { metadata: null },
      dependencies,
    );
    expect(cleared.data.metadata).toBeUndefined();
  });

  test("verifies credentials, disables changed routing, and archives terminally", async () => {
    const { createInput, dependencies, memory, principal, scope } = fixture();
    const created = await createChannelBinding(principal, createInput, dependencies);
    attachCredential(created, memory, scope);

    const verified = await verifyChannelBinding(principal, created.data.id, dependencies);
    expect(verified.data).toMatchObject({ lastVerifiedAt: timestamp, status: "active" });
    expect(publicBinding(verified)).toMatchObject({ credentialAttached: true, status: "active" });
    expect(publicBinding(verified)).not.toHaveProperty("credentialRef");
    const verificationTransaction = memory.transactions.find((operations) =>
      operations.some(
        (operation) =>
          operation.kind === "put" &&
          operation.record.itemType === "channel-binding" &&
          operation.record.data.status === "active",
      ),
    );
    expect(verificationTransaction).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expressionAttributeValues: {
            ":ready": "ready",
            ":running": "running",
            ":version": 0,
          },
          kind: "condition-check",
          table: "control",
        }),
      ]),
    );

    await updateChannelBinding(
      principal,
      created.data.id,
      { externalWorkspaceId: null },
      dependencies,
    );
    expect(verifyChannelBinding(principal, created.data.id, dependencies)).rejects.toMatchObject({
      code: "binding_incomplete",
      status: 409,
    });

    for (const [key, record] of memory.records) {
      if (record.itemType === "agent-deployment") memory.records.delete(key);
    }
    const clearedDeployment = await updateChannelBinding(
      principal,
      created.data.id,
      { agentDeploymentId: null },
      dependencies,
    );
    expect(clearedDeployment.data.agentDeploymentId).toBeUndefined();
    expect(clearedDeployment.data.status).toBe("disabled");

    const changed = await updateChannelBinding(
      principal,
      created.data.id,
      { externalChannelId: "telegram-bot-2" },
      dependencies,
    );
    expect(changed.data.status).toBe("disabled");
    expect(changed.data.lastVerifiedAt).toBeUndefined();

    const archived = await archiveChannelBinding(principal, created.data.id, dependencies);
    expect(archived.data.status).toBe("archived");
    expect(
      updateChannelBinding(principal, created.data.id, { metadata: {} }, dependencies),
    ).rejects.toMatchObject({ code: "binding_archived", status: 409 });
    expect(verifyChannelBinding(principal, created.data.id, dependencies)).rejects.toMatchObject({
      code: "binding_archived",
      status: 409,
    });
  });

  test("normalizes Slack identity metadata and rejects invalid creation or updates", async () => {
    const { createInput, dependencies, principal } = fixture();
    expect(
      createChannelBinding(
        principal,
        {
          ...createInput,
          channel: "slack",
          externalChannelId: "C1",
          externalWorkspaceId: "T1",
          idempotencyKey: "invalid-slack-identity",
          metadata: { slackAgentIdentity: { username: "x".repeat(81) } },
          provider: "slack_edge",
        },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(
      createChannelBinding(
        principal,
        {
          ...createInput,
          channel: "slack",
          externalChannelId: "C1",
          externalWorkspaceId: "T1",
          idempotencyKey: "expanded-slack-icon-url",
          metadata: {
            slackAgentIdentity: {
              iconUrl: `https://cdn.example.test/${"é".repeat(400)}`,
              username: "Rex",
            },
          },
          provider: "slack_edge",
        },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });

    const created = await createChannelBinding(
      principal,
      {
        ...createInput,
        channel: "slack",
        externalChannelId: "C1",
        externalWorkspaceId: "T1",
        idempotencyKey: "valid-slack-identity",
        metadata: {
          slackAgentIdentity: {
            iconUrl: "https://cdn.example.test/agents/rex.png",
            username: "  Rex  ",
          },
        },
        provider: "slack_edge",
      },
      dependencies,
    );
    expect(created.data.metadata?.slackAgentIdentity).toEqual({
      iconUrl: "https://cdn.example.test/agents/rex.png",
      username: "Rex",
    });
    expect(
      updateChannelBinding(
        principal,
        created.data.id,
        {
          metadata: {
            slackAgentIdentity: { iconUrl: "http://example.test/rex.png", username: "Rex" },
          },
        },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
  });

  test("disables an active Slack binding when its stream identity changes", async () => {
    const { createInput, dependencies, memory, principal, scope } = fixture();
    const created = await createChannelBinding(
      principal,
      {
        ...createInput,
        channel: "slack",
        externalChannelId: "C1",
        externalWorkspaceId: "T1",
        idempotencyKey: "slack-identity-reverification",
        metadata: { slackAgentIdentity: { username: "Rex" } },
        provider: "slack_edge",
      },
      dependencies,
    );
    attachCredential(created, memory, scope);
    const credentialReads: unknown[] = [];
    const scopedDependencies = (scopes: readonly string[]) =>
      ({
        ...dependencies,
        credentialVault: {
          read: async (request: unknown) => {
            credentialReads.push(request);
            return {
              createdAt: timestamp,
              generation: 1,
              schemaVersion: 1,
              scopes,
              updatedAt: timestamp,
              values: { botToken: "xoxb-secret" },
            };
          },
        },
      }) as unknown as RuntimeApiDependencies;

    expect(
      verifyChannelBinding(principal, created.data.id, scopedDependencies(["chat:write"])),
    ).rejects.toMatchObject({
      code: "binding_credential_capability_missing",
      status: 409,
    });
    expect(
      verifyChannelBinding(
        principal,
        created.data.id,
        scopedDependencies(["chat:write.customize"]),
      ),
    ).rejects.toMatchObject({
      code: "binding_credential_capability_missing",
      status: 409,
    });
    const identityDependencies = scopedDependencies(["chat:write", "chat:write.customize"]);
    const auditFailureDependencies = {
      ...identityDependencies,
      database: {
        ...identityDependencies.database,
        putRecord: (record: PlatformRecord) =>
          record.itemType === "audit-event"
            ? Promise.reject(new Error("simulated audit failure"))
            : identityDependencies.database.putRecord(record),
      },
    } as RuntimeApiDependencies;
    expect(
      verifyChannelBinding(principal, created.data.id, auditFailureDependencies),
    ).rejects.toThrow("simulated audit failure");
    const verified = await verifyChannelBinding(principal, created.data.id, identityDependencies);
    expect(verified.data).toMatchObject({ lastVerifiedAt: timestamp, status: "active" });
    expect(credentialReads).toHaveLength(4);
    expect(credentialReads.at(-1)).toMatchObject({
      expectedIdentity: {
        ownerId: created.data.id,
        ownerType: "channel-binding",
        projectId: scope.projectId,
        purpose: "channel-runtime",
      },
      reference: { credentialId: ids[6]!, generation: 1, store: "dynamodb-kms" },
    });
    const credentialReadAudits = [...memory.records.values()].filter(
      (record) => record.itemType === "audit-event" && record.data.action === "credential.read",
    );
    expect(credentialReadAudits).toHaveLength(3);
    expect(credentialReadAudits[0]?.data).toMatchObject({
      actor: { id: ids[19]!, type: "service-account" },
      environmentId: scope.environmentId,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      resourceId: ids[6]!,
      resourceType: "credential-vault-entry",
    });

    expect(
      updateChannelBinding(
        principal,
        created.data.id,
        {
          metadata: {
            slackAgentIdentity: { iconUrl: "http://example.test/rex.png", username: "Rex" },
          },
        },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    const sameIdentity = await updateChannelBinding(
      principal,
      created.data.id,
      {
        metadata: {
          auditLabel: "unchanged routing",
          slackAgentIdentity: { username: "Rex" },
        },
      },
      identityDependencies,
    );
    expect(sameIdentity.data).toMatchObject({ lastVerifiedAt: timestamp, status: "active" });

    const changed = await updateChannelBinding(
      principal,
      created.data.id,
      {
        metadata: {
          auditLabel: "changed identity",
          slackAgentIdentity: { iconEmoji: ":robot_face:", username: "Nova" },
        },
      },
      identityDependencies,
    );
    expect(changed.data.status).toBe("disabled");
    expect(changed.data.lastVerifiedAt).toBeUndefined();
    expect(changed.data.metadata?.slackAgentIdentity).toEqual({
      iconEmoji: ":robot_face:",
      username: "Nova",
    });
  });

  test("rejects expired credentials during binding verification", async () => {
    const { createInput, dependencies, memory, principal, scope } = fixture();
    const created = await createChannelBinding(principal, createInput, dependencies);
    attachCredential(created, memory, scope, "2026-07-25T11:59:59.000Z");

    expect(verifyChannelBinding(principal, created.data.id, dependencies)).rejects.toMatchObject({
      code: "binding_credential_invalid",
      status: 409,
    });
  });
});
