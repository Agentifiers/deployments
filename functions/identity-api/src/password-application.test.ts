import { describe, expect, test } from "bun:test";
import {
  DatabaseError,
  actionRecord,
  bffFenceRecord,
  passwordCredentialRecord,
  principalRecord,
  securityStateRecord,
  type IdentityRepository,
  type IdentityRecord,
  type ProtectedEnvelope,
  type TransactionOperation,
} from "@deployments-ai/db";
import { DEFAULT_PASSWORD_PROFILE, hashPassword, sha256 } from "@deployments-ai/identity";
import { makePasswordApplication } from "./password-application.ts";

const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as never;
const IDS = [
  "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
] as const;
const CREATED_AT = "2026-07-28T00:00:00.000Z";
const NOW = "2026-07-28T00:30:00.000Z";
const envelope: ProtectedEnvelope = {
  algorithm: "AES-256-GCM",
  authenticationTag: "tag",
  ciphertext: "ciphertext",
  encryptedDataKey: "encrypted-key",
  encryptionContextHash: "context-hash",
  iv: "iv",
  schemaVersion: 1,
};

async function loginMaterial() {
  const principal = principalRecord({
    createdAt: CREATED_AT,
    id: PRINCIPAL_ID,
    primaryEmail: "user@example.com",
  });
  const securityState = securityStateRecord({
    createdAt: CREATED_AT,
    credentialVersion: 1,
    emailVerifiedAt: CREATED_AT,
    principalId: PRINCIPAL_ID,
    sessionEpoch: 0,
    version: 1,
  });
  const credential = passwordCredentialRecord({
    createdAt: CREATED_AT,
    passwordHash: await hashPassword("correct horse battery staple", DEFAULT_PASSWORD_PROFILE),
    principalId: PRINCIPAL_ID,
    version: 1,
  });
  const fence = bffFenceRecord({
    createdAt: CREATED_AT,
    principalId: PRINCIPAL_ID,
    principalStatus: "active",
    sessionEpoch: 0,
    version: 1,
  });
  return { credential, fence, principal, securityState };
}

function application(
  repository: IdentityRepository,
  input: {
    readonly encryptEmailPayload?: (
      value: unknown,
      context: Readonly<Record<string, string>>,
    ) => Promise<ProtectedEnvelope>;
  } = {},
) {
  let id = 0;
  return makePasswordApplication(
    {
      encryptEmailPayload: input.encryptEmailPayload ?? (async () => envelope),
      generateId: () => IDS[id++ % IDS.length]! as never,
      now: () => new Date(NOW),
      random: { bytes: (length) => new Uint8Array(length).fill(7) },
      repository,
    },
    {
      actionLifetimeSeconds: 1_800,
      notificationLifetimeSeconds: 86_400,
      passwordProfiles: [DEFAULT_PASSWORD_PROFILE],
    },
  );
}

describe("identity password recovery", () => {
  test("deduplicates an SQS retry with the marker committed beside reset artifacts", async () => {
    const material = await loginMaterial();
    const requestId = "01ARZ3NDEKTSV4RRFFQ69G5FB0" as never;
    let marker: IdentityRecord<"identity-public-email-request"> | undefined;
    const transactions: TransactionOperation[][] = [];
    const repository = {
      loadLoginMaterial: () => Promise.resolve(material),
      loginMaterialVersionChecks: () => [],
      principalForEmailHash: () => Promise.resolve(material.principal),
      publicEmailRequestForId: () => Promise.resolve(marker),
      transact: async (operations: readonly TransactionOperation[]) => {
        transactions.push([...operations]);
        const markerWrite = operations.find(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "identity-public-email-request",
        );
        if (
          markerWrite?.kind === "put" &&
          markerWrite.record.itemType === "identity-public-email-request"
        ) {
          marker = markerWrite.record;
        }
      },
    } as unknown as IdentityRepository;
    const passwordApplication = application(repository);

    await passwordApplication.forgotPassword("user@example.com", undefined, requestId);
    await passwordApplication.forgotPassword("user@example.com", undefined, requestId);

    expect(transactions).toHaveLength(1);
    expect(
      transactions[0]?.filter(
        (operation) =>
          operation.kind === "put" && operation.record.itemType === "identity-email-delivery",
      ),
    ).toHaveLength(1);
    expect(marker?.data).toMatchObject({ id: requestId, operation: "password-recovery" });
  });

  test("returns generically for an unknown email without creating recovery state", async () => {
    const transactions: TransactionOperation[][] = [];
    const repository = {
      principalForEmailHash: () => Promise.resolve(undefined),
      transact: async (operations: readonly TransactionOperation[]) => {
        transactions.push([...operations]);
      },
    } as unknown as IdentityRepository;

    expect(application(repository).forgotPassword("unknown@example.com")).resolves.toBe(undefined);
    expect(transactions).toHaveLength(0);
  });

  test("binds a reset action and protected delivery to the current credential version", async () => {
    const material = await loginMaterial();
    const transactions: TransactionOperation[][] = [];
    const encryptedValues: unknown[] = [];
    const repository = {
      loadLoginMaterial: () => Promise.resolve(material),
      loginMaterialVersionChecks: () => [],
      principalForEmailHash: () => Promise.resolve(material.principal),
      transact: async (operations: readonly TransactionOperation[]) => {
        transactions.push([...operations]);
      },
    } as unknown as IdentityRepository;

    await application(repository, {
      encryptEmailPayload: async (value) => {
        encryptedValues.push(value);
        return envelope;
      },
    }).forgotPassword("USER@example.com");

    expect(transactions).toHaveLength(1);
    const action = transactions[0]?.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "identity-action",
    );
    const delivery = transactions[0]?.find(
      (operation) =>
        operation.kind === "put" && operation.record.itemType === "identity-email-delivery",
    );
    expect(action?.kind === "put" ? action.record.data : undefined).toMatchObject({
      issuedCredentialVersion: 1,
      principalId: PRINCIPAL_ID,
      purpose: "reset-password",
      status: "pending",
    });
    expect(delivery?.kind === "put" ? delivery.record.data : undefined).toMatchObject({
      actionId: IDS[0],
      principalId: PRINCIPAL_ID,
      purpose: "reset-password",
      status: "pending",
    });
    expect(encryptedValues[0]).toMatchObject({
      actionToken: expect.any(String),
      recipient: "user@example.com",
      schemaVersion: 1,
    });
  });

  test("rejects an invalid reset token before validating or hashing the new password", async () => {
    const repository = {
      identityActionForHash: () => Promise.resolve(undefined),
    } as unknown as IdentityRepository;

    expect(
      application(repository).resetPassword({ password: "x", token: "invalid" }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  test("rejects a reset action issued for an older credential version", async () => {
    const material = await loginMaterial();
    const action = actionRecord({
      createdAt: CREATED_AT,
      expiresAt: "2026-07-28T01:00:00.000Z",
      id: IDS[0]! as never,
      issuedCredentialVersion: 0,
      principalId: PRINCIPAL_ID,
      purpose: "reset-password",
      tokenHash: sha256("reset-token"),
    });
    const repository = {
      bffFenceForPrincipal: () => Promise.resolve(material.fence),
      identityActionForHash: () => Promise.resolve(action),
      loadLoginMaterial: () => Promise.resolve(material),
    } as unknown as IdentityRepository;

    expect(
      application(repository).resetPassword({ password: "x", token: "reset-token" }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  test("maps a concurrently consumed reset action to invalid_grant", async () => {
    const material = await loginMaterial();
    let action = actionRecord({
      createdAt: CREATED_AT,
      expiresAt: "2026-07-28T01:00:00.000Z",
      id: IDS[0]! as never,
      issuedCredentialVersion: 1,
      principalId: PRINCIPAL_ID,
      purpose: "reset-password",
      tokenHash: sha256("reset-token"),
    });
    const repository = {
      bffFenceForPrincipal: () => Promise.resolve(material.fence),
      identityActionForHash: () => Promise.resolve(action),
      loadLoginMaterial: () => Promise.resolve(material),
      transact: (operations: readonly TransactionOperation[]) => {
        const consumed = operations.find(
          (operation) =>
            operation.kind === "put" && operation.record.itemType === "identity-action",
        );
        if (consumed?.kind === "put" && consumed.record.itemType === "identity-action") {
          action = consumed.record;
        }
        return Promise.reject(
          new DatabaseError({
            cause: new Error("ConditionalCheckFailedException"),
            message: "Another reset consumed the action.",
            operation: "transact-write",
            reason: "conflict",
            table: "multiple",
          }),
        );
      },
    } as unknown as IdentityRepository;

    expect(
      application(repository).resetPassword({
        password: "new correct horse battery staple",
        token: "reset-token",
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  test("atomically consumes a reset action and invalidates existing sessions", async () => {
    const material = await loginMaterial();
    const action = actionRecord({
      createdAt: CREATED_AT,
      expiresAt: "2026-07-28T01:00:00.000Z",
      id: IDS[0]! as never,
      issuedCredentialVersion: 1,
      principalId: PRINCIPAL_ID,
      purpose: "reset-password",
      tokenHash: sha256("reset-token"),
    });
    const transactions: TransactionOperation[][] = [];
    const repository = {
      bffFenceForPrincipal: () => Promise.resolve(material.fence),
      identityActionForHash: () => Promise.resolve(action),
      loadLoginMaterial: () => Promise.resolve(material),
      transact: async (operations: readonly TransactionOperation[]) => {
        transactions.push([...operations]);
      },
    } as unknown as IdentityRepository;

    await application(repository).resetPassword({
      password: "new correct horse battery staple",
      token: "reset-token",
    });

    expect(transactions).toHaveLength(1);
    const records = transactions[0]!.flatMap((operation) =>
      operation.kind === "condition-check" ? [] : [operation.record],
    );
    expect(records.map((record) => record.itemType)).toEqual([
      "identity-action",
      "principal-credential",
      "principal-security-state",
      "identity-bff-revocation-fence",
      "identity-email-delivery",
      "identity-security-event",
    ]);
    expect(records[0]?.data).toMatchObject({
      consumedAt: NOW,
      status: "consumed",
      version: 2,
    });
    expect(records[1]?.data).toMatchObject({
      createdAt: CREATED_AT,
      passwordChangedAt: NOW,
      version: 2,
    });
    expect(records[2]?.data).toMatchObject({
      credentialVersion: 2,
      sessionEpoch: 1,
      version: 2,
    });
    expect(records[3]?.data).toMatchObject({ sessionEpoch: 1, version: 2 });
    expect(records[4]?.data).toMatchObject({ purpose: "password-changed", status: "pending" });
    expect(records[5]?.data).toMatchObject({
      aggregateVersion: 2,
      eventType: "identity.password-changed",
    });
  });
});

describe("authenticated password changes", () => {
  test("rejects an incorrect current password without writing", async () => {
    const material = await loginMaterial();
    const transactions: TransactionOperation[][] = [];
    const repository = {
      bffFenceForPrincipal: () => Promise.resolve(material.fence),
      loadLoginMaterial: () => Promise.resolve(material),
      transact: async (operations: readonly TransactionOperation[]) => {
        transactions.push([...operations]);
      },
    } as unknown as IdentityRepository;

    expect(
      application(repository).changePassword({
        currentPassword: "incorrect current password",
        password: "new correct horse battery staple",
        principalId: PRINCIPAL_ID,
      }),
    ).rejects.toMatchObject({ code: "access_denied" });
    expect(transactions).toHaveLength(0);
  });

  test("replaces the credential and invalidates sessions after verifying the current password", async () => {
    const material = await loginMaterial();
    const transactions: TransactionOperation[][] = [];
    const repository = {
      bffFenceForPrincipal: () => Promise.resolve(material.fence),
      loadLoginMaterial: () => Promise.resolve(material),
      transact: async (operations: readonly TransactionOperation[]) => {
        transactions.push([...operations]);
      },
    } as unknown as IdentityRepository;

    await application(repository).changePassword({
      currentPassword: "correct horse battery staple",
      password: "new correct horse battery staple",
      principalId: PRINCIPAL_ID,
    });

    const records = transactions[0]!.flatMap((operation) =>
      operation.kind === "condition-check" ? [] : [operation.record],
    );
    expect(records.map((record) => record.itemType)).toEqual([
      "principal-credential",
      "principal-security-state",
      "identity-bff-revocation-fence",
      "identity-email-delivery",
      "identity-security-event",
    ]);
    expect(records[1]?.data).toMatchObject({ credentialVersion: 2, sessionEpoch: 1 });
  });
});
