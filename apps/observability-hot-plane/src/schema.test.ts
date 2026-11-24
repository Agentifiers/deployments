import { expect, test } from "bun:test";
import { ensureObservabilitySchemaWithRetry, OBSERVABILITY_SCHEMA_SQL } from "./schema.ts";

test("retains deletion tombstones for the longest fact retention window", () => {
  expect(OBSERVABILITY_SCHEMA_SQL).toContain("fact_type IN ('trace.finalized', 'record.deleted')");
  expect(OBSERVABILITY_SCHEMA_SQL).toContain(
    "fact_type = 'span.finalized' AND JSONExtractString(payload_json, 'kind') = 'run'",
  );
});

test("initializes only objects covered by the ingest user's database grants", () => {
  expect(OBSERVABILITY_SCHEMA_SQL).not.toContain("CREATE DATABASE");
  expect(OBSERVABILITY_SCHEMA_SQL).toContain(
    "CREATE TABLE IF NOT EXISTS observability.runtime_generation",
  );
});

test("retries schema initialization while ClickHouse bootstrap converges", async () => {
  let executions = 0;
  const waits: number[] = [];
  await ensureObservabilitySchemaWithRetry(
    {
      execute: async () => {
        executions += 1;
        if (executions < 3) throw new Error("not ready");
      },
      insert: async () => undefined,
      query: async () => [],
    },
    {
      attempts: 3,
      signal: new AbortController().signal,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    },
  );
  expect(executions).toBeGreaterThanOrEqual(3);
  expect(waits).toEqual([10_000, 10_000]);
});
