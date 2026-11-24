import { describe, expect, test } from "bun:test";
import {
  MeterEventRecord,
  tableForItemType,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TableName,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { materializeMeterEvent, usageHourBucket } from "./index.ts";

const ids = Array.from(
  { length: 8 },
  (_, index) => `01ARZ3NDEKTSV4RRFFQ69G5F${String(index).padStart(2, "0")}`,
) as Ulid[];

function event(
  overrides: {
    readonly dimensions?: Readonly<Record<string, unknown>>;
    readonly id?: Ulid;
    readonly metric?: string;
    readonly quantity?: number;
    readonly unit?: string;
    readonly workspaceId?: Ulid;
  } = {},
) {
  return Schema.decodeUnknownSync(MeterEventRecord)(
    withCanonicalRecordKeys({
      data: {
        dimensions: overrides.dimensions ?? {
          costUsdNanoDollars: 1_234_000,
          costUsdMicros: 1234,
          modelId: "openai/gpt-5.2",
        },
        environmentId: ids[0]!,
        id: overrides.id ?? ids[1]!,
        idempotencyKey: `usage-${overrides.id ?? ids[1]!}`,
        metric: overrides.metric ?? "model_tokens",
        occurredAt: "2026-07-23T12:34:56.000Z",
        organizationId: ids[2]!,
        projectId: ids[3]!,
        quantity: overrides.quantity ?? 42,
        runId: ids[4]!,
        source: "model-gateway",
        unit: overrides.unit ?? "tokens",
        ...(overrides.workspaceId ? { workspaceId: overrides.workspaceId } : {}),
      },
      itemType: "meter-event" as const,
    }),
  );
}

function memoryDatabase() {
  const records = new Map<string, PlatformRecord>();
  const key = (table: TableName, pk: string, sk: string) => `${table}\u0000${pk}\u0000${sk}`;
  const database = {
    deleteRecord: async () => {},
    getRecord: async (table: TableName, input: { readonly pk: string; readonly sk: string }) =>
      records.get(key(table, input.pk, input.sk)),
    putRecord: async () => {},
    queryRecords: async () => ({ items: [] }),
    transactWrite: async (operations: readonly TransactionOperation[]) => {
      for (const operation of operations) {
        if (operation.kind !== "put") continue;
        records.set(
          key(
            tableForItemType(operation.record.itemType),
            operation.record.pk,
            operation.record.sk,
          ),
          operation.record,
        );
      }
    },
  } as unknown as DynamoDatabaseService;
  return { database, records };
}

describe("usage materialization", () => {
  test("folds quantity and cost into hourly shards exactly once", async () => {
    const memory = memoryDatabase();
    const first = await materializeMeterEvent(memory.database, event(), {
      now: () => new Date("2026-07-23T12:35:00.000Z"),
    });
    const replay = await materializeMeterEvent(memory.database, event());

    expect(usageHourBucket(event().data.occurredAt)).toBe("2026-07-23T12:00:00.000Z");
    expect(first.duplicate).toBe(false);
    expect(first.shards.map((record) => [record.data.metric, record.data.quantity])).toEqual([
      ["model_tokens", 42],
      ["model_tokens.cost_usd_micros", 1234],
      ["model_tokens.cost_usd_nanodollars", 1_234_000],
    ]);
    const dedup = [...memory.records.values()].find(
      (record) => record.itemType === "delivery-deduplication",
    );
    expect(dedup?.data.expiresAt).toBe("9999-12-31T23:59:59.999Z");
    expect(dedup?.ttl).toBeGreaterThan(250_000_000_000);
    expect(replay.duplicate).toBe(true);
  });

  test("keeps the run's agent counters, with token splits, beside the environment's", async () => {
    const memory = memoryDatabase();
    const agent = ids[5]!;
    const tokens = (id: Ulid, inputTokens: number, outputTokens: number) =>
      event({
        dimensions: { costUsdMicros: 10, inputTokens, modelId: "openai/gpt-5.2", outputTokens },
        id,
        quantity: inputTokens + outputTokens,
      });
    await materializeMeterEvent(memory.database, tokens(ids[1]!, 30, 12), {
      agentDefinitionId: agent,
    });
    // Same hour and (by id hash) possibly the same shard; a replay changes nothing.
    await materializeMeterEvent(memory.database, tokens(ids[6]!, 8, 2), {
      agentDefinitionId: agent,
    });
    await materializeMeterEvent(memory.database, tokens(ids[6]!, 8, 2), {
      agentDefinitionId: agent,
    });
    // An event of no agent's run advances only the environment counters.
    await materializeMeterEvent(memory.database, tokens(ids[7]!, 100, 0));

    const counters = [...memory.records.values()];
    const total = (
      itemType: "attributed-usage-counter-shard" | "usage-counter-shard",
      metric: string,
    ) =>
      counters.reduce(
        (sum, record) =>
          (record.itemType === "attributed-usage-counter-shard" ||
            record.itemType === "usage-counter-shard") &&
          record.itemType === itemType &&
          record.data.metric === metric
            ? sum + record.data.quantity
            : sum,
        0,
      );
    expect(total("usage-counter-shard", "model_tokens")).toBe(152);
    expect(total("attributed-usage-counter-shard", "model_tokens")).toBe(52);
    expect(total("attributed-usage-counter-shard", "model_tokens.cost_usd_micros")).toBe(20);
    const agentCounters = counters.filter(
      (record): record is Extract<PlatformRecord, { itemType: "attributed-usage-counter-shard" }> =>
        record.itemType === "attributed-usage-counter-shard",
    );
    const parts = agentCounters.reduce(
      (sum, record) => ({
        input: sum.input + (record.data.parts?.input ?? 0),
        output: sum.output + (record.data.parts?.output ?? 0),
      }),
      { input: 0, output: 0 },
    );
    expect(parts).toEqual({ input: 38, output: 14 });
    expect(
      agentCounters.every(
        (record) =>
          record.data.attribution === "agent" &&
          record.data.attributionId === agent &&
          record.sk.startsWith(`ATTRIBUTED-USAGE-COUNTER-SHARD#AGENT#${agent}#`) &&
          record.gsi2pk === undefined,
      ),
    ).toBe(true);
  });

  test("keeps a workspace's counters for every event that names it, beside its agent's", async () => {
    const memory = memoryDatabase();
    const agent = ids[5]!;
    const workspace = ids[0]!;
    const tokens = (
      id: Ulid,
      inputTokens: number,
      outputTokens: number,
      costUsdMicros: number,
      workspaceId?: Ulid,
    ) =>
      event({
        dimensions: { costUsdMicros, inputTokens, modelId: "openai/gpt-5.2", outputTokens },
        id,
        quantity: inputTokens + outputTokens,
        ...(workspaceId ? { workspaceId } : {}),
      });
    const both = await materializeMeterEvent(
      memory.database,
      tokens(ids[1]!, 20, 10, 7, workspace),
      {
        agentDefinitionId: agent,
      },
    );
    const replay = await materializeMeterEvent(
      memory.database,
      tokens(ids[1]!, 20, 10, 7, workspace),
      {
        agentDefinitionId: agent,
      },
    );
    await materializeMeterEvent(memory.database, tokens(ids[6]!, 4, 1, 11, workspace));
    const outside = await materializeMeterEvent(memory.database, tokens(ids[7]!, 100, 0, 3));

    const shareOf = (attribution: string) =>
      Object.fromEntries(
        both.attributedShards
          .filter((record) => record.data.attribution === attribution)
          .map((record) => [record.data.metric, [record.data.quantity, record.data.parts]]),
      );
    expect(shareOf("workspace")).toEqual({
      model_tokens: [30, { input: 20, output: 10 }],
      "model_tokens.cost_usd_micros": [7, undefined],
    });
    expect(shareOf("agent")).toEqual(shareOf("workspace"));
    expect(replay.duplicate).toBe(true);
    expect(outside.attributedShards).toEqual([]);

    const counters = [...memory.records.values()].filter(
      (record): record is Extract<PlatformRecord, { itemType: "attributed-usage-counter-shard" }> =>
        record.itemType === "attributed-usage-counter-shard",
    );
    const total = (attribution: string, attributionId: string, metric: string) =>
      counters.reduce(
        (sum, record) =>
          record.data.attribution === attribution &&
          record.data.attributionId === attributionId &&
          record.data.metric === metric
            ? sum + record.data.quantity
            : sum,
        0,
      );
    expect(total("workspace", workspace, "model_tokens")).toBe(35);
    expect(total("workspace", workspace, "model_tokens.cost_usd_micros")).toBe(18);
    expect(total("agent", agent, "model_tokens")).toBe(30);
    expect(total("agent", agent, "model_tokens.cost_usd_micros")).toBe(7);
    expect(
      counters.every(
        (record) =>
          record.data.attribution !== "workspace" ||
          record.sk.startsWith(`ATTRIBUTED-USAGE-COUNTER-SHARD#WORKSPACE#${workspace}#`),
      ),
    ).toBe(true);
  });

  test("rejects a unit change for an existing metric shard", async () => {
    const memory = memoryDatabase();
    await materializeMeterEvent(memory.database, event());
    for (const [key, record] of memory.records) {
      if (record.itemType === "delivery-deduplication") memory.records.delete(key);
    }

    expect(materializeMeterEvent(memory.database, event({ unit: "requests" }))).rejects.toThrow(
      "cannot aggregate requests into existing tokens",
    );
  });

  test("deduplicates equivalent meter-event maps regardless of property order", async () => {
    const memory = memoryDatabase();
    await materializeMeterEvent(
      memory.database,
      event({
        dimensions: {
          costUsdMicros: 1234,
          costUsdNanoDollars: 1_234_000,
          modelId: "openai/gpt-5.2",
        },
      }),
    );

    const replay = await materializeMeterEvent(
      memory.database,
      event({
        dimensions: {
          modelId: "openai/gpt-5.2",
          costUsdNanoDollars: 1_234_000,
          costUsdMicros: 1234,
        },
      }),
    );

    expect(replay.duplicate).toBe(true);
  });

  test("rejects a unit change when events select different counter shards", async () => {
    const memory = memoryDatabase();
    await materializeMeterEvent(memory.database, event({ id: ids[1]!, unit: "tokens" }));

    expect(
      materializeMeterEvent(memory.database, event({ id: ids[5]!, unit: "requests" })),
    ).rejects.toThrow("cannot aggregate requests into existing tokens");
  });

  test("rejects metrics in the derived cost namespace", async () => {
    expect(
      materializeMeterEvent(
        memoryDatabase().database,
        event({ metric: "requests.cost_usd_micros" }),
      ),
    ).rejects.toThrow("reserved .cost_usd_micros suffix");
  });

  test("rejects counter accumulation beyond the safe integer range", async () => {
    const memory = memoryDatabase();
    await materializeMeterEvent(
      memory.database,
      event({ id: ids[0]!, quantity: Number.MAX_SAFE_INTEGER - 10 }),
    );

    expect(
      materializeMeterEvent(memory.database, event({ id: ids[2]!, quantity: 20 })),
    ).rejects.toThrow("exceeds the safe numeric range");
  });
});
