import { describe, expect, test } from "bun:test";
import { createHotPlaneApi } from "./api.ts";
import type { ClickHouseExecutor } from "./clickhouse.ts";

const NOW = new Date("2026-08-03T12:00:00.000Z");
const headers = {
  authorization: "Bearer internal-secret",
  "x-deployments-environment": "01ENVIRONMENT00000000000000",
  "x-deployments-organization": "01ORGANIZATION000000000000",
  "x-deployments-project": "01PROJECT00000000000000000",
  "x-deployments-workspace": "01WORKSPACE000000000000000",
};

function hotPlane() {
  const calls: { readonly parameters: Readonly<Record<string, string>>; readonly sql: string }[] =
    [];
  const clickhouse: ClickHouseExecutor = {
    execute: async () => undefined,
    insert: async () => undefined,
    query: async <T extends Readonly<Record<string, unknown>>>(
      sql: string,
      parameters: Readonly<Record<string, string>> = {},
    ) => {
      calls.push({ parameters, sql });
      return (sql.includes("max(toUInt256(ingestion_sequence_number))")
        ? [{ ingestion_sequence_number: "1", ingestion_shard_id: "shardId-000000000000" }]
        : []) as unknown as readonly T[];
    },
  };
  const app = createHotPlaneApi({
    clickhouse,
    now: () => NOW,
    organizationErasure: {
      erase: async () => {
        throw new Error("Organization erasure is not exercised by query tests.");
      },
    },
    serviceToken: "internal-secret",
  });
  return {
    calls,
    request: async (path: string) => {
      const response = await app.request(path, { headers });
      return { body: (await response.json()) as Readonly<Record<string, unknown>>, response };
    },
  };
}

describe("hot-plane metric bounds", () => {
  test.each([
    ["/metrics?interval=week", "invalid_interval"],
    ["/metrics?groupBy=tool", "invalid_groupBy"],
    ["/metrics?groupBy=toString", "invalid_groupBy"],
    ["/metrics?from=2026-08-03T12:00:00.000Z&to=2026-08-03T11:00:00.000Z", "invalid_time_range"],
    ["/metrics?from=2026-07-01T00:00:00.000Z&to=2026-08-02T00:00:00.000Z", "invalid_time_range"],
    // Trace facts are retained for 90 days.
    ["/metrics?from=2026-05-01T00:00:00.000Z&to=2026-05-02T00:00:00.000Z", "invalid_time_range"],
    // Model-invocation facts are retained for 30 days.
    [
      "/metrics?groupBy=model&interval=day&from=2026-07-01T00:00:00.000Z&to=2026-07-02T00:00:00.000Z",
      "invalid_time_range",
    ],
    // Grouped hourly series cover at most seven days.
    [
      "/metrics?groupBy=agentDeploymentId&from=2026-07-25T00:00:00.000Z&to=2026-08-03T00:00:00.000Z",
      "invalid_time_range",
    ],
    ["/metrics?from=yesterday", "invalid_from"],
    ["/tools?from=2026-07-01T00:00:00.000Z&to=2026-07-02T00:00:00.000Z", "invalid_time_range"],
    ["/tools?agentDeploymentId=bad%20id", "invalid_agent_deployment_id"],
    ["/metrics?agentDeploymentId=bad%20id", "invalid_agent_deployment_id"],
  ])("rejects %s before querying", async (path, code) => {
    const hot = hotPlane();
    const { body, response } = await hot.request(path);
    expect(response.status).toBe(400);
    expect(body.code).toBe(code);
    expect(hot.calls).toHaveLength(0);
  });

  test("accepts a grouped daily series across the full lookback", async () => {
    const hot = hotPlane();
    const { body, response } = await hot.request(
      "/metrics?groupBy=agentDeploymentId&interval=day&from=2026-07-03T12:00:00.000Z",
    );
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ groupBy: "agentDeploymentId", interval: "day", source: "traces" });
    expect(hot.calls[0]?.sql).toContain("toStartOfDay(occurred_at)");
    expect(hot.calls[0]?.parameters.group_limit).toBe("20");
  });

  test("filters an ungrouped series to one deployment instead of ranking groups", async () => {
    const hot = hotPlane();
    const { body, response } = await hot.request("/metrics?agentDeploymentId=deployment-1");
    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty("groupBy");
    expect(hot.calls[0]?.parameters).toMatchObject({
      agent_deployment_id: "deployment-1",
      group_limit: "1",
    });
    expect(hot.calls[0]?.sql).toContain(
      "JSONExtractString(payload_json, 'agentDeploymentId') = {agent_deployment_id:String}",
    );
  });

  test("applies optional project, environment, and workspace scope to metrics and tools", async () => {
    const hot = hotPlane();
    await hot.request("/metrics?groupBy=provider");
    await hot.request("/tools?agentDeploymentId=deployment-1");
    for (const call of hot.calls) {
      expect(call.parameters).toMatchObject({
        environment: headers["x-deployments-environment"],
        organization: headers["x-deployments-organization"],
        project: headers["x-deployments-project"],
        workspace: headers["x-deployments-workspace"],
      });
      expect(call.sql).toContain("workspace_id = {workspace:String}");
    }
    // The tool deployment filter re-applies the scope inside its run subquery.
    const runs = hot.calls[1]?.sql.slice(hot.calls[1].sql.indexOf("run_id IN ("));
    expect(runs).toContain("project_id = {project:String}");
    expect(runs).toContain("workspace_id = {workspace:String}");
    expect(hot.calls[1]?.parameters.agent_deployment_id).toBe("deployment-1");
  });
});

describe("hot-plane trace filters", () => {
  test.each([
    ["agentDefinitionId=a%20b", "invalid_agent_definition_id"],
    ["agentDeploymentId=%27%3B", "invalid_agent_deployment_id"],
    ["agentReleaseId=", "invalid_agent_release_id"],
    ["errorClass=x".padEnd(200, "x"), "invalid_error_class"],
    ["executionPurpose=production", "invalid_execution_purpose"],
  ])("rejects %s", async (query, code) => {
    const hot = hotPlane();
    const { body, response } = await hot.request(`/traces?${query}`);
    expect(response.status).toBe(400);
    expect(body.code).toBe(code);
  });

  test("binds every filter as a typed parameter on traces and session traces", async () => {
    const hot = hotPlane();
    const query =
      "agentDefinitionId=definition-a&agentDeploymentId=deployment-1&agentReleaseId=release-1&executionPurpose=customer&errorClass=RateLimitError";
    await hot.request(`/traces?${query}`);
    await hot.request(`/sessions/session-1/traces?${query}`);
    const queries = hot.calls.filter((call) => call.sql.includes("trace.finalized"));
    expect(queries).toHaveLength(2);
    for (const call of queries) {
      expect(call.parameters).toMatchObject({
        agent_definition_id: "definition-a",
        agent_deployment_id: "deployment-1",
        agent_release_id: "release-1",
        error_class: "RateLimitError",
        execution_purpose: "customer",
      });
      expect(call.sql).toContain(
        "JSONExtractString(payload_json, 'agentDeploymentId') = {agent_deployment_id:String}",
      );
    }
    expect(queries[1]?.parameters.session_id).toBe("session-1");
  });
});
