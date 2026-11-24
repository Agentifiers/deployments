export interface BootstrapStatement {
  readonly database: "postgres" | "app_template";
  readonly sql: string;
  /**
   * `CREATE DATABASE` has no `IF NOT EXISTS` and cannot run inside `DO`, so some statements carry a
   * guard.
   */
  readonly skipWhen: string | null;
}

const TEMPLATE_EXTENSIONS = ["citext", "pg_trgm", "pgcrypto"] as const;

const TEMPLATE_MARKER = `platform template: ${TEMPLATE_EXTENSIONS.join(", ")}`;

const TEMPLATE_READY = `SELECT 1 FROM pg_database
  WHERE datname = 'app_template' AND datistemplate AND NOT datallowconn
    AND shobj_description(oid, 'pg_database') = '${TEMPLATE_MARKER}'`;

/**
 * An `rds_iam` member can log in only with an IAM token, only a role holding `rds_iam` with admin
 * option can grant it, and `CREATE DATABASE ... TEMPLATE` fails with 55006 while any session is
 * connected to the template.
 */
export function bootstrapStatements(): readonly BootstrapStatement[] {
  return [
    {
      database: "postgres",
      skipWhen: "SELECT 1 FROM pg_roles WHERE rolname = 'platform_provisioner'",
      sql: "CREATE ROLE platform_provisioner WITH LOGIN CREATEDB CREATEROLE",
    },
    {
      database: "postgres",
      skipWhen: null,
      sql: "ALTER ROLE platform_provisioner WITH LOGIN CREATEDB CREATEROLE",
    },
    {
      database: "postgres",
      skipWhen: null,
      sql: "GRANT rds_iam TO platform_provisioner WITH ADMIN OPTION",
    },
    {
      database: "postgres",
      skipWhen: null,
      sql: "GRANT pg_signal_backend TO platform_provisioner",
    },
    {
      database: "postgres",
      skipWhen: null,
      sql: "ALTER ROLE platform_provisioner SET createrole_self_grant = 'set'",
    },
    {
      database: "postgres",
      skipWhen: "SELECT 1 FROM pg_database WHERE datname = 'app_template'",
      sql: "CREATE DATABASE app_template",
    },
    {
      database: "postgres",
      skipWhen: TEMPLATE_READY,
      sql: "ALTER DATABASE app_template WITH ALLOW_CONNECTIONS true",
    },
    ...TEMPLATE_EXTENSIONS.map((extension) => ({
      database: "app_template" as const,
      skipWhen: TEMPLATE_READY,
      sql: `CREATE EXTENSION IF NOT EXISTS ${extension}`,
    })),
    {
      database: "postgres",
      skipWhen: TEMPLATE_READY,
      sql: `COMMENT ON DATABASE app_template IS '${TEMPLATE_MARKER}'`,
    },
    {
      database: "postgres",
      skipWhen: null,
      sql: "ALTER DATABASE app_template WITH IS_TEMPLATE true ALLOW_CONNECTIONS false",
    },
    {
      database: "postgres",
      skipWhen: null,
      sql: "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'app_template' AND pid <> pg_backend_pid()",
    },
  ];
}

export interface BootstrapExecutor {
  readonly execute: (
    database: BootstrapStatement["database"],
    sql: string,
  ) => Promise<ReadonlyArray<Readonly<Record<string, unknown>>>>;
}

export async function runBootstrap(executor: BootstrapExecutor): Promise<void> {
  for (const statement of bootstrapStatements()) {
    if (statement.skipWhen !== null) {
      const [guard] = await executor.execute(
        "postgres",
        `SELECT EXISTS (${statement.skipWhen}) AS already_applied`,
      );
      if (guard?.already_applied === true) continue;
    }
    await executor.execute(statement.database, statement.sql);
  }
}
