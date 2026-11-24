import type pg from "pg";
import Cursor from "pg-cursor";
import { fromPostgresError } from "./errors.ts";
import type { AppDatabaseLimits } from "./limits.ts";
import type { AppId } from "./names.ts";
import type { QueryResult } from "./protocol.ts";
import { withAppSession, type AppConnectionPools } from "./session.ts";
import { parseSingleQuery } from "./sql-policy.ts";

export interface QueryInput {
  readonly appId: AppId;
  readonly sql: string;
  readonly maxRows: number;
}

const TEXT_VALUES: pg.CustomTypesConfig = {
  getTypeParser: () => (value: string) => value,
};

interface CursorPage {
  readonly rows: Array<Array<string | null>>;
  readonly fields: pg.FieldDef[];
}

function readCursor(cursor: Cursor<Array<string | null>>, count: number) {
  const { promise, reject, resolve } = Promise.withResolvers<CursorPage>();
  cursor.read(count, (error, rows, result) => {
    if (error) reject(error);
    else resolve({ fields: result.fields, rows });
  });
  return promise;
}

export async function query(
  context: { readonly pools: AppConnectionPools; readonly limits: AppDatabaseLimits },
  input: QueryInput,
): Promise<QueryResult> {
  const statement = await parseSingleQuery(input.sql);
  return withAppSession(context.pools, input.appId, "viewer", (session) =>
    session.transaction(
      {
        access: "read only",
        deadlineMs: context.limits.queryDeadlineMs,
        graceMs: context.limits.graceMs,
      },
      async (client) => {
        const cursor = client.query(
          new Cursor<Array<string | null>>(statement.text, [], {
            rowMode: "array",
            types: TEXT_VALUES,
          }),
        );
        let read: CursorPage;
        try {
          read = await readCursor(cursor, input.maxRows + 1);
          await cursor.close();
        } catch (error) {
          throw fromPostgresError(error, statement.text);
        }
        const typeNames = await client.query<{ oid: number; name: string }>(
          "SELECT oid::int8::float8 AS oid, pg_catalog.format_type(oid, NULL) AS name FROM pg_catalog.pg_type WHERE oid = ANY($1::oid[])",
          [read.fields.map((field) => field.dataTypeID)],
        );
        const nameByOid = new Map(typeNames.rows.map((row) => [Number(row.oid), row.name]));
        return {
          columns: read.fields.map((field) => ({
            name: field.name,
            type: nameByOid.get(field.dataTypeID) ?? String(field.dataTypeID),
          })),
          rows: read.rows.slice(0, input.maxRows),
          truncated: read.rows.length > input.maxRows,
        };
      },
    ),
  );
}
