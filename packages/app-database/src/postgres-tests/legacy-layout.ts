import { withClient } from "../connection.ts";
import {
  MAINTENANCE_DATABASE,
  PROVISIONER_ROLE,
  TEMPLATE_DATABASE,
  appDatabaseNames,
  type AppId,
} from "../names.ts";
import { setTestPasswords, testConnections } from "./harness.ts";

export async function provisionLayoutOne(appId: AppId): Promise<void> {
  const { database, roles } = appDatabaseNames(appId);
  const { editor, owner, viewer } = roles;
  const asProvisioner = { database: MAINTENANCE_DATABASE, user: PROVISIONER_ROLE };
  await withClient(testConnections, asProvisioner, async (client) => {
    for (const [role, limit] of [
      [owner, 8],
      [editor, 32],
      [viewer, 40],
    ] as const) {
      await client.query(`CREATE ROLE ${role} WITH LOGIN CONNECTION LIMIT ${limit}`);
    }
    await client.query(`GRANT rds_iam TO ${owner}, ${editor}, ${viewer}`);
    await client.query(`CREATE DATABASE ${database} WITH TEMPLATE ${TEMPLATE_DATABASE}`);
    await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${owner}, ${editor}, ${viewer}`);
  });
  await withClient(testConnections, { database, user: PROVISIONER_ROLE }, async (client) => {
    await client.query("BEGIN");
    await client.query("SELECT set_config('search_path', 'pg_catalog', true)");
    for (const statement of [
      `ALTER SCHEMA public OWNER TO ${owner}`,
      `CREATE SCHEMA IF NOT EXISTS api AUTHORIZATION ${owner}`,
      `ALTER SCHEMA api OWNER TO ${owner}`,
      "CREATE SCHEMA IF NOT EXISTS platform",
      `CREATE TABLE IF NOT EXISTS platform.migrations (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        idempotency_key text NOT NULL UNIQUE,
        description text NOT NULL,
        sql text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(),
        transaction_id xid8 NOT NULL UNIQUE DEFAULT pg_current_xact_id()
      )`,
      "REVOKE ALL ON SCHEMA platform FROM PUBLIC",
      `GRANT USAGE ON SCHEMA platform TO ${owner}, ${editor}, ${viewer}`,
      `GRANT SELECT, INSERT (idempotency_key, description, sql) ON platform.migrations TO ${owner}`,
      `GRANT SELECT (id) ON platform.migrations TO ${editor}, ${viewer}`,
      `SET LOCAL ROLE ${owner}`,
      "REVOKE ALL ON SCHEMA public, api FROM PUBLIC",
      `GRANT USAGE ON SCHEMA public, api TO ${editor}, ${viewer}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${viewer}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${editor}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${editor}`,
      "ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC",
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public, api GRANT EXECUTE ON FUNCTIONS TO ${editor}, ${viewer}`,
    ]) {
      await client.query(statement);
    }
    await client.query("COMMIT");
  });
  await setTestPasswords([owner, editor, viewer]);
}
