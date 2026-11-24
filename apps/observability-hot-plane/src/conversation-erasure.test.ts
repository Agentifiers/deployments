import { afterAll, describe, expect, test } from "bun:test";
import { createHotPlaneApi } from "./api.ts";
import { parseClickHouseJsonRows, type ClickHouseExecutor } from "./clickhouse.ts";
import { createOrganizationErasure } from "./organization-erasure.ts";
import { ensureObservabilitySchema } from "./schema.ts";
import { createWriterCatchUp } from "./writer-catch-up.ts";

const clickhouseUrl = process.env.OBSERVABILITY_HOT_PLANE_TEST_CLICKHOUSE_URL;

const ORGANIZATION = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_ORGANIZATION = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
const OPERATION = "01HZY0Q2V3J4K5M6N7P8Q9R0ST";
const THREAD = "01HZY0Q2V3J4K5M6N7P8Q9R0T0";
const SIBLING_THREAD = "01HZY0Q2V3J4K5M6N7P8Q9R0T1";
const RUN = "01HZY0Q2V3J4K5M6N7P8Q9R0V0";
const USAGE_ONLY_RUN = "01HZY0Q2V3J4K5M6N7P8Q9R0V1";
const SIBLING_RUN = "01HZY0Q2V3J4K5M6N7P8Q9R0V2";
const VERIFIED_AT = "2026-10-01T12:00:00.000Z";
const NOW = Date.parse(VERIFIED_AT);
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

interface Row {
  readonly organization_id: string;
  readonly run_id?: string;
  readonly session_id?: string;
}

function ulid(index: number) {
  let suffix = "";
  for (let value = index, position = 0; position < 4; position += 1, value >>= 5) {
    suffix = CROCKFORD[value & 31] + suffix;
  }
  return `01J0000000000000000000${suffix}`;
}

function arrayParameter(text: string | undefined) {
  return text === undefined ? undefined : text.slice(2, -2).split("','");
}

function rowClickHouse(
  rows: Record<string, Row[]>,
  columns: Readonly<Record<string, readonly string[]>>,
) {
  const alters: { readonly parameters: Readonly<Record<string, string>>; readonly sql: string }[] =
    [];
  const statements: string[] = [];
  const matches = (row: Row, sql: string, parameters: Readonly<Record<string, string>>) => {
    if (row.organization_id !== parameters.organization) return false;
    const ids = arrayParameter(parameters.ids);
    if (!ids) return true;
    return ids.includes((sql.includes("session_id IN") ? row.session_id : row.run_id) ?? "");
  };
  const clickhouse: ClickHouseExecutor = {
    execute: async (sql, parameters = {}) => {
      statements.push(sql);
      alters.push({ parameters, sql });
      const table = parameters.table!;
      rows[table] = rows[table]!.filter((row) => !matches(row, sql, parameters));
    },
    insert: async () => undefined,
    query: async <T extends Readonly<Record<string, unknown>>>(
      sql: string,
      parameters: Readonly<Record<string, string>> = {},
    ) => {
      statements.push(sql);
      if (sql.includes("FROM system.columns")) {
        const required = arrayParameter(parameters.columns)!;
        return Object.keys(rows)
          .filter((table) => required.every((column) => columns[table]!.includes(column)))
          .map((table) => ({ table })) as unknown as readonly T[];
      }
      if (sql.includes("FROM system.mutations")) return [] as readonly T[];
      if (sql.includes("count() AS rows")) {
        const count = rows[parameters.table!]!.filter((row) => matches(row, sql, parameters));
        return [{ rows: String(count.length) }] as unknown as readonly T[];
      }
      throw new Error(`Unexpected ClickHouse query: ${sql}`);
    },
  };
  return { alters, clickhouse, rows, statements };
}

function erasureApi(clickhouse: ClickHouseExecutor, running: boolean) {
  const operationReads: (readonly [string, string])[] = [];
  const writerCatchUp = createWriterCatchUp();
  writerCatchUp.shardsListed(["shardId-000000000000"]);
  writerCatchUp.shardRead("shardId-000000000000", {
    millisBehindLatest: 0,
    readStartedAt: NOW - 2_000,
  });
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
      conversationErasureRunning: async (organizationId, operationId) => {
        operationReads.push([organizationId, operationId]);
        return running;
      },
      now: () => new Date(VERIFIED_AT),
      readErasureFence: async () => {
        throw new Error("A conversation purge must not read the organization fence.");
      },
      writerCatchUp,
    }),
    serviceToken: "internal-secret",
  });
  const erase = (scope: unknown) =>
    app.request("/internal/organization-erasures", {
      body: JSON.stringify({
        drainAnchorAt: "2026-10-01T11:45:00.000Z",
        operationId: OPERATION,
        organizationId: ORGANIZATION,
        scope,
      }),
      headers: { authorization: "Bearer internal-secret", "content-type": "application/json" },
      method: "POST",
    });
  return { erase, operationReads };
}

function conversationRows() {
  return {
    facts: [
      { organization_id: ORGANIZATION, run_id: RUN, session_id: THREAD },
      { organization_id: ORGANIZATION, session_id: THREAD },
      { organization_id: ORGANIZATION, run_id: USAGE_ONLY_RUN },
      { organization_id: ORGANIZATION, run_id: SIBLING_RUN, session_id: SIBLING_THREAD },
      { organization_id: OTHER_ORGANIZATION, run_id: RUN, session_id: THREAD },
    ],
    rollups: [{ organization_id: ORGANIZATION }],
  };
}

const COLUMNS = {
  facts: ["organization_id", "run_id", "session_id"],
  rollups: ["organization_id"],
};

describe("conversation-scoped POST /internal/organization-erasures", () => {
  test("deletes only the scoped threads' and runs' rows of the organization", async () => {
    const store = rowClickHouse(conversationRows(), COLUMNS);
    const api = erasureApi(store.clickhouse, true);

    const response = await api.erase({
      kind: "conversation",
      runIds: [RUN, USAGE_ONLY_RUN],
      threadIds: [THREAD],
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      rowsDeleted: 3,
      status: "complete",
      tables: [{ rowsDeleted: 3, table: "facts" }],
      verifiedAt: VERIFIED_AT,
    });
    expect(store.rows).toEqual({
      facts: [
        { organization_id: ORGANIZATION, run_id: SIBLING_RUN, session_id: SIBLING_THREAD },
        { organization_id: OTHER_ORGANIZATION, run_id: RUN, session_id: THREAD },
      ],
      rollups: [{ organization_id: ORGANIZATION }],
    });
    expect(api.operationReads).toEqual([[ORGANIZATION, OPERATION]]);
    expect(store.statements.some((sql) => sql.includes(THREAD) || sql.includes(RUN))).toBe(false);
  });

  test("refuses to purge unless the operation is a running conversation erasure", async () => {
    const store = rowClickHouse(conversationRows(), COLUMNS);
    const api = erasureApi(store.clickhouse, false);

    const response = await api.erase({ kind: "conversation", runIds: [RUN], threadIds: [THREAD] });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "conversation_erasure_not_running",
      status: 409,
    });
    expect(api.operationReads).toEqual([[ORGANIZATION, OPERATION]]);
    expect(store.statements).toEqual([]);
    expect(store.rows).toEqual(conversationRows());
  });

  test("rejects scope identifiers that are not canonical ULIDs before touching storage", async () => {
    const store = rowClickHouse(conversationRows(), COLUMNS);
    const api = erasureApi(store.clickhouse, true);

    for (const scope of [
      { kind: "conversation", runIds: [], threadIds: ["x') OR 1=1 --"] },
      { kind: "conversation", runIds: [RUN] },
      { kind: "organization", runIds: [], threadIds: [THREAD] },
    ]) {
      const response = await api.erase(scope);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_erasure_request" });
    }
    expect(api.operationReads).toEqual([]);
    expect(store.statements).toEqual([]);
  });

  test("deletes a large scope in batches of 1,000 identifiers", async () => {
    const threadIds = Array.from({ length: 1_001 }, (_, index) => ulid(index));
    const store = rowClickHouse(
      {
        facts: [
          { organization_id: ORGANIZATION, session_id: threadIds[0]! },
          { organization_id: ORGANIZATION, session_id: threadIds[1_000]! },
          { organization_id: ORGANIZATION, session_id: SIBLING_THREAD },
        ],
      },
      { facts: COLUMNS.facts },
    );
    const api = erasureApi(store.clickhouse, true);

    const response = await api.erase({ kind: "conversation", runIds: [], threadIds });

    expect(await response.json()).toMatchObject({ rowsDeleted: 2, status: "complete" });
    expect(store.rows.facts).toEqual([
      { organization_id: ORGANIZATION, session_id: SIBLING_THREAD },
    ]);
    expect(store.alters.map((alter) => arrayParameter(alter.parameters.ids)?.length)).toEqual([
      1_000, 1,
    ]);
  });
});

function httpExecutor(baseUrl: string): ClickHouseExecutor {
  const send = async (body: string, parameters: Readonly<Record<string, string>> = {}) => {
    const target = new URL(baseUrl);
    for (const [name, value] of Object.entries(parameters)) {
      target.searchParams.set(`param_${name}`, value);
    }
    const response = await fetch(target, { body, method: "POST" });
    const text = await response.text();
    if (!response.ok) throw new Error(`ClickHouse returned ${response.status}: ${text}`);
    return text;
  };
  return {
    execute: async (sql, parameters) => {
      await send(sql, parameters);
    },
    insert: async (table, rows) => {
      await send(
        `INSERT INTO ${table} FORMAT JSONEachRow\n${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      );
    },
    query: async <T extends Readonly<Record<string, unknown>>>(
      sql: string,
      parameters?: Readonly<Record<string, string>>,
    ) => parseClickHouseJsonRows<T>(await send(`${sql.trimEnd()}\nFORMAT JSONEachRow`, parameters)),
  };
}

describe.skipIf(!clickhouseUrl)("conversation erasure against ClickHouse", () => {
  const clickhouse = httpExecutor(clickhouseUrl ?? "http://127.0.0.1:8123");

  afterAll(async () => {
    await clickhouse.execute("DROP DATABASE IF EXISTS observability SYNC");
  });

  test("deletes only the scoped threads' and runs' facts of the organization", async () => {
    await clickhouse.execute("DROP DATABASE IF EXISTS observability SYNC");
    await clickhouse.execute("CREATE DATABASE observability");
    await ensureObservabilitySchema(clickhouse);
    const occurredAt = new Date().toISOString().replace("T", " ").replace(/Z$/u, "");
    await clickhouse.insert(
      "observability.facts",
      conversationRows().facts.map((row, index) => ({
        ...row,
        capture_mode: "metadata",
        environment_id: "01ENVIRONMENT0000000000000",
        fact_id: `fact-${index}`,
        fact_type: "span.finalized",
        ingestion_sequence_number: String(index),
        ingestion_shard_id: "shardId-000000000000",
        normalized_at: occurredAt,
        occurred_at: occurredAt,
        payload_json: "{}",
        project_id: "01PROJECT00000000000000000",
        redaction_policy_version: 1,
        schema_version: 1,
        source_record_id: `record-${index}`,
        source_record_type: "span",
        source_record_version: 1,
        source_table: "execution",
      })),
    );
    const api = erasureApi(clickhouse, true);

    const response = await api.erase({
      kind: "conversation",
      runIds: [RUN, USAGE_ONLY_RUN],
      threadIds: [THREAD],
    });

    expect(await response.json()).toEqual({
      rowsDeleted: 3,
      status: "complete",
      tables: [{ rowsDeleted: 3, table: "facts" }],
      verifiedAt: VERIFIED_AT,
    });
    expect(
      await clickhouse.query(
        "SELECT organization_id, run_id, session_id FROM observability.facts ORDER BY fact_id",
      ),
    ).toEqual([
      { organization_id: ORGANIZATION, run_id: SIBLING_RUN, session_id: SIBLING_THREAD },
      { organization_id: OTHER_ORGANIZATION, run_id: RUN, session_id: THREAD },
    ]);
  });
});
