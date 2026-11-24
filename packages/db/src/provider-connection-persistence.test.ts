import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { DynamoDatabaseService, TransactionOperation } from "./client-types.ts";
import { Ulid } from "./ids.ts";
import { makeProviderConnectionPersistence } from "./provider-connection-persistence.ts";
import { ConnectionCapabilityRecord, ProviderConnectionRecord } from "./records/control.ts";
import { withCanonicalRecordKeys } from "./records/index.ts";
import { makeSemanticEventRecord } from "./semantic-event-storage.ts";

const ids = Array.from({ length: 6 }, (_, index) =>
  Schema.decodeUnknownSync(Ulid)(`01ARZ3NDEKTSV4RRFFQ69G5F${String(index).padStart(2, "0")}`),
);
const occurredAt = "2026-08-25T00:00:00.000Z";
const connection = Schema.decodeUnknownSync(ProviderConnectionRecord)(
  withCanonicalRecordKeys({
    itemType: "provider-connection" as const,
    data: {
      authMethod: "none",
      createdAt: occurredAt,
      environmentId: ids[0]!,
      externalAccountId: ids[1]!,
      id: ids[1]!,
      lastVerifiedAt: occurredAt,
      organizationId: ids[2]!,
      projectId: ids[3]!,
      providerKey: "extension_callback",
      scopes: ["callback:context:read"],
      status: "active" as const,
      updatedAt: occurredAt,
      version: 0,
    },
  }),
);
const capability = Schema.decodeUnknownSync(ConnectionCapabilityRecord)(
  withCanonicalRecordKeys({
    itemType: "connection-capability" as const,
    data: {
      connectionId: connection.data.id,
      createdAt: occurredAt,
      environmentId: connection.data.environmentId,
      id: ids[4]!,
      metadata: { method: "none" },
      organizationId: connection.data.organizationId,
      projectId: connection.data.projectId,
      providerKey: connection.data.providerKey,
      scopes: connection.data.scopes,
      status: "active" as const,
      updatedAt: occurredAt,
      verificationVersion: 0,
      version: 0,
    },
  }),
);

describe("provider connection persistence", () => {
  test("atomically creates a credentialless connection, capability, and uniqueness claim", async () => {
    let committed: readonly TransactionOperation[] | undefined;
    let clientRequestToken: string | undefined;
    const database = {
      transactWrite: async (operations: readonly TransactionOperation[], token?: string) => {
        committed = operations;
        clientRequestToken = token;
      },
    } as unknown as DynamoDatabaseService;

    await makeProviderConnectionPersistence(database).createCredentialless({
      capability,
      connection,
      eventId: ids[5]!,
      idempotency: {
        environmentId: connection.data.environmentId,
        key: "request-1",
        operation: "provider-connection.create",
        principalId: "principal-1",
      },
      occurredAt,
    });

    expect(committed?.map((operation) => operation.kind)).toEqual(["put", "put", "put", "put"]);
    expect(
      committed
        ?.filter((operation) => operation.kind === "put")
        .map((operation) => operation.record.itemType),
    ).toEqual(["provider-connection", "unique-claim", "connection-capability", "semantic-event"]);
    expect(
      committed?.find(
        (operation) => operation.kind === "put" && operation.record.itemType === "semantic-event",
      ),
    ).toMatchObject({
      record: {
        data: {
          aggregateId: connection.data.id,
          eventType: "provider.connection.authorized",
        },
      },
    });
    expect(clientRequestToken).toHaveLength(36);
  });

  test("rejects a capability from another provider before persistence", async () => {
    let calls = 0;
    const database = {
      transactWrite: async () => {
        calls += 1;
      },
    } as unknown as DynamoDatabaseService;
    const mismatched = Schema.decodeUnknownSync(ConnectionCapabilityRecord)(
      withCanonicalRecordKeys({
        ...capability,
        data: { ...capability.data, providerKey: "different_provider" },
      }),
    );

    expect(
      makeProviderConnectionPersistence(database).createCredentialless({
        capability: mismatched,
        connection,
        eventId: ids[5]!,
        occurredAt,
      }),
    ).rejects.toThrow("does not match its owner");
    expect(calls).toBe(0);
  });

  test("atomically disconnects a connection and appends its next semantic event", async () => {
    const disconnectAt = "2026-08-25T01:00:00.000Z";
    const disconnected = Schema.decodeUnknownSync(ProviderConnectionRecord)(
      withCanonicalRecordKeys({
        ...connection,
        data: {
          ...connection.data,
          status: "disconnected" as const,
          updatedAt: disconnectAt,
          version: 1,
        },
      }),
    );
    const authorized = makeSemanticEventRecord({
      aggregateId: connection.data.id,
      aggregateType: "provider-connection",
      aggregateVersion: 1,
      environmentId: connection.data.environmentId,
      eventId: ids[5]!,
      eventType: "provider.connection.authorized",
      occurredAt,
      organizationId: connection.data.organizationId,
      payload: {
        connectionId: connection.data.id,
        providerKey: connection.data.providerKey,
      },
      projectId: connection.data.projectId,
    });
    let committed: readonly TransactionOperation[] | undefined;
    const database = {
      queryRecords: async () => ({ items: [authorized] }),
      transactWrite: async (operations: readonly TransactionOperation[]) => {
        committed = operations;
      },
    } as unknown as DynamoDatabaseService;

    await makeProviderConnectionPersistence(database).disconnect({
      connection: disconnected,
      eventId: ids[4]!,
      occurredAt: disconnectAt,
      previousConnection: connection,
    });

    expect(committed?.map((operation) => operation.kind)).toEqual(["put", "delete", "put"]);
    expect(
      committed?.find(
        (operation) => operation.kind === "put" && operation.record.itemType === "semantic-event",
      ),
    ).toMatchObject({
      record: {
        data: {
          aggregateVersion: 2,
          eventType: "provider.connection.disconnected",
        },
      },
    });
  });
});
