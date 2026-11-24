import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  NonEmptyString,
  NonNegativeSafeInteger,
  StringList,
  Timestamp,
  stateVersionFields,
  tenantScopeFields,
} from "../record-schema.ts";

export const status = Schema.Literals(["active", "archived", "disabled"]);

export const AgentEmailBasisPoints = NonNegativeSafeInteger.pipe(
  Schema.check(Schema.isLessThanOrEqualTo(10_000)),
);
export const AgentEmailAttachmentByteLimit = NonNegativeSafeInteger.pipe(
  Schema.check(Schema.isLessThanOrEqualTo(4 * 1024 * 1024)),
);
export const AgentEmailRecipientLimit = NonNegativeSafeInteger.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(47)),
);
export const AgentEmailRawRetentionDays = NonNegativeSafeInteger.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(365)),
);

export const InboxPlacementStatus = Schema.Literals([
  "active",
  "deprovisioning",
  "disabled",
  "failed",
  "provisioning",
  "reconciling",
]);

export const InboxDomainStatus = Schema.Literals([
  "failed",
  "pending",
  "pending_dns",
  "provisioning",
  "revoked",
  "verified",
]);

export const uniqueClaimFields = {
  createdAt: Timestamp,
  expiresAt: Schema.optional(Timestamp),
  namespace: NonEmptyString,
  ownerId: Ulid,
  ownerItemType: NonEmptyString,
  ownerPk: NonEmptyString,
  ownerSk: NonEmptyString,
  ownerTable: Schema.Literals(["control", "events", "execution", "identity", "usage"]),
  value: NonEmptyString,
} as const;

export const OAuthClientRegistration = Schema.Literals([
  "pre_registered",
  "client_id_metadata_document",
  "dynamic_client_registration",
]);

export const oauthAuthorizationAttemptFields = {
  ...stateVersionFields,
  ...tenantScopeFields,
  completedAt: Schema.optional(Schema.String),
  connectionId: Schema.optional(Ulid),
  createdAt: Timestamp,
  expiresAt: Timestamp,
  id: Ulid,
  oauthClientId: Schema.optional(NonEmptyString),
  oauthClientRegistration: Schema.optional(OAuthClientRegistration),
  oauthIssParameterSupported: Schema.optional(Schema.Boolean),
  oauthIssuer: Schema.optional(NonEmptyString),
  /** The operator access a platform administrator started the authorization under. */
  operatorAccessGrantId: Schema.optional(Ulid),
  principalId: Ulid,
  /** Absent when the client is a client ID metadata document (no provider-application). */
  providerApplicationId: Schema.optional(Ulid),
  providerKey: NonEmptyString,
  requestedResource: Schema.optional(NonEmptyString),
  requestedScopes: StringList,
  /** Allowlisted HTTPS URL the callback redirects to; absent renders a static result page. */
  returnTo: Schema.optional(NonEmptyString),
  stateHash: NonEmptyString,
  status: Schema.Literals(["completed", "consumed", "expired", "pending"]),
} as const;
