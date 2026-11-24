import type { DynamoDatabaseService } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import { PersistenceError } from "../persistence-types.ts";
import {
  CREDENTIAL_REFERENCE_OWNER_TYPES,
  credentialReferenceSummary,
  type CredentialReferenceOwner,
  type CredentialReferenceOwnerType,
  type CredentialReferenceSummary,
} from "./owner-projection.ts";

/** Storage pages one inventory request may read before it returns a partial page. */
const MAX_STORAGE_PAGES_PER_REQUEST = 10;

/**
 * Resume point of an inventory listing: the owner type being read and, when reading has started
 * inside it, the last owner examined. Owners sort by ID within a type.
 */
export interface CredentialReferencePosition {
  readonly ownerId?: Ulid;
  readonly ownerType: CredentialReferenceOwnerType;
}

export interface ListCredentialReferencesInput {
  readonly after?: CredentialReferencePosition;
  readonly environmentId: Ulid;
  /** Page size from 1 through 100. */
  readonly limit: number;
  readonly organizationId: Ulid;
  readonly ownerType?: CredentialReferenceOwnerType;
}

export interface CredentialReferencePage {
  readonly items: readonly CredentialReferenceSummary[];
  readonly next?: CredentialReferencePosition;
}

export interface CredentialReferenceInventory {
  readonly list: (input: ListCredentialReferencesInput) => Promise<CredentialReferencePage>;
}

/**
 * Lists the vault references held by an environment's durable owner records. Each owner type is
 * read from the environment partition in ID order, so a position resumes without duplicates or
 * gaps. The vault table is never read: only owner-held reference metadata is returned.
 */
export function makeCredentialReferenceInventory(
  database: DynamoDatabaseService,
): CredentialReferenceInventory {
  return {
    async list(input) {
      const ownerTypes: readonly CredentialReferenceOwnerType[] = input.ownerType
        ? [input.ownerType]
        : CREDENTIAL_REFERENCE_OWNER_TYPES;
      let typeIndex = input.after ? ownerTypes.indexOf(input.after.ownerType) : 0;
      if (typeIndex < 0) {
        throw new PersistenceError(
          "invalid-input",
          "invalid_cursor",
          "The pagination cursor is invalid.",
        );
      }
      const partition = key("ORG", input.organizationId, "ENV", input.environmentId);
      let lastOwnerId = input.after?.ownerId;
      let exclusiveStartKey: Record<string, unknown> | undefined = lastOwnerId
        ? { pk: partition, sk: key(ownerTypes[typeIndex]!.toUpperCase(), lastOwnerId) }
        : undefined;
      const items: CredentialReferenceSummary[] = [];
      for (let pages = 0; typeIndex < ownerTypes.length; pages += 1) {
        const ownerType = ownerTypes[typeIndex]!;
        if (pages === MAX_STORAGE_PAGES_PER_REQUEST) {
          return { items, next: { ownerType, ...(lastOwnerId ? { ownerId: lastOwnerId } : {}) } };
        }
        const page = await database.queryRecords("control", {
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          ExpressionAttributeValues: {
            ":pk": partition,
            ":sk": `${key(ownerType.toUpperCase())}#`,
          },
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
          Limit: input.limit,
        });
        for (const [index, record] of page.items.entries()) {
          if (record.itemType !== ownerType) continue;
          const owner = record as CredentialReferenceOwner;
          lastOwnerId = owner.data.id;
          const summary = credentialReferenceSummary(owner);
          if (!summary) continue;
          items.push(summary);
          if (items.length < input.limit) continue;
          const more =
            index < page.items.length - 1 ||
            page.lastEvaluatedKey !== undefined ||
            typeIndex < ownerTypes.length - 1;
          return more ? { items, next: { ownerId: lastOwnerId, ownerType } } : { items };
        }
        if (page.lastEvaluatedKey) {
          exclusiveStartKey = page.lastEvaluatedKey;
        } else {
          typeIndex += 1;
          exclusiveStartKey = undefined;
          lastOwnerId = undefined;
        }
      }
      return { items };
    },
  };
}
