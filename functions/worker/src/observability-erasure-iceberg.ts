/* eslint-disable no-await-in-loop -- Iceberg purge steps are ordered and budgeted per invocation. */

import {
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
  type AthenaClient,
} from "@aws-sdk/client-athena";
import type {
  ConversationErasureScope,
  IcebergTableProgress,
  IcebergTableStep,
} from "./observability-erasure-contract.ts";

export interface IcebergErasureTable {
  /** Table name reported in the receipt (for example `spans`). */
  readonly name: string;
  /** Trusted, fully qualified and quoted Athena reference. */
  readonly reference: string;
}

export interface IcebergErasureConfig {
  readonly maxCommitRetries: number;
  readonly pollIntervalMs: number;
  readonly tables: readonly IcebergErasureTable[];
  readonly workgroup: string;
}

export interface IcebergErasureUnit {
  readonly progressKey: string;
  readonly predicate: string;
  readonly table: IcebergErasureTable;
}

export interface IcebergErasureRuntime {
  readonly athena: Pick<AthenaClient, "send">;
  /** True while enough invocation time remains to start or keep waiting on a query. */
  readonly hasBudget: () => boolean;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

type QueryOutcome =
  | { readonly kind: "failed"; readonly reason: string; readonly retryableConflict: boolean }
  | { readonly kind: "running" }
  | { readonly kind: "succeeded" };

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
// Keeps each statement far below Athena's 262,144-byte query limit.
const SCOPE_BATCH_SIZE = 1_000;
const COMMIT_CONFLICT_PATTERN =
  /ICEBERG_COMMIT_ERROR|CommitFailedException|ConcurrentModificationException|commit conflict|conflicting/iu;
const TABLE_REFERENCE_PATTERN = /^"[^"]+"\."[^"]+"\."[^"]+"$/u;

export function icebergErasureTables(raw: string): readonly IcebergErasureTable[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Iceberg erasure tables must be a JSON object of table name to reference.");
  }
  const tables = Object.entries(parsed as Record<string, unknown>).map(([name, reference]) => {
    if (!/^[a-z0-9_]+$/u.test(name) || typeof reference !== "string") {
      throw new Error(`Iceberg erasure table ${name} is invalid.`);
    }
    if (!TABLE_REFERENCE_PATTERN.test(reference)) {
      throw new Error(`Iceberg erasure table ${name} must be a quoted catalog.namespace.table.`);
    }
    return { name, reference };
  });
  if (tables.length === 0) throw new Error("Iceberg erasure requires at least one table.");
  return tables.toSorted((left, right) => left.name.localeCompare(right.name));
}

function ulidLiteral(id: string) {
  if (!ULID_PATTERN.test(id)) throw new Error("Erasure identifiers must be ULIDs.");
  return `'${id}'`;
}

function batches(ids: readonly string[]) {
  const result: (readonly string[])[] = [];
  for (let start = 0; start < ids.length; start += SCOPE_BATCH_SIZE) {
    result.push(ids.slice(start, start + SCOPE_BATCH_SIZE));
  }
  return result;
}

export function icebergErasureUnits(
  tables: readonly IcebergErasureTable[],
  organizationId: string,
  scope?: ConversationErasureScope,
): readonly IcebergErasureUnit[] {
  const organization = `organization_id = ${ulidLiteral(organizationId)}`;
  if (!scope) {
    return tables.map((table) => ({ predicate: organization, progressKey: table.name, table }));
  }
  const selections = [
    ...batches(scope.threadIds).map((ids, index) => ({
      column: "session_id",
      ids,
      label: `sessions-${index}`,
    })),
    ...batches(scope.runIds).map((ids, index) => ({
      column: "run_id",
      ids,
      label: `runs-${index}`,
    })),
  ];
  return tables.flatMap((table) =>
    selections.map((selection) => ({
      progressKey: `${table.name}-${selection.label}`,
      predicate: `${organization} AND ${selection.column} IN (${selection.ids.map(ulidLiteral).join(", ")})`,
      table,
    })),
  );
}

function statement(step: IcebergTableStep, unit: IcebergErasureUnit) {
  switch (step) {
    case "count":
    case "recount":
      return `SELECT count(*) AS row_count FROM ${unit.table.reference} WHERE ${unit.predicate}`;
    case "delete":
      return `DELETE FROM ${unit.table.reference} WHERE ${unit.predicate}`;
    case "complete":
      throw new Error("A completed Iceberg table has no erasure statement.");
  }
}

async function waitForQuery(
  queryExecutionId: string,
  runtime: IcebergErasureRuntime,
  pollIntervalMs: number,
): Promise<QueryOutcome> {
  for (;;) {
    const output = await runtime.athena.send(
      new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId }),
    );
    const status = output.QueryExecution?.Status;
    switch (status?.State) {
      case "SUCCEEDED":
        return { kind: "succeeded" };
      case "FAILED":
      case "CANCELLED": {
        const reason =
          status.AthenaError?.ErrorMessage ?? status.StateChangeReason ?? status.State ?? "unknown";
        return {
          kind: "failed",
          reason,
          retryableConflict:
            status.State === "FAILED" &&
            (COMMIT_CONFLICT_PATTERN.test(reason) ||
              COMMIT_CONFLICT_PATTERN.test(status.StateChangeReason ?? "")),
        };
      }
      default:
        if (!runtime.hasBudget()) return { kind: "running" };
        await runtime.sleep(pollIntervalMs);
    }
  }
}

async function rowCount(queryExecutionId: string, runtime: IcebergErasureRuntime) {
  const output = await runtime.athena.send(
    new GetQueryResultsCommand({ MaxResults: 2, QueryExecutionId: queryExecutionId }),
  );
  const value = output.ResultSet?.Rows?.[1]?.Data?.[0]?.VarCharValue;
  const count = value === undefined ? Number.NaN : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Athena count query ${queryExecutionId} returned no row count.`);
  }
  return count;
}

/**
 * Athena writes merge-on-read position deletes; S3 Tables
 * compaction rewrites the affected data files, and snapshot expiry plus
 * unreferenced-file removal then delete the superseded files.
 */
export async function advanceIcebergTable(input: {
  readonly config: IcebergErasureConfig;
  readonly operationId: string;
  readonly progress: IcebergTableProgress;
  readonly runtime: IcebergErasureRuntime;
  readonly unit: IcebergErasureUnit;
}): Promise<IcebergTableProgress> {
  const { config, operationId, runtime, unit } = input;
  let progress = input.progress;
  while (progress.step !== "complete") {
    let queryExecutionId = progress.queryExecutionId;
    if (!queryExecutionId) {
      if (!runtime.hasBudget()) return progress;
      const attempt = progress.attempt + 1;
      const output = await runtime.athena.send(
        new StartQueryExecutionCommand({
          // Deterministic token: a retry after a lost response re-attaches to
          // the same execution instead of submitting a second DELETE.
          ClientRequestToken: `observability-erasure-${operationId}-${unit.progressKey}-${attempt}`,
          QueryString: statement(progress.step, unit),
          WorkGroup: config.workgroup,
        }),
      );
      queryExecutionId = output.QueryExecutionId;
      if (!queryExecutionId) throw new Error("Athena returned no query execution ID.");
      progress = { ...progress, attempt, queryExecutionId };
    }
    const outcome = await waitForQuery(queryExecutionId, runtime, config.pollIntervalMs);
    if (outcome.kind === "running") return progress;
    const { queryExecutionId: _completed, ...settled } = progress;
    if (outcome.kind === "failed") {
      if (progress.step !== "delete" || !outcome.retryableConflict) {
        throw new Error(
          `Athena ${progress.step} for ${unit.progressKey} failed (${queryExecutionId}): ${outcome.reason}`,
        );
      }
      if (progress.conflicts >= config.maxCommitRetries) {
        throw new Error(
          `Athena ${progress.step} for ${unit.progressKey} hit ${progress.conflicts + 1} Iceberg commit conflicts.`,
        );
      }
      progress = { ...settled, conflicts: progress.conflicts + 1 };
      await runtime.sleep(config.pollIntervalMs * 2 ** Math.min(progress.conflicts, 3));
      continue;
    }
    switch (progress.step) {
      case "count": {
        const count = await rowCount(queryExecutionId, runtime);
        progress =
          count === 0
            ? { ...settled, conflicts: 0, step: "complete" }
            : { ...settled, conflicts: 0, pendingRows: count, step: "delete" };
        break;
      }
      case "delete":
        progress = {
          ...settled,
          conflicts: 0,
          pendingRows: 0,
          rowsDeleted: progress.rowsDeleted + progress.pendingRows,
          step: "recount",
        };
        break;
      case "recount": {
        const count = await rowCount(queryExecutionId, runtime);
        progress =
          count === 0
            ? { ...settled, conflicts: 0, step: "complete" }
            : { ...settled, conflicts: 0, pendingRows: count, step: "delete" };
        break;
      }
    }
  }
  return progress;
}
