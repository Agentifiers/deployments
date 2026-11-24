import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import * as ControlFields from "./control-fields.ts";
import {
  Metadata,
  NonEmptyString,
  StringList,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
  tenantScopeFields,
} from "../record-schema.ts";

const status = ControlFields.status;

export const OrganizationRecord = makeRecordSchema("organization", {
  ...mutableResourceFields,
  billingAccountId: Schema.optional(Ulid),
  id: Ulid,
  metadata: Schema.optional(Metadata),
  name: Schema.String,
  slug: NonEmptyString,
  status,
});

export const OrganizationMemberRecord = makeRecordSchema("organization-member", {
  ...mutableResourceFields,
  invitedAt: Schema.optional(Schema.String),
  joinedAt: Schema.optional(Schema.String),
  organizationId: Ulid,
  principalId: Ulid,
  removedAt: Schema.optional(Timestamp),
  removedByPrincipalId: Schema.optional(Ulid),
  role: Schema.Literals(["admin", "billing", "member", "owner", "viewer"]),
  status: Schema.Literals(["active", "invited", "removed"]),
});

export const OrganizationInvitationRecord = makeRecordSchema("organization-invitation", {
  ...mutableResourceFields,
  acceptedAt: Schema.optional(Timestamp),
  acceptedByPrincipalId: Schema.optional(Ulid),
  email: NonEmptyString,
  expiresAt: Timestamp,
  id: Ulid,
  invitedByPrincipalId: Ulid,
  organizationId: Ulid,
  revokedAt: Schema.optional(Timestamp),
  role: Schema.Literals(["admin", "billing", "member", "owner", "viewer"]),
  status: Schema.Literals(["accepted", "expired", "pending", "revoked"]),
  tokenHash: NonEmptyString,
});

export const ProjectRecord = makeRecordSchema("project", {
  ...mutableResourceFields,
  id: Ulid,
  metadata: Schema.optional(Metadata),
  name: Schema.String,
  organizationId: Ulid,
  slug: NonEmptyString,
  status,
});

export const EnvironmentRecord = makeRecordSchema("environment", {
  ...mutableResourceFields,
  id: Ulid,
  kind: Schema.Literals(["custom", "development", "production", "staging"]),
  metadata: Schema.optional(Metadata),
  name: Schema.String,
  organizationId: Ulid,
  projectId: Ulid,
  slug: NonEmptyString,
  status,
});

export const ServiceAccountRecord = makeRecordSchema("service-account", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  createdByPrincipalId: Schema.optional(Ulid),
  description: Schema.optional(Schema.String),
  id: Ulid,
  name: Schema.String,
  scopes: StringList,
  status,
});

export const ApiCredentialRecord = makeRecordSchema("api-credential", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  credentialHash: NonEmptyString,
  expiresAt: Schema.optional(Timestamp),
  id: Ulid,
  keyPrefix: Schema.String,
  lastUsedAt: Schema.optional(Schema.String),
  name: Schema.String,
  revokedAt: Schema.optional(Schema.String),
  scopes: StringList,
  serviceAccountId: Ulid,
  status: Schema.Literals(["active", "expired", "revoked"]),
});

export const TENANCY_RECORD_SCHEMAS = {
  "api-credential": ApiCredentialRecord,
  environment: EnvironmentRecord,
  organization: OrganizationRecord,
  "organization-invitation": OrganizationInvitationRecord,
  "organization-member": OrganizationMemberRecord,
  project: ProjectRecord,
  "service-account": ServiceAccountRecord,
} as const;
