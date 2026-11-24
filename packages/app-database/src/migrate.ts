import { Schema } from "effect";
import type pg from "pg";
import { AppDatabaseError, fromPostgresError } from "./errors.ts";
import type { AppDatabaseLimits } from "./limits.ts";
import { APP_SCHEMAS, CALLABLE_SCHEMAS, appDatabaseNames, type AppId } from "./names.ts";
import type { MigrateResult } from "./protocol.ts";
import { visitorPrivilegeViolations } from "./provision-check.ts";
import { withAppSession, type AppConnectionPools } from "./session.ts";
import { parseMigration } from "./sql-policy.ts";

export interface MigrateInput {
  readonly appId: AppId;
  readonly idempotencyKey: string;
  readonly description: string;
  readonly sql: string;
}

export const MIGRATION_LOCK_KEY = 7_302_118;

const LEDGER_INSERT = `INSERT INTO platform.migrations (idempotency_key, description, sql)
VALUES ($1, $2, $3)
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING id::integer AS id, applied_at`;

const LEDGER_LOOKUP = `SELECT id::integer AS id, applied_at, sql
FROM platform.migrations WHERE idempotency_key = $1`;

const decodeViolations = Schema.decodeUnknownSync(Schema.Array(Schema.String));

const CATALOG_VIOLATIONS = `WITH params AS (
  SELECT $1::text AS owner_role, $2::text[] AS app_schemas, $3::text[] AS callable_schemas, $4::text AS visitor_role
), app_functions AS (
  SELECT p.oid, p.proname, p.prokind, p.prosqlbody, p.prosecdef, p.proconfig,
    p.proallargtypes, p.proargtypes, p.proargmodes, p.proargnames,
    n.nspname, n.nspname = ANY(params.callable_schemas) AS callable
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN params
  WHERE n.nspname = ANY(params.app_schemas)
), app_relations AS (
  SELECT c.relname, c.relkind, c.relowner, c.relforcerowsecurity, n.nspname
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN params
  WHERE n.nspname = ANY(params.app_schemas)
)
SELECT coalesce(json_agg(v.message ORDER BY v.message), '[]'::json) AS violations
FROM (
  SELECT format('Schema %s no longer exists; schemas are managed by the platform, so a migration must not drop or rename one.', s.name) AS message
  FROM params
  CROSS JOIN LATERAL unnest(CASE
    WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = params.visitor_role)
      THEN ARRAY['public', 'api', 'platform', 'visitor']
    ELSE ARRAY['public', 'api', 'platform']
  END) AS s(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname = s.name)
  UNION ALL
  SELECT format('Function %s.%s must be a LANGUAGE sql function with a BEGIN ATOMIC body.', f.nspname, f.proname)
  FROM app_functions f
  WHERE f.callable AND (f.prokind <> 'f' OR f.prosqlbody IS NULL)
  UNION ALL
  SELECT format('Function name %s.%s must match [a-z_][a-z0-9_]* to be callable at /_platform/api/<name>.', f.nspname, f.proname)
  FROM app_functions f
  WHERE f.callable AND f.proname !~ '^[a-z_][a-z0-9_]*$'
  UNION ALL
  SELECT format('Function name %s is defined more than once (%s); the api and visitor schemas together allow one function per name.',
    f.proname, string_agg(f.oid::pg_catalog.regprocedure::text, ', ' ORDER BY f.oid::pg_catalog.regprocedure::text))
  FROM app_functions f
  WHERE f.callable
  GROUP BY f.proname HAVING count(*) > 1
  UNION ALL
  SELECT format('Every input argument of %s.%s needs a name matching [a-z_][a-z0-9_]*, and VARIADIC is not supported.', f.nspname, f.proname)
  FROM app_functions f
  WHERE f.callable AND EXISTS (
    SELECT 1
    FROM unnest(coalesce(f.proallargtypes, f.proargtypes::oid[]), f.proargmodes, f.proargnames) AS a(type, mode, name)
    WHERE coalesce(a.mode, 'i') IN ('i', 'b', 'v')
      AND (a.mode = 'v' OR coalesce(a.name, '') !~ '^[a-z_][a-z0-9_]*$')
  )
  UNION ALL
  SELECT format('Function %s.%s is SECURITY DEFINER; app functions must run with their caller''s privileges.', f.nspname, f.proname)
  FROM app_functions f
  WHERE f.prosecdef
  UNION ALL
  SELECT format('Function %s.%s sets %s; app functions must not change %s.', f.nspname, f.proname, s.setting, forbidden.governs)
  FROM app_functions f
  CROSS JOIN LATERAL unnest(f.proconfig) AS s(setting)
  JOIN (VALUES
    ('role', 'the session role'),
    ('session_authorization', 'the session role'),
    ('statement_timeout', 'the platform''s call limits'),
    ('transaction_timeout', 'the platform''s call limits'),
    ('idle_in_transaction_session_timeout', 'the platform''s call limits'),
    ('client_connection_check_interval', 'the platform''s call limits')
  ) AS forbidden(name, governs) ON forbidden.name = split_part(s.setting, '=', 1)
  UNION ALL
  SELECT format('Table %I.%I forces row level security, which would block the platform''s export; enable row level security without FORCE.', r.nspname, r.relname)
  FROM app_relations r
  WHERE r.relforcerowsecurity
  UNION ALL
  SELECT format('Relation api.%I is not a view; the api schema holds only views and functions, so create it in public.', r.relname)
  FROM app_relations r
  WHERE r.nspname = 'api' AND r.relkind NOT IN ('v', 'c')
  UNION ALL
  SELECT format('%s is in the visitor schema, which holds only functions; create it in public.', pg_catalog.pg_describe_object(o.classid, o.objid, 0))
  FROM (
    SELECT 'pg_catalog.pg_class'::pg_catalog.regclass AS classid, c.oid AS objid, c.relnamespace AS namespace
    FROM pg_catalog.pg_class c
    UNION ALL
    SELECT 'pg_catalog.pg_type'::pg_catalog.regclass, t.oid, t.typnamespace
    FROM pg_catalog.pg_type t
    WHERE t.typrelid = 0
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type e WHERE e.typarray = t.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_range g WHERE g.rngmultitypid = t.oid)
    UNION ALL
    SELECT 'pg_catalog.pg_operator'::pg_catalog.regclass, p.oid, p.oprnamespace
    FROM pg_catalog.pg_operator p
  ) AS o
  JOIN pg_catalog.pg_namespace n ON n.oid = o.namespace
  WHERE n.nspname = 'visitor'
  UNION ALL
  SELECT DISTINCT format('%s reads %s; views and rules must not use the platform schema.', pg_catalog.pg_describe_object('pg_catalog.pg_class'::pg_catalog.regclass, rw.ev_class, 0), d.refobjid::pg_catalog.regclass)
  FROM pg_catalog.pg_rewrite rw
  JOIN pg_catalog.pg_class c ON c.oid = rw.ev_class
  JOIN pg_catalog.pg_namespace cn ON cn.oid = c.relnamespace
  JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_rewrite'::pg_catalog.regclass AND d.objid = rw.oid
    AND d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
  JOIN pg_catalog.pg_class target ON target.oid = d.refobjid
  JOIN pg_catalog.pg_namespace tn ON tn.oid = target.relnamespace
  CROSS JOIN params
  WHERE cn.nspname = ANY(params.app_schemas) AND tn.nspname = 'platform'
  UNION ALL
  SELECT format('Relation %I.%I is owned by %s; app objects must be owned by %s.', r.nspname, r.relname, pg_catalog.pg_get_userbyid(r.relowner), params.owner_role)
  FROM app_relations r, params
  WHERE r.relowner <> params.owner_role::pg_catalog.regrole
) AS v`;

async function replay(client: pg.ClientBase, input: MigrateInput): Promise<MigrateResult> {
  const recorded = await client.query<{ id: number; applied_at: Date; sql: string }>(
    LEDGER_LOOKUP,
    [input.idempotencyKey],
  );
  const row = recorded.rows[0];
  if (row === undefined) {
    throw new AppDatabaseError({
      code: "postgres_error",
      message: `The ledger reported a conflict for ${input.idempotencyKey} but has no such row.`,
    });
  }
  if (row.sql !== input.sql) {
    throw new AppDatabaseError({
      code: "idempotency_conflict",
      message: `Idempotency key ${input.idempotencyKey} already applied different SQL; use a new key for a new migration.`,
    });
  }
  return { appliedAt: row.applied_at.toISOString(), migrationId: row.id, replayed: true };
}

export async function migrate(
  context: { readonly pools: AppConnectionPools; readonly limits: AppDatabaseLimits },
  input: MigrateInput,
): Promise<MigrateResult> {
  const statements = await parseMigration(input.sql);
  const { roles } = appDatabaseNames(input.appId);
  return withAppSession(context.pools, input.appId, "owner", (session) =>
    session.transaction(
      {
        access: "read write",
        deadlineMs: context.limits.migrateDeadlineMs,
        graceMs: context.limits.graceMs,
        settings: { search_path: "public" },
      },
      async (client) => {
        await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
        const inserted = await client.query<{ id: number; applied_at: Date }>(LEDGER_INSERT, [
          input.idempotencyKey,
          input.description,
          input.sql,
        ]);
        const ledgerRow = inserted.rows[0];
        if (ledgerRow === undefined) return replay(client, input);
        await client.query("SELECT set_config('lock_timeout', '5s', true)");
        for (const statement of statements) {
          await client.query(statement.text).catch((error: unknown) => {
            throw fromPostgresError(error, statement.text);
          });
        }
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        await client.query("SELECT set_config('search_path', 'pg_catalog', true)");
        const check = await client.query<{ violations: unknown }>(CATALOG_VIOLATIONS, [
          roles.owner,
          APP_SCHEMAS,
          CALLABLE_SCHEMAS,
          roles.visitor,
        ]);
        const violations = [
          ...decodeViolations(check.rows[0]?.violations),
          ...(await visitorPrivilegeViolations(client, roles.visitor)),
        ].toSorted();
        if (violations.length > 0) {
          throw new AppDatabaseError({ code: "sql_rejected", message: violations.join("\n") });
        }
        return {
          appliedAt: ledgerRow.applied_at.toISOString(),
          migrationId: ledgerRow.id,
          replayed: false,
        };
      },
    ),
  );
}
