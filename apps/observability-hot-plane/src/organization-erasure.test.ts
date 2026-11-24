import { describe, expect, test } from "bun:test";
import { createHotPlaneApi } from "./api.ts";
import { ClickHouseTimeoutError, type ClickHouseExecutor } from "./clickhouse.ts";
import { createOrganizationErasure, ERASURE_DRAIN_MARGIN_MS } from "./organization-erasure.ts";
import { createWriterCatchUp, type WriterCatchUp } from "./writer-catch-up.ts";

const ORGANIZATION = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_ORGANIZATION = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
const OPERATION = "01HZY0Q2V3J4K5M6N7P8Q9R0ST";
const VERIFIED_AT = "2026-10-01T12:00:00.000Z";
const NOW = Date.parse(VERIFIED_AT);
const DRAIN_ANCHOR_AT = "2026-10-01T11:45:00.000Z";
const REQUEST = {
  drainAnchorAt: DRAIN_ANCHOR_AT,
  operationId: OPERATION,
  organizationId: ORGANIZATION,
};

/** Writer progress for one shard read `ageMs` before NOW, `behindMs` behind its tip. */
function writerAt(read?: { readonly ageMs: number; readonly behindMs: number }) {
  const catchUp = createWriterCatchUp();
  catchUp.shardsListed(["shardId-000000000000"]);
  if (read) {
    catchUp.shardRead("shardId-000000000000", {
      millisBehindLatest: read.behindMs,
      readStartedAt: NOW - read.ageMs,
    });
  }
  return catchUp;
}

interface Mutation {
  done: boolean;
  readonly organizationId: string;
  readonly table: string;
}

/** In-memory ClickHouse holding per-table, per-organization row counts. */
function fakeClickHouse(
  rows: Record<string, Record<string, number>>,
  options: { readonly alter?: "complete" | "time-out" } = {},
) {
  const mutations: Mutation[] = [];
  const statements: { sql: string; parameters?: Readonly<Record<string, string>> }[] = [];
  const alterTimeouts: (number | undefined)[] = [];
  const clickhouse: ClickHouseExecutor = {
    execute: async (sql, parameters = {}, requestOptions) => {
      statements.push({ parameters, sql });
      alterTimeouts.push(requestOptions?.timeoutMs);
      const table = parameters.table!;
      const organizationId = parameters.organization!;
      if (options.alter === "time-out") {
        mutations.push({ done: false, organizationId, table });
        throw new ClickHouseTimeoutError();
      }
      delete rows[table]![organizationId];
      mutations.push({ done: true, organizationId, table });
    },
    insert: async () => undefined,
    query: async <T extends Readonly<Record<string, unknown>>>(
      sql: string,
      parameters: Readonly<Record<string, string>> = {},
    ) => {
      statements.push({ parameters, sql });
      if (sql.includes("FROM system.columns")) {
        return Object.keys(rows).map((table) => ({ table })) as unknown as readonly T[];
      }
      if (sql.includes("FROM system.mutations")) {
        return mutations
          .filter(
            (mutation) => !mutation.done && mutation.organizationId === parameters.organization,
          )
          .map((mutation) => ({
            latest_fail_reason: "",
            mutation_id: "mutation_1.txt",
            table: mutation.table,
          })) as unknown as readonly T[];
      }
      if (sql.includes("count() AS rows")) {
        const count = rows[parameters.table!]?.[parameters.organization!] ?? 0;
        return [{ rows: String(count) }] as unknown as readonly T[];
      }
      throw new Error(`Unexpected ClickHouse query: ${sql}`);
    },
  };
  /** Lets every pending mutation finish server-side. */
  const finishMutations = () => {
    for (const mutation of mutations.filter((candidate) => !candidate.done)) {
      delete rows[mutation.table]![mutation.organizationId];
      mutation.done = true;
    }
  };
  return { alterTimeouts, clickhouse, finishMutations, mutations, rows, statements };
}

function erasureApi(
  clickhouse: ClickHouseExecutor,
  fenceOperationId: string | null = OPERATION,
  writerCatchUp: WriterCatchUp = writerAt({ ageMs: 2_000, behindMs: 0 }),
) {
  const fenceReads: string[] = [];
  const app = createHotPlaneApi({
    clickhouse: {
      execute: async () => undefined,
      insert: async () => undefined,
      query: async () => {
        throw new Error("Erasure must not use the read-only query executor.");
      },
    },
    organizationErasure: createOrganizationErasure({
      clickhouse,
      conversationErasureRunning: async () => {
        throw new Error("An organization purge must not read conversation erasures.");
      },
      mutationTimeoutMs: 1_500,
      now: () => new Date(VERIFIED_AT),
      readErasureFence: async (organizationId) => {
        fenceReads.push(organizationId);
        return fenceOperationId ? { operationId: fenceOperationId } : undefined;
      },
      writerCatchUp,
    }),
    serviceToken: "internal-secret",
  });
  const erase = (body: unknown = REQUEST, authorization = "Bearer internal-secret") =>
    app.request("/internal/organization-erasures", {
      body: JSON.stringify(body),
      headers: { authorization, "content-type": "application/json" },
      method: "POST",
    });
  return { erase, fenceReads };
}

describe("POST /internal/organization-erasures", () => {
  test("requires the internal service credential", async () => {
    const clickhouse = fakeClickHouse({ facts: { [ORGANIZATION]: 3 } });
    const api = erasureApi(clickhouse.clickhouse);

    const response = await api.erase(undefined, "Bearer wrong-secret");

    expect(response.status).toBe(401);
    expect(api.fenceReads).toEqual([]);
    expect(clickhouse.statements).toEqual([]);
  });

  test("rejects identifiers that are not canonical ULIDs before touching storage", async () => {
    const clickhouse = fakeClickHouse({ facts: { [ORGANIZATION]: 3 } });
    const api = erasureApi(clickhouse.clickhouse);

    for (const body of [
      { ...REQUEST, organizationId: "org' OR 1=1" },
      { operationId: OPERATION, organizationId: ORGANIZATION },
      { ...REQUEST, drainAnchorAt: "2026-10-01T11:45:00Z" },
      { ...REQUEST, drainAnchorAt: "yesterday" },
    ]) {
      const response = await api.erase(body);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_erasure_request" });
    }
    expect(api.fenceReads).toEqual([]);
    expect(clickhouse.statements).toEqual([]);
  });

  test("stays pending without purging until the writer has caught up past the drain anchor", async () => {
    // Caught up through exactly the anchor plus margin, read 1 s ago.
    const recentAnchor = new Date(NOW - 1_000 - ERASURE_DRAIN_MARGIN_MS).toISOString();
    for (const [label, writer, drainAnchorAt] of [
      ["never read a shard", writerAt(), DRAIN_ANCHOR_AT],
      ["behind the shard tip", writerAt({ ageMs: 2_000, behindMs: 5_001 }), DRAIN_ANCHOR_AT],
      ["stale", writerAt({ ageMs: 30_001, behindMs: 0 }), DRAIN_ANCHOR_AT],
      ["not past the anchor margin", writerAt({ ageMs: 1_000, behindMs: 0 }), recentAnchor],
    ] as const) {
      const clickhouse = fakeClickHouse({ facts: { [ORGANIZATION]: 3 } });
      const api = erasureApi(clickhouse.clickhouse, OPERATION, writer);

      const response = await api.erase({ ...REQUEST, drainAnchorAt });

      expect({ label, status: response.status }).toEqual({ label, status: 202 });
      expect(await response.json()).toEqual({ reason: "writer_catching_up", status: "pending" });
      expect(clickhouse.statements).toEqual([]);
      expect(clickhouse.rows.facts?.[ORGANIZATION]).toBe(3);
    }
  });

  test("purges once every open shard is read recently and close to its tip", async () => {
    const writer = createWriterCatchUp();
    writer.shardsListed(["shardId-000000000000", "shardId-000000000001", "shardId-000000000002"]);
    writer.shardRead("shardId-000000000000", { millisBehindLatest: 0, readStartedAt: NOW - 1_000 });
    // A closed parent is fully consumed and no longer read.
    writer.shardRead("shardId-000000000001", {
      millisBehindLatest: 0,
      readStartedAt: NOW - 600_000,
    });
    writer.shardClosed("shardId-000000000001");
    const clickhouse = fakeClickHouse({ facts: { [ORGANIZATION]: 3 } });
    const api = erasureApi(clickhouse.clickhouse, OPERATION, writer);

    const behind = await api.erase();
    expect(await behind.json()).toEqual({ reason: "writer_catching_up", status: "pending" });
    expect(clickhouse.statements).toEqual([]);

    writer.shardRead("shardId-000000000002", {
      millisBehindLatest: 5_000,
      readStartedAt: NOW - 29_000,
    });
    const caughtUp = await api.erase();

    expect(caughtUp.status).toBe(200);
    expect(await caughtUp.json()).toMatchObject({ rowsDeleted: 3, status: "complete" });
    expect(clickhouse.rows.facts?.[ORGANIZATION]).toBeUndefined();
  });

  test("refuses to purge without an erasure fence for the same operation", async () => {
    for (const fenceOperationId of [null, "01HZY0Q2V3J4K5M6N7P8Q9R0SV"]) {
      const clickhouse = fakeClickHouse({ facts: { [ORGANIZATION]: 3 } });
      const api = erasureApi(clickhouse.clickhouse, fenceOperationId);

      const response = await api.erase();

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "erasure_fence_missing", status: 409 });
      expect(api.fenceReads).toEqual([ORGANIZATION]);
      expect(clickhouse.statements).toEqual([]);
      expect(clickhouse.rows.facts?.[ORGANIZATION]).toBe(3);
    }
  });

  test("deletes only the target organization and reports per-table counts", async () => {
    const clickhouse = fakeClickHouse({
      facts: { [ORGANIZATION]: 3, [OTHER_ORGANIZATION]: 2 },
      rollups: { [OTHER_ORGANIZATION]: 4 },
    });
    const api = erasureApi(clickhouse.clickhouse);

    const response = await api.erase();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      rowsDeleted: 3,
      status: "complete",
      tables: [
        { rowsDeleted: 3, table: "facts" },
        { rowsDeleted: 0, table: "rollups" },
      ],
      verifiedAt: VERIFIED_AT,
    });
    expect(clickhouse.rows).toEqual({
      facts: { [OTHER_ORGANIZATION]: 2 },
      rollups: { [OTHER_ORGANIZATION]: 4 },
    });
    const alters = clickhouse.statements.filter((statement) => statement.sql.startsWith("ALTER"));
    expect(alters).toHaveLength(1);
    expect(alters[0]!.parameters).toEqual({ organization: ORGANIZATION, table: "facts" });
    expect(alters[0]!.sql).toContain("mutations_sync = 2");
    expect(clickhouse.statements.some((statement) => statement.sql.includes(ORGANIZATION))).toBe(
      false,
    );
    expect(clickhouse.alterTimeouts).toEqual([1_500]);
  });

  test("reports pending without resubmitting while the organization's mutation is unfinished", async () => {
    const clickhouse = fakeClickHouse({ facts: { [ORGANIZATION]: 3 } }, { alter: "time-out" });
    const api = erasureApi(clickhouse.clickhouse);

    const first = await api.erase();
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({
      reason: "mutation_running",
      remainingRows: 3,
      status: "pending",
    });

    const retry = await api.erase();
    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual({
      reason: "mutation_running",
      remainingRows: 3,
      status: "pending",
    });
    expect(clickhouse.mutations).toHaveLength(1);

    clickhouse.finishMutations();
    const settled = await api.erase();
    expect(settled.status).toBe(200);
    expect(await settled.json()).toEqual({
      rowsDeleted: 0,
      status: "complete",
      tables: [{ rowsDeleted: 0, table: "facts" }],
      verifiedAt: VERIFIED_AT,
    });
    expect(clickhouse.mutations).toHaveLength(1);
  });

  test("stays pending when rows for the organization arrive after the delete", async () => {
    const clickhouse = fakeClickHouse({ facts: { [ORGANIZATION]: 3 } });
    const execute = clickhouse.clickhouse.execute;
    const api = erasureApi({
      ...clickhouse.clickhouse,
      execute: async (sql, parameters, options) => {
        await execute(sql, parameters, options);
        clickhouse.rows.facts![ORGANIZATION] = 1;
      },
    });

    const response = await api.erase();

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      reason: "mutation_running",
      remainingRows: 1,
      status: "pending",
    });
  });
});
