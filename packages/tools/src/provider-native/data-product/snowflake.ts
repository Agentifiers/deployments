import {
  jsonProviderNativeBody,
  optionalToolObject,
  optionalToolString,
  requirePositiveLimit,
  requireProviderBaseUrl,
  requireToolString,
  sqlCodeWithoutCommentsAndLiterals,
  type ProviderNativeHttpToolDefinition,
} from "../core.ts";

function snowflakeBase(input: Record<string, unknown>): URL {
  return requireProviderBaseUrl(input, "accountUrl", "snowflake");
}

function snowflakeStatementBody(
  input: Record<string, unknown>,
  statement: string,
): ReturnType<typeof jsonProviderNativeBody> {
  return jsonProviderNativeBody({
    statement,
    timeout: requirePositiveLimit(input, "timeout", 45, 120),
    ...(optionalToolString(input, "database")
      ? { database: optionalToolString(input, "database") }
      : {}),
    ...(optionalToolString(input, "schema") ? { schema: optionalToolString(input, "schema") } : {}),
    ...(optionalToolString(input, "warehouse")
      ? { warehouse: optionalToolString(input, "warehouse") }
      : {}),
    ...(optionalToolString(input, "role") ? { role: optionalToolString(input, "role") } : {}),
    ...(optionalToolObject(input, "bindings")
      ? { bindings: optionalToolObject(input, "bindings") }
      : {}),
  });
}

function requireReadOnlySql(input: Record<string, unknown>): string {
  const statement = requireToolString(input, "statement");
  const normalized = sqlCodeWithoutCommentsAndLiterals(statement).trim().toUpperCase();
  if (!/^(SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN)\b/u.test(normalized)) {
    throw new Error(
      "Tool input statement must be a read-only SELECT, WITH, SHOW, DESCRIBE, or EXPLAIN query",
    );
  }
  if (
    /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|COPY|PUT|REMOVE|GRANT|REVOKE|CALL)\b/iu.test(
      normalized,
    )
  ) {
    throw new Error("Tool input statement contains a disallowed write or administrative operation");
  }
  return statement;
}

function snowflakeCatalogStatement(input: Record<string, unknown>): string {
  const resource = optionalToolString(input, "resource") ?? "databases";
  if (resource === "databases") return "SHOW DATABASES";
  if (resource === "schemas") return "SHOW SCHEMAS";
  if (resource === "tables") return "SHOW TABLES";
  if (resource === "warehouses") return "SHOW WAREHOUSES";
  throw new Error("Tool input resource must be databases, schemas, tables, or warehouses");
}

export const snowflakeNativeHttpToolDefinitions: readonly ProviderNativeHttpToolDefinition[] = [
  {
    toolName: "snowflake.catalog.list",
    description: "List Snowflake databases, schemas, tables, or warehouses.",
    effect: "read",
    provider: "snowflake",
    requiredScopes: [],
    defaultPolicyAction: "allow",
    method: "POST",
    filePrefix: "snowflake-catalog-list",
    buildUrl: (input) => new URL("/api/v2/statements", snowflakeBase(input)).toString(),
    buildBody: (input) => snowflakeStatementBody(input, snowflakeCatalogStatement(input)),
  },
  {
    toolName: "snowflake.query.execute",
    description:
      "Execute a SELECT-like Snowflake SQL statement after approval; use a connector restricted to a read-only Snowflake role.",
    effect: "execute",
    provider: "snowflake",
    requiredScopes: [],
    defaultPolicyAction: "require_approval",
    method: "POST",
    filePrefix: "snowflake-query-read",
    buildUrl: (input) => new URL("/api/v2/statements", snowflakeBase(input)).toString(),
    buildBody: (input) => snowflakeStatementBody(input, requireReadOnlySql(input)),
  },
  {
    toolName: "snowflake.statements.get",
    description: "Poll a Snowflake SQL API statement by handle.",
    effect: "read",
    provider: "snowflake",
    requiredScopes: [],
    defaultPolicyAction: "allow",
    method: "GET",
    filePrefix: "snowflake-statement",
    buildUrl: (input) =>
      new URL(
        `/api/v2/statements/${encodeURIComponent(requireToolString(input, "statementHandle"))}`,
        snowflakeBase(input),
      ).toString(),
  },
];
