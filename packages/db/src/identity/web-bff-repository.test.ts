import { describe, expect, test } from "bun:test";
import { DEFAULT_TABLE_NAMES } from "../client-types.ts";
import { makeDynamoDatabase } from "../dynamo-database.ts";
import { fakeDynamoDocumentClient } from "../testing/dynamo-document-client.fixture.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import {
  bffFenceRecord,
  webBffAuthorizationRecord,
  webBffSessionRecord,
} from "./record-builders.ts";
import { makeIdentityRepository, type IdentityRecord } from "./repository.ts";

const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as never;
const SESSION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as never;
const TRANSACTION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as never;
const AT = "2026-10-01T12:00:00.000Z";
const ENVELOPE = {
  algorithm: "AES-256-GCM",
  authenticationTag: "tag",
  ciphertext: "ciphertext",
  encryptedDataKey: "key",
  encryptionContextHash: "context",
  iv: "iv",
  schemaVersion: 1,
} as const;

function setup() {
  const dynamo = fakeDynamoDocumentClient();
  const repository = makeIdentityRepository(makeDynamoDatabase(dynamo.client, DEFAULT_TABLE_NAMES));
  const fence = bffFenceRecord({
    createdAt: AT,
    principalId: PRINCIPAL_ID,
    principalStatus: "active",
    sessionEpoch: 3,
    version: 4,
  });
  dynamo.put("identity", fence);
  const idle = webBffSessionRecord({
    accessTokenExpiresAt: "2026-10-01T12:10:00.000Z",
    clientId: "deployments-web",
    cookieTokenHash: "cookie-hash",
    createdAt: AT,
    expiresAt: "2026-10-31T12:00:00.000Z",
    id: SESSION_ID,
    idleExpiresAt: "2026-10-08T12:00:00.000Z",
    principalId: PRINCIPAL_ID,
    protectedCredentials: ENVELOPE,
    refreshCredentialVersion: 1,
    refreshState: "idle",
    sessionEpoch: 3,
    status: "active",
    updatedAt: AT,
    version: 1,
  });
  return { dynamo, fence, idle, repository };
}

function leasedBy(idle: IdentityRecord<"web-bff-session">, owner: string) {
  if (idle.data.status !== "active" || idle.data.refreshState !== "idle") throw new Error("idle");
  return webBffSessionRecord({
    ...idle.data,
    refreshLeaseExpiresAt: "2026-10-01T12:00:30.000Z",
    refreshLeaseOwnerHash: owner,
    refreshState: "leased",
    version: idle.data.version + 1,
  });
}

async function conflict(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error("expected write conflict");
    },
    (cause: unknown) => cause,
  );
  expect(isDatabaseWriteConflict(error)).toBe(true);
}

describe("web BFF repository writes", () => {
  test("session creation is create-only and requires the observed fence", async () => {
    const { dynamo, fence, idle, repository } = setup();
    await repository.createBffSession(fence, idle);
    await conflict(repository.createBffSession(fence, idle));

    const other = setup();
    other.dynamo.put("identity", { ...other.fence, data: { ...other.fence.data, version: 5 } });
    await conflict(other.repository.createBffSession(other.fence, other.idle));
    expect(dynamo.items("identity")).toHaveLength(2);
  });

  test("exactly one lease acquirer wins and a stale holder cannot overwrite", async () => {
    const { fence, idle, repository } = setup();
    await repository.createBffSession(fence, idle);
    const first = leasedBy(idle, "owner-a");
    const second = leasedBy(idle, "owner-b");
    await repository.replaceBffSession(idle, first, fence);
    await conflict(repository.replaceBffSession(idle, second, fence));

    const revoked = webBffSessionRecord({
      clientId: "deployments-web",
      cookieTokenHash: "cookie-hash",
      createdAt: AT,
      expiresAt: idle.data.expiresAt,
      id: SESSION_ID,
      idleExpiresAt: idle.data.idleExpiresAt,
      principalId: PRINCIPAL_ID,
      refreshCredentialVersion: 1,
      revokedAt: AT,
      sessionEpoch: 3,
      status: "revoked",
      updatedAt: AT,
      version: 3,
    });
    await repository.replaceBffSession(first, revoked);
    const resurrected = webBffSessionRecord({ ...idle.data, version: 3 });
    await conflict(repository.replaceBffSession(first, resurrected));
  });

  test("a lease cannot be acquired after the fence advances", async () => {
    const { dynamo, fence, idle, repository } = setup();
    await repository.createBffSession(fence, idle);
    dynamo.put("identity", { ...fence, data: { ...fence.data, sessionEpoch: 4, version: 5 } });
    await conflict(repository.replaceBffSession(idle, leasedBy(idle, "owner"), fence));
  });

  test("authorization consumption only succeeds once and cannot rebind the transaction", async () => {
    const { repository } = setup();
    const pending = webBffAuthorizationRecord({
      clientId: "deployments-web",
      createdAt: AT,
      expiresAt: "2026-10-01T12:10:00.000Z",
      id: TRANSACTION_ID,
      nonceHash: "nonce",
      protectedClientState: ENVELOPE,
      redirectUri: "https://console.test/auth/callback",
      stateHash: "state",
      status: "pending",
      transactionTokenHash: "transaction",
      updatedAt: AT,
      version: 1,
    });
    await repository.createBffAuthorization(pending);
    await conflict(repository.createBffAuthorization(pending));
    const consumed = webBffAuthorizationRecord({
      ...pending.data,
      consumedAt: AT,
      status: "consumed",
      version: 2,
    });
    const rebound = webBffAuthorizationRecord({ ...consumed.data, stateHash: "attacker" });
    expect(repository.replacePendingBffAuthorization(pending, rebound)).rejects.toThrow();
    await repository.replacePendingBffAuthorization(pending, consumed);
    await conflict(repository.replacePendingBffAuthorization(pending, consumed));
  });
});
