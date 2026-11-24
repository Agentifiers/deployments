import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  DatabaseError,
  type DynamoDatabaseService,
  type TransactionOperation,
} from "../client-types.ts";
import { PersistenceError } from "../persistence-types.ts";
import { tableForItemType, type PlatformRecord } from "../records/index.ts";
import { validateTransactionInvariants } from "../transaction-invariants.ts";
import { makeModelCatalogPersistence, type ModelCatalogEntryInput } from "./catalog-persistence.ts";
import { makeModelPolicyPersistence } from "./policy-persistence.ts";

const scope = {
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
};
const context = { principalId: "01ARZ3NDEKTSV4RRFFQ69G5FA4" };

function conflict() {
  return new DatabaseError({
    cause: new Error("ConditionalCheckFailed"),
    message: "Conditional write failed.",
    operation: "transact-write",
    reason: "conflict",
    table: "control",
  });
}

function versionOf(record: PlatformRecord | undefined) {
  return record && "version" in record.data ? record.data.version : undefined;
}

/** Applies transactions atomically with DynamoDB's create-only and optimistic-version semantics. */
function memoryDatabase() {
  const records = new Map<string, PlatformRecord>();
  const transactions: (readonly TransactionOperation[])[] = [];
  const storageKey = (table: string, pk: string, sk: string) => `${table}\u0000${pk}\u0000${sk}`;
  const keyOf = (record: PlatformRecord) =>
    storageKey(tableForItemType(record.itemType), record.pk, record.sk);
  const database: DynamoDatabaseService = {
    deleteRecord: () => Promise.reject(new Error("unused")),
    getRecord: async (table, key) =>
      structuredClone(records.get(storageKey(table, key.pk, key.sk))),
    putRecord: () => Promise.reject(new Error("unused")),
    queryRecords: async (table, input) => {
      const values = input.ExpressionAttributeValues ?? {};
      const start = input.ExclusiveStartKey;
      const startSk = typeof start?.sk === "string" ? start.sk : undefined;
      const matching = [...records.values()]
        .filter(
          (record) =>
            tableForItemType(record.itemType) === table &&
            record.pk === values[":pk"] &&
            record.sk.startsWith(String(values[":prefix"])) &&
            (!startSk || record.sk > startSk),
        )
        .toSorted((left, right) => left.sk.localeCompare(right.sk));
      const limit = input.Limit ?? matching.length;
      const items = matching.slice(0, limit);
      return {
        items: structuredClone(items),
        ...(matching.length > limit
          ? { lastEvaluatedKey: { pk: items.at(-1)!.pk, sk: items.at(-1)!.sk } }
          : {}),
      };
    },
    transactWrite: async (operations) => {
      await Effect.runPromise(validateTransactionInvariants(operations));
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        const existing = records.get(keyOf(operation.record));
        if (operation.kind === "delete") {
          if (!existing) throw conflict();
          continue;
        }
        if (!operation.previousRecord && existing) throw conflict();
        if (
          operation.previousRecord &&
          versionOf(existing) !== versionOf(operation.previousRecord)
        ) {
          throw conflict();
        }
      }
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        if (operation.kind === "delete") records.delete(keyOf(operation.record));
        else records.set(keyOf(operation.record), structuredClone(operation.record));
      }
      transactions.push(operations);
    },
  };
  return { database, records, transactions };
}

let sequence = 0;
const generateId = async () => `01ARZ3NDEKTSV4RRFFQ69G6${String(sequence++).padStart(3, "0")}`;

describe("model policy persistence", () => {
  test("holds one active policy per environment and releases it on archive", async () => {
    const { database, records, transactions } = memoryDatabase();
    const policies = makeModelPolicyPersistence(database, {
      generateId,
      now: () => new Date("2026-09-29T12:00:00.000Z"),
    });
    expect(await policies.getActive(scope)).toBeUndefined();

    const created = await policies.create(
      scope,
      { includeCuratedModels: true, models: ["openrouter/*"], name: "Broad models" },
      context,
    );
    expect(created).toMatchObject({ status: "active", version: 1 });
    expect(
      transactions[0]!.map((operation) =>
        operation.kind === "condition-check" ? "check" : operation.record.itemType,
      ),
    ).toEqual(["model-policy", "unique-claim", "semantic-event"]);
    expect(await policies.getActive(scope)).toEqual(created);

    const duplicate = policies.create(
      scope,
      { includeCuratedModels: false, models: ["openai/o3"], name: "Second" },
      context,
    );
    expect(duplicate).rejects.toMatchObject({
      code: "model_policy_exists",
      kind: "conflict",
    });

    const updated = await policies.update(
      scope,
      created.id,
      { expectedVersion: 1, models: ["openrouter/*", "openai/o3"] },
      context,
    );
    expect(updated).toMatchObject({ models: ["openrouter/*", "openai/o3"], version: 2 });
    expect(
      policies.update(scope, created.id, { expectedVersion: 1, name: "stale" }, context),
    ).rejects.toMatchObject({ code: "version_conflict" });

    const archived = await policies.archive(scope, created.id, 2, context);
    expect(archived).toMatchObject({ status: "archived", version: 3 });
    expect(await policies.getActive(scope)).toBeUndefined();
    expect(
      [...records.values()].filter((record) => record.itemType === "unique-claim"),
    ).toHaveLength(0);
    expect(policies.archive(scope, created.id, 3, context)).rejects.toMatchObject({
      code: "resource_inactive",
    });

    const replacement = await policies.create(
      scope,
      { includeCuratedModels: false, models: ["openai/o3"], name: "Replacement" },
      context,
    );
    expect(await policies.getActive(scope)).toEqual(replacement);
    const events = [...records.values()].flatMap((record) =>
      record.itemType === "semantic-event" ? [record.data.eventType] : [],
    );
    expect(events.toSorted()).toEqual([
      "model-policy.archived",
      "model-policy.created",
      "model-policy.created",
      "model-policy.updated",
    ]);
  });

  test("pages policies with scope-bound cursors", async () => {
    const { database } = memoryDatabase();
    const policies = makeModelPolicyPersistence(database, { generateId });
    const first = await policies.create(
      scope,
      { includeCuratedModels: true, models: [], name: "One" },
      context,
    );
    await policies.archive(scope, first.id, 1, context);
    await policies.create(scope, { includeCuratedModels: true, models: [], name: "Two" }, context);
    const page = await policies.list(scope, { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toEqual(expect.any(String));
    const next = await policies.list(scope, { cursor: page.nextCursor!, limit: 1 });
    expect(next.items.map((item) => item.name)).toEqual(["Two"]);
    expect(
      policies.list(
        { ...scope, environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FA9" },
        {
          cursor: page.nextCursor!,
        },
      ),
    ).rejects.toBeInstanceOf(PersistenceError);
    expect(policies.get(scope, "01ARZ3NDEKTSV4RRFFQ69G5FA8")).rejects.toMatchObject({
      kind: "not-found",
    });
  });
});

function entry(modelId: string, input = 1): ModelCatalogEntryInput {
  return {
    capabilities: {
      imageInput: false,
      reasoning: false,
      structuredOutputs: true,
      toolCalling: true,
    },
    contextWindowTokens: 128_000,
    displayName: modelId,
    modelId: `openrouter/${modelId}`,
    pricing: { inputUsdPerMillionTokens: input, outputUsdPerMillionTokens: 2 },
    provider: "openrouter",
    providerModelId: modelId,
  };
}

describe("model catalog persistence", () => {
  test("creates, updates, retires, and reactivates entries from provider snapshots", async () => {
    const { database } = memoryDatabase();
    const catalog = makeModelCatalogPersistence(database);
    const snapshot = ["a/one", "a/two", "a/three", "a/four", "a/five"].map((id) => entry(id));
    expect(await catalog.synchronizeProvider("openrouter", snapshot)).toMatchObject({
      created: 5,
      retired: 0,
    });
    expect(
      await catalog.synchronizeProvider("openrouter", [entry("a/one", 3), ...snapshot.slice(1, 4)]),
    ).toMatchObject({ created: 0, retired: 1, unchanged: 3, updated: 1 });
    const retired = await catalog.getEntries(["openrouter/a/five", "openrouter/a/one"]);
    expect(retired.get("openrouter/a/five")).toMatchObject({ status: "retired", version: 2 });
    expect(retired.get("openrouter/a/one")?.pricing.inputUsdPerMillionTokens).toBe(3);
    expect(
      await catalog.synchronizeProvider("openrouter", [entry("a/one", 3), ...snapshot.slice(1)]),
    ).toMatchObject({ reactivated: 1, unchanged: 4 });
    expect((await catalog.listEntries()).map((item) => item.modelId)).toEqual([
      "openrouter/a/five",
      "openrouter/a/four",
      "openrouter/a/one",
      "openrouter/a/three",
      "openrouter/a/two",
    ]);
  });

  test("refuses snapshots that would retire most of a provider catalog", async () => {
    const { database } = memoryDatabase();
    const catalog = makeModelCatalogPersistence(database);
    await catalog.synchronizeProvider(
      "openrouter",
      ["a/1", "a/2", "a/3", "a/4"].map((id) => entry(id)),
    );
    expect(catalog.synchronizeProvider("openrouter", [entry("a/1")])).rejects.toMatchObject({
      code: "partial_model_catalog_snapshot",
    });
    expect(
      await catalog.synchronizeProvider("openrouter", [entry("a/1")], {
        allowMassRetirement: true,
      }),
    ).toMatchObject({ retired: 3 });
    expect(catalog.synchronizeProvider("openai", [entry("a/1")])).rejects.toMatchObject({
      code: "invalid_model_catalog_snapshot",
    });
  });
});
