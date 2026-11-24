import { describe, expect, test } from "bun:test";
import {
  actionRecord,
  identityRegistrationRecord,
  principalRecord,
  passwordCredentialRecord,
  securityStateRecord,
  sessionRecords,
  type IdentityRepository,
  type IdentityRecord,
  type TransactionOperation,
} from "@deployments-ai/db";
import {
  DEFAULT_PASSWORD_PROFILE,
  emailClaimValue,
  hashPassword,
  sha256,
} from "@deployments-ai/identity";
import { makeIdentityApplication } from "./application.ts";
import { noMfaFactor } from "./mfa.fixture.ts";

const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as never;
const IDS = [
  "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  "01ARZ3NDEKTSV4RRFFQ69G5FAY",
] as const;
const envelope = {
  algorithm: "AES-256-GCM" as const,
  authenticationTag: "tag",
  ciphertext: "ciphertext",
  encryptedDataKey: "encrypted-key",
  encryptionContextHash: "context-hash",
  iv: "iv",
  schemaVersion: 1 as const,
};

function existingSignup(lastSentAt: string, now: string) {
  const registration = identityRegistrationRecord({
    createdAt: "2026-07-28T00:00:00.000Z",
    email: "user@example.com",
    emailHash: emailClaimValue("user@example.com"),
    expiresAt: "2026-07-29T00:00:00.000Z",
    id: PRINCIPAL_ID,
    verificationEmailSentAt: lastSentAt,
  });
  const transactions: TransactionOperation[][] = [];
  const repository = {
    principalForEmailHash: () => Promise.resolve(undefined),
    registrationForEmailHash: () => Promise.resolve(registration),
    transact: (operations: readonly TransactionOperation[]) => {
      transactions.push([...operations]);
      return Promise.resolve();
    },
  } as unknown as IdentityRepository;
  let id = 0;
  const application = makeIdentityApplication(
    {
      encryptEmailPayload: async () => envelope,
      generateId: () => IDS[id++]! as never,
      now: () => new Date(now),
      random: { bytes: (length) => new Uint8Array(length).fill(7) },
      repository,
    },
    {
      actionLifetimeSeconds: 1_800,
      sessionAbsoluteLifetimeSeconds: 86_400,
      sessionIdleLifetimeSeconds: 3_600,
    },
  );
  return { application, transactions };
}

describe("identity signup verification delivery", () => {
  test("deduplicates an SQS retry with the marker committed beside signup artifacts", async () => {
    const requestId = "01ARZ3NDEKTSV4RRFFQ69G5FB0" as never;
    let marker: IdentityRecord<"identity-public-email-request"> | undefined;
    const transactions: TransactionOperation[][] = [];
    const repository = {
      principalForEmailHash: () => Promise.resolve(undefined),
      publicEmailRequestForId: () => Promise.resolve(marker),
      registrationForEmailHash: () => Promise.resolve(undefined),
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
    let id = 0;
    const application = makeIdentityApplication(
      {
        encryptEmailPayload: async () => envelope,
        generateId: () => IDS[id++ % IDS.length]! as never,
        now: () => new Date("2026-07-28T00:00:00.000Z"),
        random: { bytes: (length) => new Uint8Array(length).fill(7) },
        repository,
      },
      {
        actionLifetimeSeconds: 1_800,
        sessionAbsoluteLifetimeSeconds: 86_400,
        sessionIdleLifetimeSeconds: 3_600,
      },
    );

    await application.signUp("user@example.com", undefined, requestId);
    await application.signUp("user@example.com", undefined, requestId);

    expect(transactions).toHaveLength(1);
    expect(
      transactions[0]?.filter(
        (operation) =>
          operation.kind === "put" && operation.record.itemType === "identity-email-delivery",
      ),
    ).toHaveLength(1);
    expect(marker?.data).toMatchObject({ id: requestId, operation: "sign-up" });
  });

  test("creates only an expiring registration before the email is verified", async () => {
    const transactions: TransactionOperation[][] = [];
    const repository = {
      principalForEmailHash: () => Promise.resolve(undefined),
      registrationForEmailHash: () => Promise.resolve(undefined),
      transact: (operations: readonly TransactionOperation[]) => {
        transactions.push([...operations]);
        return Promise.resolve();
      },
    } as unknown as IdentityRepository;
    let id = 0;
    const application = makeIdentityApplication(
      {
        encryptEmailPayload: async () => envelope,
        generateId: () => IDS[id++ % IDS.length]! as never,
        now: () => new Date("2026-07-28T00:00:00.000Z"),
        random: { bytes: (length) => new Uint8Array(length).fill(7) },
        repository,
      },
      {
        actionLifetimeSeconds: 1_800,
        sessionAbsoluteLifetimeSeconds: 86_400,
        sessionIdleLifetimeSeconds: 3_600,
      },
    );

    await application.signUp("user@example.com");

    const records = transactions[0]?.flatMap((operation) =>
      operation.kind === "condition-check" ? [] : [operation.record],
    );
    expect(records?.map((record) => record.itemType)).toEqual([
      "identity-registration",
      "identity-action",
      "identity-email-delivery",
      "identity-security-event",
    ]);
    expect(records).not.toContainEqual(
      expect.objectContaining({ itemType: expect.stringMatching(/principal|unique-claim/u) }),
    );
    expect(records?.[0]).toMatchObject({ ttl: Math.floor(Date.parse("2026-07-29") / 1_000) });
  });

  test("reissues verification for an existing unverified principal", async () => {
    const fixture = existingSignup("2026-07-28T00:00:00.000Z", "2026-07-28T01:00:00.000Z");

    await fixture.application.signUp("USER@example.com");

    expect(fixture.transactions).toHaveLength(1);
    const records = fixture.transactions[0]!.flatMap((operation) =>
      operation.kind === "condition-check" ? [] : [operation.record],
    );
    expect(records.map((record) => record.itemType)).toEqual([
      "identity-registration",
      "identity-action",
      "identity-email-delivery",
      "identity-security-event",
    ]);
    expect(records.find((record) => record.itemType === "identity-action")?.data).toMatchObject({
      principalId: PRINCIPAL_ID,
      purpose: "verify-email",
      status: "pending",
    });
  });

  test("bounds rapid verification resends without disclosing account state", async () => {
    const fixture = existingSignup("2026-07-28T00:00:30.000Z", "2026-07-28T00:01:00.000Z");

    await fixture.application.signUp("user@example.com");

    expect(fixture.transactions).toHaveLength(0);
  });

  test("creates the durable principal and email claim only when verification succeeds", async () => {
    const createdAt = "2026-07-28T00:00:00.000Z";
    const email = "user@example.com";
    const emailHash = emailClaimValue(email);
    const token = "verification-token";
    const registration = identityRegistrationRecord({
      createdAt,
      email,
      emailHash,
      expiresAt: "2026-07-29T00:00:00.000Z",
      id: PRINCIPAL_ID,
      verificationEmailSentAt: createdAt,
    });
    const action = actionRecord({
      createdAt,
      expiresAt: "2026-07-28T01:00:00.000Z",
      id: IDS[0]! as never,
      principalId: PRINCIPAL_ID,
      purpose: "verify-email",
      targetEmail: email,
      targetEmailHash: emailHash,
      tokenHash: sha256(token),
    });
    const transactions: TransactionOperation[][] = [];
    const repository = {
      identityActionForHash: () => Promise.resolve(action),
      principalForEmailHash: () => Promise.resolve(undefined),
      registrationForEmailHash: () => Promise.resolve(registration),
      transact: (operations: readonly TransactionOperation[]) => {
        transactions.push([...operations]);
        return Promise.resolve();
      },
    } as unknown as IdentityRepository;
    const application = makeIdentityApplication(
      {
        encryptEmailPayload: async () => envelope,
        generateId: () => IDS[1]! as never,
        now: () => new Date("2026-07-28T00:30:00.000Z"),
        repository,
      },
      {
        actionLifetimeSeconds: 1_800,
        sessionAbsoluteLifetimeSeconds: 86_400,
        sessionIdleLifetimeSeconds: 3_600,
      },
    );

    expect(
      application.verifyEmail({ password: "correct horse battery staple", token }),
    ).resolves.toEqual({ email: expect.any(String), principalId: PRINCIPAL_ID });

    expect(transactions).toHaveLength(1);
    expect(
      transactions[0]?.map((operation) =>
        operation.kind === "condition-check" ? "condition-check" : operation.record.itemType,
      ),
    ).toEqual([
      "identity-action",
      "identity-registration",
      "principal",
      "principal-security-state",
      "identity-bff-revocation-fence",
      "principal-credential",
      "unique-claim",
      "identity-security-event",
    ]);
    expect(transactions[0]?.[1]).toMatchObject({
      kind: "delete",
      record: { itemType: "identity-registration" },
    });
  });

  test("rejects an invalid verification token before validating or hashing the password", async () => {
    const application = makeIdentityApplication(
      {
        encryptEmailPayload: async () => envelope,
        generateId: () => IDS[0]! as never,
        now: () => new Date("2026-07-28T00:30:00.000Z"),
        repository: {
          identityActionForHash: () => Promise.resolve(undefined),
        } as unknown as IdentityRepository,
      },
      {
        actionLifetimeSeconds: 1_800,
        sessionAbsoluteLifetimeSeconds: 86_400,
        sessionIdleLifetimeSeconds: 3_600,
      },
    );

    expect(application.verifyEmail({ password: "x", token: "invalid" })).rejects.toMatchObject({
      code: "invalid_grant",
    });
  });

  test("persists decaying failure state without blocking a correct password", async () => {
    const createdAt = "2026-07-28T00:00:00.000Z";
    const principal = principalRecord({
      createdAt,
      id: PRINCIPAL_ID,
      primaryEmail: "user@example.com",
    });
    const securityState = securityStateRecord({
      createdAt,
      credentialVersion: 1,
      emailVerifiedAt: createdAt,
      principalId: PRINCIPAL_ID,
      sessionEpoch: 0,
      version: 1,
    });
    const credential = passwordCredentialRecord({
      createdAt,
      passwordHash: await hashPassword("correct horse battery staple", DEFAULT_PASSWORD_PROFILE),
      principalId: PRINCIPAL_ID,
      version: 1,
    });
    const staleFailureState = {
      ...securityState,
      data: {
        ...securityState.data,
        authenticationFailedAt: "2026-07-28T00:00:00.000Z",
        authenticationFailureCount: 50,
      },
    };
    const transactions: TransactionOperation[][] = [];
    const repository = {
      loadLoginMaterial: () =>
        Promise.resolve({ credential, principal, securityState: staleFailureState }),
      principalForEmailHash: () => Promise.resolve(principal),
      ...noMfaFactor,
      transact: (operations: readonly TransactionOperation[]) => {
        transactions.push([...operations]);
        return Promise.resolve();
      },
    } as unknown as IdentityRepository;
    const application = makeIdentityApplication(
      {
        encryptEmailPayload: async () => envelope,
        generateId: () => IDS[0]! as never,
        now: () => new Date("2026-07-28T01:00:00.000Z"),
        repository,
      },
      {
        actionLifetimeSeconds: 1_800,
        sessionAbsoluteLifetimeSeconds: 86_400,
        sessionIdleLifetimeSeconds: 3_600,
      },
    );

    expect(
      application.signIn({ email: "user@example.com", password: "wrong password value" }),
    ).rejects.toThrow("Email or password is incorrect.");
    const securityPut = transactions[0]?.find(
      (operation) =>
        operation.kind === "put" && operation.record.itemType === "principal-security-state",
    );
    expect(
      securityPut?.kind === "put" && securityPut.record.itemType === "principal-security-state"
        ? securityPut.record.data
        : undefined,
    ).toMatchObject({
      authenticationFailureCount: 1,
      authenticationFailedAt: "2026-07-28T01:00:00.000Z",
      version: 2,
    });

    const failedSecurityState = {
      ...securityState,
      data: {
        ...securityState.data,
        authenticationFailedAt: "2026-07-28T00:59:00.000Z",
        authenticationFailureCount: 4,
        version: 2,
      },
    };
    const recoveryTransactions: TransactionOperation[][] = [];
    const recoveryRepository = {
      loadLoginMaterial: () =>
        Promise.resolve({ credential, principal, securityState: failedSecurityState }),
      principalForEmailHash: () => Promise.resolve(principal),
      ...noMfaFactor,
      transact: (operations: readonly TransactionOperation[]) => {
        recoveryTransactions.push([...operations]);
        return Promise.resolve();
      },
    } as unknown as IdentityRepository;
    const recoveryApplication = makeIdentityApplication(
      {
        encryptEmailPayload: async () => envelope,
        generateId: () => IDS[0]! as never,
        now: () => new Date("2026-07-28T01:00:00.000Z"),
        repository: recoveryRepository,
      },
      {
        actionLifetimeSeconds: 1_800,
        sessionAbsoluteLifetimeSeconds: 86_400,
        sessionIdleLifetimeSeconds: 3_600,
      },
    );
    expect(
      recoveryApplication.signIn({
        email: "user@example.com",
        password: "correct horse battery staple",
      }),
    ).resolves.toMatchObject({ principalId: PRINCIPAL_ID });
    expect(recoveryTransactions).toHaveLength(1);
    const clearedSecurity = recoveryTransactions[0]?.find(
      (operation) =>
        operation.kind === "put" && operation.record.itemType === "principal-security-state",
    );
    expect(
      clearedSecurity?.kind === "put" ? clearedSecurity.record.data : undefined,
    ).not.toHaveProperty("authenticationFailureCount");
  });

  test("retries a failed-login update after a concurrent security-state write", async () => {
    const createdAt = "2026-07-28T00:00:00.000Z";
    const principal = principalRecord({
      createdAt,
      id: PRINCIPAL_ID,
      primaryEmail: "user@example.com",
    });
    let securityState = securityStateRecord({
      createdAt,
      credentialVersion: 1,
      emailVerifiedAt: createdAt,
      principalId: PRINCIPAL_ID,
      sessionEpoch: 0,
      version: 1,
    });
    const credential = passwordCredentialRecord({
      createdAt,
      passwordHash: await hashPassword("correct horse battery staple", DEFAULT_PASSWORD_PROFILE),
      principalId: PRINCIPAL_ID,
      version: 1,
    });
    const transactions: TransactionOperation[][] = [];
    let transactionAttempts = 0;
    const repository = {
      loadLoginMaterial: () => Promise.resolve({ credential, principal, securityState }),
      principalForEmailHash: () => Promise.resolve(principal),
      ...noMfaFactor,
      transact: (operations: readonly TransactionOperation[]) => {
        transactions.push([...operations]);
        transactionAttempts += 1;
        if (transactionAttempts === 1) {
          securityState = {
            ...securityState,
            data: {
              ...securityState.data,
              authenticationFailedAt: "2026-07-28T00:59:00.000Z",
              authenticationFailureCount: 1,
              updatedAt: "2026-07-28T00:59:00.000Z",
              version: 2,
            },
          };
          return Promise.reject({ name: "TransactionConflictException" });
        }
        return Promise.resolve();
      },
    } as unknown as IdentityRepository;
    const application = makeIdentityApplication(
      {
        encryptEmailPayload: async () => envelope,
        generateId: (() => {
          let index = 0;
          return () => IDS[index++]! as never;
        })(),
        now: () => new Date("2026-07-28T01:00:00.000Z"),
        repository,
      },
      {
        actionLifetimeSeconds: 1_800,
        sessionAbsoluteLifetimeSeconds: 86_400,
        sessionIdleLifetimeSeconds: 3_600,
      },
    );

    expect(
      application.signIn({ email: "user@example.com", password: "wrong password value" }),
    ).rejects.toThrow("Email or password is incorrect.");

    expect(transactions).toHaveLength(2);
    const retriedSecurity = transactions[1]?.find(
      (operation) =>
        operation.kind === "put" && operation.record.itemType === "principal-security-state",
    );
    expect(
      retriedSecurity?.kind === "put" &&
        retriedSecurity.record.itemType === "principal-security-state"
        ? retriedSecurity.record.data
        : undefined,
    ).toMatchObject({
      authenticationFailureCount: 2,
      version: 3,
    });
  });

  test("renews an active browser session near its idle deadline", async () => {
    const createdAt = "2026-07-28T00:00:00.000Z";
    const principal = principalRecord({
      createdAt,
      id: PRINCIPAL_ID,
      primaryEmail: "user@example.com",
    });
    const securityState = securityStateRecord({
      createdAt,
      credentialVersion: 1,
      emailVerifiedAt: createdAt,
      principalId: PRINCIPAL_ID,
      sessionEpoch: 0,
      version: 1,
    });
    const records = sessionRecords({
      authentication: { method: "password" },
      authenticationTime: createdAt,
      createdAt,
      expiresAt: "2026-07-28T02:00:00.000Z",
      id: IDS[0]! as never,
      idleExpiresAt: "2026-07-28T01:00:00.000Z",
      principalId: PRINCIPAL_ID,
      sessionEpoch: 0,
      tokenHash: sha256("session-token"),
    });
    const transactions: TransactionOperation[][] = [];
    const repository = {
      loadLoginMaterial: () => Promise.resolve({ credential: undefined, principal, securityState }),
      loginMaterialVersionChecks: () => [],
      sessionForHash: () => Promise.resolve(records.session),
      transact: (operations: readonly TransactionOperation[]) => {
        transactions.push([...operations]);
        return Promise.resolve();
      },
    } as unknown as IdentityRepository;
    const application = makeIdentityApplication(
      {
        encryptEmailPayload: async () => envelope,
        generateId: () => IDS[1]! as never,
        now: () => new Date("2026-07-28T00:45:00.000Z"),
        repository,
      },
      {
        actionLifetimeSeconds: 1_800,
        sessionAbsoluteLifetimeSeconds: 86_400,
        sessionIdleLifetimeSeconds: 3_600,
      },
    );

    expect(application.session("session-token")).resolves.toMatchObject({
      principal: { id: PRINCIPAL_ID },
      sessionId: IDS[0],
    });
    const renewedSession = transactions[0]?.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "identity-session",
    );
    expect(
      renewedSession?.kind === "put" && renewedSession.record.itemType === "identity-session"
        ? renewedSession.record.data
        : undefined,
    ).toMatchObject({
      idleExpiresAt: "2026-07-28T01:45:00.000Z",
      lastRefreshedAt: "2026-07-28T00:45:00.000Z",
      version: 2,
    });
  });
});
