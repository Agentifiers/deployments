import { Schema } from "effect";
import type { AppDatabaseErrorCode } from "./errors.ts";
import { AppId, AppSlug, CALLABLE_SCHEMAS, PgName } from "./names.ts";

export { AppId, AppSlug } from "./names.ts";

function text(maxLength: number) {
  return Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(maxLength)));
}

export const ExportId = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[0-9A-HJKMNP-TV-Z]{26}$/u, {
      message: "Export ids are 26-character ULIDs in canonical uppercase Crockford base32.",
    }),
  ),
  Schema.brand("ExportId"),
);
export type ExportId = typeof ExportId.Type;

export const AppsDatabaseRequest = Schema.Union([
  Schema.Struct({ appId: AppId, op: Schema.Literal("provision"), slug: AppSlug }),
  Schema.Struct({
    appId: AppId,
    description: text(500),
    idempotencyKey: text(200),
    op: Schema.Literal("migrate"),
    sql: text(1_000_000),
  }),
  Schema.Struct({
    appId: AppId,
    maxRows: Schema.Number.pipe(
      Schema.check(Schema.isInt(), Schema.isBetween({ maximum: 1000, minimum: 1 })),
    ),
    op: Schema.Literal("query"),
    sql: text(100_000),
  }),
  Schema.Struct({ appId: AppId, op: Schema.Literal("describe") }),
  Schema.Struct({ appId: AppId, exportId: ExportId, op: Schema.Literal("export") }),
  Schema.Struct({ appId: AppId, op: Schema.Literal("erase"), slug: AppSlug }),
]);
export type AppsDatabaseRequest = typeof AppsDatabaseRequest.Type;

export const VISITOR_DATABASE_LAYOUT = 2;

export const ProvisionResult = Schema.Struct({
  appId: AppId,
  database: PgName,
  roles: Schema.Struct({ editor: PgName, owner: PgName, viewer: PgName, visitor: PgName }),
  slug: AppSlug,
});
export type ProvisionResult = typeof ProvisionResult.Type;

export const MigrateResult = Schema.Struct({
  appliedAt: Schema.String,
  migrationId: Schema.Number,
  replayed: Schema.Boolean,
});
export type MigrateResult = typeof MigrateResult.Type;

const TypedName = Schema.Struct({ name: Schema.String, type: Schema.String });

export const QueryResult = Schema.Struct({
  columns: Schema.Array(TypedName),
  rows: Schema.Array(Schema.Array(Schema.NullOr(Schema.String))),
  truncated: Schema.Boolean,
});
export type QueryResult = typeof QueryResult.Type;

export const DescribedRelation = Schema.Struct({
  columns: Schema.Array(
    Schema.Struct({
      default: Schema.NullOr(Schema.String),
      generated: Schema.NullOr(Schema.String),
      identity: Schema.NullOr(Schema.Literals(["always", "by default"])),
      name: Schema.String,
      nullable: Schema.Boolean,
      type: Schema.String,
    }),
  ),
  constraints: Schema.Array(
    Schema.Struct({ definition: Schema.String, kind: Schema.String, name: Schema.String }),
  ),
  definition: Schema.NullOr(Schema.String),
  indexes: Schema.Array(Schema.Struct({ definition: Schema.String, name: Schema.String })),
  kind: Schema.Literals(["table", "partitioned table", "view", "materialized view"]),
  name: Schema.String,
  policies: Schema.Array(
    Schema.Struct({
      command: Schema.Literals(["all", "select", "insert", "update", "delete"]),
      name: Schema.String,
      permissive: Schema.Boolean,
      roles: Schema.Array(Schema.String),
      using: Schema.NullOr(Schema.String),
      withCheck: Schema.NullOr(Schema.String),
    }),
  ),
  rowSecurity: Schema.Struct({ enabled: Schema.Boolean, forced: Schema.Boolean }),
  schema: Schema.String,
});
export type DescribedRelation = typeof DescribedRelation.Type;

export const DescribedApiFunction = Schema.Struct({
  arguments: Schema.Array(
    Schema.Struct({ hasDefault: Schema.Boolean, name: Schema.String, type: Schema.String }),
  ),
  name: Schema.String,
  returns: Schema.Struct({
    columns: Schema.Array(TypedName),
    set: Schema.Boolean,
    shape: Schema.Literals(["void", "scalar", "row", "record"]),
    type: Schema.NullOr(Schema.String),
  }),
  schema: Schema.Literals(CALLABLE_SCHEMAS),
  volatility: Schema.Literals(["immutable", "stable", "volatile"]),
});
export type DescribedApiFunction = typeof DescribedApiFunction.Type;

export const AppDescription = Schema.Struct({
  client: Schema.String,
  functions: Schema.Array(DescribedApiFunction),
  migrations: Schema.Array(
    Schema.Struct({
      appliedAt: Schema.String,
      description: Schema.String,
      id: Schema.Number,
      idempotencyKey: Schema.String,
    }),
  ),
  relations: Schema.Array(DescribedRelation),
});
export type AppDescription = typeof AppDescription.Type;

export const ExportResult = Schema.Struct({
  objects: Schema.Array(
    Schema.Struct({ key: Schema.String, rows: Schema.Number, table: Schema.String }),
  ),
});
export type ExportResult = typeof ExportResult.Type;

export const EraseResult = Schema.Struct({
  appId: AppId,
  database: PgName,
  objectsDeleted: Schema.Number,
  roles: Schema.Array(PgName),
});
export type EraseResult = typeof EraseResult.Type;

export type AppsDatabaseErrorCode = AppDatabaseErrorCode | "internal_error" | "invalid_request";

export const RETRYABLE_ERROR_CODES: Readonly<Record<AppsDatabaseErrorCode, boolean>> = {
  connections_exhausted: true,
  database_unavailable: true,
  deadline_exceeded: true,
  function_not_allowed: false,
  function_not_found: false,
  idempotency_conflict: false,
  internal_error: true,
  invalid_arguments: false,
  invalid_request: false,
  key_value_store_conflict: true,
  outcome_unknown: true,
  postgres_error: false,
  provision_incomplete: false,
  result_too_large: false,
  sql_rejected: false,
  visitor_not_allowed: false,
};

export const AppsDatabaseFailure = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String.pipe(
      Schema.refine((code): code is AppsDatabaseErrorCode =>
        Object.hasOwn(RETRYABLE_ERROR_CODES, code),
      ),
    ),
    message: Schema.String,
    statement: Schema.optionalKey(Schema.String),
  }),
  ok: Schema.Literal(false),
});
export type AppsDatabaseFailure = typeof AppsDatabaseFailure.Type;

function responseOf<Value extends Schema.Constraint>(value: Value) {
  return Schema.Union([Schema.Struct({ ok: Schema.Literal(true), value }), AppsDatabaseFailure]);
}

export const AppsDatabaseResponse = {
  describe: responseOf(AppDescription),
  erase: responseOf(EraseResult),
  export: responseOf(ExportResult),
  migrate: responseOf(MigrateResult),
  provision: responseOf(ProvisionResult),
  query: responseOf(QueryResult),
} satisfies Record<AppsDatabaseRequest["op"], Schema.Constraint>;
export type AppsDatabaseResponse<Op extends AppsDatabaseRequest["op"]> =
  (typeof AppsDatabaseResponse)[Op]["Type"];
export type AppsDatabaseValue = Extract<
  AppsDatabaseResponse<AppsDatabaseRequest["op"]>,
  { readonly ok: true }
>["value"];

export function appObjectPrefix(appId: AppId): string {
  return `apps/${appId}/`;
}

export function exportPrefix(appId: AppId, exportId: ExportId): string {
  return `${appObjectPrefix(appId)}exports/${exportId}`;
}
