import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  NonEmptyString,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
} from "../record-schema.ts";

export const OPERATOR_ACCESS_DEFAULT_MINUTES = 60;
export const OPERATOR_ACCESS_MAXIMUM_MINUTES = 480;

export const OperatorAccessReason = NonEmptyString.pipe(Schema.check(Schema.isMaxLength(500)));
export const OperatorAccessTicket = NonEmptyString.pipe(Schema.check(Schema.isMaxLength(200)));

/**
 * Stored lifecycle of one grant. An open grant whose `expiresAt` has passed is expired; expiry is
 * derived from the clock, never written, so the authorizer needs no sweeper to stay correct.
 */
export const OperatorAccessState = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("open") }),
  Schema.Struct({ closedAt: Timestamp, kind: Schema.Literal("closed") }),
]);
export type OperatorAccessState = typeof OperatorAccessState.Type;

/**
 * A platform administrator's access to one organization's tenant data: one record per
 * (organization, principal), read by the authorizer with a single consistent GetItem. It holds
 * the latest grant; opening after a close or expiry starts a new `grantId` on the same record,
 * and the organization audit log keeps every grant's open, renewal, and close.
 */
export const OrganizationOperatorAccessRecord = makeRecordSchema("organization-operator-access", {
  ...mutableResourceFields,
  expiresAt: Timestamp,
  grantId: Ulid,
  openedAt: Timestamp,
  organizationId: Ulid,
  principalId: Ulid,
  reason: OperatorAccessReason,
  state: OperatorAccessState,
  ticket: Schema.optional(OperatorAccessTicket),
});
export type OrganizationOperatorAccessRecord = typeof OrganizationOperatorAccessRecord.Type;
export type OrganizationOperatorAccess = OrganizationOperatorAccessRecord["data"];

export const OPERATOR_ACCESS_RECORD_SCHEMAS = {
  "organization-operator-access": OrganizationOperatorAccessRecord,
} as const;
