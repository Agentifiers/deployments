import { describe, expect, test } from "bun:test";
import {
  DatabaseError,
  passwordCredentialRecord,
  principalRecord,
  securityStateRecord,
  type IdentityRepository,
  type TransactionOperation,
} from "@deployments-ai/db";
import { DEFAULT_PASSWORD_PROFILE, hashPassword } from "@deployments-ai/identity";
import { makeIdentityApplication } from "./application.ts";
import { noMfaFactor } from "./mfa.fixture.ts";

const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as never;
const SESSION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as never;

describe("successful sign-in conflicts", () => {
  test("retries when failed-attempt telemetry changes the security version", async () => {
    const createdAt = "2026-07-28T00:00:00.000Z";
    const principal = principalRecord({
      createdAt,
      id: PRINCIPAL_ID,
      primaryEmail: "user@example.com",
    });
    const credential = passwordCredentialRecord({
      createdAt,
      passwordHash: await hashPassword("correct horse battery staple", DEFAULT_PASSWORD_PROFILE),
      principalId: PRINCIPAL_ID,
      version: 1,
    });
    let securityState = securityStateRecord({
      createdAt,
      credentialVersion: 1,
      emailVerifiedAt: createdAt,
      principalId: PRINCIPAL_ID,
      sessionEpoch: 0,
      version: 1,
    });
    const transactions: TransactionOperation[][] = [];
    const repository = {
      loadLoginMaterial: () => Promise.resolve({ credential, principal, securityState }),
      principalForEmailHash: () => Promise.resolve(principal),
      ...noMfaFactor,
      transact: (operations: readonly TransactionOperation[]) => {
        transactions.push([...operations]);
        if (transactions.length === 1) {
          securityState = {
            ...securityState,
            data: {
              ...securityState.data,
              authenticationFailedAt: "2026-07-28T00:00:59.000Z",
              authenticationFailureCount: 1,
              updatedAt: "2026-07-28T00:00:59.000Z",
              version: 2,
            },
          };
          return Promise.reject(
            new DatabaseError({
              cause: new Error("ConditionalCheckFailedException"),
              message: "Failure telemetry won the race.",
              operation: "transact-write",
              reason: "conflict",
              table: "multiple",
            }),
          );
        }
        return Promise.resolve();
      },
    } as unknown as IdentityRepository;
    const application = makeIdentityApplication(
      {
        encryptEmailPayload: async () => {
          throw new Error("not used");
        },
        generateId: () => SESSION_ID,
        now: () => new Date("2026-07-28T00:01:00.000Z"),
        repository,
      },
      {
        actionLifetimeSeconds: 1_800,
        sessionAbsoluteLifetimeSeconds: 86_400,
        sessionIdleLifetimeSeconds: 3_600,
      },
    );

    expect(
      application.signIn({
        email: "user@example.com",
        password: "correct horse battery staple",
      }),
    ).resolves.toMatchObject({ principalId: PRINCIPAL_ID });

    expect(transactions).toHaveLength(2);
    const cleared = transactions[1]?.find(
      (operation) =>
        operation.kind === "put" && operation.record.itemType === "principal-security-state",
    );
    expect(
      cleared?.kind === "put" && cleared.record.itemType === "principal-security-state"
        ? cleared.record.data.version
        : undefined,
    ).toBe(3);
  });
});
