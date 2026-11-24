import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHotPlaneApi } from "./api.ts";
import { parseClickHouseJsonRows, type ClickHouseExecutor } from "./clickhouse.ts";
import { ensureObservabilitySchema } from "./schema.ts";

/**
 * Executes the hot-plane queries against a real ClickHouse server. The variable must point at a
 * disposable server's HTTP interface (for example `http://127.0.0.1:8123`): the suite recreates
 * the `observability` database.
 */
const clickhouseUrl = process.env.OBSERVABILITY_HOT_PLANE_TEST_CLICKHOUSE_URL;

const HOUR = 3_600_000;
const ORGANIZATION = "01ORGANIZATION000000000000";
const PROJECT = "01PROJECT00000000000000000";
const ENVIRONMENT = "01ENVIRONMENT00000000000000";
const now = new Date();
const yesterday = Math.floor(now.getTime() / (24 * HOUR)) * 24 * HOUR - 24 * HOUR;
const at = (offsetMs: number) => new Date(yesterday + offsetMs);
const iso = (offsetMs: number) => at(offsetMs).toISOString();
const sqlTime = (offsetMs: number) => iso(offsetMs).replace("T", " ").replace(/Z$/u, "");

const headers = {
  authorization: "Bearer internal-secret",
  "x-deployments-environment": ENVIRONMENT,
  "x-deployments-organization": ORGANIZATION,
  "x-deployments-project": PROJECT,
};

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

let sequence = 0;
function fact(input: {
  readonly factType: string;
  readonly offsetMs: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly runId?: string;
  readonly traceId: string;
}) {
  sequence += 1;
  const id = `fact-${String(sequence).padStart(3, "0")}`;
  return {
    capture_mode: "metadata-only",
    environment_id: ENVIRONMENT,
    fact_id: id,
    fact_type: input.factType,
    ingested_at: sqlTime(input.offsetMs),
    ingestion_sequence_number: String(sequence),
    ingestion_shard_id: "shardId-000000000000",
    normalized_at: sqlTime(input.offsetMs),
    occurred_at: sqlTime(input.offsetMs),
    organization_id: ORGANIZATION,
    payload_json: JSON.stringify(input.payload),
    project_id: PROJECT,
    redaction_policy_version: 1,
    run_id: input.runId ?? null,
    schema_version: 1,
    session_id: "session-1",
    source_record_id: id,
    source_record_type: input.factType.split(".")[0],
    source_record_version: 1,
    source_table: "execution",
    span_id: null,
    trace_id: input.traceId,
  };
}

const trace = (traceId: string, offsetMs: number, payload: Readonly<Record<string, unknown>>) =>
  fact({
    factType: "trace.finalized",
    offsetMs,
    payload: { outcome: "ok", rootRunId: `${traceId}-root`, runCount: 1, ...payload },
    traceId,
  });

const facts = [
  trace("trace-1", 1 * HOUR + 10 * 60_000, {
    agentDefinitionId: "definition-a",
    agentDeploymentId: "deployment-1",
    agentReleaseId: "release-1",
    durationMs: 100,
    executionPurpose: "customer",
    releaseSelection: "primary",
    totalCostUsdMicros: 5,
    totalTokens: 10,
    trigger: "api",
  }),
  trace("trace-2", 1 * HOUR + 40 * 60_000, {
    agentDefinitionId: "definition-a",
    agentDeploymentId: "deployment-1",
    agentReleaseId: "release-1",
    durationMs: 300,
    errorClass: "RateLimitError",
    executionPurpose: "customer",
    outcome: "error",
    totalCostUsdMicros: 7,
    totalTokens: 20,
  }),
  trace("trace-3", 2 * HOUR + 15 * 60_000, {
    agentDefinitionId: "definition-a",
    agentReleaseId: "release-2",
    durationMs: 200,
    executionPurpose: "preview",
    totalCostUsdMicros: 1,
    totalTokens: 5,
  }),
  trace("trace-4", -30 * 60_000, {
    agentDefinitionId: "definition-b",
    agentDeploymentId: "deployment-2",
    agentReleaseId: "release-2",
    durationMs: 400,
    executionPurpose: "customer",
  }),
  // Finalized before the agent summary fields existed.
  trace("trace-5", 3 * HOUR, { totalTokens: 1 }),
  fact({
    factType: "model-invocation.recorded",
    offsetMs: 1 * HOUR + 5 * 60_000,
    payload: {
      actualModelId: "model-x",
      actualProvider: "provider-a",
      cachedTokens: 2,
      costUsdMicros: 3,
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 5,
      requestedModelId: "model-x",
      status: "ok",
      totalTokens: 15,
    },
    traceId: "trace-1",
  }),
  fact({
    factType: "model-invocation.recorded",
    offsetMs: 1 * HOUR + 20 * 60_000,
    payload: {
      durationMs: 300,
      requestedModelId: "model-x",
      requestedProvider: "provider-a",
      status: "error",
    },
    traceId: "trace-2",
  }),
  fact({
    factType: "model-invocation.recorded",
    offsetMs: 2 * HOUR + 10 * 60_000,
    payload: {
      actualModelId: "model-y",
      actualProvider: "provider-b",
      durationMs: 50,
      inputTokens: 1,
      outputTokens: 1,
      requestedModelId: "model-y",
      status: "ok",
      totalTokens: 2,
    },
    traceId: "trace-3",
  }),
  ...(
    [
      ["run-1", "search", "ok", 100, 1 * HOUR],
      ["run-2", "search", "error", 300, 1 * HOUR + 30 * 60_000],
      ["run-2", "fetch", "ok", 20, 1 * HOUR + 31 * 60_000],
    ] as const
  ).map(([runId, name, status, durationMs, offsetMs]) =>
    fact({
      factType: "span.finalized",
      offsetMs,
      payload: { durationMs, kind: "tool", name, status },
      runId,
      traceId: "trace-tools",
    }),
  ),
  ...(
    [
      ["run-1", "deployment-1", 1 * HOUR + 15 * 60_000],
      ["run-2", "deployment-2", 1 * HOUR + 45 * 60_000],
    ] as const
  ).map(([runId, agentDeploymentId, offsetMs]) =>
    fact({
      factType: "span.finalized",
      offsetMs,
      payload: { agentDeploymentId, kind: "run", name: "agent.run", status: "ok" },
      runId,
      traceId: "trace-tools",
    }),
  ),
];

describe.skipIf(!clickhouseUrl)("hot-plane queries against ClickHouse", () => {
  const clickhouse = httpExecutor(clickhouseUrl ?? "http://127.0.0.1:8123");
  const app = createHotPlaneApi({
    clickhouse,
    now: () => now,
    organizationErasure: {
      erase: async () => {
        throw new Error("Organization erasure is not exercised by query tests.");
      },
    },
    serviceToken: "internal-secret",
  });
  const get = async (path: string) => {
    const response = await app.request(path, { headers });
    return { body: (await response.json()) as Readonly<Record<string, unknown>>, response };
  };
  const traceIds = async (query: string) => {
    const { body, response } = await get(`/traces?${query}`);
    expect(response.status).toBe(200);
    return (body.items as readonly { readonly trace_id: string }[]).map((item) => item.trace_id);
  };

  beforeAll(async () => {
    await clickhouse.execute("DROP DATABASE IF EXISTS observability SYNC");
    await clickhouse.execute("CREATE DATABASE observability");
    await ensureObservabilitySchema(clickhouse);
    await clickhouse.insert("observability.facts", facts);
  });

  afterAll(async () => {
    await clickhouse.execute("DROP DATABASE IF EXISTS observability SYNC");
  });

  test("returns the root-run agent summary and omits it for older facts", async () => {
    const { body } = await get("/traces?limit=10");
    const items = body.items as readonly Readonly<Record<string, unknown>>[];
    expect(items.find((item) => item.trace_id === "trace-1")).toMatchObject({
      agent_definition_id: "definition-a",
      agent_deployment_id: "deployment-1",
      agent_release_id: "release-1",
      duration_ms: 100,
      execution_purpose: "customer",
      release_selection: "primary",
      status: "ok",
      trigger: "api",
    });
    expect(items.find((item) => item.trace_id === "trace-2")).toMatchObject({
      error_class: "RateLimitError",
      status: "error",
    });
    const older = items.find((item) => item.trace_id === "trace-5")!;
    for (const field of ["agent_deployment_id", "duration_ms", "error_class", "trigger"]) {
      expect(older).not.toHaveProperty(field);
    }
  });

  test("narrows trace lists by each agent filter", async () => {
    expect(await traceIds("")).toEqual(["trace-5", "trace-3", "trace-2", "trace-1", "trace-4"]);
    expect(await traceIds("agentDefinitionId=definition-a")).toEqual([
      "trace-3",
      "trace-2",
      "trace-1",
    ]);
    expect(await traceIds("agentDeploymentId=deployment-1")).toEqual(["trace-2", "trace-1"]);
    expect(await traceIds("agentReleaseId=release-2")).toEqual(["trace-3", "trace-4"]);
    expect(await traceIds("executionPurpose=preview")).toEqual(["trace-3"]);
    expect(await traceIds("errorClass=RateLimitError")).toEqual(["trace-2"]);
    expect(await traceIds("agentDeploymentId=deployment-1&status=ok")).toEqual(["trace-1"]);
  });

  test("keeps filters bound to the pagination cursor", async () => {
    const first = await get("/traces?limit=1&agentDeploymentId=deployment-1");
    expect((first.body.items as readonly { trace_id: string }[])[0]?.trace_id).toBe("trace-2");
    const cursor = encodeURIComponent(first.body.nextCursor as string);
    expect(await traceIds(`limit=1&cursor=${cursor}`)).toEqual(["trace-1"]);
    const changed = await get(`/traces?limit=1&agentDeploymentId=deployment-2&cursor=${cursor}`);
    expect(changed.response.status).toBe(400);
    expect(changed.body.code).toBe("cursor_filter_mismatch");
  });

  test("buckets trace metrics hourly with duration percentiles", async () => {
    const { body, response } = await get(`/metrics?from=${iso(0)}&to=${iso(4 * HOUR)}`);
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      from: iso(0),
      interval: "hour",
      source: "traces",
      to: iso(4 * HOUR),
    });
    expect(body.items).toEqual([
      {
        bucket: iso(1 * HOUR),
        error_count: 1,
        p50_duration_ms: 200,
        p95_duration_ms: 290,
        total_cost_usd_micros: 12,
        total_tokens: 30,
        trace_count: 2,
      },
      {
        bucket: iso(2 * HOUR),
        error_count: 0,
        p50_duration_ms: 200,
        p95_duration_ms: 200,
        total_cost_usd_micros: 1,
        total_tokens: 5,
        trace_count: 1,
      },
      {
        bucket: iso(3 * HOUR),
        error_count: 0,
        total_cost_usd_micros: 0,
        total_tokens: 1,
        trace_count: 1,
      },
    ]);
  });

  test("groups daily trace metrics by deployment, ranked by window volume", async () => {
    const { body } = await get(
      `/metrics?from=${iso(-24 * HOUR)}&to=${iso(24 * HOUR)}&interval=day&groupBy=agentDeploymentId`,
    );
    expect(body.groupBy).toBe("agentDeploymentId");
    expect(
      (body.items as readonly Readonly<Record<string, unknown>>[]).map((item) => [
        item.bucket,
        item.group_value,
        item.trace_count,
      ]),
    ).toEqual([
      [iso(-24 * HOUR), "deployment-2", 1],
      // trace-3 (preview) and trace-5 (older fact) lack a deployment: an ungrouped remainder.
      [iso(0), undefined, 2],
      [iso(0), "deployment-1", 2],
    ]);
  });

  test("groups model-invocation metrics by provider-confirmed model", async () => {
    const { body } = await get(`/metrics?from=${iso(0)}&to=${iso(4 * HOUR)}&groupBy=model`);
    expect(body.source).toBe("model-invocations");
    expect(body.items).toEqual([
      {
        bucket: iso(1 * HOUR),
        cached_tokens: 2,
        error_count: 1,
        group_value: "model-x",
        input_tokens: 10,
        invocation_count: 2,
        output_tokens: 5,
        p50_latency_ms: 200,
        p95_latency_ms: 290,
        total_cost_usd_micros: 3,
        total_tokens: 15,
      },
      {
        bucket: iso(2 * HOUR),
        cached_tokens: 0,
        error_count: 0,
        group_value: "model-y",
        input_tokens: 1,
        invocation_count: 1,
        output_tokens: 1,
        p50_latency_ms: 50,
        p95_latency_ms: 50,
        total_cost_usd_micros: 0,
        total_tokens: 2,
      },
    ]);
    const providers = await get(`/metrics?from=${iso(0)}&to=${iso(4 * HOUR)}&groupBy=provider`);
    expect(
      (providers.body.items as readonly Readonly<Record<string, unknown>>[]).map((item) => [
        item.group_value,
        item.invocation_count,
      ]),
    ).toEqual([
      ["provider-a", 2],
      ["provider-b", 1],
    ]);
  });

  test("serves each record's latest version and hides what its tenant's tombstones delete", async () => {
    const tenant = "01TOMBSTONEORGANIZATION000";
    const record = (
      traceId: string,
      version: number,
      factType = "trace.finalized",
      payload: Readonly<Record<string, unknown>> = { outcome: version > 1 ? "error" : "ok" },
      organizationId = tenant,
      offsetMs = 5 * HOUR + traceId.length * 60_000 + version * 1_000,
    ) => ({
      ...trace(traceId, offsetMs, payload),
      fact_id: `${traceId}-${factType}-v${version}`,
      fact_type: factType,
      organization_id: organizationId,
      source_record_id: `${traceId}-record`,
      source_record_type: "trace",
      source_record_version: version,
    });
    const tombstone = (traceId: string, organizationId = tenant, offsetMs?: number) =>
      record(
        traceId,
        1,
        "record.deleted",
        { deleteThroughRecordVersion: 1, deletedFactTypes: ["trace.finalized"] },
        organizationId,
        offsetMs,
      );
    const afterWindow = 26 * HOUR;
    await clickhouse.insert("observability.facts", [
      record("updated", 1),
      record("updated", 2),
      record("deleted", 1),
      // A version or tombstone outside the queried window still supersedes one inside it.
      tombstone("deleted", tenant, afterWindow),
      record("recreated", 1),
      tombstone("recreated"),
      record("recreated", 2),
      record("moved", 1),
      record("moved", 2, "trace.finalized", { outcome: "error" }, tenant, afterWindow),
      // Another organization's tombstone for the same record never hides this tenant's.
      record("foreign", 1),
      tombstone("foreign", "01OTHERTOMBSTONEORGANIZATION"),
    ]);
    const tenantHeaders = { ...headers, "x-deployments-organization": tenant };
    const range = `from=${iso(0)}&to=${iso(24 * HOUR)}`;
    const traces = await app.request(`/traces?${range}`, { headers: tenantHeaders });
    expect(
      ((await traces.json()) as { items: readonly Readonly<Record<string, unknown>>[] }).items.map(
        (item) => [item.trace_id, item.status],
      ),
    ).toEqual([
      ["recreated", "error"],
      ["updated", "error"],
      ["foreign", "ok"],
    ]);
    const deleted = await app.request("/traces/deleted", { headers: tenantHeaders });
    expect(deleted.status).toBe(404);
    const metrics = await app.request(`/metrics?${range}&interval=day`, { headers: tenantHeaders });
    expect(
      ((await metrics.json()) as { items: readonly Readonly<Record<string, unknown>>[] }).items,
    ).toMatchObject([{ error_count: 2, trace_count: 3 }]);
  });

  test("narrows tool metrics to one deployment's runs", async () => {
    const all = await get(`/tools?from=${iso(0)}&to=${iso(4 * HOUR)}`);
    expect(all.body.items).toEqual([
      { calls: 2, errors: 1, name: "search", p95_duration_ms: 290 },
      { calls: 1, errors: 0, name: "fetch", p95_duration_ms: 20 },
    ]);
    const scoped = await get(
      `/tools?from=${iso(0)}&to=${iso(4 * HOUR)}&agentDeploymentId=deployment-2`,
    );
    expect(scoped.body.items).toEqual([
      { calls: 1, errors: 0, name: "fetch", p95_duration_ms: 20 },
      { calls: 1, errors: 1, name: "search", p95_duration_ms: 300 },
    ]);
  });
});
