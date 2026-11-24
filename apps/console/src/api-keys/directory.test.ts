import {
  ApiCredentialResponse,
  ServiceAccountResponse,
} from "@deployments-ai/api-contract/tenancy";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  allowedAccountActions,
  allowedKeyActions,
  directoryPage,
  groupKeysByAccount,
  keyState,
  parseDirectorySearch,
  scopeGroups,
  type ApiKeyView,
  type DirectoryPage,
  type ServiceAccountView,
} from "./directory.ts";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const TENANT = {
  environmentId: "01K0000000000000000000000E",
  organizationId: "01K0000000000000000000000A",
  projectId: "01K0000000000000000000000B",
};

function account(
  id: string,
  name: string,
  status: ServiceAccountView["status"] = "active",
): ServiceAccountView {
  return Schema.decodeUnknownSync(ServiceAccountResponse)({
    ...TENANT,
    createdAt: "2026-09-01T00:00:00.000Z",
    id,
    name,
    scopes: ["runs:read", "runs:write"],
    status,
    updatedAt: "2026-09-01T00:00:00.000Z",
    version: 1,
  });
}

function key(
  id: string,
  serviceAccountId: string,
  createdAt: string,
  fields: Partial<Pick<ApiKeyView, "expiresAt" | "status">> = {},
): ApiKeyView {
  return Schema.decodeUnknownSync(ApiCredentialResponse)({
    ...TENANT,
    createdAt,
    id,
    keyPrefix: `dpl_${id.slice(-4)}`,
    name: `key ${id.slice(-4)}`,
    scopes: ["runs:read"],
    serviceAccountId,
    status: "active",
    updatedAt: createdAt,
    version: 1,
    ...fields,
  });
}

const ALPHA = "01K00000000000000000000SA1";
const BETA = "01K00000000000000000000SA2";
const GAMMA = "01K00000000000000000000SA3";
const DELTA = "01K00000000000000000000SA4";
const EPSILON = "01K00000000000000000000SA5";
const GONE = "01K00000000000000000000SA9";
const KEY = "01K0000000000000000000K000";

describe("groupKeysByAccount", () => {
  test("orders accounts active first then by name, keys by state then newest", () => {
    const directory = groupKeysByAccount(
      [account(ALPHA, "worker", "disabled"), account(BETA, "billing"), account(GAMMA, "api")],
      [
        key("01K0000000000000000000K001", BETA, "2026-09-02T00:00:00.000Z"),
        key("01K0000000000000000000K002", BETA, "2026-09-03T00:00:00.000Z", {
          status: "revoked",
        }),
        key("01K0000000000000000000K003", BETA, "2026-09-04T00:00:00.000Z"),
        key("01K0000000000000000000K004", BETA, "2026-09-05T00:00:00.000Z", {
          expiresAt: "2026-10-01T00:00:00.000Z",
        }),
        key("01K0000000000000000000K005", ALPHA, "2026-09-06T00:00:00.000Z"),
        key("01K0000000000000000000K006", GONE, "2026-09-07T00:00:00.000Z"),
      ],
      NOW,
    );
    expect(
      directory.accounts.map(({ account, keys }) => [
        account.name,
        keys.map((entry) => entry.name),
      ]),
    ).toEqual([
      ["api", []],
      ["billing", ["key K003", "key K001", "key K004", "key K002"]],
      ["worker", ["key K005"]],
    ]);
    expect(directory.unassigned.map((entry) => entry.name)).toEqual(["key K006"]);
  });
});

describe("keyState", () => {
  const active = account(BETA, "billing");
  const disabled = account(BETA, "billing", "disabled");
  const created = "2026-09-01T00:00:00.000Z";

  test("revoked beats a disabled account and a past expiry", () => {
    const revoked = key(KEY, BETA, created, {
      expiresAt: "2026-09-02T00:00:00.000Z",
      status: "revoked",
    });
    expect(keyState(revoked, disabled, NOW)).toBe("revoked");
  });

  test("a disabled or archived account beats a past expiry", () => {
    const expired = key(KEY, BETA, created, { expiresAt: "2026-09-02T00:00:00.000Z" });
    expect(keyState(expired, disabled, NOW)).toBe("account-disabled");
    expect(keyState(expired, account(BETA, "billing", "archived"), NOW)).toBe("account-disabled");
  });

  test("a key stops at its expiry instant even while its stored status is active", () => {
    expect(keyState(key(KEY, BETA, created, { expiresAt: NOW.toISOString() }), active, NOW)).toBe(
      "expired",
    );
    expect(
      keyState(key(KEY, BETA, created, { expiresAt: "2026-10-05T12:00:00.001Z" }), active, NOW),
    ).toBe("active");
  });

  test("otherwise the stored status decides, also for keys of unlisted accounts", () => {
    expect(keyState(key(KEY, BETA, created, { status: "expired" }), active, NOW)).toBe("expired");
    expect(keyState(key(KEY, GONE, created), undefined, NOW)).toBe("active");
  });
});

describe("allowed actions", () => {
  const everything = {
    createApiCredential: true,
    revokeApiCredential: true,
    revokeServiceAccount: true,
    rotateApiCredential: true,
  };

  test("key actions follow the state and the caller's access", () => {
    expect(allowedKeyActions("active", everything)).toEqual(["rotate", "revoke"]);
    expect(allowedKeyActions("active", { ...everything, rotateApiCredential: false })).toEqual([
      "revoke",
    ]);
    expect(allowedKeyActions("account-disabled", everything)).toEqual(["revoke"]);
    expect(allowedKeyActions("expired", everything)).toEqual(["revoke"]);
    expect(allowedKeyActions("revoked", everything)).toEqual([]);
  });

  test("only an active account issues keys or can be revoked", () => {
    expect(allowedAccountActions(account(BETA, "billing"), everything)).toEqual([
      "issue-key",
      "revoke",
    ]);
    expect(
      allowedAccountActions(account(BETA, "billing"), {
        ...everything,
        createApiCredential: false,
      }),
    ).toEqual(["revoke"]);
    expect(allowedAccountActions(account(BETA, "billing", "disabled"), everything)).toEqual([]);
    expect(allowedAccountActions(account(BETA, "billing", "archived"), everything)).toEqual([]);
  });
});

describe("directoryPage", () => {
  const directory = groupKeysByAccount(
    [
      account(ALPHA, "worker", "disabled"),
      account(BETA, "billing"),
      account(GAMMA, "api"),
      account(DELTA, "ops", "archived"),
      account(EPSILON, "cron"),
    ],
    [
      key("01K0000000000000000000K001", BETA, "2026-09-02T00:00:00.000Z"),
      key("01K0000000000000000000K002", BETA, "2026-09-03T00:00:00.000Z", { status: "revoked" }),
      key("01K0000000000000000000K004", BETA, "2026-09-05T00:00:00.000Z", {
        expiresAt: "2026-10-01T00:00:00.000Z",
      }),
      key("01K0000000000000000000K005", ALPHA, "2026-09-06T00:00:00.000Z"),
      key("01K0000000000000000000K006", GONE, "2026-09-07T00:00:00.000Z"),
      key("01K0000000000000000000K007", GONE, "2026-09-08T00:00:00.000Z", { status: "revoked" }),
    ],
    NOW,
  );

  function summary(page: DirectoryPage) {
    return {
      accounts: page.accounts.map(({ account, keys }) => [
        account.name,
        keys.map((entry) => entry.name),
      ]),
      hidden: page.hidden,
      nextOffset: page.nextOffset,
      unassigned: page.unassigned.map((entry) => entry.name),
    };
  }

  test("the active view keeps active accounts and expired keys, drops revoked keys, and counts the hidden accounts", () => {
    expect(summary(directoryPage(directory, { offset: 0, pageSize: 25, view: "active" }))).toEqual({
      accounts: [
        ["api", []],
        ["billing", ["key K001", "key K004"]],
        ["cron", []],
      ],
      hidden: 2,
      nextOffset: undefined,
      unassigned: ["key K006"],
    });
  });

  test("a page holds pageSize accounts from its offset, and unassigned keys come only with the first page", () => {
    expect(summary(directoryPage(directory, { offset: 0, pageSize: 2, view: "active" }))).toEqual({
      accounts: [
        ["api", []],
        ["billing", ["key K001", "key K004"]],
      ],
      hidden: 2,
      nextOffset: 2,
      unassigned: ["key K006"],
    });
    expect(summary(directoryPage(directory, { offset: 2, pageSize: 2, view: "active" }))).toEqual({
      accounts: [["cron", []]],
      hidden: 2,
      nextOffset: undefined,
      unassigned: [],
    });
  });

  test("a page that ends exactly at the last account has no next offset", () => {
    expect(directoryPage(directory, { offset: 0, pageSize: 3, view: "active" })).not.toHaveProperty(
      "nextOffset",
    );
    expect(directoryPage(directory, { offset: 1, pageSize: 1, view: "active" })).toHaveProperty(
      "nextOffset",
      2,
    );
  });

  test("the all view lists every account with every key and hides nothing", () => {
    expect(summary(directoryPage(directory, { offset: 0, pageSize: 25, view: "all" }))).toEqual({
      accounts: [
        ["api", []],
        ["billing", ["key K001", "key K004", "key K002"]],
        ["cron", []],
        ["ops", []],
        ["worker", ["key K005"]],
      ],
      hidden: 0,
      nextOffset: undefined,
      unassigned: ["key K006", "key K007"],
    });
    expect(summary(directoryPage(directory, { offset: 4, pageSize: 2, view: "all" }))).toEqual({
      accounts: [["worker", ["key K005"]]],
      hidden: 0,
      nextOffset: undefined,
      unassigned: [],
    });
  });
});

test("parseDirectorySearch keeps show=all and drops every other value, so the active view is the bare path", () => {
  expect(parseDirectorySearch({ show: "all" })).toEqual({ show: "all" });
  expect(parseDirectorySearch({ show: "active" })).toEqual({});
  expect(parseDirectorySearch({ show: "revoked" })).toEqual({});
});

test("scopeGroups drops platform and sign-in scopes and groups the rest by namespace", () => {
  expect(
    scopeGroups([
      "runs:write",
      "agents:read",
      "platform:admin",
      "openid",
      "runs:read",
      "runs:write",
      "agent-email:admin",
      "offline_access",
      "runs:*",
    ]),
  ).toEqual([
    { namespace: "agent-email", scopes: ["agent-email:admin"] },
    { namespace: "agents", scopes: ["agents:read"] },
    { namespace: "runs", scopes: ["runs:*", "runs:read", "runs:write"] },
  ]);
});
