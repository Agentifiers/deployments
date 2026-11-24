import type { DynamoDatabaseService } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import type { AppDomainRecord } from "../records/app-domains.ts";
import type { AppGrantRecord, AppRecord, AppReleaseRecord } from "../records/apps.ts";
import type { PlatformRecord } from "../records/index.ts";
import { decodeCursor, encodeCursor } from "../tenancy-record-mapping.ts";

export interface AppPageQuery {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface AppPage<Item> {
  readonly items: readonly Item[];
  readonly nextCursor: string | null;
}

export interface AppReads {
  readonly pageEnvironmentApps: (
    input: AppPageQuery & { readonly environmentId: Ulid; readonly organizationId: Ulid },
  ) => Promise<AppPage<AppRecord>>;
  readonly pageReleases: (
    input: AppPageQuery & { readonly app: AppRecord },
  ) => Promise<AppPage<AppReleaseRecord>>;
  readonly pageGrants: (
    input: AppPageQuery & { readonly app: AppRecord },
  ) => Promise<AppPage<AppGrantRecord>>;
  readonly pageDomains: (
    input: AppPageQuery & { readonly app: AppRecord },
  ) => Promise<AppPage<AppDomainRecord>>;
  readonly isActiveMember: (input: {
    readonly organizationId: Ulid;
    readonly principalId: Ulid;
  }) => Promise<boolean>;
  readonly agentDefinitionReaches: (input: {
    readonly agentDefinitionId: Ulid;
    readonly app: AppRecord;
  }) => Promise<boolean>;
}

type AppListedItemType = "app" | "app-domain" | "app-grant" | "app-release";
type RecordOf<ItemType extends AppListedItemType> = Extract<
  PlatformRecord,
  { readonly itemType: ItemType }
>;

export function appChildPartition(app: AppRecord) {
  return key("ORG", app.data.organizationId, "APP", app.data.id);
}

export function makeAppReads(dependencies: { readonly database: DynamoDatabaseService }): AppReads {
  const { database } = dependencies;

  async function page<ItemType extends AppListedItemType>(
    itemType: ItemType,
    partition: string,
    sortPrefix: string,
    query: AppPageQuery,
  ): Promise<AppPage<RecordOf<ItemType>>> {
    const prefix = `${key(sortPrefix)}#`;
    const exclusiveStartKey = decodeCursor(query.cursor, "base", partition, prefix);
    const result = await database.queryRecords("control", {
      ConsistentRead: true,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      ExpressionAttributeValues: { ":pk": partition, ":sk": prefix },
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
      Limit: query.limit ?? 50,
      ScanIndexForward: false,
    });
    return {
      items: result.items.filter(
        (record): record is RecordOf<ItemType> => record.itemType === itemType,
      ),
      nextCursor: result.lastEvaluatedKey
        ? encodeCursor(result.lastEvaluatedKey, "base", partition, prefix)
        : null,
    };
  }

  return {
    pageEnvironmentApps: ({ environmentId, organizationId, ...query }) =>
      page("app", key("ORG", organizationId, "ENV", environmentId), "APP", query),

    pageReleases: ({ app, ...query }) =>
      page("app-release", appChildPartition(app), "APP-RELEASE", query),

    pageGrants: ({ app, ...query }) =>
      page("app-grant", appChildPartition(app), "APP-GRANT", query),

    pageDomains: ({ app, ...query }) =>
      page("app-domain", appChildPartition(app), "APP-DOMAIN", query),

    async isActiveMember({ organizationId, principalId }) {
      const member = await database.getRecord(
        "control",
        { pk: key("ORG", organizationId), sk: key("ORGANIZATION-MEMBER", principalId) },
        true,
      );
      return member?.itemType === "organization-member" && member.data.status === "active";
    },

    async agentDefinitionReaches({ agentDefinitionId, app }) {
      const definition = await database.getRecord(
        "control",
        {
          pk: key("ORG", app.data.organizationId, "ENV", app.data.environmentId),
          sk: key("AGENT-DEFINITION", agentDefinitionId),
        },
        true,
      );
      return (
        definition?.itemType === "agent-definition" &&
        definition.data.status === "active" &&
        (definition.data.workspaceId === undefined ||
          definition.data.workspaceId === app.data.workspaceId)
      );
    },
  };
}
