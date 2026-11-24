import { Schema } from "effect";
import { loadApiCatalog } from "./api-catalog.ts";
import type { AppDatabaseLimits } from "./limits.ts";
import type { AppId } from "./names.ts";
import { AppDescription } from "./protocol.ts";
import { withAppSession, type AppConnectionPools } from "./session.ts";
import { renderTypescriptClient } from "./typescript-client.ts";

const SchemaPayload = Schema.Struct({
  migrations: AppDescription.fields.migrations,
  relations: AppDescription.fields.relations,
});

const SCHEMA_SQL = `SELECT json_build_object(
  'relations', (SELECT coalesce(json_agg(json_build_object(
    'schema', n.nspname,
    'name', c.relname,
    'kind', CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned table'
      WHEN 'v' THEN 'view' ELSE 'materialized view' END,
    'definition', CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid) END,
    'rowSecurity', json_build_object('enabled', c.relrowsecurity, 'forced', c.relforcerowsecurity),
    'columns', (SELECT coalesce(json_agg(json_build_object(
        'name', a.attname,
        'type', format_type(a.atttypid, a.atttypmod),
        'nullable', NOT a.attnotnull,
        'default', CASE WHEN a.attgenerated = '' THEN pg_get_expr(d.adbin, d.adrelid) END,
        'generated', CASE WHEN a.attgenerated <> '' THEN pg_get_expr(d.adbin, d.adrelid) END,
        'identity', CASE a.attidentity WHEN 'a' THEN 'always' WHEN 'd' THEN 'by default' END
      ) ORDER BY a.attnum), '[]'::json)
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped),
    'constraints', (SELECT coalesce(json_agg(json_build_object(
        'name', k.conname,
        'kind', CASE k.contype WHEN 'p' THEN 'primary key' WHEN 'u' THEN 'unique'
          WHEN 'f' THEN 'foreign key' WHEN 'c' THEN 'check' WHEN 'x' THEN 'exclusion'
          WHEN 'n' THEN 'not null' ELSE k.contype::text END,
        'definition', pg_get_constraintdef(k.oid)
      ) ORDER BY k.conname), '[]'::json)
      FROM pg_constraint k WHERE k.conrelid = c.oid),
    'indexes', (SELECT coalesce(json_agg(json_build_object(
        'name', ic.relname, 'definition', pg_get_indexdef(i.indexrelid)
      ) ORDER BY ic.relname), '[]'::json)
      FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid WHERE i.indrelid = c.oid),
    'policies', (SELECT coalesce(json_agg(json_build_object(
        'name', p.polname,
        'command', CASE p.polcmd WHEN 'r' THEN 'select' WHEN 'a' THEN 'insert'
          WHEN 'w' THEN 'update' WHEN 'd' THEN 'delete' ELSE 'all' END,
        'permissive', p.polpermissive,
        'roles', (SELECT coalesce(json_agg(CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END), '[]'::json)
          FROM unnest(p.polroles) AS r),
        'using', pg_get_expr(p.polqual, p.polrelid),
        'withCheck', pg_get_expr(p.polwithcheck, p.polrelid)
      ) ORDER BY p.polname), '[]'::json)
      FROM pg_policy p WHERE p.polrelid = c.oid)
  ) ORDER BY n.nspname, c.relname), '[]'::json)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'api') AND c.relkind IN ('r', 'p', 'v', 'm')),
  'migrations', (SELECT coalesce(json_agg(json_build_object(
      'id', m.id, 'idempotencyKey', m.idempotency_key, 'description', m.description,
      'appliedAt', m.applied_at
    ) ORDER BY m.id), '[]'::json)
    FROM platform.migrations m)
) AS description`;

const decodeSchemaPayload = Schema.decodeUnknownSync(SchemaPayload);

export async function describe(
  context: { readonly pools: AppConnectionPools; readonly limits: AppDatabaseLimits },
  appId: AppId,
): Promise<AppDescription> {
  return withAppSession(context.pools, appId, "owner", (session) =>
    session.transaction(
      {
        access: "read only",
        deadlineMs: context.limits.describeDeadlineMs,
        graceMs: context.limits.graceMs,
        isolation: "repeatable read",
        settings: { search_path: "pg_catalog" },
      },
      async (client) => {
        const schema = await client.query<{ description: unknown }>(SCHEMA_SQL);
        const payload = decodeSchemaPayload(schema.rows[0]?.description);
        const functions = await loadApiCatalog(client);
        return {
          client: renderTypescriptClient(functions),
          functions: functions.map((fn) => ({
            arguments: fn.arguments.map((argument) => ({
              hasDefault: argument.hasDefault,
              name: argument.name,
              type: argument.type.sql,
            })),
            name: fn.name,
            returns: {
              columns:
                fn.result.kind === "row"
                  ? fn.result.columns.map((column) => ({
                      name: column.name,
                      type: column.type.sql,
                    }))
                  : [],
              set: fn.returnsSet,
              shape: fn.result.kind,
              type: fn.result.kind === "scalar" ? fn.result.type.sql : null,
            },
            schema: fn.schema,
            volatility: fn.volatility,
          })),
          migrations: payload.migrations,
          relations: payload.relations,
        };
      },
    ),
  );
}
