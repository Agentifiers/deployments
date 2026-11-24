import { finished } from "node:stream/promises";
import { to as copyTo } from "pg-copy-streams";
import { fromPostgresError } from "./errors.ts";
import type { AppDatabaseLimits } from "./limits.ts";
import type { AppId } from "./names.ts";
import type { AppObjectStore } from "./ports.ts";
import { exportPrefix, type ExportId, type ExportResult } from "./protocol.ts";
import { withAppSession, type AppConnectionPools } from "./session.ts";

export interface ExportInput {
  readonly appId: AppId;
  readonly bucket: string;
  readonly exportId: ExportId;
}

export async function exportTables(
  context: {
    readonly pools: AppConnectionPools;
    readonly limits: AppDatabaseLimits;
    readonly objectStore: AppObjectStore;
  },
  input: ExportInput,
): Promise<ExportResult> {
  const deadline = Date.now() + context.limits.exportDeadlineMs;
  return withAppSession(context.pools, input.appId, "owner", (session) =>
    session.transaction(
      {
        access: "read only",
        deadlineMs: Math.max(1, deadline - Date.now()),
        graceMs: context.limits.graceMs,
        isolation: "repeatable read",
        settings: { row_security: "off", search_path: "pg_catalog" },
      },
      async (client) => {
        const prefix = exportPrefix(input.appId, input.exportId);
        const tables = await client.query<{ name: string; qualified: string }>(
          `SELECT c.relname AS name, c.oid::regclass::text AS qualified
           FROM pg_class c
           WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
           ORDER BY c.relname`,
        );
        const objects: Array<ExportResult["objects"][number]> = [];
        for (const table of tables.rows) {
          const statement = `COPY ${table.qualified} TO STDOUT WITH (FORMAT csv, HEADER true)`;
          const key = `${prefix}/${encodeURIComponent(table.name)}.csv`;
          const stream = client.query(copyTo(statement));
          let copyFailure: unknown;
          stream.on("error", (error) => {
            copyFailure ??= error;
          });
          try {
            await context.objectStore.putObject({
              body: stream,
              bucket: input.bucket,
              contentType: "text/csv; charset=utf-8",
              key,
            });
          } catch (error) {
            // The connection stays busy until COPY finishes, so drain it before the rollback.
            stream.resume();
            await finished(stream).catch(() => undefined);
            throw copyFailure === undefined ? error : fromPostgresError(copyFailure, statement);
          }
          objects.push({ key, rows: stream.rowCount, table: table.name });
        }
        return { objects };
      },
    ),
  );
}
