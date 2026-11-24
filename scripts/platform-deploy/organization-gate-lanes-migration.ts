import { setTimeout as sleep } from "node:timers/promises";
import {
  type DynamoDBDocumentClient,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  isOrganizationGateSource,
  key,
  makeDynamoDatabase,
  organizationGateLaneRepairItems,
  organizationGateState,
  readOrganizationGateLanes,
  type DynamoDatabaseService,
  type OrganizationGateSource,
  type TableNames,
  type Ulid,
} from "@deployments-ai/db";
import { log } from "./process.ts";

type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
type RecordKey = Readonly<Record<"pk" | "sk", string>>;

const PAGE_SIZE = 50;
const MAX_ATTEMPTS = 8;

export interface OrganizationGateLaneReconciliation {
  /** Organizations whose lanes were created or rewritten to match their gate sources. */
  readonly repaired: readonly Ulid[];
  /** Organizations whose lanes already matched. */
  readonly current: number;
}

/** The singleton gate sources of one organization, by key. */
function singletonSourceKeys(organizationId: Ulid): readonly RecordKey[] {
  return [
    "ORG",
    "ERASURE-FENCE",
    "MEMORY-SEARCH-PLACEMENT",
    "MEMORY-SEARCH-MUTATION-FENCE",
    "BRAIN-SEARCH-PLACEMENT",
  ].map((prefix) => ({ pk: key("ORG", organizationId), sk: key(prefix, organizationId) }));
}

/**
 * A condition check that fails if the gate source at `recordKey` changed after it was read, so a
 * repair never writes lanes from sources that a concurrent writer (old or new code) just changed.
 */
function unchangedSourceCheck(
  recordKey: RecordKey,
  source: OrganizationGateSource | undefined,
  controlTable: string,
): TransactItem {
  const check = { Key: recordKey, TableName: controlTable };
  if (!source)
    return { ConditionCheck: { ...check, ConditionExpression: "attribute_not_exists(pk)" } };
  if (source.itemType === "erasure-fence") {
    return {
      ConditionCheck: {
        ...check,
        ConditionExpression: `#data.#operationId = :operationId AND #data.#createdAt = :createdAt AND ${
          source.data.leaseExpiresAt === undefined
            ? "attribute_not_exists(#data.#leaseExpiresAt)"
            : "#data.#leaseExpiresAt = :leaseExpiresAt"
        }`,
        ExpressionAttributeNames: {
          "#createdAt": "createdAt",
          "#data": "data",
          "#leaseExpiresAt": "leaseExpiresAt",
          "#operationId": "operationId",
        },
        ExpressionAttributeValues: {
          ":createdAt": source.data.createdAt,
          ":operationId": source.data.operationId,
          ...(source.data.leaseExpiresAt === undefined
            ? {}
            : { ":leaseExpiresAt": source.data.leaseExpiresAt }),
        },
      },
    };
  }
  return {
    ConditionCheck: {
      ...check,
      ConditionExpression: "#data.#version = :version",
      ExpressionAttributeNames: { "#data": "data", "#version": "version" },
      ExpressionAttributeValues: { ":version": source.data.version },
    },
  };
}

async function providerGates(database: DynamoDatabaseService, organizationId: Ulid) {
  const gates: OrganizationGateSource[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await database.queryRecords("control", {
      ConsistentRead: true,
      ExpressionAttributeValues: {
        ":pk": key("ORG", organizationId),
        ":prefix": `${key("MEMORY-PROVIDER-MUTATION-GATE")}#`,
      },
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    });
    gates.push(...page.items.filter(isOrganizationGateSource));
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey);
  return gates;
}

function isContention(cause: unknown) {
  return (
    cause instanceof Error &&
    (cause.name === "TransactionCanceledException" ||
      cause.name === "TransactionConflictException" ||
      cause.name === "ProvisionedThroughputExceededException" ||
      cause.name === "ThrottlingException")
  );
}

/**
 * Brings one organization's gate lanes to the state its gate sources define, in one transaction
 * that also checks every source it read is unchanged. Returns whether it wrote anything.
 */
export async function reconcileOrganization(
  tables: { readonly client: DynamoDBDocumentClient; readonly tableNames: TableNames },
  organizationId: Ulid,
): Promise<boolean> {
  const { client, tableNames } = tables;
  const database = makeDynamoDatabase(client, tableNames);
  for (let attempt = 1; ; attempt += 1) {
    const singletons = await Promise.all(
      singletonSourceKeys(organizationId).map(async (recordKey) => {
        const record = await database.getRecord("control", recordKey, true);
        return {
          recordKey,
          source: record && isOrganizationGateSource(record) ? record : undefined,
        };
      }),
    );
    const gates = await providerGates(database, organizationId);
    const lanes = await readOrganizationGateLanes(client, tableNames.control, organizationId);
    const state = organizationGateState(organizationId, [
      ...singletons.flatMap(({ source }) => (source ? [source] : [])),
      ...gates,
    ]);
    const repairs = organizationGateLaneRepairItems({
      at: new Date().toISOString(),
      controlTable: tableNames.control,
      lanes,
      organizationId,
      state,
    }).filter((item) => !item.ConditionCheck);
    if (repairs.length === 0) return false;
    try {
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            ...singletons.map(({ recordKey, source }) =>
              unchangedSourceCheck(recordKey, source, tableNames.control),
            ),
            ...gates.map((gate) =>
              unchangedSourceCheck({ pk: gate.pk, sk: gate.sk }, gate, tableNames.control),
            ),
            ...repairs,
          ],
        }),
      );
      return true;
    } catch (cause) {
      if (!isContention(cause) || attempt >= MAX_ATTEMPTS) throw cause;
      await sleep(Math.min(2_000, 25 * 2 ** attempt * Math.random()));
    }
  }
}

/**
 * Creates or repairs the 32 gate lanes of every organization from its gate sources (organization,
 * erasure fence, memory search placement and mutation fence, provider mutation gates, Brain search
 * placement). Safe to run repeatedly and while older code that does not maintain lanes is live: each
 * organization is repaired in one transaction conditioned on the sources it read and the lane
 * versions it read, so a concurrent gate change makes it read again instead of writing stale state.
 */
export async function reconcileOrganizationGateLanes(tables: {
  readonly client: DynamoDBDocumentClient;
  readonly tableNames: TableNames;
}): Promise<OrganizationGateLaneReconciliation> {
  const database = makeDynamoDatabase(tables.client, tables.tableNames);
  const repaired: Ulid[] = [];
  let current = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await database.queryRecords("control", {
      ExpressionAttributeValues: {
        ":pk": key("GLOBAL", "ORGANIZATIONS"),
        ":prefix": `${key("ORGANIZATION")}#`,
      },
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :pk AND begins_with(gsi1sk, :prefix)",
      Limit: PAGE_SIZE,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    });
    for (const record of page.items) {
      if (record.itemType !== "organization") continue;
      if (await reconcileOrganization(tables, record.data.id)) repaired.push(record.data.id);
      else current += 1;
    }
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey);
  log(
    `organization gate lanes: repaired ${repaired.length} organizations, ${current} already current`,
  );
  return { current, repaired };
}
