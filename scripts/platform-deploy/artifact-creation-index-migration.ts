import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  decodePlatformRecord,
  type DynamoDatabaseService,
  key,
  listGovernedOrganizationIds,
  makeDynamoDatabase,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { Effect } from "effect";
import {
  type PlatformTables,
  writeDeployMigrationMarker,
} from "./governance-inventory-shards-migration.ts";
import { log } from "./process.ts";

const COMPLETION_MARKER = {
  pk: key("GLOBAL", "deploy-migration"),
  sk: key("DEPLOY-MIGRATION", "artifact-creation-index"),
};

/** Environment index keys sorted by status, which no encoded timestamp can start with. */
const STATUS_SORTED_PREFIXES = ["available", "deleted", "failed", "pending"].map(
  (status) => `${key("ARTIFACT", status)}#`,
);

export type ArtifactCreationIndexMigration =
  | { readonly kind: "already-complete" }
  | {
      readonly kind: "swept";
      /** Environments whose artifact partition the sweep read. */
      readonly environments: number;
      /** Artifacts the sweep read. */
      readonly read: number;
      /** Artifacts whose environment index key now sorts by creation time. */
      readonly fixed: number;
      /** Artifacts that changed between the read and their write; the next deploy reads them again. */
      readonly changed: number;
    };

/** Every environment of `organizationId`, archived ones included: their artifacts stay listed. */
async function environmentIds(database: DynamoDatabaseService, organizationId: string) {
  const ids: string[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await database.queryRecords("control", {
      ExpressionAttributeValues: { ":pk": key("ORG", organizationId), ":prefix": "ENVIRONMENT#" },
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :pk AND begins_with(gsi1sk, :prefix)",
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    });
    for (const record of page.items) {
      if (record.itemType === "environment") ids.push(record.data.id);
    }
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey);
  return ids;
}

/**
 * Rewrites the item's environment index key to the canonical, creation-ordered one, unless the
 * stored item changed since the sweep read it. Nothing else on the item changes.
 */
async function reindex(
  tables: PlatformTables,
  item: Readonly<Record<string, unknown>>,
): Promise<"changed" | "fixed"> {
  const record = await Effect.runPromise(decodePlatformRecord(item));
  const { gsi2sk } = withCanonicalRecordKeys(record);
  try {
    await tables.client.send(
      new PutCommand({
        ConditionExpression: "#data = :data AND #gsi2sk = :gsi2sk",
        ExpressionAttributeNames: { "#data": "data", "#gsi2sk": "gsi2sk" },
        ExpressionAttributeValues: { ":data": item.data, ":gsi2sk": item.gsi2sk },
        Item: { ...item, gsi2sk },
        TableName: tables.tableNames.execution,
      }),
    );
    return "fixed";
  } catch (cause) {
    if (cause instanceof Error && cause.name === "ConditionalCheckFailedException") {
      return "changed";
    }
    throw cause;
  }
}

/**
 * Moves every artifact stored before the environment index sorted artifacts by creation onto the
 * creation-ordered key, once. Such artifacts sort by status and update time
 * (`ARTIFACT#<status>#<updatedAt>#<id>`), so an environment listing shows them after every newer
 * artifact and a creation window leaves them out until this sweep runs. Artifacts live in their
 * environment's execution partition, so the sweep reads that partition for every environment of
 * every governed organization. After a sweep that rewrote every artifact it found, an
 * install-wide marker makes every later run a single read.
 */
export async function migrateArtifactCreationIndex(
  tables: PlatformTables,
): Promise<ArtifactCreationIndexMigration> {
  const database = makeDynamoDatabase(tables.client, tables.tableNames);
  if (await database.getRecord("control", COMPLETION_MARKER, true)) {
    return { kind: "already-complete" };
  }

  const outcomes = { changed: 0, fixed: 0 };
  let environments = 0;
  let read = 0;
  for (const organizationId of await listGovernedOrganizationIds(
    tables.client,
    tables.tableNames,
  )) {
    for (const environmentId of await environmentIds(database, organizationId)) {
      environments += 1;
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await tables.client.send(
          new QueryCommand({
            ConsistentRead: true,
            ExpressionAttributeNames: { "#gsi2sk": "gsi2sk", "#itemType": "itemType" },
            ExpressionAttributeValues: {
              ":artifact": "artifact",
              ":artifacts": "ARTIFACT#",
              ":pk": key("ORG", organizationId, "ENV", environmentId),
              ...Object.fromEntries(
                STATUS_SORTED_PREFIXES.map((prefix, index) => [`:statusSorted${index}`, prefix]),
              ),
            },
            FilterExpression: `#itemType = :artifact AND (${STATUS_SORTED_PREFIXES.map(
              (_prefix, index) => `begins_with(#gsi2sk, :statusSorted${index})`,
            ).join(" OR ")})`,
            KeyConditionExpression: "pk = :pk AND begins_with(sk, :artifacts)",
            TableName: tables.tableNames.execution,
            ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          }),
        );
        read += page.ScannedCount ?? 0;
        for (const item of page.Items ?? []) outcomes[await reindex(tables, item)] += 1;
        exclusiveStartKey = page.LastEvaluatedKey;
      } while (exclusiveStartKey);
    }
  }

  if (outcomes.changed === 0) await writeDeployMigrationMarker(database, "artifact-creation-index");
  log(
    `artifact creation index migration read ${read} artifacts in ${environments} environments, re-keyed ${outcomes.fixed}, and left ${outcomes.changed} that changed during the sweep`,
  );
  return { environments, kind: "swept", read, ...outcomes };
}
