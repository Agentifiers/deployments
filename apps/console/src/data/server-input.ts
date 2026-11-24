/**
 * Server functions are callable with arbitrary payloads, so their validators re-check every
 * field before the handler calls the platform API.
 */

import { SCOPE_FIELDS, type EnvironmentScope } from "../scope.ts";

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const MAX_IDEMPOTENCY_KEY_LENGTH = 512;
const MAX_CURSOR_LENGTH = 8_192;

export interface ScopedInput {
  readonly scope: EnvironmentScope;
}

export interface KeyedInput extends ScopedInput {
  readonly idempotencyKey: string;
}

export interface PageInput extends ScopedInput {
  readonly cursor?: string;
}

export function fields(input: unknown): Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}

/** The named fields, each required to be a platform ULID. */
export function requireIds<const Field extends string>(input: unknown, names: readonly Field[]) {
  const record = fields(input);
  const ids = {} as Record<Field, string>;
  for (const name of names) {
    const value = record[name];
    if (typeof value !== "string" || !ULID.test(value)) {
      throw new TypeError(`${name} must be a ULID.`);
    }
    ids[name] = value;
  }
  return ids;
}

/** The named optional fields, each a list of platform ULIDs when present. */
export function optionalIdLists<const Field extends string>(
  input: unknown,
  names: readonly Field[],
): Partial<Record<Field, readonly string[]>> {
  const record = fields(input);
  const lists: Partial<Record<Field, readonly string[]>> = {};
  for (const name of names) {
    const value: unknown = record[name];
    if (value === undefined) continue;
    if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && ULID.test(id))) {
      throw new TypeError(`${name} must be a list of ULIDs.`);
    }
    lists[name] = value;
  }
  return lists;
}

/** The mutation's `idempotencyKey`, which the console generates once per dialog open. */
export function requireIdempotencyKey(input: unknown): string {
  const value = fields(input).idempotencyKey;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDEMPOTENCY_KEY_LENGTH
  ) {
    throw new TypeError("idempotencyKey must be a non-empty string of at most 512 characters.");
  }
  return value;
}

export function instantInput(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${name} must be an ISO 8601 UTC instant.`);
  }
  return value;
}

/** The request body; the handler decodes it against the operation's contract schema. */
export function requireBody(input: unknown): unknown {
  const body = fields(input).body;
  if (typeof body !== "object" || body === null) throw new TypeError("body must be an object.");
  return body;
}

export function scopedInput<const Field extends string = never>(
  input: unknown,
  ids: readonly Field[] = [],
): ScopedInput & Readonly<Record<Field, string>> {
  return { ...requireIds(input, ids), scope: requireIds(fields(input).scope, SCOPE_FIELDS) };
}

export function keyedInput<const Field extends string = never>(
  input: unknown,
  ids: readonly Field[] = [],
): KeyedInput & Readonly<Record<Field, string>> {
  return { ...scopedInput(input, ids), idempotencyKey: requireIdempotencyKey(input) };
}

function optionalCursor(input: unknown): { readonly cursor?: string } {
  const { cursor } = fields(input);
  if (
    cursor !== undefined &&
    (typeof cursor !== "string" || cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH)
  ) {
    throw new TypeError("cursor must be a non-empty string of at most 8192 characters.");
  }
  return cursor === undefined ? {} : { cursor };
}

export function pageInput<const Field extends string = never>(
  input: unknown,
  ids: readonly Field[] = [],
): PageInput & Readonly<Record<Field, string>> {
  return { ...scopedInput(input, ids), ...optionalCursor(input) };
}

/** Tenant levels above the environment; each route sends only the headers its level allows. */
const LEVEL_FIELDS = {
  none: [],
  organization: ["organizationId"],
  project: ["organizationId", "projectId"],
} as const satisfies Readonly<Record<string, readonly (typeof SCOPE_FIELDS)[number][]>>;

export type ScopeLevel = keyof typeof LEVEL_FIELDS;

export type ScopeAt<Level extends ScopeLevel> = Readonly<
  Record<(typeof LEVEL_FIELDS)[Level][number], string>
>;

export interface KeyedInputAt<Level extends ScopeLevel> {
  readonly idempotencyKey: string;
  readonly scope: ScopeAt<Level>;
}

export interface PageInputAt<Level extends ScopeLevel> {
  readonly cursor?: string;
  readonly scope: ScopeAt<Level>;
}

function scopeAt<Level extends ScopeLevel>(level: Level, input: unknown): ScopeAt<Level> {
  return requireIds(fields(input).scope, LEVEL_FIELDS[level]);
}

/** `keyedInput` for organization- and project-level mutations; deeper scope fields are dropped. */
export function keyedInputAt<Level extends ScopeLevel, const Field extends string = never>(
  level: Level,
  input: unknown,
  ids: readonly Field[] = [],
): KeyedInputAt<Level> & Readonly<Record<Field, string>> {
  return {
    ...requireIds(input, ids),
    idempotencyKey: requireIdempotencyKey(input),
    scope: scopeAt(level, input),
  };
}

export function pageInputAt<Level extends ScopeLevel>(
  level: Level,
  input: unknown,
): PageInputAt<Level> {
  return { ...optionalCursor(input), scope: scopeAt(level, input) };
}
