import { expect, test } from "bun:test";
import path from "node:path";
import {
  bashSsmCommand,
  checkpointDeleteKey,
  coldHistoryOverlapsRetainedStream,
  exportWatermarkRows,
  exportWatermarkSql,
  importSql,
  parseRebuildCommand,
  projectorCheckpointBootstrapTargets,
  projectorCoversRetainedStream,
  REBUILD_LEASE_KEY,
  reconciliationSucceeded,
  remainingTimeoutSeconds,
  replayGateSatisfied,
  replayTargetsForRetainedShards,
  targetReconciliationSql,
  targetReconciliationSucceeded,
  unloadSql,
} from "./observability-clickhouse-rebuild.ts";

const orchestratorSource = await Bun.file(
  new URL("./observability-clickhouse-rebuild.ts", import.meta.url),
).text();
const rebuildSource = (
  await Promise.all(
    [
      "./observability-clickhouse-rebuild-aws.ts",
      "./observability-clickhouse-rebuild-lease.ts",
      "./observability-clickhouse-rebuild-replay.ts",
    ].map((name) => Bun.file(new URL(name, import.meta.url)).text()),
  )
).join(`\n${orchestratorSource}\n`);

test("keeps recovery modules within the repository source-file limit", async () => {
  for (const name of [
    "./observability-clickhouse-rebuild.ts",
    "./observability-clickhouse-rebuild-aws.ts",
    "./observability-clickhouse-rebuild-lease.ts",
    "./observability-clickhouse-rebuild-replay.ts",
    "./observability-clickhouse-rebuild-sql.ts",
    "./observability-clickhouse-rebuild-support.ts",
  ]) {
    const lines = (await Bun.file(new URL(name, import.meta.url)).text()).split("\n").length;
    expect(lines).toBeLessThanOrEqual(700);
  }
});

test("executes rebuild payloads through an explicit Bash interpreter", () => {
  const command = bashSsmCommand(["echo rebuild"]);
  const encoded = command.match(/'([A-Za-z0-9+/=]+)'/)?.[1];
  expect(command).toEndWith("| base64 --decode | /usr/bin/env bash");
  expect(Buffer.from(encoded!, "base64").toString()).toBe("set -euo pipefail\necho rebuild\n");
});

test("passes the full recovery timeout to SSM and cancels expired commands", () => {
  expect(rebuildSource).toContain("executionTimeout: [String(timeout)]");
  expect(rebuildSource).toContain('"ssm", "cancel-command", "--command-id", commandId');
});

test("requires the post-clear replay marker and every captured shard watermark", () => {
  const streamArn = "arn:aws:kinesis:us-east-2:123456789012:stream/facts";
  const targets = [
    { sequenceNumber: "100", shardId: "shard-1", streamArn },
    { sequenceNumber: "999", shardId: "shard-2", streamArn },
  ];
  const checkpoints = [
    { sequenceNumber: "100", shardId: "shard-1", streamArn },
    { sequenceNumber: "1000", shardId: "shard-2", streamArn },
    {
      sequenceNumber: "complete",
      shardId: "initial-replay-complete",
      streamArn,
      updatedAt: "2026-08-03T00:00:01.000Z",
    },
  ];
  expect(replayGateSatisfied(checkpoints, targets, streamArn)).toBe(true);
  expect(
    replayGateSatisfied(
      checkpoints.map((checkpoint) =>
        checkpoint.shardId === "shard-2" ? { ...checkpoint, sequenceNumber: "998" } : checkpoint,
      ),
      targets,
      streamArn,
    ),
  ).toBe(false);
  expect(
    replayGateSatisfied(
      checkpoints.filter((checkpoint) => checkpoint.shardId !== "initial-replay-complete"),
      targets,
      streamArn,
      false,
    ),
  ).toBe(true);
  expect(
    replayGateSatisfied(
      checkpoints.filter((checkpoint) => checkpoint.shardId !== "initial-replay-complete"),
      targets,
      streamArn,
    ),
  ).toBe(false);
  expect(
    replayGateSatisfied(
      checkpoints.map((checkpoint) =>
        checkpoint.shardId === "initial-replay-complete"
          ? { ...checkpoint, updatedAt: "2026-08-02T23:59:59.000Z" }
          : checkpoint,
      ),
      targets,
      streamArn,
    ),
  ).toBe(true);
});

test("shares one absolute deadline across rebuild stages", () => {
  expect(remainingTimeoutSeconds(10_500, "test stage", 8_001)).toBe(3);
  expect(() => remainingTimeoutSeconds(10_000, "test stage", 10_000)).toThrow(
    "Observability rebuild timed out before test stage.",
  );
  expect(rebuildSource).toContain('remaining("ClickHouse target reconciliation")');
  expect(rebuildSource).not.toContain("waitForAthena(executionId, recoveryTimeoutSeconds)");
});

test("requires the OpenTofu root and keeps rebuilds dry unless executed", () => {
  expect(() => parseRebuildCommand([])).toThrow("--root is required.");
  expect(() => parseRebuildCommand(["dev"])).toThrow();
  expect(parseRebuildCommand(["--root", "environments/prod"])).toEqual({
    execute: false,
    recoveryTimeoutSeconds: 2 * 60 * 60,
    root: path.resolve("environments/prod"),
  });
  expect(
    parseRebuildCommand(["--root", "/srv/root", "--recovery-timeout-hours", "8", "--execute"]),
  ).toEqual({ execute: true, recoveryTimeoutSeconds: 8 * 60 * 60, root: "/srv/root" });
  expect(() =>
    parseRebuildCommand(["--root", "/srv/root", "--recovery-timeout-hours", "0"]),
  ).toThrow("--recovery-timeout-hours must be a positive number.");
});

test("serializes destructive rebuilds with an expiring owner lease", () => {
  expect(REBUILD_LEASE_KEY).toEqual({
    consumer: { S: "observability-clickhouse-rebuild-v1" },
    shard: { S: "full-rebuild" },
  });
  expect(rebuildSource).toContain("attribute_not_exists(#leaseOwner) OR #leaseExpiresAt < :now");
  expect(rebuildSource).toContain('"#leaseOwner = :owner"');
  expect(orchestratorSource.indexOf("await acquireRebuildLease(")).toBeLessThan(
    orchestratorSource.indexOf("await eventSourceMappingState("),
  );
  expect(orchestratorSource.indexOf("await releaseRebuildLease(")).toBeGreaterThan(
    orchestratorSource.lastIndexOf("await setEventSourceMappingEnabled("),
  );
});

test("revalidates the advancing retention boundary before stopping service", () => {
  expect(orchestratorSource.match(/await retainedStreamWindow\(/gu)).toHaveLength(3);
  expect(orchestratorSource).toContain('remaining("pre-outage retained-stream scan")');
  expect(orchestratorSource.indexOf('remaining("pre-outage retained-stream scan")')).toBeLessThan(
    orchestratorSource.indexOf("await stopService(hot)"),
  );
  expect(orchestratorSource).toContain(
    "Kinesis retention advanced beyond the cold watermark during the rebuild export.",
  );
  expect(orchestratorSource).toContain(
    "Kinesis retention advanced beyond the immutable export during the offline import.",
  );
  expect(orchestratorSource.indexOf('remaining("post-import retained-stream scan")')).toBeLessThan(
    orchestratorSource.indexOf("await clearCheckpoints("),
  );
  expect(orchestratorSource).toContain('remaining("immutable export watermark query")');
});

test("publishes cold-seed readiness only after replay and reconciliation", () => {
  const replayWithoutReadiness = orchestratorSource.indexOf(
    'remaining("Kinesis replay"),\n      false',
  );
  const reconciliation = orchestratorSource.indexOf(
    "if (!reconciliationSucceeded(reconciliationRows))",
  );
  const seed = orchestratorSource.indexOf("await markCanonicalSeed(");
  const readiness = orchestratorSource.indexOf('remaining("canonical seed readiness"),');
  expect(replayWithoutReadiness).toBeGreaterThan(0);
  expect(reconciliation).toBeGreaterThan(replayWithoutReadiness);
  expect(seed).toBeGreaterThan(reconciliation);
  expect(readiness).toBeGreaterThan(seed);
});

test("paces retained-stream scans and retries shared-quota throttles", () => {
  expect(rebuildSource).toContain(
    'result.stderr.includes("ProvisionedThroughputExceededException")',
  );
  expect(rebuildSource).toContain("await Bun.sleep(2_000)");
  expect(rebuildSource).toContain("backoff = Math.min(8_000, backoff * 2)");
});

test("fences rebuilds on exhausted projectors and failed Firehose deliveries", () => {
  expect(orchestratorSource.match(/assertProjectionFailureFencesClear\(/gu)).toHaveLength(2);
  expect(rebuildSource).toContain(
    "The observability Firehose failed-delivery bucket is not empty.",
  );
  expect(rebuildSource).toContain("ApproximateNumberOfMessagesNotVisible");
});

test("quiesces the projector through the Firehose delivery window", () => {
  expect(orchestratorSource).toContain("const PROJECTOR_DRAIN_MS = 8 * 60_000");
  const quiesce = orchestratorSource.indexOf('remaining("projector quiesce")');
  const drain = orchestratorSource.indexOf("await Bun.sleep(PROJECTOR_DRAIN_MS)");
  const unload = orchestratorSource.indexOf("unloadSql(");
  const resume = orchestratorSource.lastIndexOf("await setEventSourceMappingEnabled(");
  expect(quiesce).toBeGreaterThan(0);
  expect(drain).toBeGreaterThan(quiesce);
  expect(unload).toBeGreaterThan(drain);
  expect(resume).toBeGreaterThan(unload);
  expect(rebuildSource).toContain('enabled ? "--enabled" : "--no-enabled"');
});

test("requires a contiguous projector checkpoint across trimmed shards", () => {
  const streamArn = "arn:aws:kinesis:us-east-2:123456789012:stream/facts";
  const projector = [
    { sequenceNumber: "100", shardId: "retained", streamArn },
    { sequenceNumber: "1000", shardId: "fully-trimmed", streamArn },
  ];
  const boundaries = [{ sequenceNumber: "100", shardId: "retained" }, { shardId: "fully-trimmed" }];
  const hot = [{ sequenceNumber: "999", shardId: "fully-trimmed", streamArn }];
  expect(projectorCoversRetainedStream(projector, boundaries, hot, streamArn)).toBe(true);
  expect(
    projectorCoversRetainedStream(
      projector.filter((item) => item.shardId !== "fully-trimmed"),
      boundaries,
      hot,
      streamArn,
    ),
  ).toBe(false);
  expect(
    projectorCoversRetainedStream(
      [{ sequenceNumber: "99", shardId: "retained", streamArn }],
      [{ sequenceNumber: "100", shardId: "retained" }],
      [],
      streamArn,
    ),
  ).toBe(false);
});

test("bootstraps idle-shard projector checkpoints from quiesced Iceberg", () => {
  const streamArn = "arn:aws:kinesis:us-east-2:123456789012:stream/facts";
  const rows = [
    [
      "fact_family",
      "projection_stream_arn",
      "projection_shard_id",
      "projection_sequence_watermark",
    ],
    ["spans", streamArn, "shard-closed", "100"],
    ["traces", streamArn, "shard-closed", "120"],
    ["usage", streamArn, "shard-existing", "80"],
  ];
  expect(
    projectorCheckpointBootstrapTargets(
      rows,
      [
        {
          sequenceNumber: "80",
          shardId: "shard-existing",
          streamArn,
        },
      ],
      streamArn,
    ),
  ).toEqual([
    {
      sequenceNumber: "120",
      shardId: "shard-closed",
      streamArn,
    },
  ]);
});

test("requires cold history to overlap each retained fact family and shard", () => {
  const streamArn = "arn:aws:kinesis:us-east-2:123456789012:stream/facts";
  const rows = [
    [
      "fact_family",
      "projection_stream_arn",
      "projection_shard_id",
      "projection_sequence_watermark",
    ],
    ["traces", streamArn, "shard-1", "100"],
    ["usage", streamArn, "shard-1", "120"],
    ["spans", streamArn, "shard-2", "200"],
  ];
  expect(
    coldHistoryOverlapsRetainedStream(
      rows,
      [
        {
          factFamily: "usage",
          sequenceNumber: "110",
          shardId: "shard-1",
        },
        {
          factFamily: "spans",
          sequenceNumber: "200",
          shardId: "shard-2",
        },
      ],
      streamArn,
    ),
  ).toBe(true);
  expect(
    coldHistoryOverlapsRetainedStream(
      rows,
      [
        {
          factFamily: "spans",
          sequenceNumber: "201",
          shardId: "shard-2",
        },
      ],
      streamArn,
    ),
  ).toBe(false);
  expect(
    coldHistoryOverlapsRetainedStream(
      rows,
      [
        {
          factFamily: "traces",
          sequenceNumber: "110",
          shardId: "shard-1",
        },
      ],
      streamArn,
    ),
  ).toBe(false);
});

test("does not wait for pre-stop checkpoints on fully trimmed shards", () => {
  const streamArn = "arn:aws:kinesis:us-east-2:123456789012:stream/facts";
  const checkpoints = [
    { sequenceNumber: "100", shardId: "retained", streamArn },
    { sequenceNumber: "999", shardId: "fully-trimmed", streamArn },
    {
      sequenceNumber: "complete",
      shardId: "initial-replay-complete",
      streamArn,
    },
    {
      sequenceNumber: "complete",
      shardId: "canonical-seed-complete",
      streamArn,
    },
  ];
  expect(
    replayTargetsForRetainedShards(
      checkpoints,
      [
        {
          factFamily: "traces",
          sequenceNumber: "90",
          shardId: "retained",
        },
      ],
      streamArn,
    ),
  ).toEqual([{ sequenceNumber: "100", shardId: "retained", streamArn }]);
});

test("fails reconciliation when any canonical trace total mismatches", () => {
  expect(
    reconciliationSucceeded([
      ["trace_id", "reconciled"],
      ["trace-1", "true"],
    ]),
  ).toBe(true);
  expect(
    reconciliationSucceeded([
      ["trace_id", "reconciled"],
      ["trace-1", "false"],
    ]),
  ).toBe(false);
});

test("compares the immutable export with target ClickHouse facts", () => {
  const sql = targetReconciliationSql(
    "agent-observability-backups",
    "rebuild/20260803T000000Z-test/",
  );
  expect(sql).toContain("FROM s3(observability_rebuild, filename = '20260803T000000Z-test/*')");
  expect(sql).toContain("FROM observability.facts");
  expect(sql).toContain("payload_mismatch_count");
  expect(sql).toContain("fact_type IN ('trace.finalized', 'record.deleted')");
  expect(sql).toContain(
    "fact_type = 'span.finalized' AND JSONExtractString(payload_json, 'kind') = 'run'",
  );
  const reconciled = {
    missing_count: 0,
    payload_mismatch_count: 0,
    source_count: 10,
    source_normalized_watermark: 1000,
    source_trace_cost: 7,
    source_trace_tokens: 12,
    target_count: 10,
    target_normalized_watermark: 1000,
    target_trace_cost: 7,
    target_trace_tokens: 12,
  };
  expect(targetReconciliationSucceeded(reconciled)).toBe(true);
  expect(targetReconciliationSucceeded({ ...reconciled, missing_count: 1 })).toBe(false);
});

test("builds a bounded immutable Parquet rebuild export", () => {
  expect(
    unloadSql("SELECT * FROM canonical_rebuild;", "agent-observability-backups", "rebuild/test/"),
  ).toBe(
    "UNLOAD (SELECT * FROM canonical_rebuild) TO 's3://agent-observability-backups/rebuild/test/' WITH (format = 'PARQUET', compression = 'SNAPPY')",
  );
});

test("imports through a staging table before atomically replacing live facts", () => {
  const sql = importSql(
    "agent-observability-backups",
    "rebuild/20260803T000000Z-test/",
    "20260803T000000Z-test",
  );
  expect(sql).toContain("CREATE TABLE observability.facts_rebuild AS observability.facts");
  expect(sql).toContain("INSERT INTO observability.facts_rebuild");
  expect(sql).toContain("parseDateTime64BestEffort(projected_at, 3, 'UTC'), payload_json");
  expect(sql).toContain("FROM s3(observability_rebuild, filename = '20260803T000000Z-test/*')");
  expect(sql).toContain("EXCHANGE TABLES observability.facts AND observability.facts_rebuild");
  expect(sql).toContain("VALUES ('20260803T000000Z-test', now64(3))");
  expect(sql).not.toContain("TRUNCATE TABLE observability.facts");
});

test("derives final continuity evidence from the immutable export", () => {
  const sql = exportWatermarkSql("agent-observability-backups", "rebuild/20260803T000000Z-test/");
  expect(sql).toContain("FROM s3(observability_rebuild, filename = '20260803T000000Z-test/*')");
  expect(sql).toContain("projection_sequence_watermark");
  expect(
    exportWatermarkRows(
      `${JSON.stringify({
        fact_family: "traces",
        projection_sequence_watermark: "100",
        projection_shard_id: "shard-1",
        projection_stream_arn: "arn:stream",
      })}\n`,
    ),
  ).toEqual([
    [
      "fact_family",
      "projection_stream_arn",
      "projection_shard_id",
      "projection_sequence_watermark",
    ],
    ["traces", "arn:stream", "shard-1", "100"],
  ]);
});

test("accepts only this writer's checkpoint keys for rebuild clearing", () => {
  expect(
    checkpointDeleteKey({
      consumer: { S: "observability-hot-writer-v1" },
      shard: { S: "shardId-000000000001" },
    }),
  ).toEqual({
    consumer: { S: "observability-hot-writer-v1" },
    shard: { S: "shardId-000000000001" },
  });
  expect(() =>
    checkpointDeleteKey({
      consumer: { S: "another-consumer" },
      shard: { S: "shardId-000000000001" },
    }),
  ).toThrow("malformed observability checkpoint key");
});
