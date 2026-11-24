import { Schema } from "effect";
import type pg from "pg";
import {
  APP_SCHEMAS,
  PROVISIONER_ROLE,
  appRoleList,
  type AppDatabaseNames,
  type PgName,
} from "./names.ts";

export const ProvisionObservation = Schema.Struct({
  aclIsDefault: Schema.Boolean,
  databaseAcl: Schema.Array(Schema.Struct({ grantee: Schema.String, privilege: Schema.String })),
  iamMembers: Schema.Array(Schema.String),
  iamRolePresent: Schema.Boolean,
  schemaOwners: Schema.Record(Schema.String, Schema.String),
});
export type ProvisionObservation = typeof ProvisionObservation.Type;

export const PROVISION_OBSERVATION_SQL = `SELECT json_build_object(
  'aclIsDefault', (SELECT d.datacl IS NULL FROM pg_database d WHERE d.datname = current_database()),
  'databaseAcl', (
    SELECT coalesce(json_agg(json_build_object(
      'grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      'privilege', a.privilege_type
    ) ORDER BY a.grantee, a.privilege_type), '[]'::json)
    FROM pg_database d, aclexplode(d.datacl) a
    WHERE d.datname = current_database()
  ),
  'iamMembers', (
    SELECT coalesce(json_agg(member.rolname ORDER BY member.rolname), '[]'::json)
    FROM pg_auth_members m
    JOIN pg_roles granted ON granted.oid = m.roleid
    JOIN pg_roles member ON member.oid = m.member
    WHERE granted.rolname = 'rds_iam' AND member.rolname = ANY($1::text[])
  ),
  'iamRolePresent', EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rds_iam'),
  'schemaOwners', (
    SELECT coalesce(json_object_agg(n.nspname, pg_get_userbyid(n.nspowner)), '{}'::json)
    FROM pg_namespace n
    WHERE n.nspname IN ('public', 'api', 'visitor', 'platform')
  )
) AS observation`;

/**
 * Shared by `verify-catalog` and the migration catalog check. It returns no rows until both the
 * visitor role and the visitor schema exist, so it also runs on a layout-1 database.
 */
const VISITOR_PRIVILEGE_VIOLATIONS = `WITH params AS (
  SELECT $1::text AS visitor_role, $2::text[] AS app_schemas
), visitor_role AS (
  SELECT r.oid FROM pg_catalog.pg_roles r, params
  WHERE r.rolname = params.visitor_role
    AND EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'visitor')
), app_functions AS (
  SELECT p.oid, p.proname, n.nspname
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN params
  WHERE n.nspname = ANY(params.app_schemas) AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend e
    WHERE e.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND e.objid = p.oid AND e.deptype = 'e'
  )
)
SELECT coalesce(json_agg(v.message ORDER BY v.message), '[]'::json) AS violations
FROM visitor_role r CROSS JOIN LATERAL (
  SELECT format('The visitor role has USAGE on schema %s; it may use only public, visitor and platform.', n.nspname) AS message
  FROM pg_catalog.pg_namespace n
  WHERE n.nspname = 'api'
    AND pg_catalog.has_schema_privilege(r.oid, n.oid, 'USAGE')
  UNION ALL
  SELECT format('The visitor role lacks USAGE on schema %s.', n.nspname)
  FROM pg_catalog.pg_namespace n
  WHERE n.nspname IN ('public', 'visitor', 'platform')
    AND NOT pg_catalog.has_schema_privilege(r.oid, n.oid, 'USAGE')
  UNION ALL
  SELECT format('Function %s.%s is executable by visitors, but only functions in the visitor schema may be; drop it and create it again.', f.nspname, f.proname)
  FROM app_functions f
  WHERE f.nspname <> 'visitor' AND pg_catalog.has_function_privilege(r.oid, f.oid, 'EXECUTE')
  UNION ALL
  SELECT format('Function visitor.%s is not executable by visitors because it was created in another schema; drop it and create it in visitor.', f.proname)
  FROM app_functions f
  WHERE f.nspname = 'visitor' AND NOT pg_catalog.has_function_privilege(r.oid, f.oid, 'EXECUTE')
  UNION ALL
  SELECT format('The visitor role lacks SELECT, INSERT, UPDATE or DELETE on %s.', c.oid::pg_catalog.regclass)
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT (
    pg_catalog.has_table_privilege(r.oid, c.oid, 'SELECT')
    AND pg_catalog.has_table_privilege(r.oid, c.oid, 'INSERT')
    AND pg_catalog.has_table_privilege(r.oid, c.oid, 'UPDATE')
    AND pg_catalog.has_table_privilege(r.oid, c.oid, 'DELETE')
  )
  UNION ALL
  SELECT format('The visitor role lacks USAGE or SELECT on sequence %s.', c.oid::pg_catalog.regclass)
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'S' AND NOT (
    pg_catalog.has_sequence_privilege(r.oid, c.oid, 'USAGE')
    AND pg_catalog.has_sequence_privilege(r.oid, c.oid, 'SELECT')
  )
  UNION ALL
  SELECT DISTINCT format('Function visitor.%s uses %s, which the visitor role cannot use; a visitor function may use public tables and types, visitor functions, and functions every role may execute.',
    f.proname, pg_catalog.pg_describe_object(d.refclassid, d.refobjid, 0))
  FROM app_functions f
  JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND d.objid = f.oid
  WHERE f.nspname = 'visitor' AND CASE d.refclassid
    WHEN 'pg_catalog.pg_proc'::pg_catalog.regclass THEN
      NOT pg_catalog.has_function_privilege(r.oid, d.refobjid, 'EXECUTE')
    WHEN 'pg_catalog.pg_operator'::pg_catalog.regclass THEN
      NOT pg_catalog.has_function_privilege(r.oid,
        (SELECT o.oprcode::oid FROM pg_catalog.pg_operator o WHERE o.oid = d.refobjid), 'EXECUTE')
    WHEN 'pg_catalog.pg_class'::pg_catalog.regclass THEN
      NOT pg_catalog.has_schema_privilege(r.oid,
        (SELECT c.relnamespace FROM pg_catalog.pg_class c WHERE c.oid = d.refobjid), 'USAGE')
    WHEN 'pg_catalog.pg_type'::pg_catalog.regclass THEN
      NOT pg_catalog.has_schema_privilege(r.oid,
        (SELECT t.typnamespace FROM pg_catalog.pg_type t WHERE t.oid = d.refobjid), 'USAGE')
    ELSE false
  END
) AS v`;

const decodeViolations = Schema.decodeUnknownSync(Schema.Array(Schema.String));

export async function visitorPrivilegeViolations(
  client: pg.ClientBase,
  visitorRole: PgName,
): Promise<readonly string[]> {
  const result = await client.query<{ violations: unknown }>(VISITOR_PRIVILEGE_VIOLATIONS, [
    visitorRole,
    APP_SCHEMAS,
  ]);
  return decodeViolations(result.rows[0]?.violations);
}

function sameMembers(actual: readonly string[], expected: readonly string[]) {
  return actual.toSorted().join(",") === expected.toSorted().join(",");
}

export function provisionViolations(
  observation: ProvisionObservation,
  names: AppDatabaseNames,
): readonly string[] {
  const appRoles = appRoleList(names);
  const expectedRoles = `[${appRoles.toSorted().join(", ")}]`;
  const violations: string[] = [];
  if (observation.aclIsDefault) {
    violations.push(`Database ${names.database} has the default ACL, so PUBLIC may connect.`);
  }
  for (const entry of observation.databaseAcl) {
    if (entry.grantee === "PUBLIC") {
      violations.push(`PUBLIC holds ${entry.privilege} on database ${names.database}.`);
    }
  }
  const connectGrantees = observation.databaseAcl
    .filter((entry) => entry.privilege === "CONNECT" && entry.grantee !== PROVISIONER_ROLE)
    .map((entry) => entry.grantee);
  if (!sameMembers(connectGrantees, appRoles)) {
    violations.push(
      `CONNECT on ${names.database} is granted to [${connectGrantees.toSorted().join(", ")}], expected ${expectedRoles}.`,
    );
  }
  if (observation.iamRolePresent && !sameMembers(observation.iamMembers, appRoles)) {
    violations.push(
      `rds_iam members among the app roles are [${observation.iamMembers.join(", ")}], expected ${expectedRoles}.`,
    );
  }
  const expectedOwners: Readonly<Record<string, string>> = {
    api: names.roles.owner,
    platform: PROVISIONER_ROLE,
    public: names.roles.owner,
    visitor: names.roles.owner,
  };
  for (const [schema, owner] of Object.entries(expectedOwners)) {
    const actual = observation.schemaOwners[schema];
    if (actual !== owner) {
      violations.push(`Schema ${schema} is owned by ${actual ?? "nobody"}, expected ${owner}.`);
    }
  }
  return violations;
}
