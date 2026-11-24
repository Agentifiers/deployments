import { Schema } from "effect";
import pg from "pg";
import { openClient, type ConnectionSettings } from "./connection.ts";
import { AppDatabaseError, fromPostgresError } from "./errors.ts";
import { DEFAULT_LIMITS } from "./limits.ts";
import {
  APP_ROLES,
  MAINTENANCE_DATABASE,
  PROVISIONER_ROLE,
  TEMPLATE_DATABASE,
  appDatabaseNames,
  appRoleList,
  type AppDatabaseNames,
  type AppId,
  type AppRole,
  type AppSlug,
  type PgName,
} from "./names.ts";
import { MIGRATION_LOCK_KEY } from "./migrate.ts";
import type { SlugDirectory } from "./ports.ts";
import type { ProvisionResult } from "./protocol.ts";
import {
  PROVISION_OBSERVATION_SQL,
  ProvisionObservation,
  provisionViolations,
  visitorPrivilegeViolations,
} from "./provision-check.ts";

export interface ProvisionInput {
  readonly appId: AppId;
  readonly slug: AppSlug;
}

export interface ProvisionDependencies {
  readonly connections: ConnectionSettings;
  readonly slugDirectory: SlugDirectory;
}

const LOGINS_PER_SESSION_WITH_TERMINATOR = 2;
export const MAX_GATEWAY_TASKS_DURING_DEPLOY = 4;
const LAMBDA_CONCURRENT_OPERATIONS_PER_APP = 4;
const gatewayLogins = (role: AppRole) =>
  MAX_GATEWAY_TASKS_DURING_DEPLOY *
  DEFAULT_LIMITS.maxConnectionsPerPool[role] *
  LOGINS_PER_SESSION_WITH_TERMINATOR;
const LAMBDA_LOGINS = LAMBDA_CONCURRENT_OPERATIONS_PER_APP * LOGINS_PER_SESSION_WITH_TERMINATOR;
const ROLE_CONNECTION_LIMITS: Readonly<Record<AppRole, number>> = {
  editor: gatewayLogins("editor"),
  owner: LAMBDA_LOGINS,
  viewer: gatewayLogins("viewer") + LAMBDA_LOGINS,
  visitor: gatewayLogins("visitor"),
};

class ProvisionerSessions {
  readonly #clients = new Map<PgName, Promise<pg.Client>>();

  constructor(private readonly connections: ConnectionSettings) {}

  async run<T>(database: PgName, work: (client: pg.Client) => Promise<T>): Promise<T> {
    let client = this.#clients.get(database);
    if (client === undefined) {
      client = openClient(this.connections, { database, user: PROVISIONER_ROLE });
      this.#clients.set(database, client);
    }
    try {
      return await work(await client);
    } catch (error) {
      throw fromPostgresError(error);
    }
  }

  async close() {
    await Promise.all(
      [...this.#clients.values()].map((client) =>
        client.then((connected) => connected.end()).catch(() => undefined),
      ),
    );
  }
}

interface StepContext extends ProvisionInput, ProvisionDependencies {
  readonly names: AppDatabaseNames;
  readonly sessions: ProvisionerSessions;
}

export interface ProvisionStep {
  readonly name: string;
  readonly run: (context: StepContext) => Promise<void>;
}

async function inTransaction(client: pg.Client, work: () => Promise<void>) {
  await client.query("BEGIN");
  try {
    await work();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function isDuplicate(error: unknown) {
  // 23505 covers two passes racing on the same catalog row.
  return (
    error instanceof pg.DatabaseError && ["42710", "42P04", "23505"].includes(error.code ?? "")
  );
}

function setupStatements({ roles }: AppDatabaseNames): readonly string[] {
  const { editor, owner, viewer, visitor } = roles;
  return [
    `ALTER SCHEMA public OWNER TO ${owner}`,
    `CREATE SCHEMA IF NOT EXISTS api AUTHORIZATION ${owner}`,
    `ALTER SCHEMA api OWNER TO ${owner}`,
    `CREATE SCHEMA IF NOT EXISTS visitor AUTHORIZATION ${owner}`,
    `ALTER SCHEMA visitor OWNER TO ${owner}`,
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
    `GRANT USAGE ON SCHEMA platform TO ${owner}, ${editor}, ${viewer}, ${visitor}`,
    `GRANT SELECT, INSERT (idempotency_key, description, sql) ON platform.migrations TO ${owner}`,
    `GRANT SELECT (id) ON platform.migrations TO ${editor}, ${viewer}, ${visitor}`,
    `SET LOCAL ROLE ${owner}`,
    "REVOKE ALL ON SCHEMA public, api, visitor FROM PUBLIC",
    `GRANT USAGE ON SCHEMA public, api, visitor TO ${editor}, ${viewer}`,
    `GRANT USAGE ON SCHEMA public, visitor TO ${visitor}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${viewer}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${editor}, ${visitor}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${editor}, ${visitor}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${visitor}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${visitor}`,
    "ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC",
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public, api, visitor GRANT EXECUTE ON FUNCTIONS TO ${editor}, ${viewer}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA visitor GRANT EXECUTE ON FUNCTIONS TO ${visitor}`,
  ];
}

export const PROVISION_STEPS: readonly ProvisionStep[] = [
  {
    name: "create-roles",
    run: ({ names, sessions }) =>
      sessions.run(MAINTENANCE_DATABASE, (client) =>
        inTransaction(client, async () => {
          const existing = await client.query<{ rolname: string }>(
            "SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])",
            [appRoleList(names)],
          );
          const present = existing.rows.map((row) => row.rolname);
          for (const role of APP_ROLES) {
            const name = names.roles[role];
            if (!present.includes(name)) await client.query(`CREATE ROLE ${name} WITH LOGIN`);
            await client.query(
              `ALTER ROLE ${name} WITH CONNECTION LIMIT ${ROLE_CONNECTION_LIMITS[role]}`,
            );
          }
        }),
      ),
  },
  {
    name: "grant-iam-login",
    run: ({ names, sessions }) =>
      sessions.run(MAINTENANCE_DATABASE, async (client) => {
        const iam = await client.query<{ present: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rds_iam') AS present",
        );
        if (iam.rows[0]?.present === true) {
          await client.query(`GRANT rds_iam TO ${appRoleList(names).join(", ")}`);
        }
      }),
  },
  {
    name: "create-database",
    run: ({ names, sessions }) =>
      sessions.run(MAINTENANCE_DATABASE, async (client) => {
        const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
          names.database,
        ]);
        if (existing.rowCount !== 0) return;
        await client
          .query(
            `CREATE DATABASE ${names.database} WITH TEMPLATE ${TEMPLATE_DATABASE} ALLOW_CONNECTIONS false`,
          )
          .catch((error: unknown) => {
            if (!isDuplicate(error)) throw error;
          });
      }),
  },
  {
    name: "restrict-database-acl",
    run: ({ names, sessions }) =>
      sessions.run(MAINTENANCE_DATABASE, (client) =>
        inTransaction(client, async () => {
          await client.query(`REVOKE ALL ON DATABASE ${names.database} FROM PUBLIC`);
          await client.query(
            `GRANT CONNECT ON DATABASE ${names.database} TO ${appRoleList(names).join(", ")}`,
          );
        }),
      ),
  },
  {
    name: "allow-connections",
    run: ({ names, sessions }) =>
      sessions.run(MAINTENANCE_DATABASE, async (client) => {
        await client.query(`ALTER DATABASE ${names.database} WITH ALLOW_CONNECTIONS true`);
      }),
  },
  {
    name: "configure-schemas",
    run: ({ names, sessions }) =>
      sessions.run(names.database, (client) =>
        inTransaction(client, async () => {
          await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
          await client.query(
            "SELECT set_config('search_path', 'pg_catalog', true), set_config('lock_timeout', '5s', true)",
          );
          for (const statement of setupStatements(names)) await client.query(statement);
        }),
      ),
  },
  {
    name: "verify-catalog",
    run: async ({ names, sessions }) => {
      const { observation, visitor } = await sessions.run(names.database, async (client) => {
        await client.query("SELECT set_config('search_path', 'pg_catalog', false)");
        const result = await client.query<{ observation: unknown }>(PROVISION_OBSERVATION_SQL, [
          appRoleList(names),
        ]);
        return {
          observation: result.rows[0]?.observation,
          visitor: await visitorPrivilegeViolations(client, names.roles.visitor),
        };
      });
      const violations = [
        ...provisionViolations(Schema.decodeUnknownSync(ProvisionObservation)(observation), names),
        ...visitor,
      ];
      if (violations.length > 0) {
        throw new AppDatabaseError({
          code: "provision_incomplete",
          message: violations.join("\n"),
        });
      }
    },
  },
  {
    name: "publish-slug",
    run: ({ appId, slug, slugDirectory }) => slugDirectory.put(slug, appId),
  },
];

export async function runProvisionSteps(
  dependencies: ProvisionDependencies,
  input: ProvisionInput,
  steps: readonly ProvisionStep[],
): Promise<ProvisionResult> {
  const names = appDatabaseNames(input.appId);
  const sessions = new ProvisionerSessions(dependencies.connections);
  try {
    for (const step of steps) await step.run({ ...dependencies, ...input, names, sessions });
  } finally {
    await sessions.close();
  }
  return { ...input, database: names.database, roles: names.roles };
}

export function provision(
  dependencies: ProvisionDependencies,
  input: ProvisionInput,
): Promise<ProvisionResult> {
  return runProvisionSteps(dependencies, input, PROVISION_STEPS);
}
