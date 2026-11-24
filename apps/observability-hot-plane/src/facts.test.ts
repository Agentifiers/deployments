import { expect, test } from "bun:test";
import { makeObservabilityFact } from "@deployments-ai/observability";
import { hotFactRow } from "./facts.ts";

test("maps canonical normalized facts without changing their identity", () => {
  const fact = makeObservabilityFact({
    captureMode: "metadata-only",
    factType: "trace.finalized",
    normalizedAt: "2026-08-03T00:00:01.000Z",
    occurredAt: "2026-08-03T00:00:00.000Z",
    payload: { status: "ok", totalTokens: 42 },
    scope: {
      environmentId: "environment",
      organizationId: "organization",
      projectId: "project",
    },
    source: {
      recordId: "trace-1",
      recordType: "trace",
      recordVersion: 3,
      table: "execution",
    },
  });
  expect(
    hotFactRow(
      fact,
      { sequenceNumber: "123", shardId: "shard-000" },
      new Date("2026-08-03T00:00:02.000Z"),
    ),
  ).toMatchObject({
    fact_id: fact.factId,
    fact_type: "trace.finalized",
    ingestion_sequence_number: "123",
    ingestion_shard_id: "shard-000",
    ingested_at: "2026-08-03 00:00:02.000",
    normalized_at: "2026-08-03 00:00:01.000",
    occurred_at: "2026-08-03 00:00:00.000",
    source_record_version: 3,
  });
});
