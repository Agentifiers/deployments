import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  NonEmptyString,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
} from "../record-schema.ts";

/** The roles a directory may grant. Owners and admins are only ever assigned by people. */
export const DirectoryRole = Schema.Literals(["member", "viewer"]);
export type DirectoryRole = typeof DirectoryRole.Type;

export const MAX_DIRECTORY_TOKENS = 2;

const DirectoryText = NonEmptyString.pipe(Schema.check(Schema.isMaxLength(256)));

export const DirectoryToken = Schema.Struct({
  createdAt: Timestamp,
  createdBy: Ulid,
  id: Ulid,
  /** sha256 of the bearer secret, hex. */
  tokenHash: NonEmptyString,
  /** The leading characters of the secret, shown so administrators can tell tokens apart. */
  tokenPrefix: NonEmptyString,
});
export type DirectoryToken = typeof DirectoryToken.Type;

/**
 * One row per organization holds the SCIM settings and its bearer tokens, so the token cap is a
 * schema check and concurrent token writes serialize on `version`. Its `id` is the organization
 * ID because token-hash claims need their owner's id to be a ULID.
 */
export const OrganizationDirectoryRecord = makeRecordSchema("organization-directory", {
  ...mutableResourceFields,
  defaultRole: DirectoryRole,
  id: Ulid,
  organizationId: Ulid,
  tokens: Schema.Array(DirectoryToken).pipe(Schema.check(Schema.isMaxLength(MAX_DIRECTORY_TOKENS))),
}).pipe(
  Schema.check(
    Schema.makeFilter((record) =>
      record.data.id === record.data.organizationId
        ? undefined
        : "An organization directory's id must be its organization ID.",
    ),
  ),
);
export type OrganizationDirectoryRecord = typeof OrganizationDirectoryRecord.Type;

/**
 * The organization's SCIM identity for one principal (`id` is the principal ID). Provenance lives
 * here rather than on the global principal, so organization erasure forgets it.
 */
export const OrganizationDirectoryUserRecord = makeRecordSchema("organization-directory-user", {
  ...mutableResourceFields,
  externalId: Schema.optional(DirectoryText),
  id: Ulid,
  organizationId: Ulid,
  origin: Schema.Literals(["adopted", "provisioned"]),
  userName: DirectoryText,
});
export type OrganizationDirectoryUserRecord = typeof OrganizationDirectoryUserRecord.Type;

export const DIRECTORY_CONTROL_RECORD_SCHEMAS = {
  "organization-directory": OrganizationDirectoryRecord,
  "organization-directory-user": OrganizationDirectoryUserRecord,
} as const;
