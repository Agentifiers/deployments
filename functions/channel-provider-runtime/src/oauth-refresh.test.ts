import { describe, expect, test } from "bun:test";
import type { OAuthRefreshClaimTarget } from "@deployments-ai/db";
import { ProviderApplicationRecord, withCanonicalRecordKeys } from "@deployments-ai/db";
import {
  CODE_PROVIDER_DEFINITION_INPUTS,
  OAUTH_REFRESH_REQUEST_KIND,
  parsePlatformOAuthAppRegistry,
  type OAuthRefreshRequest,
} from "@deployments-ai/providers";
import { Schema } from "effect";

import {
  OAUTH_REFRESH_POLL_INTERVAL_MS,
  refreshOAuthConnection,
  refreshOAuthConnectionRoute,
  type OAuthRefreshDependencies,
} from "./oauth-refresh.ts";
import {
  CONNECTION_CREDENTIAL_ID,
  CONNECTION_ID,
  NOW,
  formBody,
  jsonResponse,
  oauthHarness,
  putRecord,
  SCOPE,
  seedVendorConnection,
  storedConnection,
  ulid,
  type OAuthHarness,
} from "./oauth-test-support.ts";

const OWNER = "lambda-request-1";

function request(expectedGeneration: number): OAuthRefreshRequest {
  return {
    ...SCOPE,
    connectionId: CONNECTION_ID,
    expectedGeneration,
    kind: OAUTH_REFRESH_REQUEST_KIND,
    requestedBy: "worker",
  };
}

function refreshHarness(
  claim: "acquired" | "held",
  harness: OAuthHarness = oauthHarness(),
  onSleep: (count: number) => void = () => undefined,
) {
  const acquired: OAuthRefreshClaimTarget[] = [];
  const released: OAuthRefreshClaimTarget[] = [];
  let sleeps = 0;
  const dependencies: OAuthRefreshDependencies = {
    ...harness.dependencies,
    claims: {
      acquire: async (input) => {
        acquired.push(input);
        return claim;
      },
      release: async (input) => {
        released.push(input);
      },
    },
    sleep: async (ms) => {
      sleeps += 1;
      harness.clock = new Date(harness.clock.getTime() + ms);
      onSleep(sleeps);
    },
  };
  return { acquired, dependencies, harness, released, sleeps: () => sleeps };
}

describe("internal oauth-refresh handler", () => {
  test("returns the current reference without claiming when another refresher advanced it", async () => {
    const state = refreshHarness("acquired");
    seedVendorConnection(state.harness, { generation: 4, refreshToken: "refresh-4" });
    expect(await refreshOAuthConnection(request(3), state.dependencies, OWNER)).toEqual({
      reference: { credentialId: CONNECTION_CREDENTIAL_ID, generation: 4, store: "dynamodb-kms" },
      refreshAfter: NOW.toISOString(),
      status: "current",
    });
    expect(state.acquired).toEqual([]);
    expect(state.harness.fetches).toEqual([]);
  });

  test("polls while another refresher holds the claim and returns its new reference", async () => {
    const state = refreshHarness("held", oauthHarness(), (count) => {
      if (count === 3) {
        seedVendorConnection(state.harness, { generation: 4, refreshToken: "refresh-4" });
      }
    });
    seedVendorConnection(state.harness, { generation: 3, refreshToken: "refresh-3" });
    const result = await refreshOAuthConnection(request(3), state.dependencies, OWNER);
    expect(result).toMatchObject({ reference: { generation: 4 }, status: "current" });
    expect(state.sleeps()).toBe(3);
    expect(state.harness.fetches).toEqual([]);
    expect(state.released).toEqual([]);
  });

  test("gives up as retryable when the held claim never advances", async () => {
    const state = refreshHarness("held");
    seedVendorConnection(state.harness, { generation: 3, refreshToken: "refresh-3" });
    expect(await refreshOAuthConnection(request(3), state.dependencies, OWNER)).toMatchObject({
      code: "refresh_in_progress",
      status: "retryable",
    });
    expect(state.sleeps()).toBe(10_000 / OAUTH_REFRESH_POLL_INTERVAL_MS);
    expect(state.harness.fetches).toEqual([]);
  });

  test("refreshes a vendor MCP connection once under the claim and releases it", async () => {
    const state = refreshHarness("acquired");
    seedVendorConnection(state.harness, { generation: 3, refreshToken: "refresh-3" });
    state.harness.respond = async () =>
      jsonResponse({ access_token: "access-4", expires_in: 600, refresh_token: "refresh-4" });
    const result = await refreshOAuthConnection(request(3), state.dependencies, OWNER);
    expect(result).toMatchObject({
      reference: { credentialId: CONNECTION_CREDENTIAL_ID, generation: 4 },
      status: "refreshed",
    });
    expect(result).toHaveProperty("refreshAfter");
    expect(state.acquired).toMatchObject([
      { connectionId: CONNECTION_ID, credentialGeneration: 3, leaseMs: 30_000, owner: OWNER },
    ]);
    expect(state.released).toMatchObject([{ credentialGeneration: 3, owner: OWNER }]);
    expect(state.harness.mutations).toHaveLength(1);
    expect(storedConnection(state.harness).data.status).toBe("active");
  });

  test("marks the connection for reauthorization on invalid_grant", async () => {
    const state = refreshHarness("acquired");
    const reference = seedVendorConnection(state.harness, {
      generation: 3,
      refreshToken: "refresh-3",
    });
    state.harness.respond = async () => jsonResponse({ error: "invalid_grant" }, 400);
    expect(await refreshOAuthConnection(request(3), state.dependencies, OWNER)).toMatchObject({
      code: "oauth_refresh_rejected",
      status: "reauthorization_required",
    });
    expect(state.harness.marks).toEqual([
      { connectionId: CONNECTION_ID, credentialRef: reference, scope: SCOPE },
    ]);
    expect(state.harness.mutations).toEqual([]);
    expect(state.released).toHaveLength(1);
  });

  for (const [label, respond] of [
    ["a 5xx token endpoint", async () => new Response("down", { status: 503 })],
    [
      "a network failure",
      async () => {
        throw new TypeError("fetch failed");
      },
    ],
  ] as const) {
    test(`is retryable on ${label} without marking the connection`, async () => {
      const state = refreshHarness("acquired");
      seedVendorConnection(state.harness, { generation: 3, refreshToken: "refresh-3" });
      state.harness.respond = respond;
      expect(await refreshOAuthConnection(request(3), state.dependencies, OWNER)).toMatchObject({
        status: "retryable",
      });
      expect(state.harness.marks).toEqual([]);
      expect(state.released).toHaveLength(1);
    });
  }

  test("is not refreshable without a refresh token", async () => {
    const state = refreshHarness("acquired");
    seedVendorConnection(state.harness, { generation: 3 });
    expect(await refreshOAuthConnection(request(3), state.dependencies, OWNER)).toMatchObject({
      code: "oauth_refresh_token_missing",
      status: "not_refreshable",
    });
    expect(state.harness.fetches).toEqual([]);
  });

  test("is not refreshable for missing, disconnected, or non-OAuth connections", async () => {
    const missing = refreshHarness("acquired");
    expect(await refreshOAuthConnection(request(0), missing.dependencies, OWNER)).toMatchObject({
      status: "not_refreshable",
    });
    for (const data of [{ status: "disconnected" }, { authMethod: "api_key" }]) {
      const state = refreshHarness("acquired");
      seedVendorConnection(state.harness, { data, generation: 0, refreshToken: "refresh-0" });
      expect(await refreshOAuthConnection(request(0), state.dependencies, OWNER)).toMatchObject({
        status: "not_refreshable",
      });
      expect(state.acquired).toEqual([]);
    }
  });

  test("reports reauthorization for a connection already marked", async () => {
    const state = refreshHarness("acquired");
    seedVendorConnection(state.harness, {
      data: { status: "reauthorization-required" },
      generation: 3,
      refreshToken: "refresh-3",
    });
    expect(await refreshOAuthConnection(request(3), state.dependencies, OWNER)).toMatchObject({
      status: "reauthorization_required",
    });
    expect(state.acquired).toEqual([]);
  });

  test("refreshes platform_oauth connections through the existing two-phase rotation", async () => {
    const searchConsole = CODE_PROVIDER_DEFINITION_INPUTS.find(
      (input) => input.key === "google_search_console",
    );
    if (!searchConsole) throw new Error("google_search_console definition is missing.");
    const readonlyScope = "https://www.googleapis.com/auth/webmasters.readonly";
    const harness = oauthHarness([searchConsole], {
      platformApps: parsePlatformOAuthAppRegistry(
        JSON.stringify({
          google: {
            authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
            clientAuthentication: "client_secret_post",
            clientId: "configured-client-id",
            redirectUri:
              "https://channels.example.test/public/provider-connections/oauth/callback/google",
            refreshTokenRequired: true,
            tokenEndpoint: "https://oauth2.googleapis.com/token",
          },
        }),
      ),
    });
    const applicationId = ulid(30);
    const secretId = ulid(31);
    harness.vaultEntries.set(secretId, {
      document: {
        createdAt: NOW.toISOString(),
        generation: 0,
        schemaVersion: 1,
        updatedAt: NOW.toISOString(),
        values: { clientSecret: "google-secret" },
      },
      ownerId: applicationId,
      purpose: "provider-oauth-client-secret",
    });
    putRecord(
      harness,
      Schema.decodeUnknownSync(ProviderApplicationRecord)(
        withCanonicalRecordKeys({
          itemType: "provider-application" as const,
          data: {
            ...SCOPE,
            clientId: "google-client",
            clientSecretRef: { credentialId: secretId, generation: 0, store: "dynamodb-kms" },
            createdAt: NOW.toISOString(),
            displayName: "Google Search Console",
            id: applicationId,
            providerKey: "google_search_console",
            redirectUris: [],
            requestedScopes: [readonlyScope],
            status: "active",
            updatedAt: NOW.toISOString(),
            version: 0,
          },
        }),
      ),
    );
    seedVendorConnection(harness, {
      data: {
        authorizationScopes: ["email", "openid", readonlyScope],
        externalAccountId: "google-subject",
        providerApplicationId: applicationId,
        providerKey: "google_search_console",
      },
      generation: 3,
      oauthFields: {},
      refreshToken: "refresh-3",
    });
    const state = refreshHarness("acquired", harness);
    // Google refresh responses omit refresh_token; the stored refresh token stays valid.
    harness.respond = async () =>
      jsonResponse({
        access_token: "access-5",
        expires_in: 3599,
        scope: `openid ${readonlyScope} email`,
        token_type: "Bearer",
      });
    const refreshed = await refreshOAuthConnection(request(3), state.dependencies, OWNER);
    expect(refreshed).toMatchObject({ reference: { generation: 5 }, status: "refreshed" });
    expect(refreshed).toHaveProperty("refreshAfter");
    expect(harness.fetches.map((fetched) => fetched.url)).toEqual([
      "https://oauth2.googleapis.com/token",
    ]);
    const body = new URLSearchParams(formBody(harness.fetches[0]!.init));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-3");
    expect(body.get("client_id")).toBe("google-client");
    expect(body.get("client_secret")).toBe("google-secret");
    expect(body.has("resource")).toBe(false);
    expect(harness.mutations.map((mutation) => mutation.providerConnectionUpdate?.status)).toEqual([
      "reauthorization-required",
      "active",
    ]);
    expect(harness.mutations.at(-1)?.providerConnectionUpdate).toMatchObject({
      externalAccountId: "google-subject",
      scopes: [readonlyScope],
    });
  });
});

describe("claimed refresh losers", () => {
  test("report the winner's generation instead of reauthorization when their spent token is rejected", async () => {
    const state = refreshHarness("acquired");
    seedVendorConnection(state.harness, { generation: 3, refreshToken: "refresh-3" });
    state.harness.respond = async () => {
      // A refresher whose lease lapsed rotated the credential while this one was in flight.
      seedVendorConnection(state.harness, { generation: 4, refreshToken: "refresh-4" });
      return jsonResponse({ error: "invalid_grant" }, 400);
    };
    expect(await refreshOAuthConnection(request(3), state.dependencies, OWNER)).toMatchObject({
      reference: { generation: 4 },
      status: "current",
    });
    expect(state.harness.marks).toEqual([]);
  });
});

describe("JWT provider-connection refresh route", () => {
  test("waits on a held claim instead of replaying the refresh token", async () => {
    const harness = oauthHarness();
    seedVendorConnection(harness, { generation: 3, refreshToken: "refresh-3" });
    harness.claims.set(`${CONNECTION_ID}#3`, "oauth-refresh-lambda");
    const sleep = harness.dependencies.sleep;
    const dependencies: OAuthRefreshDependencies = {
      ...harness.dependencies,
      sleep: async (ms) => {
        await sleep(ms);
        seedVendorConnection(harness, { generation: 4, refreshToken: "refresh-4" });
      },
    };
    const result = await refreshOAuthConnectionRoute(
      dependencies,
      SCOPE,
      storedConnection(harness),
      OWNER,
    );
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body ?? "{}")).toEqual({
      reference: { credentialId: CONNECTION_CREDENTIAL_ID, generation: 4, store: "dynamodb-kms" },
    });
    expect(harness.fetches).toEqual([]);
  });

  test("refreshes once under its own claim and releases it", async () => {
    const harness = oauthHarness();
    seedVendorConnection(harness, { generation: 3, refreshToken: "refresh-3" });
    harness.respond = async () =>
      jsonResponse({ access_token: "access-4", expires_in: 600, refresh_token: "refresh-4" });
    const result = await refreshOAuthConnectionRoute(
      harness.dependencies,
      SCOPE,
      storedConnection(harness),
      OWNER,
    );
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body ?? "{}")).toMatchObject({ reference: { generation: 4 } });
    expect(harness.fetches).toHaveLength(1);
    expect(harness.claims.size).toBe(0);
  });

  for (const [status, expected] of [
    [400, 409],
    [503, 503],
  ] as const) {
    test(`maps a token endpoint HTTP ${status} to HTTP ${expected}`, async () => {
      const harness = oauthHarness();
      seedVendorConnection(harness, { generation: 3, refreshToken: "refresh-3" });
      harness.respond = async () => jsonResponse({ error: "failed" }, status);
      const result = await refreshOAuthConnectionRoute(
        harness.dependencies,
        SCOPE,
        storedConnection(harness),
        OWNER,
      );
      expect(result.statusCode).toBe(expected);
    });
  }
});
