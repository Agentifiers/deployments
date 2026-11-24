import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  athenaResultRows,
  assertProjectionFailureFencesClear,
  bashSsmCommand,
  CLICKHOUSE_ADMIN_CLIENT,
  eventSourceMappingState,
  namedQuery,
  reconciliationSucceeded,
  setEventSourceMappingEnabled,
  ssmCommand,
  startAthena,
  startService,
  stopService,
  waitForAthena,
  type HotOutputs,
} from "./observability-clickhouse-rebuild-aws.ts";
import {
  acquireRebuildLease,
  releaseRebuildLease,
} from "./observability-clickhouse-rebuild-lease.ts";
import {
  clearCheckpoints,
  coldHistoryOverlapsRetainedStream,
  markCanonicalSeed,
  projectorCoversRetainedStream,
  readCheckpoints,
  readProjectorCheckpoints,
  replayTargetsForRetainedShards,
  retainedStreamWindow,
  seedProjectorCheckpoints,
  waitForReplay,
} from "./observability-clickhouse-rebuild-replay.ts";
import {
  exportWatermarkSql,
  importSql,
  targetReconciliationSql,
  targetReconciliationSucceeded,
  unloadSql,
  type TargetReconciliation,
} from "./observability-clickhouse-rebuild-sql.ts";
import { json, safe } from "./observability-clickhouse-rebuild-support.ts";
import { tofuOutput, tofuRoot } from "./tofu-output.ts";

const PROJECTOR_DRAIN_MS = 8 * 60_000;
const DEFAULT_RECOVERY_TIMEOUT_HOURS = 2;
const USAGE =
  "Usage: bun scripts/observability-clickhouse-rebuild.ts --root <opentofu-root-dir> [--recovery-timeout-hours <hours>] [--execute]";

export { bashSsmCommand, reconciliationSucceeded } from "./observability-clickhouse-rebuild-aws.ts";
export { REBUILD_LEASE_KEY } from "./observability-clickhouse-rebuild-lease.ts";
export {
  checkpointDeleteKey,
  coldHistoryOverlapsRetainedStream,
  projectorCheckpointBootstrapTargets,
  projectorCoversRetainedStream,
  replayGateSatisfied,
  replayTargetsForRetainedShards,
} from "./observability-clickhouse-rebuild-replay.ts";
export {
  exportWatermarkSql,
  importSql,
  targetReconciliationSql,
  targetReconciliationSucceeded,
  unloadSql,
} from "./observability-clickhouse-rebuild-sql.ts";

interface ColdOutputs {
  readonly athena_workgroup_name: string;
  readonly backup_bucket: string;
  readonly clickhouse_rebuild_query_id: string;
  readonly fact_stream_arn: string;
  readonly failure_queue_urls: Readonly<Record<string, string>>;
  readonly projector_checkpoint_table: string;
  readonly projector_event_source_mapping_uuid: string;
  readonly rebuild_query_id: string;
  readonly reconciliation_query_id: string;
  readonly watermark_query_id: string;
}

export function remainingTimeoutSeconds(deadline: number, stage: string, now = Date.now()) {
  const remaining = Math.ceil((deadline - now) / 1_000);
  if (remaining <= 0) {
    throw new Error(`Observability rebuild timed out before ${stage}.`);
  }
  return remaining;
}

export function exportWatermarkRows(output: string) {
  const header = [
    "fact_family",
    "projection_stream_arn",
    "projection_shard_id",
    "projection_sequence_watermark",
  ] as const;
  const rows = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => json<Record<(typeof header)[number], string>>(line, "export watermark"));
  return [header, ...rows.map((row) => header.map((name) => row[name]))];
}

/** Parses the rebuild flags; the OpenTofu root names the deployment whose outputs drive it. */
export function parseRebuildCommand(args: readonly string[]) {
  const { values } = parseArgs({
    args: [...args],
    options: {
      execute: { type: "boolean" },
      "recovery-timeout-hours": { type: "string" },
      root: { type: "string" },
    },
  });
  const hours = Number(values["recovery-timeout-hours"] ?? DEFAULT_RECOVERY_TIMEOUT_HOURS);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(`--recovery-timeout-hours must be a positive number.\n${USAGE}`);
  }
  return {
    execute: values.execute === true,
    recoveryTimeoutSeconds: Math.round(hours * 60 * 60),
    root: tofuRoot(values.root, USAGE),
  };
}

async function main() {
  const { execute, recoveryTimeoutSeconds, root } = parseRebuildCommand(process.argv.slice(2));
  const hot = tofuOutput<HotOutputs>(root, "agent_observability_hot");
  const cold = tofuOutput<ColdOutputs>(root, "agent_observability");
  for (const [name, value] of Object.entries({ ...hot, ...cold })) {
    if (typeof value === "string") safe(value, name);
  }
  for (const [name, value] of Object.entries(cold.failure_queue_urls))
    safe(value, `${name} failure queue URL`);
  const [rebuildQuery, reconciliationQuery, watermarkQuery] = await Promise.all([
    namedQuery(cold.clickhouse_rebuild_query_id),
    namedQuery(cold.reconciliation_query_id),
    namedQuery(cold.watermark_query_id),
  ]);
  const rebuildId = `${new Date().toISOString().replaceAll(/[-:.]/gu, "")}-${randomUUID().slice(0, 8)}`;
  const prefix = `rebuild/${rebuildId}/`;
  if (!execute) {
    process.stdout.write(
      `${JSON.stringify({ action: "full-rebuild", bucket: hot.backup_bucket, instanceId: hot.instance_id, prefix, root }, null, 2)}\n`,
    );
    return;
  }

  const recoveryDeadline = Date.now() + recoveryTimeoutSeconds * 1_000;
  const leaseOwner = rebuildId;
  const leaseExpiresAtSeconds = Math.ceil((recoveryDeadline + 30 * 60_000) / 1_000);
  const remaining = (operation: string) => remainingTimeoutSeconds(recoveryDeadline, operation);
  let serviceStopped = false;
  let projectorPaused = false;
  await acquireRebuildLease(hot.checkpoint_table, leaseOwner, leaseExpiresAtSeconds);
  try {
    const projectorMapping = await eventSourceMappingState(
      cold.projector_event_source_mapping_uuid,
    );
    if (projectorMapping.State !== "Enabled") {
      throw new Error(
        `The canonical projector must be enabled before rebuild (state ${projectorMapping.State ?? "unknown"}).`,
      );
    }
    projectorPaused = true;
    await setEventSourceMappingEnabled(
      cold.projector_event_source_mapping_uuid,
      false,
      remaining("projector quiesce"),
    );
    if (remaining("projector delivery drain") * 1_000 <= PROJECTOR_DRAIN_MS) {
      throw new Error("Observability rebuild timed out before the projector delivery drain.");
    }
    await Bun.sleep(PROJECTOR_DRAIN_MS);
    const initialRetainedWindow = await retainedStreamWindow(
      cold.fact_stream_arn,
      remaining("retained-stream scan"),
    );
    const [existingProjectorCheckpoints, initialHotCheckpoints] = await Promise.all([
      readProjectorCheckpoints(cold.projector_checkpoint_table, cold.fact_stream_arn),
      readCheckpoints(hot.checkpoint_table),
    ]);
    await assertProjectionFailureFencesClear(cold.backup_bucket, cold.failure_queue_urls);
    const watermarkExecutionId = await startAthena(cold.athena_workgroup_name, watermarkQuery);
    await waitForAthena(watermarkExecutionId, remaining("cold-watermark query"));
    const watermarkRows = await athenaResultRows(watermarkExecutionId);
    const seededProjectorCheckpointCount = await seedProjectorCheckpoints(
      cold.projector_checkpoint_table,
      watermarkRows,
      existingProjectorCheckpoints,
      cold.fact_stream_arn,
    );
    const initialProjectorCheckpoints =
      seededProjectorCheckpointCount === 0
        ? existingProjectorCheckpoints
        : await readProjectorCheckpoints(cold.projector_checkpoint_table, cold.fact_stream_arn);
    if (
      !projectorCoversRetainedStream(
        initialProjectorCheckpoints,
        initialRetainedWindow.shardBoundaries,
        initialHotCheckpoints,
        cold.fact_stream_arn,
      )
    ) {
      throw new Error(
        "The canonical projector has not crossed every retained Kinesis shard boundary.",
      );
    }
    if (
      !coldHistoryOverlapsRetainedStream(
        watermarkRows,
        initialRetainedWindow.factStarts,
        cold.fact_stream_arn,
      )
    ) {
      throw new Error(
        "Cold observability history does not overlap every retained fact family and shard.",
      );
    }
    const executionId = await startAthena(
      cold.athena_workgroup_name,
      unloadSql(rebuildQuery, hot.backup_bucket, prefix),
    );
    await waitForAthena(executionId, remaining("immutable rebuild export"));
    const retainedWindow = await retainedStreamWindow(
      cold.fact_stream_arn,
      remaining("pre-outage retained-stream scan"),
    );
    const [projectorCheckpoints, hotCheckpoints] = await Promise.all([
      readProjectorCheckpoints(cold.projector_checkpoint_table, cold.fact_stream_arn),
      readCheckpoints(hot.checkpoint_table),
    ]);
    await assertProjectionFailureFencesClear(cold.backup_bucket, cold.failure_queue_urls);
    const immutableExportWatermarks = exportWatermarkRows(
      await ssmCommand(
        hot.instance_id,
        [
          bashSsmCommand([
            `${CLICKHOUSE_ADMIN_CLIENT} --format JSONEachRow <<'SQL'\n${exportWatermarkSql(hot.backup_bucket, prefix)}\nSQL`,
          ]),
        ],
        remaining("immutable export watermark query"),
      ),
    );
    if (
      !projectorCoversRetainedStream(
        projectorCheckpoints,
        retainedWindow.shardBoundaries,
        hotCheckpoints,
        cold.fact_stream_arn,
      )
    ) {
      throw new Error(
        "The canonical projector fell behind a retained Kinesis shard boundary during export.",
      );
    }
    if (
      !coldHistoryOverlapsRetainedStream(
        immutableExportWatermarks,
        retainedWindow.factStarts,
        cold.fact_stream_arn,
      )
    ) {
      throw new Error(
        "Kinesis retention advanced beyond the cold watermark during the rebuild export.",
      );
    }
    await stopService(hot);
    serviceStopped = true;
    const stoppedHotCheckpoints = await readCheckpoints(hot.checkpoint_table);
    await ssmCommand(
      hot.instance_id,
      [
        bashSsmCommand([
          `${CLICKHOUSE_ADMIN_CLIENT} --multiquery <<'SQL'\n${importSql(hot.backup_bucket, prefix, rebuildId)}\nSQL`,
        ]),
      ],
      remaining("ClickHouse import"),
    );
    const postImportRetainedWindow = await retainedStreamWindow(
      cold.fact_stream_arn,
      remaining("post-import retained-stream scan"),
    );
    if (
      !coldHistoryOverlapsRetainedStream(
        immutableExportWatermarks,
        postImportRetainedWindow.factStarts,
        cold.fact_stream_arn,
      )
    ) {
      throw new Error(
        "Kinesis retention advanced beyond the immutable export during the offline import.",
      );
    }
    const replayTargets = replayTargetsForRetainedShards(
      stoppedHotCheckpoints,
      postImportRetainedWindow.factStarts,
      cold.fact_stream_arn,
    );
    await clearCheckpoints(hot.checkpoint_table);
    await startService(hot);
    await waitForReplay(
      hot.checkpoint_table,
      replayTargets,
      cold.fact_stream_arn,
      remaining("Kinesis replay"),
      false,
    );
    const targetReconciliation = json<TargetReconciliation>(
      (
        await ssmCommand(
          hot.instance_id,
          [
            bashSsmCommand([
              `${CLICKHOUSE_ADMIN_CLIENT} --format JSONEachRow <<'SQL'\n${targetReconciliationSql(hot.backup_bucket, prefix)}\nSQL`,
            ]),
          ],
          remaining("ClickHouse target reconciliation"),
        )
      ).trim(),
      "ClickHouse target reconciliation",
    );
    if (!targetReconciliationSucceeded(targetReconciliation)) {
      throw new Error("Rebuilt ClickHouse facts do not match the immutable cold export.");
    }
    const reconciliationExecutionId = await startAthena(
      cold.athena_workgroup_name,
      reconciliationQuery,
    );
    await waitForAthena(reconciliationExecutionId, remaining("cold-history reconciliation"));
    const reconciliationRows = await athenaResultRows(reconciliationExecutionId);
    if (!reconciliationSucceeded(reconciliationRows)) {
      throw new Error("Cold trace and usage reconciliation reported mismatches.");
    }
    await markCanonicalSeed(hot.checkpoint_table, cold.fact_stream_arn, rebuildId);
    await waitForReplay(
      hot.checkpoint_table,
      replayTargets,
      cold.fact_stream_arn,
      remaining("canonical seed readiness"),
      true,
    );
    process.stdout.write(
      `${JSON.stringify({ checkpointMode: "trim-horizon", executionId, prefix, reconciliationExecutionId, replayTargetCount: replayTargets.length, retainedShardStartCount: postImportRetainedWindow.factStarts.length, root, status: "complete", targetReconciliation, watermarkExecutionId, watermarkRowCount: Math.max(0, watermarkRows.length - 1) }, null, 2)}\n`,
    );
    serviceStopped = false;
  } finally {
    try {
      try {
        if (serviceStopped) {
          process.stderr.write(
            "Rebuild failed after stopping the hot-plane service; forcing desired count back to zero.\n",
          );
          await stopService(hot);
          process.stderr.write(
            "The hot-plane service remains stopped to prevent stale checkpoints from skipping facts. Repair or rerun the rebuild before starting it.\n",
          );
        }
      } finally {
        if (projectorPaused) {
          await setEventSourceMappingEnabled(cold.projector_event_source_mapping_uuid, true, 600);
        }
      }
    } finally {
      if (!(await releaseRebuildLease(hot.checkpoint_table, leaseOwner))) {
        process.stderr.write(
          "The rebuild lease expired or changed ownership before release; it was left untouched.\n",
        );
      }
    }
  }
}

if (import.meta.main) {
  main().catch((cause: unknown) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
