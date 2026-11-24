import type { Ulid } from "./ids.ts";
import { requiredField, type KeyableRecord } from "./record-key-fields.ts";

type ScopeIdField = "environmentId" | "projectId" | "workspaceId";

/**
 * The identifier fields each usage scope level carries, ancestors included, most general level
 * first. Record filters, key parts, and the scope chain all derive from this registry.
 */
export const SCOPE_LEVEL_IDS = {
  organization: [],
  project: ["projectId"],
  environment: ["projectId", "environmentId"],
  workspace: ["projectId", "environmentId", "workspaceId"],
} as const satisfies Record<string, readonly ScopeIdField[]>;

export type ScopeLevel = keyof typeof SCOPE_LEVEL_IDS;
export const SCOPE_LEVELS = Object.keys(SCOPE_LEVEL_IDS) as readonly ScopeLevel[];
const SCOPE_ID_FIELDS: readonly ScopeIdField[] = [
  ...new Set(Object.values(SCOPE_LEVEL_IDS).flat()),
];

const SCOPE_KEY_PREFIXES = {
  environment: "ENV",
  organization: "ORGANIZATION",
  project: "PROJECT",
  workspace: "WORKSPACE",
} as const satisfies Record<ScopeLevel, string>;

/** One spend-tracked, budgetable scope. Each level names its ancestors, so a target is its fields. */
export type ScopeTarget = {
  readonly [Level in ScopeLevel]: { readonly scope: Level } & {
    readonly [Field in (typeof SCOPE_LEVEL_IDS)[Level][number]]: Ulid;
  };
}[ScopeLevel];

/**
 * The full scope of one meter event or run. `workspaceId` is a required key whose value may be
 * undefined, so every constructor states whether the usage belongs to a workspace.
 */
export interface UsageScope {
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly workspaceId: Ulid | undefined;
}

/** The usage scope of any record or input that carries the workspace scope fields. */
export function usageScopeOf(
  data: Omit<UsageScope, "workspaceId"> & { readonly workspaceId?: Ulid | undefined },
): UsageScope {
  return {
    environmentId: data.environmentId,
    organizationId: data.organizationId,
    projectId: data.projectId,
    workspaceId: data.workspaceId,
  };
}

function scopeTargetAt(level: ScopeLevel, idOf: (field: ScopeIdField) => Ulid): ScopeTarget {
  return Object.fromEntries([
    ["scope", level],
    ...SCOPE_LEVEL_IDS[level].map((field) => [field, idOf(field)]),
  ]) as ScopeTarget;
}

/**
 * The targets a scope's spend counts toward and whose budgets govern it, most specific first: every
 * level whose identifiers the scope names, so a scope without a workspace stops at its environment.
 */
export function scopeChain(scope: UsageScope): readonly ScopeTarget[] {
  return SCOPE_LEVELS.toReversed().flatMap((level) => {
    const fields: readonly ScopeIdField[] = SCOPE_LEVEL_IDS[level];
    return fields.every((field) => scope[field] !== undefined)
      ? [scopeTargetAt(level, (field) => scope[field]!)]
      : [];
  });
}

type ScopeFields<Id extends string> = { readonly scope: ScopeLevel } & {
  readonly [Field in ScopeIdField]?: Id | undefined;
};

/** Whether a scope-carrying record names exactly the identifier fields of its level. */
export function scopeFieldsMatch(data: ScopeFields<string>): boolean {
  const required: readonly ScopeIdField[] = SCOPE_LEVEL_IDS[data.scope];
  return SCOPE_ID_FIELDS.every((field) => (data[field] !== undefined) === required.includes(field));
}

function isScopeLevel(value: string): value is ScopeLevel {
  return Object.hasOwn(SCOPE_LEVEL_IDS, value);
}

/**
 * The target a stored budget or spend shard names. Keys are derived before the record schema
 * runs, so this reads the level's identifier fields as strings and leaves validating them to it.
 */
export function scopeTargetOfRecord(record: KeyableRecord): ScopeTarget {
  const scope = requiredField(record, "scope");
  if (!isScopeLevel(scope)) throw new TypeError(`Unknown scope level ${scope}.`);
  return scopeTargetAt(scope, (field) => requiredField(record, field) as Ulid);
}

/**
 * Key segments of a target inside its organization: `ORGANIZATION`, `PROJECT#<id>`, `ENV#<id>`,
 * or `WORKSPACE#<id>`. Only the innermost id keys a partition; ancestors are data.
 */
export function scopeKeyParts(target: ScopeTarget): readonly string[] {
  const prefix = SCOPE_KEY_PREFIXES[target.scope];
  const innermost = SCOPE_LEVEL_IDS[target.scope].at(-1);
  const fields: ScopeFields<Ulid> = target;
  const id = innermost && fields[innermost];
  return id ? [prefix, id] : [prefix];
}
