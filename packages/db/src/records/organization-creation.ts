import { Ulid } from "../ids.ts";
import {
  NonNegativeSafeInteger,
  makeRecordSchema,
  mutableResourceFields,
} from "../record-schema.ts";

/**
 * Lifetime count of organizations one principal has created. Erasing an organization never
 * lowers it, so deleting and recreating cannot reset an install's creation quota.
 */
export const PrincipalOrganizationCreationsRecord = makeRecordSchema(
  "principal-organization-creations",
  {
    ...mutableResourceFields,
    organizationsCreated: NonNegativeSafeInteger,
    principalId: Ulid,
  },
);
export type PrincipalOrganizationCreationsRecord = typeof PrincipalOrganizationCreationsRecord.Type;

export const ORGANIZATION_CREATION_RECORD_SCHEMAS = {
  "principal-organization-creations": PrincipalOrganizationCreationsRecord,
} as const;
