import https from "node:https";

export interface ClickHouseConnection {
  readonly ca: string;
  readonly host: string;
  readonly password: string;
  readonly username: string;
}

export interface ClickHouseExecutor {
  readonly execute: (
    sql: string,
    parameters?: Readonly<Record<string, string>>,
    options?: ClickHouseRequestOptions,
  ) => Promise<void>;
  readonly insert: (
    table: string,
    rows: readonly Readonly<Record<string, unknown>>[],
  ) => Promise<void>;
  readonly query: <T extends Readonly<Record<string, unknown>>>(
    sql: string,
    parameters?: Readonly<Record<string, string>>,
  ) => Promise<readonly T[]>;
}

interface ClickHouseRequestOptions {
  /** Idle-socket bound for statements that hold the response open (for example `mutations_sync`). */
  readonly timeoutMs?: number;
}

export class ClickHouseTimeoutError extends Error {
  override readonly name = "ClickHouseTimeoutError";
  constructor() {
    super("ClickHouse request timed out.");
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 25_000;

function request(
  connection: ClickHouseConnection,
  body: string,
  parameters: Readonly<Record<string, string>> = {},
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
) {
  const target = new URL(`https://${connection.host}:8443/`);
  for (const [name, value] of Object.entries(parameters)) {
    if (!/^[a-z][a-z0-9_]*$/u.test(name))
      throw new TypeError(`Invalid ClickHouse parameter ${name}.`);
    target.searchParams.set(`param_${name}`, value);
  }
  return new Promise<string>((resolve, reject) => {
    const operation = https.request(
      target,
      {
        auth: `${connection.username}:${connection.password}`,
        ca: connection.ca,
        headers: {
          "content-length": Buffer.byteLength(body).toString(),
          "content-type": "text/plain; charset=utf-8",
        },
        method: "POST",
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const value = Buffer.concat(chunks).toString("utf8");
          if ((response.statusCode ?? 500) >= 400) {
            reject(
              new Error(`ClickHouse returned ${response.statusCode}: ${value.slice(0, 1_024)}`),
            );
            return;
          }
          resolve(value);
        });
      },
    );
    operation.on("timeout", () => {
      // Bun does not emit "error" for destroy(error); reject explicitly.
      const timeout = new ClickHouseTimeoutError();
      reject(timeout);
      operation.destroy(timeout);
    });
    operation.on("error", reject);
    operation.end(body);
  });
}

export function parseClickHouseJsonRows<T extends Readonly<Record<string, unknown>>>(
  response: string,
): readonly T[] {
  return response
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("ClickHouse returned a non-object JSONEachRow value.");
      }
      return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== null)) as T;
    });
}

export function createClickHouseExecutor(connection: ClickHouseConnection): ClickHouseExecutor {
  return {
    async execute(sql, parameters, options) {
      await request(connection, sql, parameters, options?.timeoutMs);
    },
    async insert(table, rows) {
      if (rows.length === 0) return;
      if (!/^observability\.[a-z_]+$/u.test(table)) throw new TypeError("Invalid insert table.");
      const body = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
      await request(connection, `INSERT INTO ${table} FORMAT JSONEachRow\n${body}`);
    },
    async query<T extends Readonly<Record<string, unknown>>>(sql: string, parameters = {}) {
      const response = await request(
        connection,
        `${sql.trimEnd()}\nFORMAT JSONEachRow`,
        parameters,
      );
      return parseClickHouseJsonRows<T>(response);
    },
  };
}
