import { Schema } from "effect";
import { PrincipalIdentityRecord } from "../records/identity.ts";
import {
  FEDERATION_CONTROL_RECORD_SCHEMAS,
  FEDERATION_IDENTITY_RECORD_SCHEMAS,
} from "../records/identity-federation.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";

const FEDERATION_RECORD_SCHEMAS = {
  ...FEDERATION_CONTROL_RECORD_SCHEMAS,
  ...FEDERATION_IDENTITY_RECORD_SCHEMAS,
  "principal-identity": PrincipalIdentityRecord,
} as const;

export type FederationItemType = keyof typeof FEDERATION_RECORD_SCHEMAS;
export type FederationRecord<ItemType extends FederationItemType> =
  (typeof FEDERATION_RECORD_SCHEMAS)[ItemType]["Type"];

export function federationRecord<ItemType extends FederationItemType>(
  itemType: ItemType,
  data: FederationRecord<ItemType>["data"],
): FederationRecord<ItemType> {
  const expiresAt = "expiresAt" in data ? data.expiresAt : undefined;
  const decode = Schema.decodeUnknownSync(FEDERATION_RECORD_SCHEMAS[itemType]) as (
    input: unknown,
  ) => FederationRecord<ItemType>;
  return decode(
    withCanonicalRecordKeys({
      data,
      itemType,
      ...(expiresAt === undefined ? {} : { ttl: Math.floor(Date.parse(expiresAt) / 1_000) }),
    }),
  );
}

type MutableFederationRecord = FederationRecord<
  Exclude<FederationItemType, "organization-federated-grant">
>;

export function nextFederationRecord<Previous extends MutableFederationRecord>(
  previous: Previous,
  changes: Partial<Previous["data"]>,
  updatedAt: string,
): Previous {
  const data = { ...previous.data, ...changes, updatedAt, version: previous.data.version + 1 };
  const expiresAt = "expiresAt" in data ? data.expiresAt : undefined;
  return Schema.decodeUnknownSync(FEDERATION_RECORD_SCHEMAS[previous.itemType])(
    withCanonicalRecordKeys({
      data,
      itemType: previous.itemType,
      ...(expiresAt === undefined ? {} : { ttl: Math.floor(Date.parse(expiresAt) / 1_000) }),
    }),
  ) as Previous;
}
