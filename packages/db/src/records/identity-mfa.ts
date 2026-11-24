import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  NonEmptyString,
  NonNegativeSafeInteger,
  Timestamp,
  makeRecordSchema,
  makeUnionRecordSchema,
  mutableResourceFields,
} from "../record-schema.ts";
import { IdentityProtectedEnvelope } from "./identity-envelope.ts";

export const MFA_RECOVERY_CODE_COUNT = 10;

const factorFields = {
  ...mutableResourceFields,
  /** The principal's id: one factor record per principal, so its events share one aggregate. */
  id: Ulid,
  kind: Schema.Literal("totp"),
  principalId: Ulid,
} as const;

export const MfaRecoveryCode = Schema.Struct({
  hash: NonEmptyString,
  usedAt: Schema.optionalKey(Timestamp),
});
export type MfaRecoveryCode = typeof MfaRecoveryCode.Type;

/**
 * A principal's TOTP factor. `pending` holds a secret no code has confirmed yet, so sign-in
 * ignores it; `active` is required at password sign-in; `disabled` keeps the version history.
 * The secret is a KMS envelope bound to the principal; recovery codes are stored only as hashes.
 */
export const PrincipalMfaFactorRecord = makeUnionRecordSchema("principal-mfa-factor", [
  Schema.Struct({
    ...factorFields,
    protectedSecret: IdentityProtectedEnvelope,
    state: Schema.Literal("pending"),
  }),
  Schema.Struct({
    ...factorFields,
    activatedAt: Timestamp,
    /** The newest TOTP step accepted; a code from this step or an earlier one is a replay. */
    lastUsedStep: NonNegativeSafeInteger,
    protectedSecret: IdentityProtectedEnvelope,
    recoveryCodes: Schema.Array(MfaRecoveryCode).pipe(
      Schema.check(Schema.isLengthBetween(MFA_RECOVERY_CODE_COUNT, MFA_RECOVERY_CODE_COUNT)),
    ),
    state: Schema.Literal("active"),
  }),
  Schema.Struct({
    ...factorFields,
    disabledAt: Timestamp,
    state: Schema.Literal("disabled"),
  }),
]);
export type PrincipalMfaFactorRecord = typeof PrincipalMfaFactorRecord.Type;

/**
 * The second sign-in step: issued after a correct password when a factor is active, consumed in
 * the transaction that creates the browser session. It is bound to the credential version and
 * session epoch it was issued under, so a password change or sign-out-everywhere voids it.
 */
export const IdentityMfaChallengeRecord = makeRecordSchema(
  "identity-mfa-challenge",
  {
    ...mutableResourceFields,
    consumedAt: Schema.optionalKey(Timestamp),
    credentialVersion: NonNegativeSafeInteger,
    expiresAt: Timestamp,
    id: Ulid,
    principalId: Ulid,
    sessionEpoch: NonNegativeSafeInteger,
    status: Schema.Literals(["pending", "consumed"]),
    tokenHash: NonEmptyString,
  },
  { expiresAtField: "expiresAt" },
);
export type IdentityMfaChallengeRecord = typeof IdentityMfaChallengeRecord.Type;

export const MFA_IDENTITY_RECORD_SCHEMAS = {
  "identity-mfa-challenge": IdentityMfaChallengeRecord,
  "principal-mfa-factor": PrincipalMfaFactorRecord,
} as const;
