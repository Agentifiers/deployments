import { randomInt } from "node:crypto";
import type { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { Schema } from "effect";
import pg from "pg";
import { createAppDatabaseControl, type AppDatabaseControl } from "../app-database.ts";
import { runBootstrap } from "../bootstrap.ts";
import { withClient, type ConnectionSettings } from "../connection.ts";
import type { AppDatabaseLimits } from "../limits.ts";
import { AppId, AppSlug, PROVISIONER_ROLE, type PgName } from "../names.ts";
import type { AppObjectStore, SlugDirectory } from "../ports.ts";

const databaseUrl = process.env.APPS_TEST_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === "") {
  throw new Error(
    "APPS_TEST_DATABASE_URL must name a Postgres 17 superuser, for example after `docker run --rm -d --name app-database-pg -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:17-alpine` use postgres://postgres:postgres@127.0.0.1:55432/postgres",
  );
}
const url = new URL(databaseUrl);
const TEST_PASSWORD = "app-database-test";

// pg lets connectionString override an explicit `database`, so the URL is split instead.
function superuserConfig(database: string): pg.ClientConfig {
  return {
    database,
    host: url.hostname,
    password: decodeURIComponent(url.password),
    port: Number(url.port || "5432"),
    user: decodeURIComponent(url.username),
  };
}

export async function asSuperuser<T>(
  database: string,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client(superuserConfig(database));
  client.on("error", () => undefined);
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/**
 * The server reads the stored verifier before it asks for the password, so passwords are set when
 * a role comes into existence, not inside the credential callback.
 */
export const testConnections: ConnectionSettings = {
  credentials: async () => TEST_PASSWORD,
  host: url.hostname,
  port: Number(url.port || "5432"),
  resumeWaitMs: 0,
  tls: { kind: "disabled" },
};

export async function setTestPasswords(roles: readonly PgName[]) {
  await asSuperuser("postgres", async (client) => {
    for (const role of roles) await client.query(`ALTER ROLE ${role} PASSWORD '${TEST_PASSWORD}'`);
  });
}

let clusterReady: Promise<void> | undefined;

export function prepareCluster(): Promise<void> {
  clusterReady ??= (async () => {
    await asSuperuser("postgres", (client) =>
      client.query(
        "DO $$ BEGIN CREATE ROLE rds_iam; EXCEPTION WHEN duplicate_object THEN NULL; END $$",
      ),
    );
    await runBootstrap({
      execute: (database, sql) =>
        asSuperuser(database, async (client) => (await client.query(sql)).rows),
    });
    await setTestPasswords([PROVISIONER_ROLE]);
  })();
  return clusterReady;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newAppId(): AppId {
  const id = Array.from({ length: 26 }, (_, index) =>
    CROCKFORD.charAt(index === 0 ? randomInt(8) : randomInt(32)),
  ).join("");
  return Schema.decodeUnknownSync(AppId)(id);
}

export function newSlug(): AppSlug {
  return Schema.decodeUnknownSync(AppSlug)(`app-${randomInt(1_000_000_000).toString(36)}`);
}

export class MemorySlugDirectory implements SlugDirectory {
  readonly entries = new Map<string, string>();
  readonly put = async (slug: AppSlug, appId: AppId) => {
    this.entries.set(slug, appId);
  };
  readonly remove = async (slug: AppSlug) => {
    this.entries.delete(slug);
  };
}

const LIST_PAGE_SIZE = 2;

export class MemoryAppObjectStore implements AppObjectStore {
  readonly entries = new Map<string, string>();
  readonly putObject = async (input: {
    readonly bucket: string;
    readonly key: string;
    readonly body: Readable;
  }) => {
    this.entries.set(`${input.bucket}/${input.key}`, await text(input.body));
  };
  readonly listObjects = async (input: { readonly bucket: string; readonly prefix: string }) =>
    [...this.entries.keys()]
      .filter((entry) => entry.startsWith(`${input.bucket}/${input.prefix}`))
      .slice(0, LIST_PAGE_SIZE)
      .map((entry) => entry.slice(input.bucket.length + 1));
  readonly deleteObjects = async (input: {
    readonly bucket: string;
    readonly keys: readonly string[];
  }) => {
    for (const key of input.keys) this.entries.delete(`${input.bucket}/${key}`);
  };
}

export function eraseInput(app: { readonly appId: AppId; readonly slug: AppSlug }) {
  return { appId: app.appId, bucket: "apps-bucket", slug: app.slug };
}

export interface TestControl {
  readonly control: AppDatabaseControl;
  readonly slugs: MemorySlugDirectory;
  readonly objects: MemoryAppObjectStore;
}

export function createTestControl(
  limits?: Partial<AppDatabaseLimits>,
  connections: ConnectionSettings = testConnections,
): TestControl {
  const slugs = new MemorySlugDirectory();
  const objects = new MemoryAppObjectStore();
  const control = createAppDatabaseControl({
    connections,
    limits: { maxConnectionsPerPool: { editor: 2, owner: 2, viewer: 2, visitor: 2 }, ...limits },
    objectStore: objects,
    slugDirectory: slugs,
  });
  return {
    control: {
      ...control,
      provision: async (input) => {
        const result = await control.provision(input);
        await setTestPasswords(Object.values(result.roles));
        return result;
      },
    },
    objects,
    slugs,
  };
}

export function asRole<T>(
  database: PgName,
  user: PgName,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  return withClient(testConnections, { database, user }, work);
}

export async function errorOf(work: Promise<unknown>): Promise<{
  readonly name: string;
  readonly code: unknown;
  readonly message: string;
  readonly statement: unknown;
}> {
  try {
    await work;
  } catch (error) {
    if (error instanceof Error) {
      return {
        code: "code" in error ? error.code : undefined,
        message: error.message,
        name: error.name,
        statement: "statement" in error ? error.statement : undefined,
      };
    }
    throw error;
  }
  throw new Error("Expected the operation to fail.");
}
