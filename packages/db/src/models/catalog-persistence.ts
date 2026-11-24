import { Effect, Schema } from "effect";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import { fromDatabase } from "../database-effect.ts";
import { key } from "../keys.ts";
import { PersistenceError } from "../persistence-types.ts";
import { ModelCatalogEntryRecord } from "../records/models.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";

export type ModelCatalogEntryRecordValue = typeof ModelCatalogEntryRecord.Type;
export type ModelCatalogEntryData = ModelCatalogEntryRecordValue["data"];
export type ModelCatalogEntryProvider = ModelCatalogEntryData["provider"];

/** Provider metadata for one model; the facade owns status, version, and timestamps. */
export type ModelCatalogEntryInput = Omit<
  ModelCatalogEntryData,
  "createdAt" | "status" | "updatedAt" | "version"
>;

export interface ModelCatalogSynchronizationResult {
  readonly created: number;
  readonly provider: ModelCatalogEntryProvider;
  readonly reactivated: number;
  readonly retired: number;
  readonly unchanged: number;
  readonly updated: number;
}

export interface ModelCatalogPersistence {
  /** Every catalog entry, including retired ones, ordered by model id. */
  readonly listEntries: () => Promise<readonly ModelCatalogEntryData[]>;
  /** Strongly consistent reads of specific entries; absent ids are omitted. */
  readonly getEntries: (
    modelIds: readonly string[],
  ) => Promise<ReadonlyMap<string, ModelCatalogEntryData>>;
  /**
   * Reconciles one provider's catalog with a complete provider snapshot: new models are created,
   * changed metadata is replaced at version+1, and models missing from the snapshot are retired.
   */
  readonly synchronizeProvider: (
    provider: ModelCatalogEntryProvider,
    entries: readonly ModelCatalogEntryInput[],
    options?: { readonly allowMassRetirement?: boolean },
  ) => Promise<ModelCatalogSynchronizationResult>;
}

export interface ModelCatalogPersistenceOptions {
  readonly now?: () => Date;
}

const PARTITION = key("GLOBAL", "model-catalog-entry");
const ITEM_PREFIX = `${key("MODEL-CATALOG-ENTRY")}#`;
/** A snapshot that would retire more than this share of active entries is treated as partial. */
const MAX_RETIRED_SHARE = 0.25;
const WRITE_BATCH_SIZE = 50;
/** Matches the bounded decode concurrency used by DynamoDB query reads. */
const GET_ENTRIES_CONCURRENCY = 8;

async function run<A>(promise: Promise<A>): Promise<A> {
  try {
    return await promise;
  } catch (cause) {
    if (cause instanceof PersistenceError) throw cause;
    throw new PersistenceError(
      "internal",
      "persistence_error",
      "Model catalog persistence failed.",
    );
  }
}

function entryRecord(data: ModelCatalogEntryData): ModelCatalogEntryRecordValue {
  return Schema.decodeUnknownSync(ModelCatalogEntryRecord, { onExcessProperty: "error" })(
    withCanonicalRecordKeys({ data, itemType: "model-catalog-entry" as const }),
  );
}

function metadata(data: ModelCatalogEntryInput | ModelCatalogEntryData) {
  return JSON.stringify({
    capabilities: data.capabilities,
    contextWindowTokens: data.contextWindowTokens,
    displayName: data.displayName,
    maximumOutputTokens: data.maximumOutputTokens ?? null,
    pricing: data.pricing,
    providerModelId: data.providerModelId,
  });
}

export function makeModelCatalogPersistence(
  database: DynamoDatabaseService,
  options: ModelCatalogPersistenceOptions = {},
): ModelCatalogPersistence {
  const now = options.now ?? (() => new Date());

  async function listRecords() {
    const records: ModelCatalogEntryRecordValue[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await run(
        database.queryRecords("control", {
          ConsistentRead: true,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          ExpressionAttributeValues: { ":pk": PARTITION, ":prefix": ITEM_PREFIX },
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        }),
      );
      for (const record of page.items) {
        if (record.itemType === "model-catalog-entry") records.push(record);
      }
      exclusiveStartKey = page.lastEvaluatedKey;
    } while (exclusiveStartKey);
    return records;
  }

  return {
    async listEntries() {
      return (await listRecords())
        .map((record) => record.data)
        .toSorted((left, right) => left.modelId.localeCompare(right.modelId));
    },
    async getEntries(modelIds) {
      const found = await run(
        Effect.runPromise(
          Effect.forEach(
            [...new Set(modelIds)],
            (modelId) =>
              fromDatabase(() =>
                database.getRecord(
                  "control",
                  { pk: PARTITION, sk: key("MODEL-CATALOG-ENTRY", modelId) },
                  true,
                ),
              ),
            { concurrency: GET_ENTRIES_CONCURRENCY },
          ),
        ),
      );
      return new Map(
        found.flatMap((record) =>
          record?.itemType === "model-catalog-entry" ? [[record.data.modelId, record.data]] : [],
        ),
      );
    },
    async synchronizeProvider(provider, entries, options) {
      if (entries.some((entry) => entry.provider !== provider)) {
        throw new PersistenceError(
          "invalid-input",
          "invalid_model_catalog_snapshot",
          `Every synchronized entry must belong to provider ${provider}.`,
        );
      }
      const timestamp = now().toISOString();
      const existing = new Map(
        (await listRecords())
          .filter((record) => record.data.provider === provider)
          .map((record) => [record.data.modelId, record]),
      );
      const incoming = new Map(entries.map((entry) => [entry.modelId, entry]));
      const activeCount = [...existing.values()].filter(
        (record) => record.data.status === "active",
      ).length;
      const retiring = [...existing.values()].filter(
        (record) => record.data.status === "active" && !incoming.has(record.data.modelId),
      );
      if (
        !options?.allowMassRetirement &&
        activeCount > 0 &&
        retiring.length > activeCount * MAX_RETIRED_SHARE
      ) {
        throw new PersistenceError(
          "unprocessable",
          "partial_model_catalog_snapshot",
          `The ${provider} snapshot would retire ${retiring.length} of ${activeCount} active models; refusing a likely partial provider response.`,
        );
      }
      const operations: TransactionOperation[] = [];
      const result = { created: 0, reactivated: 0, retired: 0, unchanged: 0, updated: 0 };
      for (const entry of incoming.values()) {
        const previous = existing.get(entry.modelId);
        if (!previous) {
          operations.push({
            kind: "put",
            record: entryRecord({
              ...entry,
              createdAt: timestamp,
              status: "active",
              updatedAt: timestamp,
              version: 1,
            }),
          });
          result.created += 1;
          continue;
        }
        const reactivating = previous.data.status !== "active";
        if (!reactivating && metadata(previous.data) === metadata(entry)) {
          result.unchanged += 1;
          continue;
        }
        operations.push({
          kind: "put",
          previousRecord: previous,
          record: entryRecord({
            ...entry,
            createdAt: previous.data.createdAt,
            status: "active",
            updatedAt: timestamp,
            version: previous.data.version + 1,
          }),
        });
        if (reactivating) result.reactivated += 1;
        else result.updated += 1;
      }
      for (const previous of retiring) {
        operations.push({
          kind: "put",
          previousRecord: previous,
          record: entryRecord({
            ...previous.data,
            status: "retired",
            updatedAt: timestamp,
            version: previous.data.version + 1,
          }),
        });
        result.retired += 1;
      }
      for (let index = 0; index < operations.length; index += WRITE_BATCH_SIZE) {
        await run(database.transactWrite(operations.slice(index, index + WRITE_BATCH_SIZE)));
      }
      return { ...result, provider };
    },
  };
}
