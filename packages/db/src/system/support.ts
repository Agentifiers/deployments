import { PersistenceError } from "../persistence-types.ts";

const DEFAULT_SYSTEM_PAGE_LIMIT = 50;
const MAX_CURSOR_LENGTH = 4_096;

export interface SystemPageOptions {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface SystemPage<Item> {
  readonly items: readonly Item[];
  readonly nextCursor?: string;
}

export async function runSystemPersistence<A>(operation: string, promise: Promise<A>): Promise<A> {
  try {
    return await promise;
  } catch (cause) {
    if (cause instanceof PersistenceError) throw cause;
    throw new PersistenceError("internal", "persistence_error", `Failed to ${operation}.`);
  }
}

export function systemPageLimit(limit: number | undefined) {
  const value = limit ?? DEFAULT_SYSTEM_PAGE_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new PersistenceError(
      "invalid-input",
      "invalid_limit",
      "limit must be an integer from 1 through 100.",
    );
  }
  return value;
}

export function encodeSystemCursor(lastEvaluatedKey: Readonly<Record<string, unknown>>) {
  return Buffer.from(JSON.stringify(lastEvaluatedKey)).toString("base64url");
}

/** Decodes a page cursor that must continue the given partition and carry only string keys. */
export function decodeSystemCursor(
  cursor: string | undefined,
  expected: { readonly partition: string; readonly partitionField: string },
): Record<string, string> | undefined {
  if (cursor === undefined) return undefined;
  const reject = (): never => {
    throw new PersistenceError(
      "invalid-input",
      "invalid_cursor",
      "The page cursor is invalid for this list.",
    );
  };
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) reject();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    reject();
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) reject();
  const value = decoded as Record<string, unknown>;
  if (
    Object.values(value).some((entry) => typeof entry !== "string") ||
    value[expected.partitionField] !== expected.partition
  ) {
    reject();
  }
  return value as Record<string, string>;
}
