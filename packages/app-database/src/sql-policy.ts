import { hasSqlDetails, parse, type Node, type ParseResult } from "libpg-query";
import { AppDatabaseError } from "./errors.ts";
import { CALLABLE_SCHEMAS } from "./names.ts";

export interface ParsedStatement {
  readonly text: string;
  readonly node: Node;
}

const EXTENSIONS_MANAGED =
  "Extensions are managed by the platform; pgcrypto, citext, and pg_trgm are already installed.";
const ROLES_MANAGED = "Role and privilege statements are not allowed; the platform manages roles.";
const SCHEMAS_MANAGED =
  "Schemas are managed by the platform; DROP SCHEMA and ALTER SCHEMA ... RENAME are not allowed.";

// Matched anywhere in the tree, because CREATE SCHEMA, CREATE RULE, and EXPLAIN can nest statements.
const MIGRATION_FORBIDDEN_NODES: Readonly<Record<string, string>> = {
  AlterDefaultPrivilegesStmt: ROLES_MANAGED,
  AlterExtensionContentsStmt: EXTENSIONS_MANAGED,
  AlterExtensionStmt: EXTENSIONS_MANAGED,
  AlterRoleSetStmt: ROLES_MANAGED,
  AlterRoleStmt: ROLES_MANAGED,
  CopyStmt: "COPY is not allowed in a migration.",
  CreateExtensionStmt: EXTENSIONS_MANAGED,
  CreateRoleStmt: ROLES_MANAGED,
  DeclareCursorStmt: "Cursors are not allowed in a migration.",
  DoStmt: "DO blocks are not allowed; write the logic as SQL statements or a function.",
  DropOwnedStmt: ROLES_MANAGED,
  DropRoleStmt: ROLES_MANAGED,
  GrantRoleStmt: ROLES_MANAGED,
  GrantStmt: ROLES_MANAGED,
  ListenStmt: "LISTEN, UNLISTEN, and NOTIFY are not allowed.",
  NotifyStmt: "LISTEN, UNLISTEN, and NOTIFY are not allowed.",
  ReassignOwnedStmt: ROLES_MANAGED,
  TransactionStmt:
    "Transaction control is not allowed; the platform runs each migration in one transaction.",
  UnlistenStmt: "LISTEN, UNLISTEN, and NOTIFY are not allowed.",
};

const QUERY_FORBIDDEN_NODES: Readonly<Record<string, string>> = {
  CopyStmt: "COPY is not supported by app.query.",
  TransactionStmt: "Transaction control is not allowed; app.query runs in a read-only transaction.",
};

const ROLE_SWITCH_SETTINGS: Readonly<Record<string, true>> = {
  role: true,
  session_authorization: true,
};

async function parseStatements(sql: string): Promise<readonly ParsedStatement[]> {
  let result: ParseResult;
  try {
    result = await parse(sql);
  } catch (error) {
    const position = hasSqlDetails(error)
      ? ` at character ${error.sqlDetails.cursorPosition + 1}`
      : "";
    throw new AppDatabaseError({
      cause: error,
      code: "sql_rejected",
      message: `${error instanceof Error ? error.message : String(error)}${position}`,
    });
  }
  // libpg_query reports byte offsets into the UTF-8 encoding of the source.
  const source = Buffer.from(sql, "utf8");
  return (result.stmts ?? []).flatMap(({ stmt, stmt_len, stmt_location }) => {
    if (stmt === undefined) return [];
    const start = stmt_location ?? 0;
    const end = stmt_len === undefined || stmt_len === 0 ? source.length : start + stmt_len;
    return [{ node: stmt, text: source.subarray(start, end).toString("utf8").trim() }];
  });
}

function reject(statement: ParsedStatement, reason: string): never {
  throw new AppDatabaseError({ code: "sql_rejected", message: reason, statement: statement.text });
}

function visitNodes(value: unknown, visit: (tag: string, body: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visitNodes(item, visit);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    visit(key, child);
    visitNodes(child, visit);
  }
}

function checkNestedNodes(statement: ParsedStatement, forbidden: Readonly<Record<string, string>>) {
  visitNodes(statement.node, (tag, body) => {
    if (Object.hasOwn(forbidden, tag)) reject(statement, forbidden[tag] ?? tag);
    if (
      tag === "VariableSetStmt" &&
      typeof body === "object" &&
      body !== null &&
      "name" in body &&
      typeof body.name === "string" &&
      Object.hasOwn(ROLE_SWITCH_SETTINGS, body.name)
    ) {
      reject(statement, "SET ROLE and SET SESSION AUTHORIZATION are not allowed.");
    }
  });
}

function definitionOptions(options: readonly Node[] | undefined) {
  return (options ?? []).flatMap((option) => ("DefElem" in option ? [option.DefElem] : []));
}

function isSecurityDefiner(options: readonly Node[] | undefined): boolean {
  return definitionOptions(options).some(
    (option) =>
      option.defname === "security" &&
      option.arg !== undefined &&
      "Boolean" in option.arg &&
      option.arg.Boolean.boolval === true,
  );
}

function checkFunctionDefinition(statement: ParsedStatement) {
  const { node } = statement;
  if ("AlterFunctionStmt" in node && isSecurityDefiner(node.AlterFunctionStmt.actions)) {
    reject(statement, "SECURITY DEFINER functions are not allowed.");
  }
  if (!("CreateFunctionStmt" in node)) return;
  const definition = node.CreateFunctionStmt;
  if (isSecurityDefiner(definition.options)) {
    reject(statement, "SECURITY DEFINER functions are not allowed.");
  }
  const nameParts = (definition.funcname ?? []).flatMap((part) =>
    "String" in part && part.String.sval !== undefined ? [part.String.sval] : [],
  );
  const schema = CALLABLE_SCHEMAS.find((callable) => callable === nameParts.at(-2));
  if (schema === undefined) return;
  const language = definitionOptions(definition.options).find(
    (option) => option.defname === "language",
  )?.arg;
  const isSqlLanguage =
    language !== undefined && "String" in language && language.String.sval === "sql";
  const hasAtomicBody = definition.sql_body !== undefined && "List" in definition.sql_body;
  if (definition.is_procedure === true || !isSqlLanguage || !hasAtomicBody) {
    reject(
      statement,
      `Functions in the ${schema} schema must be LANGUAGE sql functions with a BEGIN ATOMIC ... END body.`,
    );
  }
}

function checkManagedObject(statement: ParsedStatement) {
  const { node } = statement;
  if ("DropStmt" in node && node.DropStmt.removeType === "OBJECT_EXTENSION") {
    reject(statement, EXTENSIONS_MANAGED);
  }
  if ("DropStmt" in node && node.DropStmt.removeType === "OBJECT_SCHEMA") {
    reject(statement, SCHEMAS_MANAGED);
  }
  if ("RenameStmt" in node && node.RenameStmt.renameType === "OBJECT_SCHEMA") {
    reject(statement, SCHEMAS_MANAGED);
  }
}

export async function parseMigration(sql: string): Promise<readonly ParsedStatement[]> {
  const statements = await parseStatements(sql);
  if (statements.length === 0) {
    throw new AppDatabaseError({
      code: "sql_rejected",
      message: "The migration has no statements.",
    });
  }
  for (const statement of statements) {
    checkNestedNodes(statement, MIGRATION_FORBIDDEN_NODES);
    checkFunctionDefinition(statement);
    checkManagedObject(statement);
  }
  return statements;
}

export async function parseSingleQuery(sql: string): Promise<ParsedStatement> {
  const statements = await parseStatements(sql);
  const [statement] = statements;
  if (statement === undefined || statements.length > 1) {
    throw new AppDatabaseError({
      code: "sql_rejected",
      message: `app.query runs exactly one statement; this SQL has ${statements.length}.`,
    });
  }
  checkNestedNodes(statement, QUERY_FORBIDDEN_NODES);
  return statement;
}
