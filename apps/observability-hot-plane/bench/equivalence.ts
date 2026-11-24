/**
 * Checks on the seeded data that every tenant's aggregates read through activeFactsSql() equal
 * the same aggregates read through the observability.active_facts view, over the last 1, 7, and
 * 30 days. The view side ranks the whole table once per fact type and window, grouped by tenant;
 * the activeFactsSql side runs per tenant with the window as `occurredSql`, as the API does.
 * Runs as the administrator, without the query user's memory cap.
 *
 *   bun apps/observability-hot-plane/bench/equivalence.ts
 */
import { activeFactsSql, scopeSql } from "../src/api-query.ts";
import { adminExecutor } from "./executor.ts";
import { environmentId, organizationId, ORGANIZATIONS, PROJECT_ID } from "./settings.ts";

const clickhouse = adminExecutor();
const FACT_TYPES = ["trace.finalized", "span.finalized", "model-invocation.recorded"] as const;
const AGGREGATE = `count() AS rows,
  countIf(JSONExtractString(payload_json, 'outcome') = 'error' OR JSONExtractString(payload_json, 'status') = 'error') AS errors,
  sum(JSONExtractUInt(payload_json, 'totalTokens') + JSONExtractUInt(payload_json, 'durationMs')) AS total,
  groupBitXor(cityHash64(fact_id, source_record_version)) AS ids`;
type Aggregate = Readonly<Record<"errors" | "ids" | "rows" | "total", string | number>>;
const key = (row: Aggregate) => `${row.rows}/${row.errors}/${row.total}/${row.ids}`;

const WINDOW_DAYS = [1, 7, 30] as const;
const NOW = new Date().toISOString().replace("T", " ").replace("Z", "");
const window = (days: number) =>
  `occurred_at >= toDateTime64('${NOW}', 3, 'UTC') - toIntervalDay(${days})`;

let compared = 0;
let rows = 0;
for (const [factType, days] of FACT_TYPES.flatMap((type) =>
  WINDOW_DAYS.map((days) => [type, days] as const),
)) {
  const view = new Map(
    (
      await clickhouse.query<Aggregate & { environment_id: string; organization_id: string }>(
        `SELECT organization_id, environment_id, ${AGGREGATE}
         FROM observability.active_facts WHERE fact_type = '${factType}' AND ${window(days)}
         GROUP BY organization_id, environment_id`,
      )
    ).map((row) => [`${row.organization_id}/${row.environment_id}`, key(row)]),
  );
  for (let organization = 0; organization < ORGANIZATIONS; organization += 1) {
    for (const environment of [0, 1]) {
      const queryScope = scopeSql({
        environmentId: environmentId(organization, environment),
        organizationId: organizationId(organization),
        projectId: PROJECT_ID,
      });
      const [tenantFirst] = await clickhouse.query<Aggregate>(
        `SELECT ${AGGREGATE}
         FROM ${activeFactsSql({
           factTypes: [factType],
           occurredSql: window(days),
           tenantSql: queryScope.partitionSql,
         })}
         WHERE fact_type = '${factType}' AND ${queryScope.sql} AND ${window(days)}`,
        queryScope.parameters,
      );
      const tenant = `${organizationId(organization)}/${environmentId(organization, environment)}`;
      const expected = view.get(tenant) ?? "0/0/0/0";
      if (!tenantFirst || key(tenantFirst) !== expected) {
        throw new Error(
          `Mismatch for ${tenant} ${factType} over ${days} days: ${expected} != ${tenantFirst && key(tenantFirst)}.`,
        );
      }
      compared += 1;
      rows += Number(tenantFirst.rows);
    }
  }
}
console.log(`${compared} tenant aggregates over ${rows} active facts match the view.`);
