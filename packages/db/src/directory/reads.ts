import type { DynamoDatabaseService } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { Keys, key } from "../keys.ts";
import type {
  OrganizationDirectoryRecord,
  OrganizationDirectoryUserRecord,
} from "../records/directory.ts";
import { databaseValue } from "../tenancy-record-mapping.ts";
import {
  directoryExternalIdClaimNamespace,
  directoryExternalIdClaimValue,
  directoryUserNameClaimNamespace,
  directoryUserNameClaimValue,
} from "./record-rules.ts";

export type DirectoryUserAttribute = "externalId" | "userName";

export interface DirectoryReads {
  readonly belongsElsewhere: (principalId: Ulid, organizationId: Ulid) => Promise<boolean>;
  readonly directory: (organizationId: Ulid) => Promise<OrganizationDirectoryRecord | undefined>;
  readonly user: (
    organizationId: Ulid,
    principalId: Ulid,
  ) => Promise<OrganizationDirectoryUserRecord | undefined>;
  readonly userWith: (
    organizationId: Ulid,
    attribute: DirectoryUserAttribute,
    value: string,
  ) => Promise<OrganizationDirectoryUserRecord | undefined>;
  readonly users: (organizationId: Ulid) => Promise<readonly OrganizationDirectoryUserRecord[]>;
}

export function makeDirectoryReads(database: DynamoDatabaseService): DirectoryReads {
  const get = (recordKey: { readonly pk: string; readonly sk: string }) =>
    databaseValue(database.getRecord("control", recordKey, true));

  return {
    directory: async (organizationId: Ulid) => {
      const record = await get({
        pk: key("ORG", organizationId),
        sk: key("ORGANIZATION-DIRECTORY", organizationId),
      });
      return record?.itemType === "organization-directory" ? record : undefined;
    },

    user: async (organizationId: Ulid, principalId: Ulid) => {
      const record = await get({
        pk: key("ORG", organizationId),
        sk: key("ORGANIZATION-DIRECTORY-USER", principalId),
      });
      return record?.itemType === "organization-directory-user" ? record : undefined;
    },

    /** The user holding a userName or externalId in one organization, through its claim. */
    userWith: async (organizationId: Ulid, attribute: DirectoryUserAttribute, value: string) => {
      const claim = await get(
        attribute === "userName"
          ? Keys.control.uniqueClaim(
              directoryUserNameClaimNamespace(organizationId),
              directoryUserNameClaimValue(value),
            )
          : Keys.control.uniqueClaim(
              directoryExternalIdClaimNamespace(organizationId),
              directoryExternalIdClaimValue(value),
            ),
      );
      if (claim?.itemType !== "unique-claim") return undefined;
      const record = await get({ pk: claim.data.ownerPk, sk: claim.data.ownerSk });
      return record?.itemType === "organization-directory-user" ? record : undefined;
    },

    /** Every user of the organization in principal ID order. */
    users: async (organizationId: Ulid) => {
      const users: OrganizationDirectoryUserRecord[] = [];
      let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
      do {
        const page = await databaseValue(
          database.queryRecords("control", {
            ConsistentRead: true,
            ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
            ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
            ExpressionAttributeValues: {
              ":pk": key("ORG", organizationId),
              ":prefix": `${key("ORGANIZATION-DIRECTORY-USER")}#`,
            },
            KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
          }),
        );
        users.push(
          ...page.items.filter(
            (record): record is OrganizationDirectoryUserRecord =>
              record.itemType === "organization-directory-user",
          ),
        );
        exclusiveStartKey = page.lastEvaluatedKey;
      } while (exclusiveStartKey);
      return users;
    },

    /** Whether the principal has a membership row, in any status, outside this organization. */
    belongsElsewhere: async (principalId: Ulid, organizationId: Ulid) => {
      // At most one row per organization, so two rows always reveal another organization.
      const page = await databaseValue(
        database.queryRecords("control", {
          ExpressionAttributeNames: { "#partition": "gsi2pk", "#sort": "gsi2sk" },
          ExpressionAttributeValues: {
            ":partition": key("PRINCIPAL", principalId),
            ":prefix": `${key("ORGANIZATION-MEMBER")}#`,
          },
          IndexName: "gsi2",
          KeyConditionExpression: "#partition = :partition AND begins_with(#sort, :prefix)",
          Limit: 2,
        }),
      );
      return page.items.some(
        (record) =>
          record.itemType === "organization-member" &&
          record.data.organizationId !== organizationId,
      );
    },
  };
}
