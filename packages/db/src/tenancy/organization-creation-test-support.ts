import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import { Ulid } from "../ids.ts";
import { bffFenceRecord, securityStateRecord } from "../identity/record-builders.ts";
import type { PersistenceInvocation } from "../persistence-types.ts";
import { humanPrincipalRecord } from "../tenancy-test-support.ts";

export const PERSON = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAV");
export const ADMINISTRATOR = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FB1");
const SIGNED_UP_AT = "2026-10-01T00:00:00.000Z";

let sequence = 0;

/** A tenant JWT create request; by default the token says the email is verified. */
export function createAs(
  principalId: string,
  name: string,
  identity: Partial<PersistenceInvocation["identity"]> = { emailVerified: true },
): PersistenceInvocation<{ readonly name: string }> {
  return {
    body: { name },
    identity: { authentication: "tenant-jwt", principalId, scopes: [], ...identity },
    idempotencyKey: `organization-creation-${++sequence}`,
    query: {},
    scope: {},
  };
}

/** The records platform identity writes when a person finishes signing up. */
export function signedUpPerson(principalId: Ulid) {
  return [
    humanPrincipalRecord(principalId, `${principalId.toLowerCase()}@example.test`),
    securityStateRecord({
      createdAt: SIGNED_UP_AT,
      credentialVersion: 1,
      emailVerifiedAt: SIGNED_UP_AT,
      principalId,
      sessionEpoch: 3,
      version: 1,
    }),
    bffFenceRecord({
      createdAt: SIGNED_UP_AT,
      principalId,
      principalStatus: "active",
      sessionEpoch: 3,
      version: 1,
    }),
  ];
}

/**
 * Holds the first `count` creation-count reads until all of them have read, so every create is
 * admitted against the same count before any of them writes.
 */
export function creatorsMeetBeforeWriting(count: number) {
  return (database: DynamoDatabaseService): DynamoDatabaseService => {
    const waiting: (() => void)[] = [];
    return {
      ...database,
      getRecord: async (table, recordKey, consistent) => {
        const record = await database.getRecord(table, recordKey, consistent);
        if (recordKey.sk === "PRINCIPAL-ORGANIZATION-CREATIONS" && waiting.length < count) {
          await new Promise<void>((resolve) => {
            waiting.push(resolve);
            if (waiting.length === count) for (const release of waiting) release();
          });
        }
        return record;
      },
    };
  };
}
