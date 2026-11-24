import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  Metadata,
  NonEmptyString,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
  tenantScopeFields,
} from "../record-schema.ts";

export const EmailTenantRecord = makeRecordSchema("email-tenant", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  id: Ulid,
  name: NonEmptyString,
  status: Schema.Literals(["active", "paused"]),
  region: NonEmptyString,
  providerName: NonEmptyString,
  configurationSetName: NonEmptyString,
  sendingStatus: Schema.Literals(["provisioning", "enabled", "reinstated", "disabled"]),
  providerId: Schema.optional(Schema.String),
  providerArn: Schema.optional(Schema.String),
  providerMetadata: Metadata,
  awsManagedStatus: Schema.optional(Schema.Literals(["disabled", "enabled", "reinstated"])),
  customerManagedStatus: Schema.optional(Schema.Literals(["disabled", "enabled", "reinstated"])),
});
export type EmailTenantRecord = typeof EmailTenantRecord.Type;

export const EmailDomainRecord = makeRecordSchema("email-domain", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  id: Ulid,
  tenantId: Ulid,
  domain: NonEmptyString,
  status: Schema.Literals([
    "pending",
    "provisioning",
    "pending_dns",
    "verified",
    "failed",
    "revoked",
  ]),
  dnsRecords: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      type: Schema.Literals(["CNAME", "MX", "TXT"]),
      value: Schema.String,
      priority: Schema.optional(Schema.Number),
    }),
  ),
  mailFromDomain: NonEmptyString,
  providerIdentity: Schema.optional(Schema.String),
  providerMetadata: Metadata,
  failureReason: Schema.optional(Schema.String),
  lastCheckedAt: Schema.optional(Timestamp),
  verifiedAt: Schema.optional(Timestamp),
  revocationCompletedAt: Schema.optional(Timestamp),
});
export type EmailDomainRecord = typeof EmailDomainRecord.Type;
