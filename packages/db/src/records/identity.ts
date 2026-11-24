import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import * as ControlFields from "./control-fields.ts";
import {
  Metadata,
  NonEmptyString,
  makeRecordSchema,
  mutableResourceFields,
  tenantScopeFields,
} from "../record-schema.ts";

const status = ControlFields.status;

export const PrincipalRecord = makeRecordSchema("principal", {
  ...mutableResourceFields,
  displayName: Schema.optional(Schema.String),
  id: Ulid,
  kind: Schema.Literals(["human", "service", "support"]),
  metadata: Schema.optional(Metadata),
  platformRole: Schema.optional(Schema.Literal("administrator")),
  primaryEmail: Schema.optional(Schema.String),
  status: ControlFields.status,
});

export const PrincipalIdentityRecord = makeRecordSchema("principal-identity", {
  ...mutableResourceFields,
  /** SAML links only: the connection whose signing certificates proved the subject. */
  connectionId: Schema.optionalKey(Ulid),
  email: Schema.optional(Schema.String),
  id: Ulid,
  issuer: NonEmptyString,
  metadata: Schema.optional(Metadata),
  organizationId: Ulid,
  principalId: Ulid,
  subject: NonEmptyString,
});

export const WorkspaceRecord = makeRecordSchema("workspace", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  createdByPrincipalId: Schema.optional(Ulid),
  description: Schema.optional(Schema.String),
  id: Ulid,
  name: Schema.String,
  slug: NonEmptyString,
  status,
});

export const UniqueClaimRecord = makeRecordSchema("unique-claim", ControlFields.uniqueClaimFields, {
  expiresAtField: "expiresAt",
  expiresAtRequired: false,
});
