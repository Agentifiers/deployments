import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  NonNegativeSafeInteger,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
} from "../record-schema.ts";
import { status } from "./control-fields.ts";

const versioned = { generation: NonNegativeSafeInteger, version: NonNegativeSafeInteger };

/**
 * One of an organization's identical copies of the organization-wide state that tenant writes
 * condition on. The source records stay authoritative; every transaction that changes one rewrites
 * every lane, so a tenant transaction can condition-check one lane instead of the shared sources.
 */
export const OrganizationGateLaneRecord = makeRecordSchema("organization-gate-lane", {
  ...mutableResourceFields,
  brainSearchPlacement: Schema.optional(
    Schema.Struct({
      ...versioned,
      phase: Schema.Literals(["active", "provisioning", "unconfigured"]),
    }),
  ),
  erasureFence: Schema.optional(
    Schema.Struct({ leaseExpiresAt: Schema.optional(Timestamp), operationId: Ulid }),
  ),
  lane: NonNegativeSafeInteger,
  memoryProviderGates: Schema.Record(Ulid, Schema.Literals(["closed", "draining", "open"])),
  memorySearchMutationFence: Schema.optional(
    Schema.Struct({
      epoch: NonNegativeSafeInteger,
      status: Schema.Literals(["closed", "open"]),
      version: NonNegativeSafeInteger,
    }),
  ),
  memorySearchPlacement: Schema.optional(Schema.Struct(versioned)),
  organization: Schema.Struct({ status }),
  organizationId: Ulid,
});
export type OrganizationGateLaneRecord = typeof OrganizationGateLaneRecord.Type;

export const ORGANIZATION_GATE_RECORD_SCHEMAS = {
  "organization-gate-lane": OrganizationGateLaneRecord,
} as const;
