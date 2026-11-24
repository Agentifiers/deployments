/** Longest operator statement the guard accepts, in characters. */
export const MAX_QUERY_LENGTH = 20_000;

/**
 * Words that start or smuggle a statement other than a read. They are rejected anywhere outside
 * a string literal or a quoted identifier, so a read cannot hide a write, a DDL statement, an
 * UNLOAD export, a partition repair, or an external Lambda function call.
 */
const FORBIDDEN_WORDS: Readonly<Record<string, true>> = {
  alter: true,
  call: true,
  commit: true,
  create: true,
  deallocate: true,
  delete: true,
  describe: true,
  drop: true,
  execute: true,
  explain: true,
  external: true,
  grant: true,
  insert: true,
  merge: true,
  msck: true,
  optimize: true,
  prepare: true,
  repair: true,
  reset: true,
  revoke: true,
  rollback: true,
  show: true,
  start: true,
  truncate: true,
  unload: true,
  update: true,
  use: true,
  vacuum: true,
};

export class UnsafeQueryError extends Error {
  override readonly name = "UnsafeQueryError";
}

type TokenKind = "number" | "quoted" | "symbol" | "word";

interface Token {
  readonly depth: number;
  readonly end: number;
  readonly kind: TokenKind;
  readonly start: number;
  readonly text: string;
}

function quotedEnd(sql: string, start: number, quote: string) {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === quote) {
      if (sql[index + 1] !== quote) return index + 1;
      index += 2;
    } else {
      index += 1;
    }
  }
  throw new UnsafeQueryError("The query has an unterminated quoted string or identifier.");
}

function runEnd(sql: string, start: number, pattern: RegExp) {
  let index = start;
  while (index < sql.length && pattern.test(sql[index] ?? "")) index += 1;
  return index;
}

/** Splits SQL into tokens outside literals, rejecting comments and constructs it cannot judge. */
function tokenize(sql: string): readonly Token[] {
  const tokens: Token[] = [];
  let depth = 0;
  let index = 0;
  while (index < sql.length) {
    const character = sql[index] ?? "";
    const next = sql[index + 1];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if ((character === "-" && next === "-") || (character === "/" && next === "*")) {
      throw new UnsafeQueryError("Comments are not allowed in operator queries.");
    }
    if (character === "`") {
      throw new UnsafeQueryError('Backtick identifiers are not allowed; quote identifiers with ".');
    }
    let end: number;
    let kind: TokenKind;
    if (character === "'" || character === '"') {
      end = quotedEnd(sql, index, character);
      kind = "quoted";
    } else if (/[A-Za-z_]/u.test(character)) {
      end = runEnd(sql, index, /[A-Za-z0-9_$]/u);
      kind = "word";
    } else if (/[0-9]/u.test(character)) {
      end = runEnd(sql, index, /[0-9.eE]/u);
      kind = "number";
    } else {
      end = index + 1;
      kind = "symbol";
      if (character === ")") depth -= 1;
      if (depth < 0) throw new UnsafeQueryError("The query has unbalanced parentheses.");
    }
    const text = sql.slice(index, end);
    tokens.push({
      depth,
      end,
      kind,
      start: index,
      text: kind === "word" ? text.toLowerCase() : text,
    });
    if (character === "(") depth += 1;
    index = end;
  }
  if (depth !== 0) throw new UnsafeQueryError("The query has unbalanced parentheses.");
  return tokens;
}

export interface GuardedQuery {
  /** The statement Athena runs, with a LIMIT of at most `maxRows + 1`. */
  readonly sql: string;
  /** The LIMIT the guarded statement carries. One more than `maxRows` reveals truncation. */
  readonly limit: number;
}

/**
 * Accepts one read-only SELECT or WITH statement and caps its result. A trailing top-level LIMIT
 * at or below `maxRows` stays; a larger one, `LIMIT ALL`, or none becomes `LIMIT maxRows + 1` so
 * the caller can report that rows were cut off.
 */
export function guardReadOnlyQuery(sql: string, maxRows: number): GuardedQuery {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) {
    throw new RangeError("maxRows must be a positive integer.");
  }
  if (sql.length > MAX_QUERY_LENGTH) {
    throw new UnsafeQueryError(`Queries are limited to ${String(MAX_QUERY_LENGTH)} characters.`);
  }
  const all = tokenize(sql);
  const last = all.at(-1);
  const tokens = last?.kind === "symbol" && last.text === ";" ? all.slice(0, -1) : all;
  const statement = sql.slice(0, tokens.at(-1)?.end ?? 0);
  if (tokens.some((token) => token.kind === "symbol" && token.text === ";")) {
    throw new UnsafeQueryError("Run one statement at a time.");
  }
  const first = tokens.find((token) => !(token.kind === "symbol" && token.text === "("));
  if (first?.kind !== "word" || (first.text !== "select" && first.text !== "with")) {
    throw new UnsafeQueryError("Only SELECT and WITH queries are allowed.");
  }
  const forbidden = tokens.find(
    (token) => token.kind === "word" && Object.hasOwn(FORBIDDEN_WORDS, token.text),
  );
  if (forbidden) {
    throw new UnsafeQueryError(
      `${forbidden.text.toUpperCase()} is not allowed; operator queries are read-only.`,
    );
  }
  const topLevel = tokens.filter((token) => token.depth === 0);
  if (topLevel.some((token) => token.kind === "word" && token.text === "fetch")) {
    throw new UnsafeQueryError("Use LIMIT instead of FETCH.");
  }

  const cap = maxRows + 1;
  const [limitWord, limitValue] = topLevel.slice(-2);
  if (limitWord?.kind === "word" && limitWord.text === "limit" && limitValue) {
    const requested =
      limitValue.kind === "number" && /^[0-9]+$/u.test(limitValue.text)
        ? Number(limitValue.text)
        : limitValue.kind === "word" && limitValue.text === "all"
          ? Number.POSITIVE_INFINITY
          : undefined;
    if (requested === undefined) {
      throw new UnsafeQueryError("LIMIT must be a whole number or ALL.");
    }
    const limit = requested <= maxRows ? requested : cap;
    return {
      limit,
      sql: `${statement.slice(0, limitValue.start)}${String(limit)}`,
    };
  }
  if (topLevel.some((token) => token.kind === "word" && token.text === "limit")) {
    throw new UnsafeQueryError("LIMIT must end the query.");
  }
  return { limit: cap, sql: `${statement}\nLIMIT ${String(cap)}` };
}
