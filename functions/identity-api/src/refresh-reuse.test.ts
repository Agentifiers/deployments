import { describe, expect, test } from "bun:test";
import {
  principalRecord,
  refreshRecords,
  type IdentityRepository,
  type TransactionOperation,
} from "@deployments-ai/db";
import { makeRefreshReuseApplication } from "./refresh-reuse.ts";

const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as never;
const FAMILY_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as never;
const TOKEN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as never;
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as never;

describe("refresh-token reuse response", () => {
  test("compromises the token family when notification encryption is unavailable", async () => {
    const createdAt = "2026-07-28T00:00:00.000Z";
    const principal = principalRecord({
      createdAt,
      id: PRINCIPAL_ID,
      primaryEmail: "user@example.com",
    });
    const { family, token } = refreshRecords({
      audience: "https://api.deployments.ai",
      authenticationTime: createdAt,
      clientId: "deployments-cli",
      createdAt,
      expiresAt: "2026-08-28T00:00:00.000Z",
      familyId: FAMILY_ID,
      principalId: PRINCIPAL_ID,
      scopes: ["offline_access"],
      sessionEpoch: 0,
      tokenHash: "refresh-token-hash",
      tokenId: TOKEN_ID,
    });
    const transactions: TransactionOperation[][] = [];
    const notificationFailures: unknown[] = [];
    const repository = {
      principalForId: () => Promise.resolve(principal),
      transact: async (operations: readonly TransactionOperation[]) => {
        transactions.push([...operations]);
      },
    } as unknown as IdentityRepository;
    const application = makeRefreshReuseApplication(
      {
        encryptEmailPayload: async () => {
          throw new Error("KMS unavailable");
        },
        generateId: () => EVENT_ID,
        now: () => new Date("2026-07-28T01:00:00.000Z"),
        reportSecurityNotificationFailure: (cause) => notificationFailures.push(cause),
        repository,
      },
      86_400,
    );

    await application.compromiseRefreshFamily(family, token, "deployments-cli");

    expect(notificationFailures).toHaveLength(1);
    expect(transactions).toHaveLength(1);
    expect(
      transactions[0]?.some(
        (operation) =>
          operation.kind === "put" &&
          operation.record.itemType === "oauth-refresh-family" &&
          operation.record.data.status === "compromised",
      ),
    ).toBeTrue();
    expect(
      transactions[0]?.some(
        (operation) =>
          operation.kind === "put" && operation.record.itemType === "identity-security-event",
      ),
    ).toBeTrue();
    expect(
      transactions[0]?.some(
        (operation) =>
          operation.kind === "put" && operation.record.itemType === "identity-email-delivery",
      ),
    ).toBeFalse();
  });
});
