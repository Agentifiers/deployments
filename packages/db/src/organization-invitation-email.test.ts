import { DecryptCommand, GenerateDataKeyCommand, type KMSClient } from "@aws-sdk/client-kms";
import { describe, expect, test } from "bun:test";

import { makeDynamoDatabase, prepareDynamoTransactionOperations } from "./client.ts";
import {
  identityEmailDeliveryBinding,
  makeKmsEnvelopeAdapter,
  makeTenancyPersistence,
  organizationInvitationForEmail,
  pendingEmailDeliveryRecord,
  withCanonicalRecordKeys,
  type PersistenceInvocation,
  type PlatformRecord,
  type ProtectedEnvelope,
  type TenancyPersistenceDependencies,
} from "./index.ts";
import {
  fakeDynamoDocumentClient,
  transactionCanceledError,
  type FakeDynamoTransaction,
} from "./testing/dynamo-document-client.fixture.ts";
import { humanPrincipalRecord } from "./tenancy-test-support.ts";

const OWNER_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NOW = new Date("2026-07-25T12:00:00.000Z");
const TOKEN_SUFFIX = "invitation-secret-value";
const identity = { principalId: OWNER_ID, scopes: ["organizations:write"] };
let sequence = 0;

function invocation<Body>(body: Body, organizationId?: string): PersistenceInvocation<Body> {
  return {
    body,
    identity,
    idempotencyKey: `invitation-email-test-${++sequence}`,
    query: {},
    scope: organizationId ? { organizationId } : {},
  };
}

function envelopeAdapter() {
  const dataKey = () => new Uint8Array(32).fill(5);
  const kms = {
    send: async (command: unknown) => {
      if (command instanceof GenerateDataKeyCommand) {
        return { CiphertextBlob: new Uint8Array([9, 9]), Plaintext: dataKey() };
      }
      if (command instanceof DecryptCommand) return { Plaintext: dataKey() };
      throw new Error("Unexpected KMS command.");
    },
  } as unknown as KMSClient;
  return makeKmsEnvelopeAdapter({ keyId: "email-key", kms, stage: "test" });
}

async function seeded(invitationEmail?: TenancyPersistenceDependencies["invitationEmail"]) {
  const dynamo = fakeDynamoDocumentClient();
  const database = makeDynamoDatabase(dynamo.client);
  const service = makeTenancyPersistence({
    database,
    generateInvitationToken: (invitationId) => `dpl_inv_${invitationId}_${TOKEN_SUFFIX}`,
    ...(invitationEmail ? { invitationEmail } : {}),
    now: () => NOW,
  });
  dynamo.put("control", humanPrincipalRecord(OWNER_ID, "owner@example.test"));
  const organization = await service.organizations.create(invocation({ name: "Acme" }));
  return { database, dynamo, organization, service };
}

function putItems(transaction: FakeDynamoTransaction) {
  return (transaction.input.TransactItems ?? []).flatMap((item) =>
    item.Put?.Item
      ? [{ itemType: item.Put.Item.itemType, record: item.Put.Item, table: item.Put.TableName }]
      : [],
  );
}

describe("organization invitation email", () => {
  test("commits the invitation and its protected outbox delivery in one transaction", async () => {
    const envelope = envelopeAdapter();
    const { dynamo, organization, service } = await seeded({ encryptPayload: envelope.encrypt });
    const before = dynamo.transactions.length;

    const issued = await service.organizationInvitations.create(
      invocation({ email: "New.User@Example.test", role: "admin" }, organization.id),
    );

    expect(issued).toMatchObject({ secretVisibleOnce: true, status: "pending" });
    const transactions = dynamo.transactions.slice(before);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]!.outcome).toBe("applied");
    const puts = putItems(transactions[0]!);
    const invitation = puts.find((put) => put.itemType === "organization-invitation");
    const delivery = puts.find((put) => put.itemType === "identity-email-delivery");
    expect(invitation?.table).toBe("control");
    expect(delivery?.table).toBe("identity-email-outbox");
    expect(puts.filter((put) => put.table === "identity-email-outbox")).toHaveLength(1);
    const deliveryData = delivery!.record.data;
    expect(deliveryData).toMatchObject({
      expiresAt: issued.expiresAt,
      invitationId: issued.id,
      organizationId: organization.id,
      principalId: OWNER_ID,
      purpose: "organization-invitation",
      status: "pending",
    });
    expect(deliveryData.actionId).toBeUndefined();
    expect(delivery!.record.gsi1pk).toMatch(/^IDENTITY-EMAIL-PENDING#(0\d|1[0-5])$/u);

    expect(JSON.stringify(transactions[0]!.input)).not.toContain(TOKEN_SUFFIX);
    for (const table of ["control", "events", "identity-email-outbox"]) {
      expect(JSON.stringify(dynamo.items(table))).not.toContain(TOKEN_SUFFIX);
    }
    expect(
      envelope.decrypt(
        deliveryData.protectedPayload as ProtectedEnvelope,
        identityEmailDeliveryBinding(deliveryData as never),
      ),
    ).resolves.toEqual({
      actionToken: issued.token,
      recipient: "new.user@example.test",
      schemaVersion: 1,
    });
  });

  test("without the dependency an invitation writes no outbox delivery", async () => {
    const { dynamo, organization, service } = await seeded();
    const before = dynamo.transactions.length;

    await service.organizationInvitations.create(
      invocation({ email: "plain@example.test", role: "member" }, organization.id),
    );

    const transactions = dynamo.transactions.slice(before);
    expect(transactions).toHaveLength(1);
    expect(putItems(transactions[0]!).map((put) => put.table)).not.toContain(
      "identity-email-outbox",
    );
    expect(dynamo.items("identity-email-outbox")).toEqual([]);
  });

  test("a rejected transaction persists neither the invitation nor its delivery", async () => {
    const envelope = envelopeAdapter();
    const { dynamo, organization, service } = await seeded({ encryptPayload: envelope.encrypt });
    let itemCount = 0;
    dynamo.failNextTransaction(
      (input) => {
        itemCount = input.TransactItems?.length ?? 0;
        return true;
      },
      () =>
        transactionCanceledError(
          Array.from({ length: itemCount }, (_, index) =>
            index === 0 ? "ConditionalCheckFailed" : "None",
          ),
        ),
    );

    expect(
      service.organizationInvitations.create(
        invocation({ email: "rejected@example.test", role: "member" }, organization.id),
      ),
    ).rejects.toMatchObject({ code: "invitation_conflict" });
    expect(
      dynamo.items("control").filter((item) => item.itemType === "organization-invitation"),
    ).toEqual([]);
    expect(dynamo.items("identity-email-outbox")).toEqual([]);
  });

  test("a KMS failure aborts invitation creation before any write", async () => {
    const { dynamo, organization, service } = await seeded({
      encryptPayload: async () => {
        throw new Error("KMS unavailable");
      },
    });
    const before = dynamo.transactions.length;

    expect(
      service.organizationInvitations.create(
        invocation({ email: "kms@example.test", role: "member" }, organization.id),
      ),
    ).rejects.toThrow("KMS unavailable");
    expect(dynamo.transactions.length).toBe(before);
  });

  test("loads the invitation, organization, and inviter for the email worker", async () => {
    const envelope = envelopeAdapter();
    const { database, organization, service } = await seeded({ encryptPayload: envelope.encrypt });
    const issued = await service.organizationInvitations.create(
      invocation({ email: "reader@example.test", role: "viewer" }, organization.id),
    );

    const context = await organizationInvitationForEmail(database, organization.id, issued.id);
    expect(context?.invitation.data).toMatchObject({ email: "reader@example.test", id: issued.id });
    expect(context?.organization.data.name).toBe("Acme");
    expect(context?.inviter?.data.primaryEmail).toBe("owner@example.test");
    expect(
      organizationInvitationForEmail(database, organization.id, "01ARZ3NDEKTSV4RRFFQ69G5FAZ"),
    ).resolves.toBeUndefined();
  });
});

describe("organization invitation delivery invariants", () => {
  const envelope = {
    algorithm: "AES-256-GCM" as const,
    authenticationTag: "tag",
    ciphertext: "ciphertext",
    encryptedDataKey: "key",
    encryptionContextHash: "hash",
    iv: "iv",
    schemaVersion: 1 as const,
  };
  const delivery = pendingEmailDeliveryRecord({
    createdAt: NOW.toISOString(),
    dispatchShard: "04",
    expiresAt: "2026-08-01T12:00:00.000Z",
    id: "01ARZ3NDEKTSV4RRFFQ69G5FB1" as never,
    invitationId: "01ARZ3NDEKTSV4RRFFQ69G5FB2" as never,
    organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FB3" as never,
    principalId: OWNER_ID as never,
    protectedPayload: envelope,
    purpose: "organization-invitation",
  });

  test("an invitation delivery cannot be created without its invitation", async () => {
    expect(
      prepareDynamoTransactionOperations([{ kind: "put", record: delivery }]),
    ).rejects.toBeDefined();
  });

  test("settling an invitation delivery is not fenced on its organization", async () => {
    const {
      nextDispatchAt: _next,
      protectedPayload: _payload,
      ...remaining
    } = delivery.data as unknown as Record<string, unknown>;
    const sent = withCanonicalRecordKeys({
      ...delivery,
      data: { ...remaining, sentAt: NOW.toISOString(), status: "sent", version: 2 },
    }) as PlatformRecord;

    const prepared = await prepareDynamoTransactionOperations([
      { kind: "put", previousRecord: delivery, record: sent },
    ]);
    expect(
      prepared.filter(
        (operation) => operation.kind === "condition-check" && operation.table === "control",
      ),
    ).toEqual([]);
  });
});
