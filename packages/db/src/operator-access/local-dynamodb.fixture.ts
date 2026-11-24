import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  type CreateTableCommandInput,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { TableNames } from "../client-types.ts";
import { makeDynamoDatabase } from "../dynamo-database.ts";
import {
  isOrganizationGateSource,
  organizationGateLaneRepairItems,
  organizationGateSourceOrganizationId,
  organizationGateState,
} from "../organization-gate/lanes.ts";
import { tableForItemType, type PlatformRecord } from "../records/index.ts";

/** `DYNAMODB_LOCAL_ENDPOINT`, when the run has DynamoDB Local; tests skip without it. */
export const DYNAMODB_LOCAL_ENDPOINT = process.env.DYNAMODB_LOCAL_ENDPOINT;

const KEY = [
  { AttributeName: "pk", KeyType: "HASH" },
  { AttributeName: "sk", KeyType: "RANGE" },
] as const;

function indexed(name: string, indexes: readonly string[]): CreateTableCommandInput {
  return {
    AttributeDefinitions: [
      "pk",
      "sk",
      ...indexes.flatMap((index) => [`${index}pk`, `${index}sk`]),
    ].map((attribute) => ({ AttributeName: attribute, AttributeType: "S" as const })),
    BillingMode: "PAY_PER_REQUEST",
    ...(indexes.length > 0
      ? {
          GlobalSecondaryIndexes: indexes.map((index) => ({
            IndexName: index,
            KeySchema: [
              { AttributeName: `${index}pk`, KeyType: "HASH" as const },
              { AttributeName: `${index}sk`, KeyType: "RANGE" as const },
            ],
            Projection: { ProjectionType: "ALL" as const },
          })),
        }
      : {}),
    KeySchema: [...KEY],
    TableName: name,
  };
}

/**
 * Fresh, uniquely named platform tables on DynamoDB Local with the production key and index
 * layout, so a test exercises the real database client, conditions, and transactions.
 */
export async function localPlatformTables(endpoint: string) {
  const client = new DynamoDBClient({
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
    endpoint,
    region: "us-east-1",
  });
  const suffix = crypto.randomUUID();
  const names: TableNames = {
    control: `control-${suffix}`,
    events: `events-${suffix}`,
    execution: `execution-${suffix}`,
    identity: `identity-${suffix}`,
    "identity-email-outbox": `identity-email-outbox-${suffix}`,
    usage: `usage-${suffix}`,
  };
  const created = [
    indexed(names.control, ["gsi1", "gsi2"]),
    indexed(names.events, ["gsi1", "gsi2"]),
  ];
  await Promise.all(created.map((table) => client.send(new CreateTableCommand(table))));
  const documents = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
  return {
    database: makeDynamoDatabase(documents, names),
    /**
     * Seeds records as other components wrote them, without this test's transactions. A seeded
     * organization gets the gate lanes its writes would have left.
     */
    seed: async (records: readonly PlatformRecord[]) => {
      for (const record of records) {
        await documents.send(
          new PutCommand({ Item: record, TableName: names[tableForItemType(record.itemType)] }),
        );
        if (!isOrganizationGateSource(record)) continue;
        const organizationId = organizationGateSourceOrganizationId(record);
        await documents.send(
          new TransactWriteCommand({
            TransactItems: [
              ...organizationGateLaneRepairItems({
                at: new Date().toISOString(),
                controlTable: names.control,
                lanes: [],
                organizationId,
                state: organizationGateState(organizationId, [record]),
              }),
            ],
          }),
        );
      }
    },
    drop: () =>
      Promise.all(
        created.map((table) => client.send(new DeleteTableCommand({ TableName: table.TableName }))),
      ),
  };
}
