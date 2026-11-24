import type { Ulid } from "@deployments-ai/db/ids";
import { QueryProblem } from "./api-query.ts";
import { ClickHouseTimeoutError, type ClickHouseExecutor } from "./clickhouse.ts";
import type { WriterCatchUp } from "./writer-catch-up.ts";

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
// The erasure Lambda waits on this endpoint synchronously; keep the
// `mutations_sync` wait well under its HTTP budget and report `pending`
// instead of holding the request while ClickHouse finishes the mutation.
const DEFAULT_MUTATION_TIMEOUT_MS = 20_000;
// Facts produced for an organization before its erasure's drain anchor (the
// canonical-deletion time) reach Kinesis within the normalizer's iterator-age
// bound, which the erasure Lambda gates at 120 seconds. The writer must have
// consumed every shard past the anchor plus this margin before a purge, so no
// such fact can be inserted after the delete. The margin does not depend on
// Firehose, which feeds Iceberg, not ClickHouse.
export const ERASURE_DRAIN_MARGIN_MS = 300_000;

// Keeps each mutation's `param_ids` well inside ClickHouse's 1 MiB HTTP URI limit.
const SCOPE_BATCH_SIZE = 1_000;

// Views expose `organization_id` too but hold no data; only MergeTree-family
// tables store rows and accept `ALTER TABLE … DELETE`.
const ERASURE_TABLES_SQL = `SELECT columns.table AS table
FROM system.columns AS columns
WHERE columns.database = 'observability'
  AND columns.name IN {columns:Array(String)}
  AND columns.table IN (
    SELECT name FROM system.tables WHERE database = 'observability' AND engine LIKE '%MergeTree'
  )
GROUP BY columns.table
HAVING count() = length({columns:Array(String)})
ORDER BY table`;

// ClickHouse stores the parameter-substituted command text, so an
// organization's delete mutation always contains the literal ULID.
const UNFINISHED_MUTATIONS_SQL = `SELECT table, mutation_id, latest_fail_reason
FROM system.mutations
WHERE database = 'observability'
  AND is_done = 0
  AND position(command, {organization:String}) > 0`;

export interface ConversationErasureScope {
  readonly kind: "conversation";
  readonly runIds: readonly Ulid[];
  readonly threadIds: readonly Ulid[];
}

type ErasureColumn = "organization_id" | "run_id" | "session_id";

export interface OrganizationErasureRequest {
  /** Canonical-deletion time of the erasure operation (canonical ISO-8601). */
  readonly drainAnchorAt: string;
  readonly operationId: string;
  readonly organizationId: string;
  readonly scope?: ConversationErasureScope;
}

interface Selection {
  readonly parameters: Readonly<Record<string, string>>;
  readonly where: string;
}

interface Purge {
  readonly organizationId: string;
  readonly scope: ConversationErasureScope | undefined;
}

interface OrganizationErasureTable {
  readonly rowsDeleted: number;
  readonly table: string;
}

type OrganizationErasureOutcome =
  | {
      readonly rowsDeleted: number;
      readonly status: "complete";
      readonly tables: readonly OrganizationErasureTable[];
      readonly verifiedAt: string;
    }
  | {
      readonly reason: "mutation_running";
      readonly remainingRows: number;
      readonly status: "pending";
    }
  | { readonly reason: "writer_catching_up"; readonly status: "pending" }
  | { readonly status: "conversation_erasure_not_running" }
  | { readonly status: "fence_missing" };

export interface OrganizationErasureDependencies {
  /** Executor whose user holds ALTER DELETE on `observability.*` and SELECT on `system.mutations`. */
  readonly clickhouse: ClickHouseExecutor;
  readonly conversationErasureRunning: (
    organizationId: string,
    operationId: string,
  ) => Promise<boolean>;
  readonly mutationTimeoutMs?: number;
  readonly now?: () => Date;
  readonly readErasureFence: (
    organizationId: string,
  ) => Promise<{ readonly operationId: string } | undefined>;
  /** Hot-writer progress; erasure purges only once it covers the drain anchor plus margin. */
  readonly writerCatchUp: Pick<WriterCatchUp, "caughtUpThrough">;
}

export interface OrganizationErasure {
  readonly erase: (request: OrganizationErasureRequest) => Promise<OrganizationErasureOutcome>;
}

export function parseOrganizationErasureRequest(body: string): OrganizationErasureRequest {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new QueryProblem(400, "invalid_erasure_request", "The erasure request must be JSON.");
  }
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const { drainAnchorAt, operationId, organizationId, scope } = candidate;
  if (
    typeof operationId !== "string" ||
    typeof organizationId !== "string" ||
    !ULID_PATTERN.test(operationId) ||
    !ULID_PATTERN.test(organizationId)
  ) {
    throw new QueryProblem(
      400,
      "invalid_erasure_request",
      "organizationId and operationId must be canonical ULIDs.",
    );
  }
  const anchor = typeof drainAnchorAt === "string" ? new Date(drainAnchorAt) : undefined;
  if (!anchor || !Number.isFinite(anchor.getTime()) || anchor.toISOString() !== drainAnchorAt) {
    throw new QueryProblem(
      400,
      "invalid_erasure_request",
      "drainAnchorAt must be a canonical ISO-8601 timestamp.",
    );
  }
  const request = { drainAnchorAt, operationId, organizationId };
  return scope === undefined ? request : { ...request, scope: parseScope(scope) };
}

function ulids(value: unknown): value is readonly Ulid[] {
  return (
    Array.isArray(value) && value.every((id) => typeof id === "string" && ULID_PATTERN.test(id))
  );
}

function parseScope(value: unknown): ConversationErasureScope {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const { kind, runIds, threadIds } = candidate;
  if (kind !== "conversation" || !ulids(runIds) || !ulids(threadIds)) {
    throw new QueryProblem(
      400,
      "invalid_erasure_request",
      "scope must be a conversation scope whose threadIds and runIds are canonical ULIDs.",
    );
  }
  return { kind, runIds, threadIds };
}

function batches(ids: readonly Ulid[]) {
  const result: (readonly Ulid[])[] = [];
  for (let start = 0; start < ids.length; start += SCOPE_BATCH_SIZE) {
    result.push(ids.slice(start, start + SCOPE_BATCH_SIZE));
  }
  return result;
}

function arrayParameter(values: readonly (Ulid | ErasureColumn)[]) {
  return `[${values.map((value) => `'${value}'`).join(",")}]`;
}

function selections({ organizationId, scope }: Purge): readonly Selection[] {
  const organization = "organization_id = {organization:String}";
  if (!scope) return [{ parameters: { organization: organizationId }, where: organization }];
  const byColumn = (column: Exclude<ErasureColumn, "organization_id">, ids: readonly Ulid[]) =>
    batches(ids).map((batch) => ({
      parameters: { ids: arrayParameter(batch), organization: organizationId },
      where: `${organization} AND ${column} IN {ids:Array(String)}`,
    }));
  return [...byColumn("session_id", scope.threadIds), ...byColumn("run_id", scope.runIds)];
}

async function erasureTables(clickhouse: ClickHouseExecutor, { scope }: Purge) {
  const columns: readonly ErasureColumn[] = scope
    ? ["organization_id", "run_id", "session_id"]
    : ["organization_id"];
  const rows = await clickhouse.query<{ table?: unknown }>(ERASURE_TABLES_SQL, {
    columns: arrayParameter(columns),
  });
  return rows.map((row) => {
    if (typeof row.table !== "string" || !row.table) {
      throw new Error("ClickHouse returned an invalid organization table name.");
    }
    return row.table;
  });
}

async function selectedRows(clickhouse: ClickHouseExecutor, table: string, selection: Selection) {
  const [row] = await clickhouse.query<{ rows?: unknown }>(
    `SELECT count() AS rows FROM observability.{table:Identifier}
     WHERE ${selection.where}`,
    { ...selection.parameters, table },
  );
  // JSONEachRow quotes UInt64 values by default.
  const rows = Number(row?.rows);
  if (!Number.isSafeInteger(rows) || rows < 0) {
    throw new Error("ClickHouse returned an invalid organization row count.");
  }
  return rows;
}

async function remainingRows(
  clickhouse: ClickHouseExecutor,
  tables: readonly string[],
  purge: Purge,
) {
  let remaining = 0;
  for (const table of tables) {
    for (const selection of selections(purge)) {
      remaining += await selectedRows(clickhouse, table, selection);
    }
  }
  return remaining;
}

async function hasUnfinishedMutation(clickhouse: ClickHouseExecutor, organizationId: string) {
  const mutations = await clickhouse.query<{
    latest_fail_reason?: unknown;
    mutation_id?: unknown;
    table?: unknown;
  }>(UNFINISHED_MUTATIONS_SQL, { organization: organizationId });
  for (const mutation of mutations) {
    if (typeof mutation.latest_fail_reason === "string" && mutation.latest_fail_reason) {
      console.error("Observability organization erasure mutation is failing.", {
        mutationId: mutation.mutation_id,
        reason: mutation.latest_fail_reason.slice(0, 512),
        table: mutation.table,
      });
    }
  }
  return mutations.length > 0;
}

async function deleteRows(
  dependencies: OrganizationErasureDependencies,
  purge: Purge,
): Promise<OrganizationErasureOutcome> {
  const { clickhouse } = dependencies;
  const { organizationId } = purge;
  const tables = await erasureTables(clickhouse, purge);
  // Never stack a second delete mutation on one that is still running.
  if (await hasUnfinishedMutation(clickhouse, organizationId)) {
    return {
      remainingRows: await remainingRows(clickhouse, tables, purge),
      reason: "mutation_running",
      status: "pending",
    };
  }
  const deletedByTable = new Map<string, number>();
  const targets = tables.flatMap((table) =>
    selections(purge).map((selection) => ({ selection, table })),
  );
  for (const { selection, table } of targets) {
    const rows = await selectedRows(clickhouse, table, selection);
    if (rows === 0) continue;
    deletedByTable.set(table, (deletedByTable.get(table) ?? 0) + rows);
    try {
      await clickhouse.execute(
        `ALTER TABLE observability.{table:Identifier}
         DELETE WHERE ${selection.where}
         SETTINGS mutations_sync = 2`,
        { ...selection.parameters, table },
        { timeoutMs: dependencies.mutationTimeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS },
      );
    } catch (cause) {
      // The mutation is durable once accepted and keeps running after the
      // client stops waiting; verification below reports it as pending.
      if (!(cause instanceof ClickHouseTimeoutError)) throw cause;
      break;
    }
  }
  const remaining = await remainingRows(clickhouse, tables, purge);
  if (remaining > 0 || (await hasUnfinishedMutation(clickhouse, organizationId))) {
    return { reason: "mutation_running", remainingRows: remaining, status: "pending" };
  }
  const deletedTables = tables.map((table) => ({
    rowsDeleted: deletedByTable.get(table) ?? 0,
    table,
  }));
  return {
    rowsDeleted: deletedTables.reduce((total, table) => total + table.rowsDeleted, 0),
    status: "complete",
    tables: deletedTables,
    verifiedAt: (dependencies.now?.() ?? new Date()).toISOString(),
  };
}

export function createOrganizationErasure(
  dependencies: OrganizationErasureDependencies,
): OrganizationErasure {
  const inFlight = new Set<string>();
  return {
    async erase({ drainAnchorAt, operationId, organizationId, scope }) {
      if (scope) {
        if (!(await dependencies.conversationErasureRunning(organizationId, operationId))) {
          return { status: "conversation_erasure_not_running" };
        }
      } else {
        const fence = await dependencies.readErasureFence(organizationId);
        if (fence?.operationId !== operationId) return { status: "fence_missing" };
      }
      const purge = { organizationId, scope };
      // Purge only once the writer has inserted every fact Kinesis accepted
      // through the anchor plus margin; otherwise a fact still in the stream
      // would be inserted after the delete and survive the erasure.
      const now = (dependencies.now?.() ?? new Date()).getTime();
      const caughtUpThrough = dependencies.writerCatchUp.caughtUpThrough(now);
      if (
        caughtUpThrough === undefined ||
        caughtUpThrough <= Date.parse(drainAnchorAt) + ERASURE_DRAIN_MARGIN_MS
      ) {
        return { reason: "writer_catching_up", status: "pending" };
      }
      // A retried request must not race the original into a second mutation.
      if (inFlight.has(organizationId)) {
        const tables = await erasureTables(dependencies.clickhouse, purge);
        return {
          reason: "mutation_running",
          remainingRows: await remainingRows(dependencies.clickhouse, tables, purge),
          status: "pending",
        };
      }
      inFlight.add(organizationId);
      try {
        return await deleteRows(dependencies, purge);
      } finally {
        inFlight.delete(organizationId);
      }
    },
  };
}
