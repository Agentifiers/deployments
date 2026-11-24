import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
  BatchGetCommand,
  type BatchGetCommandOutput,
  DeleteCommand,
  type DynamoDBDocumentClient,
  PutCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  DeployMigrationRecord,
  EntitlementGrant,
  GrantedTenantLimits,
  governanceLegacyInventoryPartition,
  governanceTenantDirectoryKey,
  key,
  makeDynamoDatabase,
  makeOrganizationStandingRepository,
  StandingActor,
  Ulid,
  withCanonicalRecordKeys,
  type InstallDefaults,
  type OrganizationStandingRepository,
  type TableNames,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { log } from "./process.ts";

/**
 * A grant write this migration began for one legacy item. A crash can land the write and lose the
 * delete that follows it, so the next run looks for `grant` in the standing history after
 * `standingVersion` before it folds the item again.
 */
const FoldClaim = Schema.Struct({
  grant: EntitlementGrant,
  standingVersion: Schema.Number,
});
type FoldClaim = typeof FoldClaim.Type;

/** An override an operator set through the removed `organization-limits` routes. */
const LegacyOrganizationLimits = Schema.Struct({
  data: Schema.Struct({
    organizationId: Ulid,
    overrides: GrantedTenantLimits,
    updatedBy: Ulid,
    version: Schema.Number,
  }),
  itemType: Schema.Literal("organization-limits"),
  migration: Schema.optional(FoldClaim),
});
type LegacyOrganizationLimits = typeof LegacyOrganizationLimits.Type;

interface LegacyItem {
  readonly item: Record<string, unknown>;
  readonly legacy: LegacyOrganizationLimits;
}

type RecordKey = Readonly<Record<"pk" | "sk", string>>;

const decodeLegacy = Schema.decodeUnknownSync(LegacyOrganizationLimits);
const decodeActor = Schema.decodeUnknownSync(StandingActor);
const decodeMarker = Schema.decodeUnknownSync(DeployMigrationRecord);
/** Three keys per organization fill one BatchGet, which takes at most 100. */
const PAGE_SIZE = 33;
const HISTORY_PAGE_SIZE = 25;
const COMPLETION_MARKER = {
  pk: key("GLOBAL", "deploy-migration"),
  sk: key("DEPLOY-MIGRATION", "organization-limits"),
};

const legacyKey = (organizationId: string): RecordKey => ({
  pk: key("ORG", organizationId),
  sk: key("ORGANIZATION-LIMITS", organizationId),
});

/**
 * Where a legacy item's governance tenant-inventory locator can be. The platform wrote it to the
 * legacy partition, and a released inventory reader may already have moved it to its shard.
 */
function locatorKeys(organizationId: string): readonly RecordKey[] {
  const legacy = legacyKey(organizationId);
  const shard = governanceTenantDirectoryKey(organizationId, "control", legacy.pk, legacy.sk);
  return [{ pk: governanceLegacyInventoryPartition(organizationId), sk: shard.sk }, shard];
}

/**
 * The repository derives effective standing from install defaults, which this migration never
 * reads: it reads stored grants and writes the operator grant.
 */
const UNREAD_INSTALL_DEFAULTS: InstallDefaults = {
  operatorFundedModelSpendCeiling: "unlimited",
  tenantLimits: {
    activeSandboxes: 0,
    apiRequestBurst: 1,
    apiRequestsPerSecond: 1,
    concurrentRuns: 1,
  },
};

export type OrganizationLimitsMigration =
  | { readonly kind: "already-complete" }
  | {
      readonly kind: "swept";
      /** Organizations whose operator grant gained a field before their legacy item was deleted. */
      readonly copied: readonly Ulid[];
      /** Organizations whose legacy item was deleted with nothing left to add to the grant. */
      readonly retired: readonly Ulid[];
      /** Organizations whose legacy item changed during the sweep; the next deploy folds it. */
      readonly remaining: readonly Ulid[];
    };

type LimitName = keyof GrantedTenantLimits;
type Fold = "copied" | "remaining" | "retired";

/**
 * Reads each organization's legacy item and its locators. Tenant inventory cannot resolve a locator
 * whose legacy item is gone, so tenant export and erasure fail until the orphan is deleted.
 */
async function legacyLimits(
  client: DynamoDBDocumentClient,
  table: string,
  organizationIds: readonly string[],
): Promise<{ readonly found: LegacyItem[]; readonly orphanLocators: RecordKey[] }> {
  const found: LegacyItem[] = [];
  const locators = new Set<string>();
  let keys: Record<string, unknown>[] | undefined = organizationIds.flatMap((organizationId) => [
    legacyKey(organizationId),
    ...locatorKeys(organizationId),
  ]);
  for (let attempt = 0; keys && keys.length > 0; attempt += 1) {
    if (attempt > 0) await sleep(Math.min(2_000, 50 * 2 ** attempt));
    const result: BatchGetCommandOutput = await client.send(
      new BatchGetCommand({ RequestItems: { [table]: { ConsistentRead: true, Keys: keys } } }),
    );
    for (const item of result.Responses?.[table] ?? []) {
      if (item.itemType === "organization-limits") found.push({ item, legacy: decodeLegacy(item) });
      else locators.add(`${item.pk}\0${item.sk}`);
    }
    keys = result.UnprocessedKeys?.[table]?.Keys;
  }
  const legacyOrganizations = new Set<string>(
    found.map(({ legacy }) => legacy.data.organizationId),
  );
  const orphanLocators = organizationIds.flatMap((organizationId) =>
    legacyOrganizations.has(organizationId)
      ? []
      : locatorKeys(organizationId).filter((locator) =>
          locators.has(`${locator.pk}\0${locator.sk}`),
        ),
  );
  return { found, orphanLocators };
}

/**
 * The override fields the operator grant does not set yet. A field the grant sets wins. A legacy
 * burst below the grant's rate, or a legacy rate above the grant's burst, is dropped and logged:
 * it was coherent with the defaults it was written against, not with the grant.
 */
function addedLimits(
  organizationId: Ulid,
  granted: GrantedTenantLimits,
  overrides: GrantedTenantLimits,
): GrantedTenantLimits {
  const added: Partial<Record<LimitName, number>> = {};
  for (const name of Object.keys(overrides) as LimitName[]) {
    const value = overrides[name];
    if (value !== undefined && granted[name] === undefined) added[name] = value;
  }
  const burst = added.apiRequestBurst ?? granted.apiRequestBurst;
  const rate = added.apiRequestsPerSecond ?? granted.apiRequestsPerSecond;
  const dropped: LimitName | undefined =
    added.apiRequestBurst !== undefined
      ? "apiRequestBurst"
      : added.apiRequestsPerSecond !== undefined
        ? "apiRequestsPerSecond"
        : undefined;
  if (dropped && burst !== undefined && rate !== undefined && burst < rate) {
    log(
      `organization limits migration dropped ${organizationId}'s legacy ${dropped} ${added[dropped]}: its operator grant would set apiRequestBurst ${burst} below apiRequestsPerSecond ${rate}`,
    );
    delete added[dropped];
  }
  return added;
}

const isTransactionCanceled = Schema.is(
  Schema.Struct({
    CancellationReasons: Schema.Array(Schema.Struct({ Code: Schema.optional(Schema.String) })),
    name: Schema.Literal("TransactionCanceledException"),
  }),
);

/** A conditional write, alone or inside a transaction, that the stored item refused. */
function conditionFailed(cause: unknown) {
  if (cause instanceof Error && cause.name === "ConditionalCheckFailedException") return true;
  return (
    isTransactionCanceled(cause) &&
    cause.CancellationReasons.some((reason) => reason.Code === "ConditionalCheckFailed")
  );
}

/**
 * Folds one legacy item into its organization's operator grant, then deletes it with its locators in
 * one transaction. Every write to the item is conditional on the version it was read at, so an
 * override changed mid-sweep is left, locator and all, for the next deploy.
 */
function makeFolder(
  client: DynamoDBDocumentClient,
  table: string,
  standing: OrganizationStandingRepository,
) {
  const conditionally = async (write: () => Promise<unknown>) => {
    try {
      await write();
      return true;
    } catch (cause) {
      if (conditionFailed(cause)) return false;
      throw cause;
    }
  };

  /** Whether `claim.grant` became the operator grant after `claim.standingVersion`. */
  const landed = async (organizationId: Ulid, claim: FoldClaim, currentVersion: number) => {
    if (currentVersion <= claim.standingVersion) return false;
    let before: number | undefined;
    do {
      const page = await standing.listHistory({
        organizationId,
        limit: HISTORY_PAGE_SIZE,
        ...(before === undefined ? {} : { before }),
      });
      for (const change of page.items) {
        if (change.standingVersion <= claim.standingVersion) return false;
        if (
          change.actor.kind === "operator" &&
          change.change.kind === "grant-set" &&
          isDeepStrictEqual(change.change.entitlements, claim.grant)
        ) {
          return true;
        }
      }
      before = page.before;
    } while (before !== undefined);
    return false;
  };

  return async ({ item, legacy }: LegacyItem): Promise<Fold> => {
    const organizationId = legacy.data.organizationId;
    const unchangedSinceRead = {
      ConditionExpression: "#data.#version = :version",
      ExpressionAttributeNames: { "#data": "data", "#version": "version" },
      ExpressionAttributeValues: { ":version": legacy.data.version },
      TableName: table,
    };
    const retire = async (outcome: Fold) =>
      (await conditionally(() =>
        client.send(
          new TransactWriteCommand({
            TransactItems: [
              { Delete: { Key: { pk: item.pk, sk: item.sk }, ...unchangedSinceRead } },
              ...locatorKeys(organizationId).map((locator) => ({
                Delete: { Key: locator, TableName: table },
              })),
            ],
          }),
        ),
      ))
        ? outcome
        : "remaining";

    const { grants, standing: effective } = await standing.readWithGrants(organizationId, {
      consistent: true,
    });
    if (legacy.migration && (await landed(organizationId, legacy.migration, effective.version))) {
      return retire("retired");
    }
    const current = grants.operator?.entitlements;
    const granted = current?.tenantLimits ?? {};
    const added = addedLimits(organizationId, granted, legacy.data.overrides);
    if (Object.keys(added).length === 0) return retire("retired");
    const grant: EntitlementGrant = { ...current, tenantLimits: { ...granted, ...added } };
    const migration: FoldClaim = { grant, standingVersion: effective.version };
    const claimed = await conditionally(() =>
      client.send(new PutCommand({ Item: { ...item, migration }, ...unchangedSinceRead })),
    );
    if (!claimed) return "remaining";
    await standing.setGrant({
      actor: decodeActor({ kind: "operator", principalId: legacy.data.updatedBy }),
      entitlements: grant,
      organizationId,
    });
    return retire("copied");
  };
}

/**
 * Folds each organization's legacy limit override into its operator grant and deletes the legacy
 * item, once. A field the operator grant already sets wins over the override's. After a sweep that
 * leaves no legacy item, an install-wide marker makes every later run a single read.
 */
export async function migrateOrganizationLimits(tables: {
  readonly client: DynamoDBDocumentClient;
  readonly tableNames: TableNames;
}): Promise<OrganizationLimitsMigration> {
  const { client, tableNames } = tables;
  const database = makeDynamoDatabase(client, tableNames);
  if (await database.getRecord("control", COMPLETION_MARKER, true)) {
    return { kind: "already-complete" };
  }

  const fold = makeFolder(
    client,
    tableNames.control,
    makeOrganizationStandingRepository({ database, installDefaults: UNREAD_INSTALL_DEFAULTS }),
  );
  const outcomes: Record<Fold, Ulid[]> = { copied: [], remaining: [], retired: [] };
  let orphansDeleted = 0;
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
    const organizationIds = page.items.flatMap((record) =>
      record.itemType === "organization" ? [record.data.id] : [],
    );
    const read = await legacyLimits(client, tableNames.control, organizationIds);
    for (const found of read.found) {
      outcomes[await fold(found)].push(found.legacy.data.organizationId);
    }
    for (const locator of read.orphanLocators) {
      await client.send(new DeleteCommand({ Key: locator, TableName: tableNames.control }));
    }
    orphansDeleted += read.orphanLocators.length;
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey);

  if (outcomes.remaining.length === 0) {
    await database.putRecord(
      decodeMarker(
        withCanonicalRecordKeys({
          data: { completedAt: new Date().toISOString(), id: "organization-limits" },
          itemType: "deploy-migration" as const,
        }),
      ),
    );
  }
  log(
    `organization limits migration copied ${outcomes.copied.length} overrides into operator grants, retired ${outcomes.retired.length} more, left ${outcomes.remaining.length} that changed during the sweep, and deleted ${orphansDeleted} orphaned inventory locators`,
  );
  return { kind: "swept", ...outcomes };
}
