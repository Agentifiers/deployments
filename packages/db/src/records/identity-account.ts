import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  NonEmptyString,
  NonNegativeSafeInteger,
  Timestamp,
  makeUnionRecordSchema,
  mutableResourceFields,
} from "../record-schema.ts";

const changeFields = {
  ...mutableResourceFields,
  /** The principal's id: one change per principal, so a newer request replaces an older one. */
  id: Ulid,
  principalId: Ulid,
} as const;

/**
 * A person's own change of their primary email. `pending` waits for the link sent to the new
 * address and is void once `expiresAt` passes or the password changes; `applied` swapped the
 * address and lets the old address report the change until `reportExpiresAt`; `reported` put the
 * old address back when it was still free and ended every session; `cancelled` and `reported`
 * are terminal. Link tokens are stored only as hashes.
 */
export const PrincipalEmailChangeRecord = makeUnionRecordSchema("principal-email-change", [
  Schema.Struct({
    ...changeFields,
    /** The credential version the request was proven under; a password change voids it. */
    credentialVersion: NonNegativeSafeInteger,
    expiresAt: Timestamp,
    newEmail: NonEmptyString,
    state: Schema.Literal("pending"),
    tokenHash: NonEmptyString,
  }),
  Schema.Struct({
    ...changeFields,
    cancelledAt: Timestamp,
    state: Schema.Literal("cancelled"),
  }),
  Schema.Struct({
    ...changeFields,
    appliedAt: Timestamp,
    newEmail: NonEmptyString,
    previousEmail: NonEmptyString,
    reportExpiresAt: Timestamp,
    reportTokenHash: NonEmptyString,
    state: Schema.Literal("applied"),
  }),
  Schema.Struct({
    ...changeFields,
    /** False when someone else had claimed the previous address, so it could not come back. */
    emailRestored: Schema.Boolean,
    reportedAt: Timestamp,
    state: Schema.Literal("reported"),
  }),
]);
export type PrincipalEmailChangeRecord = typeof PrincipalEmailChangeRecord.Type;

export const ACCOUNT_IDENTITY_RECORD_SCHEMAS = {
  "principal-email-change": PrincipalEmailChangeRecord,
} as const;
