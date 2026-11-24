import { createHash } from "node:crypto";
import { DIRECTORY_CONTROL_RECORD_SCHEMAS } from "../records/directory.ts";
import type { PlatformRecord } from "../records/index.ts";
import { claimOwnerAttributes, claimRequirement } from "../unique-claim-requirement.ts";
import type { UniqueClaimRequirement } from "../unique-claims.ts";

export type DirectoryItemType = keyof typeof DIRECTORY_CONTROL_RECORD_SCHEMAS;
type DirectoryData<ItemType extends DirectoryItemType> =
  (typeof DIRECTORY_CONTROL_RECORD_SCHEMAS)[ItemType]["Type"]["data"];

interface DirectoryRecordRule<ItemType extends DirectoryItemType> {
  /** Fields beyond the common `id`/`organizationId` that a replacement must keep. */
  readonly immutableFields: readonly (keyof DirectoryData<ItemType>)[];
  /** Stored fields an update or delete conditions on, so claims never drift from their owner. */
  readonly ownerAttributes: readonly (keyof DirectoryData<ItemType>)[];
}

/** Directory records have no retention class: like memberships they live until org erasure. */
const DIRECTORY_RECORD_RULES = {
  "organization-directory": {
    immutableFields: [],
    ownerAttributes: ["organizationId"],
  },
  "organization-directory-user": {
    immutableFields: ["origin"],
    ownerAttributes: ["organizationId", "id", "userName", "externalId"],
  },
} as const satisfies { readonly [ItemType in DirectoryItemType]: DirectoryRecordRule<ItemType> };

export const DIRECTORY_TOKEN_HASH_CLAIM_NAMESPACE = "directory-token-hash";

export function directoryUserNameClaimNamespace(organizationId: string) {
  return `organization:${organizationId}:directory-user-name`;
}

export function directoryExternalIdClaimNamespace(organizationId: string) {
  return `organization:${organizationId}:directory-external-id`;
}

/** SCIM userName is case-insensitive (RFC 7643 §4.1.1); the hash keeps claim keys short. */
export function directoryUserNameClaimValue(userName: string) {
  return createHash("sha256").update(userName.toLowerCase()).digest("hex");
}

/** SCIM externalId is case-exact (RFC 7643 §3.1). */
export function directoryExternalIdClaimValue(externalId: string) {
  return createHash("sha256").update(externalId).digest("hex");
}

function isDirectoryItemType(itemType: string): itemType is DirectoryItemType {
  return Object.hasOwn(DIRECTORY_RECORD_RULES, itemType);
}

export function directoryImmutableFields(itemType: string): readonly string[] | undefined {
  return isDirectoryItemType(itemType)
    ? DIRECTORY_RECORD_RULES[itemType].immutableFields
    : undefined;
}

export function directoryClaimOwnerAttributes(
  record: PlatformRecord,
): Readonly<Record<string, unknown>> | undefined {
  return isDirectoryItemType(record.itemType)
    ? claimOwnerAttributes(record.data, DIRECTORY_RECORD_RULES[record.itemType].ownerAttributes)
    : undefined;
}

export function directoryClaimRequirements(
  record: PlatformRecord,
): readonly UniqueClaimRequirement[] {
  switch (record.itemType) {
    case "organization-directory":
      return record.data.tokens.flatMap((token) =>
        claimRequirement(record, DIRECTORY_TOKEN_HASH_CLAIM_NAMESPACE, token.tokenHash),
      );
    case "organization-directory-user": {
      const { externalId, organizationId, userName } = record.data;
      return [
        ...claimRequirement(
          record,
          directoryUserNameClaimNamespace(organizationId),
          directoryUserNameClaimValue(userName),
        ),
        ...(externalId === undefined
          ? []
          : claimRequirement(
              record,
              directoryExternalIdClaimNamespace(organizationId),
              directoryExternalIdClaimValue(externalId),
            )),
      ];
    }
    default:
      record.itemType satisfies Exclude<PlatformRecord["itemType"], DirectoryItemType>;
      return [];
  }
}
