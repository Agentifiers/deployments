import {
  ProviderApplicationResponse,
  ProviderConnectionResponse,
} from "@deployments-ai/api-contract/providers";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { ConnectionView } from "./connection-state.ts";
import {
  appActions,
  appChoice,
  authorizationOrder,
  identityCanCollide,
  oauthCallbackUri,
  parseConnectReturn,
  returnToUrl,
  type OAuthAppView,
} from "./oauth.ts";

const OLD = "01K0000000000000000000000X";
const NEW = "01K0000000000000000000000Y";
const UPDATED = "2026-09-10T12:00:00.000Z";
const SCOPE = {
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G600E",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G600C",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G600D",
};
const EVERY_APP_ACTION = {
  archiveProviderApplication: true,
  rotateProviderApplicationSecret: true,
};

function connection(status: string, externalAccountId?: string): ConnectionView {
  return Schema.decodeUnknownSync(ProviderConnectionResponse)({
    authMethod: "oauth",
    createdAt: "2026-09-01T00:00:00.000Z",
    displayName: "QA ads",
    hasCredential: true,
    id: OLD,
    providerKey: "google_ads",
    scopes: ["openid"],
    status,
    updatedAt: UPDATED,
    version: 3,
    ...(externalAccountId === undefined ? {} : { externalAccountId }),
  });
}

function app(status: string, hasClientSecret = true): OAuthAppView {
  return Schema.decodeUnknownSync(ProviderApplicationResponse)({
    clientId: "qa-client",
    createdAt: UPDATED,
    displayName: "QA ads",
    hasClientSecret,
    id: NEW,
    providerKey: "google_ads",
    redirectUris: [],
    requestedScopes: ["openid"],
    status,
    updatedAt: UPDATED,
    version: 0,
  });
}

describe("appActions", () => {
  test("rotates a secret-bearing active app and archives anything not archived", () => {
    expect(appActions(app("active"), EVERY_APP_ACTION)).toEqual(["rotate", "archive"]);
    expect(appActions(app("active", false), EVERY_APP_ACTION)).toEqual(["archive"]);
    expect(appActions(app("archived"), EVERY_APP_ACTION)).toEqual([]);
    expect(
      appActions(app("active"), {
        archiveProviderApplication: false,
        rotateProviderApplicationSecret: false,
      }),
    ).toEqual([]);
  });
});

describe("appChoice", () => {
  const listed = (id: string, providerKey: string, status: string): OAuthAppView =>
    Schema.decodeUnknownSync(ProviderApplicationResponse)({
      clientId: `client-${id}`,
      createdAt: UPDATED,
      displayName: "QA app",
      hasClientSecret: true,
      id,
      providerKey,
      redirectUris: [],
      requestedScopes: [],
      status,
      updatedAt: UPDATED,
      version: 0,
    });
  const A = listed(OLD, "github", "active");
  const B = listed(NEW, "github", "active");
  const C = listed("01K0000000000000000000000Z", "github", "archived");

  test("uses the only active app, asks among several, and needs one only where required", () => {
    const github = { key: "github", requiresApp: true };
    expect(appChoice([A, B, C], github, undefined)).toEqual({ active: [A, B], kind: "choose" });
    expect(appChoice([A, B, C], github, NEW)).toEqual({ active: [A, B], app: B, kind: "chosen" });
    expect(appChoice([A, B, C], github, C.id)).toEqual({ active: [A, B], kind: "choose" });
    expect(appChoice([A, C], github, C.id)).toEqual({ active: [A], app: A, kind: "chosen" });
    expect(appChoice([A, B], { key: "google_ads", requiresApp: true }, undefined)).toEqual({
      kind: "missing",
    });
    expect(appChoice([A, B], { key: "linear", requiresApp: false }, undefined)).toEqual({
      kind: "platform",
    });
  });
});

describe("identityCanCollide", () => {
  test("only a provider account claim can collide", () => {
    expect(
      [undefined, "", "mcp:01K0000000000000000000ATT", OLD, "user-42"].map((account) =>
        identityCanCollide(connection("active", account)),
      ),
    ).toEqual([false, false, false, false, true]);
  });
});

describe("authorizationOrder", () => {
  test("authorizes first when the old connection cannot hold the account", () => {
    expect(authorizationOrder(connection("disconnected", "user-42"), UPDATED)).toEqual({
      kind: "authorize-first",
    });
    expect(
      authorizationOrder(connection("active", "mcp:01K0000000000000000000ATT"), UPDATED),
    ).toEqual({ kind: "authorize-first" });
  });

  test("lets the operator choose for an active connection with a provider account", () => {
    expect(authorizationOrder(connection("active", "user-42"), UPDATED)).toEqual({
      kind: "choose",
    });
  });

  test("revokes first once a denied connection has settled, and waits while it may refresh", () => {
    const required = connection("reauthorization-required", "user-42");
    expect(authorizationOrder(required, "2026-09-10T12:10:00.000Z")).toEqual({
      kind: "revoke-first",
    });
    expect(authorizationOrder(required, "2026-09-10T12:00:30.000Z")).toEqual({
      kind: "wait",
      until: "2026-09-10T12:02:00.000Z",
    });
    expect(authorizationOrder(connection("error", "user-42"), "2026-09-10T12:00:30.000Z")).toEqual({
      kind: "revoke-first",
    });
  });
});

describe("oauthCallbackUri", () => {
  test("joins the channel API origin and the provider's callback key", () => {
    expect(
      oauthCallbackUri("https://abc.execute-api.us-east-2.amazonaws.com", {
        callbackKey: "notion",
      }),
    ).toEqual({
      complete: true,
      uri: "https://abc.execute-api.us-east-2.amazonaws.com/public/provider-connections/oauth/callback/notion",
    });
    expect(oauthCallbackUri(undefined, { callbackKey: "google-calendar" })).toEqual({
      complete: false,
      uri: "<channel API origin>/public/provider-connections/oauth/callback/google-calendar",
    });
  });
});

describe("returnToUrl", () => {
  test("returns to the landing page, carrying a rebind's old connection and since", () => {
    expect(returnToUrl("https://app.example.com", SCOPE, { kind: "connect" })).toBe(
      "https://app.example.com/o/01ARZ3NDEKTSV4RRFFQ69G600C/p/01ARZ3NDEKTSV4RRFFQ69G600D/e/01ARZ3NDEKTSV4RRFFQ69G600E/connections/authorized",
    );
    expect(
      returnToUrl("https://app.example.com", SCOPE, {
        kind: "rebind",
        oldConnectionId: OLD,
        since: UPDATED,
      }),
    ).toBe(
      "https://app.example.com/o/01ARZ3NDEKTSV4RRFFQ69G600C/p/01ARZ3NDEKTSV4RRFFQ69G600D/e/01ARZ3NDEKTSV4RRFFQ69G600E/connections/authorized?rebind=01K0000000000000000000000X&since=2026-09-10T12%3A00%3A00.000Z",
    );
    expect(
      returnToUrl("https://app.example.com", SCOPE, {
        kind: "rebind",
        oldConnectionId: OLD,
        since: UPDATED,
        skip: [NEW],
      }),
    ).toBe(
      "https://app.example.com/o/01ARZ3NDEKTSV4RRFFQ69G600C/p/01ARZ3NDEKTSV4RRFFQ69G600D/e/01ARZ3NDEKTSV4RRFFQ69G600E/connections/authorized?rebind=01K0000000000000000000000X&since=2026-09-10T12%3A00%3A00.000Z&skip=%5B%2201K0000000000000000000000Y%22%5D",
    );
  });
});

describe("parseConnectReturn", () => {
  test("reads the callback's result and the rebind it returns to", () => {
    expect(parseConnectReturn({ connection_id: NEW, provider: "google_ads" })).toEqual({
      result: { connectionId: NEW, kind: "connected" },
    });
    expect(
      parseConnectReturn({ error: "access_denied", rebind: OLD, since: "2026-09-10T12:00:00Z" }),
    ).toEqual({
      rebind: { oldConnectionId: OLD, since: UPDATED },
      result: { error: "access_denied", kind: "failed" },
    });
    expect(parseConnectReturn({ connection_id: NEW, rebind: OLD, since: "yesterday" })).toEqual({
      rebind: { oldConnectionId: OLD },
      result: { connectionId: NEW, kind: "connected" },
    });
    expect(parseConnectReturn({ connection_id: "x", error: "server_error", rebind: "x" })).toEqual({
      result: { kind: "none" },
    });
  });
});
