import type {
  ApiCredentialResponse,
  ServiceAccountResponse,
} from "@deployments-ai/api-contract/tenancy";
import type { OperationAccess } from "../access.ts";

export type ApiKeyView = ApiCredentialResponse;
export type ServiceAccountView = ServiceAccountResponse;
export type AccountStatus = ServiceAccountView["status"];

export const KEY_STATE_ORDER = ["active", "account-disabled", "expired", "revoked"] as const;
export type KeyState = (typeof KEY_STATE_ORDER)[number];
export type KeyAction = "rotate" | "revoke";
export type AccountAction = "issue-key" | "revoke";
export const DIRECTORY_VIEWS = ["active", "all"] as const;
export type DirectoryView = (typeof DIRECTORY_VIEWS)[number];

export const KEY_ACTIONS: Readonly<Record<KeyState, readonly KeyAction[]>> = {
  active: ["rotate", "revoke"],
  "account-disabled": ["revoke"],
  expired: ["revoke"],
  revoked: [],
};

export const ACCOUNT_ACTIONS: Readonly<Record<AccountStatus, readonly AccountAction[]>> = {
  active: ["issue-key", "revoke"],
  archived: [],
  disabled: [],
};

const KEY_ACTION_OPERATIONS = {
  revoke: "revokeApiCredential",
  rotate: "rotateApiCredential",
} as const satisfies Record<KeyAction, keyof OperationAccess>;

const ACCOUNT_ACTION_OPERATIONS = {
  "issue-key": "createApiCredential",
  revoke: "revokeServiceAccount",
} as const satisfies Record<AccountAction, keyof OperationAccess>;

export interface AccountKeys {
  readonly account: ServiceAccountView;
  readonly keys: readonly ApiKeyView[];
}

export interface AccessDirectory {
  readonly accounts: readonly AccountKeys[];
  readonly unassigned: readonly ApiKeyView[];
}

export interface DirectoryPage extends AccessDirectory {
  readonly hidden: number;
  readonly nextOffset?: number;
}

export interface DirectorySearch {
  readonly show?: "all";
}

export interface ScopeGroup {
  readonly namespace: string;
  readonly scopes: readonly string[];
}

export function keyState(
  key: ApiKeyView,
  account: ServiceAccountView | undefined,
  now: Date,
): KeyState {
  if (key.status === "revoked") return "revoked";
  if (account !== undefined && account.status !== "active") return "account-disabled";
  if (key.expiresAt !== undefined && Date.parse(key.expiresAt) <= now.getTime()) return "expired";
  return key.status;
}

export function allowedKeyActions(
  state: KeyState,
  access: Pick<OperationAccess, (typeof KEY_ACTION_OPERATIONS)[KeyAction]>,
): readonly KeyAction[] {
  return KEY_ACTIONS[state].filter((action) => access[KEY_ACTION_OPERATIONS[action]]);
}

export function allowedAccountActions(
  account: ServiceAccountView,
  access: Pick<OperationAccess, (typeof ACCOUNT_ACTION_OPERATIONS)[AccountAction]>,
): readonly AccountAction[] {
  return ACCOUNT_ACTIONS[account.status].filter(
    (action) => access[ACCOUNT_ACTION_OPERATIONS[action]],
  );
}

function sortKeys(keys: readonly ApiKeyView[], account: ServiceAccountView | undefined, now: Date) {
  const rank = (key: ApiKeyView) => KEY_STATE_ORDER.indexOf(keyState(key, account, now));
  return keys.toSorted(
    (left, right) =>
      rank(left) - rank(right) ||
      right.createdAt.localeCompare(left.createdAt) ||
      right.id.localeCompare(left.id),
  );
}

export function groupKeysByAccount(
  accounts: readonly ServiceAccountView[],
  keys: readonly ApiKeyView[],
  now: Date,
): AccessDirectory {
  const byAccount = Map.groupBy(keys, (key) => key.serviceAccountId);
  const listed = new Set(accounts.map((account) => account.id));
  return {
    accounts: accounts
      .toSorted(
        (left, right) =>
          Number(left.status !== "active") - Number(right.status !== "active") ||
          left.name.localeCompare(right.name),
      )
      .map((account) => ({
        account,
        keys: sortKeys(byAccount.get(account.id) ?? [], account, now),
      })),
    unassigned: sortKeys(
      keys.filter((key) => !listed.has(key.serviceAccountId)),
      undefined,
      now,
    ),
  };
}

const VIEW_FILTERS: Readonly<
  Record<DirectoryView, (directory: AccessDirectory) => AccessDirectory>
> = {
  active: ({ accounts, unassigned }) => ({
    accounts: accounts
      .filter(({ account }) => account.status === "active")
      .map(({ account, keys }) => ({
        account,
        keys: keys.filter((key) => key.status !== "revoked"),
      })),
    unassigned: unassigned.filter((key) => key.status !== "revoked"),
  }),
  all: (directory) => directory,
};

export function parseDirectorySearch(search: Readonly<Record<string, unknown>>): DirectorySearch {
  return search.show === "all" ? { show: "all" } : {};
}

export function directoryPage(
  directory: AccessDirectory,
  {
    offset,
    pageSize,
    view,
  }: { readonly offset: number; readonly pageSize: number; readonly view: DirectoryView },
): DirectoryPage {
  const shown = VIEW_FILTERS[view](directory);
  const end = offset + pageSize;
  return {
    accounts: shown.accounts.slice(offset, end),
    hidden: directory.accounts.length - shown.accounts.length,
    unassigned: offset === 0 ? shown.unassigned : [],
    ...(end < shown.accounts.length ? { nextOffset: end } : {}),
  };
}

export function scopeGroups(capabilities: readonly string[]): readonly ScopeGroup[] {
  const byNamespace = new Map<string, string[]>();
  for (const scope of new Set(capabilities)) {
    const separator = scope.indexOf(":");
    const signInProtocolScope = separator < 0;
    const platformAdministration = scope.startsWith("platform:");
    if (signInProtocolScope || platformAdministration) continue;
    const namespace = scope.slice(0, separator);
    byNamespace.set(namespace, [...(byNamespace.get(namespace) ?? []), scope]);
  }
  return [...byNamespace]
    .map(([namespace, scopes]) => ({ namespace, scopes: scopes.toSorted() }))
    .toSorted((left, right) => left.namespace.localeCompare(right.namespace));
}
