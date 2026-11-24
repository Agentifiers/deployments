import { describe, expect, test } from "bun:test";
import {
  DatabaseError,
  sessionRecords,
  type IdentityRepository,
  type TransactionOperation,
} from "@deployments-ai/db";
import { sha256 } from "@deployments-ai/identity";
import { makeIdentityApplication } from "./application.ts";

const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as never;
const SESSION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as never;
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as never;
const CREATED_AT = "2026-07-28T00:00:00.000Z";
const REVOKED_AT = "2026-07-28T01:00:00.000Z";

function application(repository: IdentityRepository) {
  return makeIdentityApplication(
    {
      encryptEmailPayload: async () => {
        throw new Error("Unexpected email encryption.");
      },
      generateId: () => EVENT_ID,
      now: () => new Date(REVOKED_AT),
      repository,
    },
    {
      actionLifetimeSeconds: 1_800,
      sessionAbsoluteLifetimeSeconds: 86_400,
      sessionIdleLifetimeSeconds: 3_600,
    },
  );
}

describe("browser session revocation", () => {
  test("revokes the session and matching locator in one transaction", async () => {
    const records = sessionRecords({
      authentication: { method: "password" },
      authenticationTime: CREATED_AT,
      createdAt: CREATED_AT,
      expiresAt: "2026-07-29T00:00:00.000Z",
      id: SESSION_ID,
      idleExpiresAt: "2026-07-28T02:00:00.000Z",
      principalId: PRINCIPAL_ID,
      sessionEpoch: 0,
      tokenHash: sha256("session-token"),
    });
    const transactions: TransactionOperation[][] = [];
    const repository = {
      sessionForHash: () => Promise.resolve(records.session),
      sessionLocator: () => Promise.resolve(records.locator),
      transact: (operations: readonly TransactionOperation[]) => {
        transactions.push([...operations]);
        return Promise.resolve();
      },
    } as unknown as IdentityRepository;

    await application(repository).signOut("session-token");

    expect(transactions).toHaveLength(1);
    const writes = transactions[0]!.filter((operation) => operation.kind === "put");
    expect(writes.map((operation) => operation.record.itemType)).toEqual([
      "identity-session",
      "identity-session-locator",
      "identity-security-event",
    ]);
    expect(writes[0]).toMatchObject({
      previousRecord: records.session,
      record: {
        data: { revokedAt: REVOKED_AT, status: "revoked", version: 2 },
      },
    });
    expect(writes[1]).toMatchObject({
      previousRecord: records.locator,
      record: {
        data: { revokedAt: REVOKED_AT, status: "revoked", version: 2 },
      },
    });
    expect(writes[2]).toMatchObject({
      record: {
        data: {
          aggregateId: SESSION_ID,
          aggregateVersion: 2,
          eventType: "identity.session-revoked",
          principalId: PRINCIPAL_ID,
        },
      },
    });
  });

  test("treats missing and already-revoked session tokens as successful", async () => {
    let session = undefined as ReturnType<typeof sessionRecords>["session"] | undefined;
    let writes = 0;
    const repository = {
      sessionForHash: () => Promise.resolve(session),
      transact: () => {
        writes += 1;
        return Promise.resolve();
      },
    } as unknown as IdentityRepository;
    const identity = application(repository);

    await identity.signOut("unknown-token");
    const records = sessionRecords({
      authentication: { method: "password" },
      authenticationTime: CREATED_AT,
      createdAt: CREATED_AT,
      expiresAt: "2026-07-29T00:00:00.000Z",
      id: SESSION_ID,
      idleExpiresAt: "2026-07-28T02:00:00.000Z",
      principalId: PRINCIPAL_ID,
      sessionEpoch: 0,
      tokenHash: sha256("session-token"),
    });
    session = {
      ...records.session,
      data: { ...records.session.data, revokedAt: REVOKED_AT, status: "revoked" },
    };
    await identity.signOut("session-token");

    expect(writes).toBe(0);
  });

  test("retries write conflicts while the same session remains active", async () => {
    const records = sessionRecords({
      authentication: { method: "password" },
      authenticationTime: CREATED_AT,
      createdAt: CREATED_AT,
      expiresAt: "2026-07-29T00:00:00.000Z",
      id: SESSION_ID,
      idleExpiresAt: "2026-07-28T02:00:00.000Z",
      principalId: PRINCIPAL_ID,
      sessionEpoch: 0,
      tokenHash: sha256("session-token"),
    });
    let transactions = 0;
    const repository = {
      sessionForHash: () => Promise.resolve(records.session),
      sessionLocator: () => Promise.resolve(records.locator),
      transact: () => {
        transactions += 1;
        return transactions === 1
          ? Promise.reject(
              new DatabaseError({
                cause: new Error("ConditionalCheckFailedException"),
                message: "Concurrent session update.",
                operation: "transact-write",
                reason: "conflict",
                table: "multiple",
              }),
            )
          : Promise.resolve();
      },
    } as unknown as IdentityRepository;

    await application(repository).signOut("session-token");

    expect(transactions).toBe(2);
  });
});
