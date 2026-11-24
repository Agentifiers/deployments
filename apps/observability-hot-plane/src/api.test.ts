import { describe, expect, test } from "bun:test";
import { createHotPlaneApi } from "./api.ts";
import type { ClickHouseExecutor } from "./clickhouse.ts";
import type { OrganizationErasure } from "./organization-erasure.ts";

function executor(rows: readonly Readonly<Record<string, unknown>>[] = []) {
  const calls: {
    parameters?: Readonly<Record<string, string>>;
    sql: string;
  }[] = [];
  const clickhouse: ClickHouseExecutor = {
    execute: async () => undefined,
    insert: async () => undefined,
    query: async <T extends Readonly<Record<string, unknown>>>(
      sql: string,
      parameters?: Readonly<Record<string, string>>,
    ) => {
      if (sql.includes("max(toUInt256(ingestion_sequence_number))")) {
        return [
          {
            ingestion_sequence_number: "100",
            ingestion_shard_id: "shardId-000000000000",
          },
        ] as unknown as readonly T[];
      }
      calls.push({ sql, ...(parameters ? { parameters } : {}) });
      return rows as readonly T[];
    },
  };
  return { calls, clickhouse };
}

const headers = {
  authorization: "Bearer internal-secret",
  "x-deployments-environment": "01ENVIRONMENT00000000000000",
  "x-deployments-organization": "01ORGANIZATION000000000000",
  "x-deployments-project": "01PROJECT00000000000000000",
  "x-deployments-workspace": "01WORKSPACE000000000000000",
};

const unusedOrganizationErasure: OrganizationErasure = {
  erase: async () => {
    throw new Error("Organization erasure is not exercised by query tests.");
  },
};

describe("observability hot-plane API", () => {
  test("requires the internal service credential", async () => {
    const dependency = executor();
    const response = await createHotPlaneApi({
      clickhouse: dependency.clickhouse,
      organizationErasure: unusedOrganizationErasure,
      serviceToken: "internal-secret",
    }).request("/traces");
    expect(response.status).toBe(401);
  });

  test("serves liveness while gating queries until ClickHouse is initialized", async () => {
    const dependency = executor();
    const app = createHotPlaneApi({
      clickhouse: dependency.clickhouse,
      ready: () => false,
      organizationErasure: unusedOrganizationErasure,
      serviceToken: "internal-secret",
    });
    expect((await app.request("/health")).status).toBe(200);
    const query = await app.request("/traces", { headers });
    expect(query.status).toBe(503);
    expect(query.headers.get("content-type")).toContain("application/problem+json");
    expect(await query.json()).toEqual({
      code: "observability_initializing",
      detail: "The hot plane is initializing.",
      status: 503,
      title: "Observability query failed",
    });
    expect(dependency.calls).toHaveLength(0);
  });

  test("derives tenant filters exclusively from trusted headers", async () => {
    const dependency = executor([
      {
        capture_mode: "metadata-only",
        fact_id: "fact-1",
        normalized_at: "2026-08-03 00:00:00.000",
        occurred_at: "2026-08-03 00:00:00.000",
        payload_json: "{}",
        trace_id: "trace-1",
      },
    ]);
    const response = await createHotPlaneApi({
      clickhouse: dependency.clickhouse,
      now: () => new Date("2026-08-03T00:00:00.000Z"),
      organizationErasure: unusedOrganizationErasure,
      serviceToken: "internal-secret",
    }).request("/traces?limit=10", { headers });
    expect(response.status).toBe(200);
    expect(dependency.calls[0]?.parameters).toMatchObject({
      environment: headers["x-deployments-environment"],
      organization: headers["x-deployments-organization"],
      project: headers["x-deployments-project"],
      workspace: headers["x-deployments-workspace"],
    });
    expect(dependency.calls[0]?.sql).toContain("organization_id = {organization:String}");
    expect(await response.json()).toEqual({
      items: [
        {
          fact_id: "fact-1",
          occurred_at: "2026-08-03T00:00:00.000Z",
          trace_id: "trace-1",
        },
      ],
    });
  });

  test("rejects unbounded trace windows", async () => {
    const dependency = executor();
    const response = await createHotPlaneApi({
      clickhouse: dependency.clickhouse,
      organizationErasure: unusedOrganizationErasure,
      serviceToken: "internal-secret",
    }).request("/traces?from=2026-01-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z", {
      headers,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_time_range" });
  });

  test("rejects trace windows outside hot retention", async () => {
    const dependency = executor();
    const response = await createHotPlaneApi({
      clickhouse: dependency.clickhouse,
      now: () => new Date("2026-08-03T00:00:00.000Z"),
      organizationErasure: unusedOrganizationErasure,
      serviceToken: "internal-secret",
    }).request("/traces?from=2026-04-01T00:00:00.000Z&to=2026-04-15T00:00:00.000Z", { headers });
    expect(response.status).toBe(400);
    expect(dependency.calls).toHaveLength(0);
  });

  test("normalizes valid RFC 3339 timestamps before querying", async () => {
    const dependency = executor();
    const response = await createHotPlaneApi({
      clickhouse: dependency.clickhouse,
      now: () => new Date("2026-08-03T00:00:00.000Z"),
      organizationErasure: unusedOrganizationErasure,
      serviceToken: "internal-secret",
    }).request("/traces?from=2026-08-02T17:00:00-07:00&to=2026-08-03T01:00:00Z", { headers });
    expect(response.status).toBe(200);
    expect(dependency.calls[0]?.parameters).toMatchObject({
      from: "2026-08-03T00:00:00.000Z",
      to: "2026-08-03T01:00:00.000Z",
    });
  });

  test("binds pagination cursors to the original tenant and filters", async () => {
    const dependency = executor([
      { fact_id: "fact-2", occurred_at: "2026-08-02 00:00:00.000" },
      { fact_id: "fact-1", occurred_at: "2026-08-01 00:00:00.000" },
    ]);
    const app = createHotPlaneApi({
      clickhouse: dependency.clickhouse,
      now: () => new Date("2026-08-03T00:00:00.000Z"),
      organizationErasure: unusedOrganizationErasure,
      serviceToken: "internal-secret",
    });
    const first = await app.request("/traces?limit=1&status=ok", { headers });
    const cursor = ((await first.json()) as { nextCursor: string }).nextCursor;
    const continued = await app.request(`/traces?limit=1&status=ok&cursor=${cursor}`, {
      headers,
    });
    expect(continued.status).toBe(200);
    const changed = await app.request(`/traces?limit=1&status=error&cursor=${cursor}`, { headers });
    expect(changed.status).toBe(400);
    expect(await changed.json()).toMatchObject({
      code: "cursor_filter_mismatch",
    });
    expect(dependency.calls[0]?.sql).toContain("snapshot_latest");
    expect(dependency.calls[0]?.sql).toContain(
      "toUInt256(ingestion_sequence_number) <= {snapshot_sequence_0:UInt256}",
    );
    expect(dependency.calls[0]?.sql).toContain(
      "coalesce(nullIf(JSONExtractString(payload_json, 'outcome'), ''), 'unknown') = {status:String}",
    );
    expect(dependency.calls[0]?.parameters?.snapshot).toBe("2026-08-03T00:00:00.000Z");
    expect(dependency.calls[0]?.parameters?.snapshot_sequence_0).toBe("100");
    expect(dependency.calls[0]?.parameters?.snapshot_shard_0).toBe("shardId-000000000000");
    expect(dependency.calls[1]?.parameters?.snapshot).toBe("2026-08-03T00:00:00.000Z");
    expect(dependency.calls[1]?.parameters?.snapshot_sequence_0).toBe("100");
  });

  test("validates continuation retention against the cursor snapshot", async () => {
    const dependency = executor([
      { fact_id: "fact-2", occurred_at: "2026-05-06 00:00:00.000" },
      { fact_id: "fact-1", occurred_at: "2026-05-05 00:00:00.000" },
    ]);
    let now = new Date("2026-08-03T00:00:00.000Z");
    const app = createHotPlaneApi({
      clickhouse: dependency.clickhouse,
      now: () => now,
      organizationErasure: unusedOrganizationErasure,
      serviceToken: "internal-secret",
    });
    const first = await app.request(
      "/traces?limit=1&from=2026-05-05T00:05:00.000Z&to=2026-05-06T00:00:00.000Z",
      { headers },
    );
    const cursor = ((await first.json()) as { nextCursor: string }).nextCursor;
    now = new Date("2026-08-03T00:00:01.000Z");
    const continuation = await app.request(`/traces?limit=1&cursor=${cursor}`, {
      headers,
    });
    expect(continuation.status).toBe(200);
    expect(dependency.calls[1]?.parameters?.snapshot).toBe("2026-08-03T00:00:00.000Z");
    now = new Date("2026-08-03T00:05:01.000Z");
    const expired = await app.request(`/traces?limit=1&cursor=${cursor}`, {
      headers,
    });
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ code: "cursor_expired" });
  });

  test("paginates spans with a trace- and tenant-bound cursor", async () => {
    const dependency = executor([
      {
        actual_model_id: "actual-model",
        actual_provider: "actual-provider",
        attempt_id: "attempt-1",
        cost_usd_micros: 7,
        fact_id: "fact-1",
        invocation_kind: "assistant",
        model_call_index: 2,
        occurred_at: "2026-08-01 00:05:00.000",
        requested_model_id: "requested-model",
        requested_provider: "requested-provider",
        span_id: "span-1",
        total_tokens: 12,
        trace_id: "trace-1",
      },
      {
        fact_id: "fact-2",
        occurred_at: "2026-08-01 00:05:01.000",
        span_id: "span-2",
        trace_id: "trace-1",
      },
    ]);
    let now = new Date("2026-08-31T00:00:00.000Z");
    const app = createHotPlaneApi({
      clickhouse: dependency.clickhouse,
      now: () => now,
      organizationErasure: unusedOrganizationErasure,
      serviceToken: "internal-secret",
    });
    const first = await app.request("/traces/trace-1/spans?limit=1", {
      headers,
    });
    const firstPage = (await first.json()) as {
      items: readonly Readonly<Record<string, unknown>>[];
      nextCursor: string;
    };
    const cursor = firstPage.nextCursor;
    expect(cursor).toBeString();
    expect(firstPage.items[0]).toMatchObject({
      actual_model_id: "actual-model",
      actual_provider: "actual-provider",
      attempt_id: "attempt-1",
      cost_usd_micros: 7,
      invocation_kind: "assistant",
      model_call_index: 2,
      requested_model_id: "requested-model",
      requested_provider: "requested-provider",
      total_tokens: 12,
    });
    expect(dependency.calls[0]?.sql).toContain("if(JSONHas(payload_json, 'actualModelId')");
    expect(dependency.calls[0]?.sql).toContain(
      "toFloat64(JSONExtractUInt(payload_json, 'modelCallIndex')), NULL) AS model_call_index",
    );
    expect(dependency.calls[0]?.sql).toContain(
      "JSONExtractString(payload_json, 'invocationKind'), NULL) AS invocation_kind",
    );
    now = new Date("2026-08-31T00:01:00.000Z");
    const second = await app.request(`/traces/trace-1/spans?limit=1&cursor=${cursor}`, {
      headers,
    });
    expect(second.status).toBe(200);
    expect(dependency.calls[1]?.sql).toContain("span_id > {cursor_span:String}");
    expect(dependency.calls[1]?.sql).toContain("{retention_start:String}");
    expect(dependency.calls[1]?.sql).toContain("snapshot_latest");
    expect(dependency.calls[0]?.parameters?.snapshot).toBe(
      dependency.calls[1]?.parameters?.snapshot,
    );
    expect(dependency.calls[1]?.parameters).toMatchObject({
      cursor_fact: "fact-1",
      cursor_span: "span-1",
      cursor_time: "2026-08-01 00:05:00.000",
      retention_start: "2026-08-01T00:05:00.000Z",
    });
  });

  test("resolves a child run through its active span before loading the trace", async () => {
    const dependency = executor([
      {
        environment_id: headers["x-deployments-environment"],
        fact_id: "trace-fact",
        occurred_at: "2026-08-01 00:00:00.000",
        project_id: headers["x-deployments-project"],
        trace_id: "trace-1",
      },
    ]);
    const response = await createHotPlaneApi({
      clickhouse: dependency.clickhouse,
      organizationErasure: unusedOrganizationErasure,
      serviceToken: "internal-secret",
    }).request("/runs/child-run/trace", { headers });
    expect(response.status).toBe(200);
    expect(dependency.calls[0]?.sql).toContain("run_id = {run:String}");
    expect(dependency.calls[0]?.sql).toContain(
      "has(JSONExtract(payload_json, 'runIds', 'Array(String)'), {run:String})",
    );
    expect(dependency.calls[0]?.sql).toContain("occurred_at >= now() - INTERVAL 90 DAY");
    expect(dependency.calls[0]?.sql.match(/INTERVAL 90 DAY/gu)).toHaveLength(2);
    expect(dependency.calls[0]?.sql).toContain("JSONExtractString(payload_json, 'kind') = 'run'");
  });

  test("exports with the default limit when the request body is empty", async () => {
    const dependency = executor();
    const response = await createHotPlaneApi({
      clickhouse: dependency.clickhouse,
      now: () => new Date("2026-08-03T00:00:00.000Z"),
      organizationErasure: unusedOrganizationErasure,
      serviceToken: "internal-secret",
    }).request("/exports", { headers, method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      generatedAt: "2026-08-03T00:00:00.000Z",
      items: [],
    });
  });

  test("returns metric buckets as canonical UTC timestamps", async () => {
    const dependency = executor([
      {
        bucket: "2026-08-03 00:00:00",
        error_count: 0,
        group_value: "",
        total_cost_usd_micros: 7,
        total_tokens: 12,
        trace_count: 1,
      },
    ]);
    const response = await createHotPlaneApi({
      clickhouse: dependency.clickhouse,
      now: () => new Date("2026-08-03T12:00:00.000Z"),
      organizationErasure: unusedOrganizationErasure,
      serviceToken: "internal-secret",
    }).request("/metrics", { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      from: "2026-08-02T12:00:00.000Z",
      interval: "hour",
      items: [
        {
          bucket: "2026-08-03T00:00:00.000Z",
          error_count: 0,
          total_cost_usd_micros: 7,
          total_tokens: 12,
          trace_count: 1,
        },
      ],
      source: "traces",
      to: "2026-08-03T12:00:00.000Z",
    });
  });

  test("executes a bounded export in one ClickHouse query", async () => {
    const limits: string[] = [];
    let queryCount = 0;
    const clickhouse: ClickHouseExecutor = {
      execute: async () => undefined,
      insert: async () => undefined,
      query: async <T extends Readonly<Record<string, unknown>>>(
        _sql: string,
        parameters?: Readonly<Record<string, string>>,
      ) => {
        limits.push(parameters?.limit ?? "");
        queryCount += 1;
        return Array.from({ length: 101 }, (_, index) => ({
          fact_id: `fact-${index}`,
          occurred_at: `2026-08-02 00:00:${String(index % 60).padStart(2, "0")}.000`,
        })) as unknown as readonly T[];
      },
    };
    const response = await createHotPlaneApi({
      clickhouse,
      now: () => new Date("2026-08-03T00:00:00.000Z"),
      organizationErasure: unusedOrganizationErasure,
      serviceToken: "internal-secret",
    }).request("/exports", {
      body: JSON.stringify({ limit: 101 }),
      headers,
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(queryCount).toBe(1);
    expect(limits).toEqual(["102"]);
  });

  test("rejects a synchronous export above the encoded response budget", async () => {
    const dependency = executor([
      {
        environment_id: headers["x-deployments-environment"],
        fact_id: "x".repeat(5 * 1_024 * 1_024),
        occurred_at: "2026-08-01 00:00:00.000",
        project_id: headers["x-deployments-project"],
        trace_id: "trace-1",
      },
    ]);
    const response = await createHotPlaneApi({
      clickhouse: dependency.clickhouse,
      organizationErasure: unusedOrganizationErasure,
      serviceToken: "internal-secret",
    }).request("/exports", {
      body: JSON.stringify({ limit: 1 }),
      headers,
      method: "POST",
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "export_too_large" });
  });
});
