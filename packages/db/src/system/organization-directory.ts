import type { DynamoDatabaseService } from "../client-types.ts";
import { key } from "../keys.ts";
import type { OrganizationRecord } from "../records/tenancy.ts";
import {
  decodeSystemCursor,
  encodeSystemCursor,
  runSystemPersistence,
  systemPageLimit,
  type SystemPage,
  type SystemPageOptions,
} from "./support.ts";

type Organization = (typeof OrganizationRecord.Type)["data"];

export interface PlatformOrganizationSummary {
  readonly activeMemberCount: number;
  readonly createdAt: string;
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: Organization["status"];
  readonly updatedAt: string;
}

/** Install-wide organization listing for operators; never scans the control table. */
export interface PlatformOrganizationDirectory {
  /** Every organization ordered by status and last update, through the GSI1 projection. */
  readonly list: (options?: SystemPageOptions) => Promise<SystemPage<PlatformOrganizationSummary>>;
}

const ORGANIZATIONS_PARTITION = key("GLOBAL", "ORGANIZATIONS");
const ORGANIZATION_PREFIX = `${key("ORGANIZATION")}#`;
const MEMBER_PREFIX = `${key("ORGANIZATION-MEMBER")}#`;

export function makePlatformOrganizationDirectory(
  database: DynamoDatabaseService,
): PlatformOrganizationDirectory {
  async function activeMemberCount(organizationId: string) {
    let count = 0;
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await runSystemPersistence(
        "count organization members",
        database.queryRecords("control", {
          ConsistentRead: true,
          ExpressionAttributeNames: { "#data": "data", "#status": "status" },
          ExpressionAttributeValues: {
            ":active": "active",
            ":pk": key("ORG", organizationId),
            ":prefix": MEMBER_PREFIX,
          },
          FilterExpression: "#data.#status = :active",
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      count += page.items.filter(
        (record) => record.itemType === "organization-member" && record.data.status === "active",
      ).length;
      exclusiveStartKey = page.lastEvaluatedKey;
    } while (exclusiveStartKey);
    return count;
  }

  return {
    async list(options = {}) {
      const exclusiveStartKey = decodeSystemCursor(options.cursor, {
        partition: ORGANIZATIONS_PARTITION,
        partitionField: "gsi1pk",
      });
      const page = await runSystemPersistence(
        "list organizations",
        database.queryRecords("control", {
          ExpressionAttributeValues: {
            ":pk": ORGANIZATIONS_PARTITION,
            ":prefix": ORGANIZATION_PREFIX,
          },
          IndexName: "gsi1",
          KeyConditionExpression: "gsi1pk = :pk AND begins_with(gsi1sk, :prefix)",
          Limit: systemPageLimit(options.limit),
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      const organizations = page.items.flatMap((record) =>
        record.itemType === "organization" ? [record.data] : [],
      );
      const items = await Promise.all(
        organizations.map(async (organization) => ({
          activeMemberCount: await activeMemberCount(organization.id),
          createdAt: organization.createdAt,
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          status: organization.status,
          updatedAt: organization.updatedAt,
        })),
      );
      return {
        items,
        ...(page.lastEvaluatedKey ? { nextCursor: encodeSystemCursor(page.lastEvaluatedKey) } : {}),
      };
    },
  };
}
