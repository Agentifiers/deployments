/* eslint-disable no-await-in-loop -- purge phases are ordered and budgeted per invocation. */

import type { AthenaClient } from "@aws-sdk/client-athena";
import type { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { observabilityErasureFence } from "@deployments-ai/db";
import {
  canonicalTimestamp,
  decodeObservabilityErasureRequest,
  initialIcebergTableProgress,
  initialObservabilityErasureProgress,
  type ObservabilityErasurePendingReason,
  type ObservabilityErasureProgress,
  type ObservabilityErasureRequest,
  type ObservabilityErasureResponse,
} from "./observability-erasure-contract.ts";
import {
  observabilityPipelineDrained,
  type ObservabilityDrainConfig,
} from "./observability-erasure-drain.ts";
import type { HotPlaneErasureClient } from "./observability-erasure-hot-plane.ts";
import {
  advanceIcebergTable,
  icebergErasureUnits,
  type IcebergErasureConfig,
} from "./observability-erasure-iceberg.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Retention settings pinned in OpenTofu that bound residual physical copies. */
interface ObservabilityRemovalBounds {
  readonly clickhouseNativeBackupDays: number;
  readonly clickhouseSnapshotDays: number;
  readonly icebergNoncurrentFileDays: number;
  readonly icebergSnapshotMaxAgeHours: number;
  readonly icebergUnreferencedFileDays: number;
}

export interface ObservabilityErasureConfig {
  readonly controlTable: string;
  readonly drain: ObservabilityDrainConfig;
  readonly hotPlanePollIntervalMs: number;
  readonly hotPlaneRequestTimeoutMs: number;
  readonly iceberg: IcebergErasureConfig;
  readonly removal: ObservabilityRemovalBounds;
  /** Invocation time kept in reserve to return progress before the Lambda deadline. */
  readonly safetyMarginMs: number;
}

export interface ObservabilityErasureDependencies {
  readonly athena: Pick<AthenaClient, "send">;
  readonly cloudwatch: Pick<CloudWatchClient, "send">;
  readonly dynamodb: DynamoDBClient;
  /** Absent when the ClickHouse hot plane is not deployed. */
  readonly hotPlane?: HotPlaneErasureClient;
  readonly now: () => Date;
  readonly remainingTimeMs: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

function pending(
  reason: ObservabilityErasurePendingReason,
  progress: ObservabilityErasureProgress,
): ObservabilityErasureResponse {
  return { progress, reason, status: "pending" };
}

async function authorize(
  request: ObservabilityErasureRequest,
  config: ObservabilityErasureConfig,
  dependencies: ObservabilityErasureDependencies,
) {
  const { operationId, organizationId } = request;
  if (request.scope) {
    const running = await observabilityErasureFence.conversationErasureRunning(
      dependencies.dynamodb,
      config.controlTable,
      organizationId,
      operationId,
    );
    if (!running) {
      throw new Error(
        `Operation ${operationId} is not a running conversation erasure of organization ${organizationId}.`,
      );
    }
    return;
  }
  const fence = await observabilityErasureFence.read(
    dependencies.dynamodb,
    config.controlTable,
    organizationId,
  );
  if (fence?.operationId !== operationId) {
    throw new Error(
      `Organization ${organizationId} is not fenced for erasure operation ${operationId}.`,
    );
  }
}

export async function runObservabilityErasure(
  input: unknown,
  config: ObservabilityErasureConfig,
  dependencies: ObservabilityErasureDependencies,
): Promise<ObservabilityErasureResponse> {
  const request = decodeObservabilityErasureRequest(input);
  await authorize(request, config, dependencies);
  let progress = request.progress ?? initialObservabilityErasureProgress();

  if (!progress.drainedAt) {
    const now = dependencies.now();
    const drained = await observabilityPipelineDrained({
      anchor: new Date(request.drainAnchorAt),
      cloudwatch: dependencies.cloudwatch,
      config: config.drain,
      now,
    });
    if (!drained) return pending("pipeline_draining", progress);
    progress = { ...progress, drainedAt: canonicalTimestamp(now) };
  }

  const hotPlane = dependencies.hotPlane;
  // Until the hot plane reports its writer caught up past the anchor, the
  // pipeline into ClickHouse is still draining.
  let clickhouseReason: ObservabilityErasurePendingReason = "clickhouse_purge_running";
  while (!progress.clickhouse.verifiedAt) {
    if (!hotPlane) {
      // No hot plane is deployed, so no ClickHouse copy of the organization exists.
      progress = {
        ...progress,
        clickhouse: { ...progress.clickhouse, verifiedAt: canonicalTimestamp(dependencies.now()) },
      };
      break;
    }
    if (dependencies.remainingTimeMs() < config.safetyMarginMs + config.hotPlaneRequestTimeoutMs) {
      return pending(clickhouseReason, progress);
    }
    const result = await hotPlane.erase({
      drainAnchorAt: canonicalTimestamp(request.drainAnchorAt),
      operationId: request.operationId,
      organizationId: request.organizationId,
      scope: request.scope,
      timeoutMs: config.hotPlaneRequestTimeoutMs,
    });
    if (result.status === "complete") {
      // A mutation reported as pending is not re-reported by the completing
      // request, so the largest pending remainder is added to the total.
      progress = {
        ...progress,
        clickhouse: {
          pendingRows: 0,
          rowsDeleted:
            progress.clickhouse.rowsDeleted + progress.clickhouse.pendingRows + result.rowsDeleted,
          verifiedAt: canonicalTimestamp(result.verifiedAt),
        },
      };
      break;
    }
    if (result.reason === "mutation_running") {
      clickhouseReason = "clickhouse_purge_running";
      progress = {
        ...progress,
        clickhouse: {
          ...progress.clickhouse,
          pendingRows: Math.max(progress.clickhouse.pendingRows, result.remainingRows),
        },
      };
    } else {
      clickhouseReason = "pipeline_draining";
    }
    if (
      dependencies.remainingTimeMs() <
      config.safetyMarginMs + config.hotPlaneRequestTimeoutMs + config.hotPlanePollIntervalMs
    ) {
      return pending(clickhouseReason, progress);
    }
    await dependencies.sleep(config.hotPlanePollIntervalMs);
  }

  const runtime = {
    athena: dependencies.athena,
    hasBudget: () => dependencies.remainingTimeMs() > config.safetyMarginMs,
    sleep: dependencies.sleep,
  };
  const units = icebergErasureUnits(config.iceberg.tables, request.organizationId, request.scope);
  for (const unit of units) {
    const unitProgress = await advanceIcebergTable({
      config: config.iceberg,
      operationId: request.operationId,
      progress: progress.iceberg.tables[unit.progressKey] ?? initialIcebergTableProgress(),
      runtime,
      unit,
    });
    progress = {
      ...progress,
      iceberg: { tables: { ...progress.iceberg.tables, [unit.progressKey]: unitProgress } },
    };
    if (unitProgress.step !== "complete") return pending("iceberg_purge_running", progress);
  }

  const clickhouseVerifiedAt = progress.clickhouse.verifiedAt;
  if (!clickhouseVerifiedAt) throw new Error("ClickHouse absence was not verified.");
  const icebergVerifiedAt = dependencies.now().getTime();
  const { removal } = config;
  const tables = config.iceberg.tables.map((table) => ({
    rowsDeleted: units
      .filter((unit) => unit.table.name === table.name)
      .reduce(
        (total, unit) => total + (progress.iceberg.tables[unit.progressKey]?.rowsDeleted ?? 0),
        0,
      ),
    table: table.name,
  }));
  return {
    receipt: {
      clickhouse: {
        absenceVerifiedAt: clickhouseVerifiedAt,
        rowsDeleted: progress.clickhouse.rowsDeleted,
      },
      clickhouseBackupsExpireBy: canonicalTimestamp(
        Date.parse(clickhouseVerifiedAt) +
          Math.max(removal.clickhouseNativeBackupDays, removal.clickhouseSnapshotDays) * DAY_MS,
      ),
      iceberg: {
        absenceVerifiedAt: canonicalTimestamp(icebergVerifiedAt),
        // DELETE writes position deletes; the data files holding the rows are
        // rewritten only once S3 Tables managed compaction applies them, which
        // the platform cannot observe. From that rewrite, snapshots that still
        // reference the old files expire after the snapshot age, and the files
        // then become unreferenced, noncurrent, and deleted by table-bucket
        // maintenance. This bound covers those pinned maintenance windows.
        physicalRemovalBy: canonicalTimestamp(
          icebergVerifiedAt +
            removal.icebergSnapshotMaxAgeHours * HOUR_MS +
            (removal.icebergUnreferencedFileDays + removal.icebergNoncurrentFileDays) * DAY_MS,
        ),
        rowsDeleted: tables.reduce((total, table) => total + table.rowsDeleted, 0),
        tables,
      },
      operationId: request.operationId,
    },
    status: "complete",
  };
}
