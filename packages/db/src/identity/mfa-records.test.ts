import { describe, expect, test } from "bun:test";
import { DynamoDBDocumentClient, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { Schema } from "effect";
import { makeDynamoDatabase } from "../client.ts";
import { Ulid } from "../ids.ts";
import { PrincipalMfaFactorRecord } from "../records/identity-mfa.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { mfaChallengeRecord, mfaFactorRecord } from "./mfa-records.ts";
import { makeIdentityRepository } from "./repository.ts";

/** The error a call rejects with; `undefined` when it resolves, so the assertion fails. */
const refusal = (call: Promise<unknown>) =>
  call.then(
    () => undefined,
    (error: unknown) => error,
  );

const PRINCIPAL_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const CHALLENGE_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAW");
const AT = "2026-07-28T00:00:00.000Z";
const envelope = {
  algorithm: "AES-256-GCM" as const,
  authenticationTag: "tag",
  ciphertext: "ciphertext",
  encryptedDataKey: "encrypted-key",
  encryptionContextHash: "context-hash",
  iv: "iv",
  schemaVersion: 1 as const,
};
const codes = Array.from({ length: 10 }, (_, index) => ({ hash: `hash-${index}` }));

function pending() {
  return mfaFactorRecord({
    createdAt: AT,
    id: PRINCIPAL_ID,
    kind: "totp",
    principalId: PRINCIPAL_ID,
    protectedSecret: envelope,
    state: "pending",
    updatedAt: AT,
    version: 1,
  });
}

function recordingClient() {
  const transactions: TransactWriteCommand[] = [];
  const client = {
    send: async (command: unknown) => {
      if (command instanceof TransactWriteCommand) transactions.push(command);
      return {};
    },
  } as unknown as DynamoDBDocumentClient;
  return { client, transactions };
}

describe("MFA identity records", () => {
  test("keeps one factor per principal in the principal partition", () => {
    const factor = pending();
    expect(factor.pk).toBe(`PRINCIPAL#${PRINCIPAL_ID}`);
    expect(factor.sk).toBe(`PRINCIPAL-MFA-FACTOR#${PRINCIPAL_ID}`);
    expect(factor.ttl).toBeUndefined();
  });

  test("accepts each factor state only with that state's fields", () => {
    const decode = Schema.decodeUnknownSync(PrincipalMfaFactorRecord, {
      onExcessProperty: "error",
    });
    const base = pending();
    const active = {
      ...base.data,
      activatedAt: AT,
      lastUsedStep: 1,
      recoveryCodes: codes,
      state: "active",
      version: 2,
    };
    expect(decode({ ...base, data: active }).data.state).toBe("active");
    expect(() => decode({ ...base, data: { ...active, recoveryCodes: codes.slice(1) } })).toThrow();
    expect(() => decode({ ...base, data: { ...base.data, recoveryCodes: codes } })).toThrow();
    const { createdAt, id, kind, principalId, updatedAt, version } = base.data;
    const disabled = { createdAt, disabledAt: AT, id, kind, principalId, state: "disabled" };
    expect(() => decode({ ...base, data: { ...disabled, updatedAt, version } })).not.toThrow();
    expect(() =>
      decode({ ...base, data: { ...base.data, disabledAt: AT, state: "disabled" } }),
    ).toThrow();
  });

  test("keys a challenge by its token hash and expires it with TTL", () => {
    const challenge = mfaChallengeRecord({
      createdAt: AT,
      credentialVersion: 3,
      expiresAt: "2026-07-28T00:05:00.000Z",
      id: CHALLENGE_ID,
      principalId: PRINCIPAL_ID,
      sessionEpoch: 2,
      tokenHash: "a".repeat(64),
    });
    expect(challenge.pk).toBe(`IDENTITY-MFA-CHALLENGE#${"a".repeat(64)}`);
    expect(challenge.ttl).toBe(Math.floor(Date.parse("2026-07-28T00:05:00.000Z") / 1_000));
    expect(challenge.data.status).toBe("pending");
  });

  test("writes a new factor create-only and a transition against the exact prior version", async () => {
    const { client, transactions } = recordingClient();
    const repository = makeIdentityRepository(makeDynamoDatabase(client));
    const factor = pending();
    const activated = mfaFactorRecord({
      activatedAt: AT,
      createdAt: AT,
      id: PRINCIPAL_ID,
      kind: "totp",
      lastUsedStep: 1,
      principalId: PRINCIPAL_ID,
      protectedSecret: envelope,
      recoveryCodes: codes,
      state: "active",
      updatedAt: AT,
      version: 2,
    });

    await repository.transact([{ kind: "put", record: factor }]);
    await repository.transact([{ kind: "put", previousRecord: factor, record: activated }]);

    const [create, update] = transactions.map((command) => command.input.TransactItems?.[0]?.Put);
    expect(create?.ConditionExpression).toBe(
      "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    );
    expect(update?.ConditionExpression).toContain(
      "#dbResourceData.#dbResourceVersion = :dbPreviousVersion",
    );
    expect(update?.ExpressionAttributeValues).toMatchObject({ ":dbPreviousVersion": 1 });
  });

  test("rejects a transition that skips a version", async () => {
    const { client, transactions } = recordingClient();
    const repository = makeIdentityRepository(makeDynamoDatabase(client));
    const factor = pending();
    const skipped = withCanonicalRecordKeys({
      ...factor,
      data: { ...factor.data, version: 3 },
    });
    expect(
      await refusal(
        repository.transact([{ kind: "put", previousRecord: factor, record: skipped }]),
      ),
    ).toBeInstanceOf(Error);
    expect(transactions).toHaveLength(0);
  });
});
