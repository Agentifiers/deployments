import { DatabaseError } from "pg";

export type AppDatabaseErrorCode =
  | "connections_exhausted"
  | "database_unavailable"
  | "deadline_exceeded"
  | "function_not_allowed"
  | "function_not_found"
  | "idempotency_conflict"
  | "invalid_arguments"
  | "key_value_store_conflict"
  | "outcome_unknown"
  | "postgres_error"
  | "provision_incomplete"
  | "result_too_large"
  | "sql_rejected"
  | "visitor_not_allowed";

export class AppDatabaseError extends Error {
  override readonly name = "AppDatabaseError";
  readonly code: AppDatabaseErrorCode;
  readonly statement: string | undefined;

  constructor(input: {
    readonly code: AppDatabaseErrorCode;
    readonly message: string;
    readonly statement?: string | undefined;
    readonly cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.code = input.code;
    this.statement = input.statement;
  }
}

const CONNECTION_EXCEPTION_CLASS = "08";
const SESSION_REFUSAL_SQLSTATES: Readonly<Record<string, string>> = {
  "53300": "too_many_connections",
  "57P01": "admin_shutdown",
  "57P02": "crash_shutdown",
  "57P03": "cannot_connect_now",
};

export function fromPostgresError(error: unknown, statement?: string): AppDatabaseError {
  if (error instanceof AppDatabaseError) return error;
  if (!(error instanceof DatabaseError)) {
    return new AppDatabaseError({
      cause: error,
      code: "database_unavailable",
      message: `The app database did not answer: ${error instanceof Error ? error.message : String(error)}`,
      statement,
    });
  }
  const lines = [error.message];
  if (error.detail) lines.push(`DETAIL: ${error.detail}`);
  if (error.hint) lines.push(`HINT: ${error.hint}`);
  const sqlState = error.code ?? "";
  return new AppDatabaseError({
    cause: error,
    code:
      sqlState.startsWith(CONNECTION_EXCEPTION_CLASS) ||
      Object.hasOwn(SESSION_REFUSAL_SQLSTATES, sqlState)
        ? "database_unavailable"
        : "postgres_error",
    message: lines.join("\n"),
    statement,
  });
}
