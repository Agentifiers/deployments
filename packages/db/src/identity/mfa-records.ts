import { Schema } from "effect";
import type { Ulid } from "../ids.ts";
import { IdentityMfaChallengeRecord, PrincipalMfaFactorRecord } from "../records/identity-mfa.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";

export type MfaFactorData = PrincipalMfaFactorRecord["data"];
export type MfaChallengeData = IdentityMfaChallengeRecord["data"];

/** Builds a validated factor record from its full data; every state transition goes through it. */
export function mfaFactorRecord(data: MfaFactorData): PrincipalMfaFactorRecord {
  return Schema.decodeUnknownSync(PrincipalMfaFactorRecord)(
    withCanonicalRecordKeys({ data, itemType: "principal-mfa-factor" }),
  );
}

export function mfaChallengeRecord(input: {
  readonly createdAt: string;
  readonly credentialVersion: number;
  readonly expiresAt: string;
  readonly id: Ulid;
  readonly principalId: Ulid;
  readonly sessionEpoch: number;
  readonly tokenHash: string;
}): IdentityMfaChallengeRecord {
  return Schema.decodeUnknownSync(IdentityMfaChallengeRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: input.createdAt,
        credentialVersion: input.credentialVersion,
        expiresAt: input.expiresAt,
        id: input.id,
        principalId: input.principalId,
        sessionEpoch: input.sessionEpoch,
        status: "pending",
        tokenHash: input.tokenHash,
        updatedAt: input.createdAt,
        version: 1,
      },
      itemType: "identity-mfa-challenge",
      ttl: Math.floor(Date.parse(input.expiresAt) / 1_000),
    }),
  );
}
