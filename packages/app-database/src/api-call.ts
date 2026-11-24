import type pg from "pg";
import { loadApiCatalog, type ApiFunction } from "./api-catalog.ts";
import { AppDatabaseError, fromPostgresError } from "./errors.ts";
import type { AppDatabaseLimits } from "./limits.ts";
import type { ApiCallerRole, AppId } from "./names.ts";
import type { AppConnectionPools } from "./session.ts";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface ApiPrincipal {
  readonly id: string;
  readonly email: string | null;
}

export type ApiCaller =
  | { readonly role: Exclude<ApiCallerRole, "visitor">; readonly principal: ApiPrincipal }
  | { readonly role: "visitor"; readonly principal?: undefined };

export type ApiCallInput = ApiCaller & {
  readonly appId: AppId;
  readonly appIsPublic: boolean;
  readonly functionName: string;
  readonly args: Readonly<Record<string, JsonValue>>;
  /**
   * Bounds the whole call below `apiDeadlineMs`, connection wait included. A connection that
   * waited out a database resume does not count that wait, so the call keeps its full deadline.
   */
  readonly deadlineMs?: number;
};

export interface ApiCallResult {
  readonly rows: readonly JsonValue[];
}

interface CatalogEntry {
  readonly version: number;
  readonly functions: ReadonlyMap<string, ApiFunction>;
}

export interface ApiSession {
  readonly role: ApiCallerRole;
  readonly access: "read only" | "read write";
}

type AttemptOutcome =
  | { readonly kind: "done"; readonly result: ApiCallResult }
  | { readonly kind: "switch-session"; readonly session: ApiSession; readonly deadline: number };

const APP_FUNCTION_SEARCH_PATH = "public";

function quoteIdentifier(name: string) {
  return `"${name.replaceAll('"', '""')}"`;
}

function qualifiedName(fn: ApiFunction) {
  return `${fn.schema}.${fn.name}`;
}

function visitorRefusal(functionName: string) {
  return new AppDatabaseError({
    code: "visitor_not_allowed",
    message: `Visitors cannot call ${JSON.stringify(functionName)}; only the visitor functions of a public app are open to them.`,
  });
}

export function apiSessionFor(input: ApiCallInput, fn: ApiFunction): ApiSession | AppDatabaseError {
  const access = fn.volatility === "volatile" ? "read write" : "read only";
  if (fn.schema === "visitor" && input.appIsPublic) return { access, role: "visitor" };
  if (input.role === "visitor") return visitorRefusal(input.functionName);
  if (fn.volatility !== "volatile") return { access, role: "viewer" };
  if (input.role === "viewer") {
    return new AppDatabaseError({
      code: "function_not_allowed",
      message: `${qualifiedName(fn)} is volatile and needs editor access.`,
    });
  }
  return { access, role: "editor" };
}

function bindArguments(fn: ApiFunction, args: ApiCallInput["args"]) {
  const known = new Map(fn.arguments.map((argument) => [argument.name, argument]));
  const unknownNames = Object.keys(args).filter((name) => !known.has(name));
  if (unknownNames.length > 0) {
    throw new AppDatabaseError({
      code: "invalid_arguments",
      message: `${qualifiedName(fn)} has no argument ${unknownNames.join(", ")}; it takes ${fn.arguments.map((argument) => argument.name).join(", ") || "no arguments"}.`,
    });
  }
  const missing = fn.arguments.filter(
    (argument) => !argument.hasDefault && !Object.hasOwn(args, argument.name),
  );
  if (missing.length > 0) {
    throw new AppDatabaseError({
      code: "invalid_arguments",
      message: `${qualifiedName(fn)} requires ${missing.map((argument) => argument.name).join(", ")}.`,
    });
  }
  const provided = fn.arguments.filter((argument) => Object.hasOwn(args, argument.name));
  const values = provided.map((argument) => {
    const value = args[argument.name] ?? null;
    const isJson = argument.type.base.name === "json" || argument.type.base.name === "jsonb";
    return isJson && value !== null ? JSON.stringify(value) : value;
  });
  const parameters = provided.map(
    (argument, index) => `${quoteIdentifier(argument.name)} => $${index + 1}::${argument.type.sql}`,
  );
  return {
    expression: `${fn.schema}.${quoteIdentifier(fn.name)}(${parameters.join(", ")})`,
    values,
  };
}

function capResultBytes(
  call: { readonly expression: string; readonly values: readonly JsonValue[] },
  maxBytes: number,
) {
  const limit = `$${call.values.length + 1}::integer`;
  return {
    sql: `SELECT octet_length(result) AS bytes, CASE WHEN octet_length(result) <= ${limit} THEN result END AS rows
FROM (SELECT coalesce(json_agg(r), '[]'::json)::text AS result FROM ${call.expression} AS r) AS called`,
    values: [...call.values, maxBytes],
  };
}

export class ApiFunctionCaller {
  readonly #catalogs = new Map<AppId, CatalogEntry>();

  constructor(
    private readonly pools: AppConnectionPools,
    private readonly limits: AppDatabaseLimits,
  ) {}

  async call(input: ApiCallInput): Promise<ApiCallResult> {
    if (input.role === "visitor" && !input.appIsPublic) throw visitorRefusal(input.functionName);
    const deadline =
      input.deadlineMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + input.deadlineMs;
    const cached = this.#catalogs.get(input.appId)?.functions.get(input.functionName);
    const guess = cached === undefined ? undefined : apiSessionFor(input, cached);
    const session: ApiSession =
      guess === undefined || guess instanceof AppDatabaseError
        ? { access: "read only", role: input.role === "visitor" ? "visitor" : "viewer" }
        : guess;
    const first = await this.#attempt(input, session, deadline);
    if (first.kind === "done") return first.result;
    const second = await this.#attempt(input, first.session, first.deadline);
    if (second.kind === "done") return second.result;
    throw new AppDatabaseError({
      code: "postgres_error",
      message: `${input.functionName} changed during the call; retry.`,
    });
  }

  async #attempt(
    input: ApiCallInput,
    session: ApiSession,
    callDeadline: number,
  ): Promise<AttemptOutcome> {
    const appSession = await this.pools.acquire(
      input.appId,
      session.role,
      Math.min(this.limits.connectionWaitMs, callDeadline - Date.now()),
    );
    const deadline = callDeadline + appSession.resumedMs;
    try {
      return await appSession.transaction(
        {
          access: session.access,
          deadlineMs: Math.max(1, Math.min(this.limits.apiDeadlineMs, deadline - Date.now())),
          graceMs: this.limits.graceMs,
          settings: {
            "app.principal_email": input.principal?.email ?? "",
            "app.principal_id": input.principal?.id ?? "",
            lock_timeout: this.limits.apiLockTimeout,
            search_path: APP_FUNCTION_SEARCH_PATH,
            work_mem: this.limits.apiWorkMem,
          },
        },
        async (client) => {
          const fn = await this.#resolve(client, input);
          const required = apiSessionFor(input, fn);
          if (required instanceof AppDatabaseError) throw required;
          if (required.role !== session.role || required.access !== session.access) {
            return { deadline, kind: "switch-session", session: required };
          }
          const call = capResultBytes(bindArguments(fn, input.args), this.limits.apiResultMaxBytes);
          const result = await client
            .query<{ bytes: number; rows: string | null }>(call.sql, call.values)
            .catch((error: unknown) => {
              throw fromPostgresError(error, qualifiedName(fn));
            });
          const { bytes, rows } = result.rows[0] ?? { bytes: 2, rows: "[]" };
          if (rows === null) {
            throw new AppDatabaseError({
              code: "result_too_large",
              message: `${qualifiedName(fn)} returned ${bytes} bytes of JSON, over the ${this.limits.apiResultMaxBytes}-byte limit; return fewer or smaller rows per call and page through the rest.`,
              statement: qualifiedName(fn),
            });
          }
          const parsed: JsonValue = JSON.parse(rows);
          if (!Array.isArray(parsed)) {
            throw new TypeError(`${qualifiedName(fn)} returned JSON that is not an array.`);
          }
          return { kind: "done", result: { rows: fn.result.kind === "void" ? [] : parsed } };
        },
      );
    } finally {
      await appSession.release();
    }
  }

  async #resolve(client: pg.ClientBase, input: ApiCallInput): Promise<ApiFunction> {
    const version = await client.query<{ version: number }>(
      "SELECT coalesce(max(id), 0)::integer AS version FROM platform.migrations",
    );
    const current = version.rows[0]?.version ?? 0;
    let entry = this.#catalogs.get(input.appId);
    if (entry === undefined || entry.version !== current) {
      await client.query("SELECT set_config('search_path', 'pg_catalog', true)");
      const functions = await loadApiCatalog(client);
      await client.query("SELECT set_config('search_path', $1, true)", [APP_FUNCTION_SEARCH_PATH]);
      entry = { functions: new Map(functions.map((fn) => [fn.name, fn])), version: current };
      this.#catalogs.set(input.appId, entry);
    }
    const fn = entry.functions.get(input.functionName);
    if (fn !== undefined) return fn;
    if (input.role === "visitor") throw visitorRefusal(input.functionName);
    throw new AppDatabaseError({
      code: "function_not_found",
      message: `The api and visitor schemas have no function named ${JSON.stringify(input.functionName)}.`,
    });
  }
}
