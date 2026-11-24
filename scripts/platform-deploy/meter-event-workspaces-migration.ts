import { PutCommand, QueryCommand, type QueryCommandOutput } from "@aws-sdk/lib-dynamodb";
import {
  decodePlatformRecord,
  type DynamoDatabaseService,
  key,
  listGovernedOrganizationIds,
  makeDynamoDatabase,
} from "@deployments-ai/db";
import { Effect, Schema } from "effect";
import {
  type PlatformTables,
  writeDeployMigrationMarker,
} from "./governance-inventory-shards-migration.ts";
import { log } from "./process.ts";

const COMPLETION_MARKER = {
  pk: key("GLOBAL", "deploy-migration"),
  sk: key("DEPLOY-MIGRATION", "meter-event-workspaces"),
};

const UnattributedMeterEvent = Schema.Struct({
  data: Schema.Struct({ observability: Schema.Struct({ workspaceId: Schema.String }) }),
  pk: Schema.String,
  sk: Schema.String,
});
const decodeUnattributed = Schema.decodeUnknownSync(UnattributedMeterEvent);

export type MeterEventWorkspacesMigration =
  | { readonly kind: "already-complete" }
  | {
      readonly kind: "swept";
      /** Environments whose meter event partition the sweep read. */
      readonly environments: number;
      /** Meter events the sweep read. */
      readonly read: number;
      /** Meter events that now name their run's workspace. */
      readonly fixed: number;
      /** Meter events that changed between the read and their write; the next deploy reads them again. */
      readonly changed: number;
    };

/**
 * Every environment of `organizationId`, archived ones included: an environment is archived, never
 * deleted, and its meter events stay in its usage partition.
 */
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
 * Writes `item` back naming the workspace its run context names, unless the stored item changed
 * since the sweep read it. Fails when the attributed item still does not decode.
 */
async function attribute(
  tables: PlatformTables,
  item: NonNullable<QueryCommandOutput["Items"]>[number],
): Promise<"changed" | "fixed"> {
  const event = decodeUnattributed(item);
  const attributed = {
    ...item,
    data: { ...item.data, workspaceId: event.data.observability.workspaceId },
  };
  await Effect.runPromise(decodePlatformRecord(attributed)).catch((cause: unknown) => {
    throw new Error(
      `Meter event ${event.pk} ${event.sk} does not decode even once it names its run's workspace.`,
      { cause },
    );
  });
  // A meter event that decodes carries no `ttl`, so the condition matches the item as read.
  try {
    await tables.client.send(
      new PutCommand({
        ConditionExpression: "#data = :data AND attribute_not_exists(#ttl)",
        ExpressionAttributeNames: { "#data": "data", "#ttl": "ttl" },
        ExpressionAttributeValues: { ":data": item.data },
        Item: attributed,
        TableName: tables.tableNames.usage,
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
 * Names the workspace on every meter event stored before meter events did, once. Decoding refuses a
 * run's meter event whose run context names a workspace the event does not, so each such event is
 * rewritten with `data.workspaceId` set to its run's workspace and nothing else changed. Meter
 * events live in their environment's usage partition, so the sweep reads that partition for every
 * environment of every governed organization. Usage counters stay as they are. After a sweep that
 * rewrote every event it found, an install-wide marker makes every later run a single read.
 */
export async function migrateMeterEventWorkspaces(
  tables: PlatformTables,
): Promise<MeterEventWorkspacesMigration> {
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
            ExpressionAttributeNames: {
              "#data": "data",
              "#itemType": "itemType",
              "#observability": "observability",
              "#workspaceId": "workspaceId",
            },
            ExpressionAttributeValues: {
              ":meterEvent": "meter-event",
              ":meterEvents": "METER-EVENT#",
              ":pk": key("ORG", organizationId, "ENV", environmentId),
            },
            FilterExpression:
              "#itemType = :meterEvent AND attribute_exists(#data.#observability.#workspaceId) AND attribute_not_exists(#data.#workspaceId)",
            KeyConditionExpression: "pk = :pk AND begins_with(sk, :meterEvents)",
            TableName: tables.tableNames.usage,
            ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          }),
        );
        read += page.ScannedCount ?? 0;
        for (const item of page.Items ?? []) outcomes[await attribute(tables, item)] += 1;
        exclusiveStartKey = page.LastEvaluatedKey;
      } while (exclusiveStartKey);
    }
  }

  if (outcomes.changed === 0) await writeDeployMigrationMarker(database, "meter-event-workspaces");
  log(
    `meter event workspaces migration read ${read} meter events in ${environments} environments, named the workspace on ${outcomes.fixed}, and left ${outcomes.changed} that changed during the sweep`,
  );
  return { environments, kind: "swept", read, ...outcomes };
}
