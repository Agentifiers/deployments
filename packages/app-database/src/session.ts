import pg from "pg";
import {
  clientConfig,
  connectAwaitingResume,
  withClient,
  type ConnectionSettings,
  type SessionTarget,
} from "./connection.ts";
import { AppDatabaseError, fromPostgresError } from "./errors.ts";
import type { AppDatabaseLimits } from "./limits.ts";
import { appDatabaseNames, type AppId, type AppRole } from "./names.ts";

export interface TransactionOptions {
  readonly access: "read only" | "read write";
  readonly isolation?: "repeatable read";
  readonly deadlineMs: number;
  readonly graceMs: number;
  readonly settings?: Readonly<Record<string, string>>;
}

const BEGIN_STATEMENTS = {
  "read only": "BEGIN READ ONLY",
  "read only/repeatable read": "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  "read write": "BEGIN READ WRITE",
  "read write/repeatable read": "BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE",
} as const;

async function applySettings(client: pg.ClientBase, settings: Readonly<Record<string, string>>) {
  const entries = Object.entries(settings);
  if (entries.length === 0) return;
  const calls = entries.map((_, index) => `set_config($${index * 2 + 1}, $${index * 2 + 2}, true)`);
  await client.query(`SELECT ${calls.join(", ")}`, entries.flat());
}

function answeredWithin<T>(
  work: Promise<T>,
  ms: number,
  refusal: () => AppDatabaseError,
): Promise<T> {
  let timer: Timer | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(refusal()), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

function silence(statement: string, ms: number) {
  return () =>
    new AppDatabaseError({
      code: "database_unavailable",
      message: `The app database did not answer ${statement} within ${ms} ms.`,
    });
}

async function terminateBackend(
  settings: ConnectionSettings,
  target: SessionTarget,
  pid: number,
  graceMs: number,
) {
  await withClient({ ...settings, resumeWaitMs: 0 }, target, (client) =>
    answeredWithin(
      client.query("SELECT pg_terminate_backend($1)", [pid]),
      graceMs,
      silence("pg_terminate_backend", graceMs),
    ),
  );
}

/**
 * A plpgsql handler can trap `statement_timeout` and `pg_cancel_backend`, so the hard deadline is
 * `pg_terminate_backend` from a second session of the same role, which needs no extra privilege.
 * The backend's answer to a COMMIT already sent arrives before the close that termination causes,
 * so the session waits for that close before it closes a socket whose server went silent.
 */
export class AppSession {
  #doomed = false;

  constructor(
    private readonly client: pg.PoolClient,
    private readonly target: SessionTarget,
    private readonly pid: number,
    private readonly settings: ConnectionSettings,
    private readonly graceMs: number,
    /** How long getting the connection took when it waited out a database resume, else 0. */
    readonly resumedMs: number,
  ) {}

  async transaction<T>(
    options: TransactionOptions,
    work: (client: pg.ClientBase) => Promise<T>,
  ): Promise<T> {
    const { client } = this;
    let expired = false;
    let settled = false;
    let committing = false;
    let termination: Promise<void> | undefined;
    const timer = setTimeout(() => {
      expired = true;
      this.#doomed = true;
      termination = this.#terminate(() => settled);
    }, options.deadlineMs + options.graceMs);
    try {
      const mode =
        options.isolation === undefined
          ? options.access
          : (`${options.access}/${options.isolation}` as const);
      await client.query(BEGIN_STATEMENTS[mode]);
      await applySettings(client, {
        ...options.settings,
        // Ends a backend that traps cancels once its socket is closed, when no terminator got in.
        client_connection_check_interval: "1s",
        statement_timeout: `${options.deadlineMs}ms`,
      });
      const result = await work(client);
      committing = true;
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (committing && fromPostgresError(error).code === "database_unavailable") {
        this.#doomed = true;
        throw new AppDatabaseError({
          cause: error,
          code: "outcome_unknown",
          message:
            "The app database did not confirm COMMIT, so whether the call's changes were saved is unknown.",
        });
      }
      const answering =
        !expired &&
        (await client.query("ROLLBACK").then(
          () => true,
          () => false,
        ));
      if (!answering) this.#doomed = true;
      const cause = error instanceof AppDatabaseError ? error.cause : error;
      if (expired || (cause instanceof pg.DatabaseError && cause.code === "57014")) {
        throw new AppDatabaseError({
          cause: error,
          code: "deadline_exceeded",
          message: `The statement exceeded its ${options.deadlineMs} ms deadline.`,
          statement: error instanceof AppDatabaseError ? error.statement : undefined,
        });
      }
      if (answering && !(error instanceof pg.DatabaseError)) throw error;
      throw fromPostgresError(error);
    } finally {
      clearTimeout(timer);
      settled = true;
      await termination;
    }
  }

  async #terminate(settled: () => boolean) {
    const { client, graceMs } = this;
    const closed = new Promise<void>((resolve) => client.once("end", () => resolve()));
    const terminated = await terminateBackend(this.settings, this.target, this.pid, graceMs).then(
      () => true,
      () => false,
    );
    if (terminated) {
      await answeredWithin(closed, graceMs, silence("with its close", graceMs)).catch(
        () => undefined,
      );
    }
    if (!settled()) await client.end().catch(() => undefined);
  }

  async release(): Promise<void> {
    if (this.#doomed) {
      this.client.release(true);
      return;
    }
    try {
      await answeredWithin(
        this.client.query("DISCARD ALL"),
        this.graceMs,
        silence("DISCARD ALL", this.graceMs),
      );
      this.client.release();
    } catch {
      this.client.release(true);
    }
  }
}

type PoolLimits = Pick<
  AppDatabaseLimits,
  "connectionWaitMs" | "graceMs" | "maxConnectionsPerPool" | "maxConnectionsTotal"
>;

interface PoolEntry {
  readonly database: string;
  readonly pool: pg.Pool;
  readonly size: number;
}

export class AppConnectionPools {
  readonly #pools = new Map<string, PoolEntry>();
  readonly #pids = new WeakMap<pg.PoolClient, number>();
  readonly #waiters = new Set<() => void>();

  constructor(
    private readonly settings: ConnectionSettings,
    private readonly limits: PoolLimits,
  ) {}

  async acquire(
    appId: AppId,
    role: AppRole,
    waitMs = this.limits.connectionWaitMs,
  ): Promise<AppSession> {
    const names = appDatabaseNames(appId);
    const target = { database: names.database, user: names.roles[role] };
    const key = `${target.database}/${target.user}`;
    let entry = this.#pools.get(key);
    if (entry === undefined) {
      const size = this.limits.maxConnectionsPerPool[role];
      const pool = new pg.Pool({
        ...clientConfig(this.settings, target),
        idleTimeoutMillis: 120_000,
        max: size,
      });
      // pg-pool already discards an idle client whose connection failed.
      pool.on("error", () => undefined);
      const wake = () => {
        for (const waiter of this.#waiters) waiter();
      };
      pool.on("release", wake);
      pool.on("remove", wake);
      entry = { database: target.database, pool, size };
    }
    this.#pools.delete(key);
    this.#pools.set(key, entry);
    const { resumeWaitMs } = this.settings;
    const connecting = Date.now();
    let client: pg.PoolClient;
    try {
      client = await connectAwaitingResume(resumeWaitMs, () =>
        this.#connect(entry, waitMs, connecting + resumeWaitMs),
      );
    } catch (error) {
      throw fromPostgresError(error);
    }
    const connectedMs = Date.now() - connecting;
    // Only the resume wait lets a connection take longer than waitMs.
    const resumedMs = resumeWaitMs > 0 && connectedMs > waitMs ? connectedMs : 0;
    try {
      let pid = this.#pids.get(client);
      if (pid === undefined) {
        // pg-pool listens for errors only while a client is idle; a backend ended while it is
        // checked out, such as by the terminator after COMMIT, reports its FATAL here.
        client.on("error", () => undefined);
        const result = await answeredWithin(
          client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"),
          this.limits.graceMs,
          silence("pg_backend_pid()", this.limits.graceMs),
        );
        pid = result.rows[0]?.pid;
        if (pid === undefined) {
          throw new AppDatabaseError({
            code: "postgres_error",
            message: "pg_backend_pid() returned no row.",
          });
        }
        this.#pids.set(client, pid);
      }
      return new AppSession(client, target, pid, this.settings, this.limits.graceMs, resumedMs);
    } catch (error) {
      client.release(true);
      throw fromPostgresError(error);
    }
  }

  /**
   * Room is checked and claimed in the same synchronous step: `pool.connect()` registers a new
   * client before it yields, so the next check already counts it.
   *
   * A resuming database holds a login until it is up, so a new client may wait out the rest of the
   * resume window. Abandoning it would leave it counted in the pool while the next attempt opens
   * another.
   */
  async #connect(entry: PoolEntry, waitMs: number, resumeDeadline: number): Promise<pg.PoolClient> {
    const { pool, size } = entry;
    const started = Date.now();
    const deadline = started + waitMs;
    const loginWaitMs = Math.max(waitMs, resumeDeadline - started);
    for (;;) {
      const reusesClient = pool.idleCount > pool.waitingCount || pool.totalCount >= size;
      const opensClient =
        !reusesClient && this.#openConnections() < this.limits.maxConnectionsTotal;
      if (reusesClient || opensClient) {
        const connecting = pool.connect();
        const answerBy = opensClient ? started + loginWaitMs : deadline;
        return answeredWithin(connecting, Math.max(1, answerBy - Date.now()), () =>
          opensClient
            ? new AppDatabaseError({
                code: "database_unavailable",
                message: `The app database did not accept a connection within ${loginWaitMs} ms.`,
              })
            : new AppDatabaseError({
                code: "connections_exhausted",
                message: `The app's ${size} connections for this role stayed busy for ${waitMs} ms.`,
              }),
        ).catch((error: unknown) => {
          void connecting.then(
            (late) => late.release(),
            () => undefined,
          );
          throw error;
        });
      }
      if (this.#endIdlePool(entry)) continue;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new AppDatabaseError({
          code: "connections_exhausted",
          message: `All ${this.limits.maxConnectionsTotal} app database connections stayed busy for ${waitMs} ms.`,
        });
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.#waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, remaining);
        this.#waiters.add(done);
      });
    }
  }

  #openConnections() {
    let open = 0;
    for (const { pool } of this.#pools.values()) open += pool.totalCount;
    return open;
  }

  #endIdlePool(keep: PoolEntry) {
    for (const [key, entry] of this.#pools) {
      const { pool } = entry;
      if (entry === keep || pool.totalCount === 0 || pool.idleCount < pool.totalCount) continue;
      this.#pools.delete(key);
      void pool.end();
      return true;
    }
    return false;
  }

  async closeApp(appId: AppId): Promise<void> {
    const { database } = appDatabaseNames(appId);
    const closing = [...this.#pools].filter(([, entry]) => entry.database === database);
    for (const [key] of closing) this.#pools.delete(key);
    await Promise.all(closing.map(([, entry]) => entry.pool.end()));
  }

  async close(): Promise<void> {
    const entries = [...this.#pools.values()];
    this.#pools.clear();
    await Promise.all(entries.map((entry) => entry.pool.end()));
  }
}

export async function withAppSession<T>(
  pools: AppConnectionPools,
  appId: AppId,
  role: AppRole,
  work: (session: AppSession) => Promise<T>,
): Promise<T> {
  const session = await pools.acquire(appId, role);
  try {
    return await work(session);
  } finally {
    await session.release();
  }
}
