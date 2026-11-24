import { describe, expect, spyOn, test } from "bun:test";
import type { ProviderDefinitionInput } from "@deployments-ai/providers";

import {
  refreshProviderConnection,
  revokeProviderConnection,
} from "./oauth-connection-lifecycle.ts";
import {
  CIMD_CLIENT_ID,
  CONNECTION_CREDENTIAL_ID,
  formBody,
  header,
  jsonResponse,
  NOTION_ENDPOINT,
  notionInput,
  oauthHarness,
  SCOPE,
  seedVendorConnection,
  storedConnection,
} from "./oauth-test-support.ts";

const { revocationEndpoint: _revocationEndpoint, ...notionAuthorization } =
  notionInput.mcpServer.authorization;
const linearInput = {
  ...notionInput,
  displayName: "Linear",
  key: "linear",
  mcpServer: {
    ...notionInput.mcpServer,
    authorization: {
      ...notionAuthorization,
      authorizationEndpoint: "https://mcp.linear.example/authorize",
      issuer: "https://mcp.linear.example",
      tokenEndpoint: "https://mcp.linear.example/token",
    },
    resource: "https://mcp.linear.example/mcp",
    url: "https://mcp.linear.example/mcp",
  },
  oauthProviderKey: "linear",
} as const satisfies ProviderDefinitionInput;

describe("vendor MCP connection refresh", () => {
  test("rotates once straight to active with the exact resource and public client id", async () => {
    const harness = oauthHarness();
    seedVendorConnection(harness, { generation: 3, refreshToken: "refresh-3" });
    harness.respond = async () =>
      jsonResponse({ access_token: "access-4", expires_in: 1800, refresh_token: "refresh-4" });

    const result = await refreshProviderConnection(
      harness.dependencies,
      SCOPE,
      storedConnection(harness),
    );

    expect(result.reference).toEqual({
      credentialId: CONNECTION_CREDENTIAL_ID,
      generation: 4,
      store: "dynamodb-kms",
    });
    expect(harness.fetches).toHaveLength(1);
    expect(harness.fetches[0]?.url).toBe("https://mcp.notion.example/token");
    expect(formBody(harness.fetches[0]!.init)).toEqual({
      client_id: CIMD_CLIENT_ID,
      grant_type: "refresh_token",
      redirect_uri:
        "https://channels.example.test/public/provider-connections/oauth/callback/notion",
      refresh_token: "refresh-3",
      resource: NOTION_ENDPOINT,
    });
    expect(harness.vaultWrites.map((write) => write.expectedGeneration)).toEqual([3]);
    expect(harness.vaultWrites[0]?.secret.values).toMatchObject({
      accessToken: "access-4",
      refreshToken: "refresh-4",
    });
    expect(harness.mutations).toHaveLength(1);
    expect(harness.mutations[0]?.providerConnectionUpdate?.status).toBe("active");
    expect(storedConnection(harness).data).toMatchObject({
      credentialRef: { generation: 4 },
      externalAccountId: expect.stringMatching(/^mcp:/u),
      oauthResource: NOTION_ENDPOINT,
      refreshAfter: result.refreshAfter,
      scopes: ["tools:read", "tools:write"],
      status: "active",
    });
  });

  test("keeps the current refresh token when the provider does not rotate it", async () => {
    const harness = oauthHarness();
    seedVendorConnection(harness, { generation: 0, refreshToken: "refresh-0" });
    harness.respond = async () => jsonResponse({ access_token: "access-1" });
    await refreshProviderConnection(harness.dependencies, SCOPE, storedConnection(harness));
    expect(harness.vaultWrites[0]?.secret.values.refreshToken).toBe("refresh-0");
  });

  test("rejects a token subject that differs from the connected account", async () => {
    const harness = oauthHarness();
    seedVendorConnection(harness, {
      data: { externalAccountId: "user-1" },
      generation: 0,
      refreshToken: "refresh-0",
    });
    harness.respond = async () => jsonResponse({ access_token: "access-1", sub: "user-2" });
    expect(
      refreshProviderConnection(harness.dependencies, SCOPE, storedConnection(harness)),
    ).rejects.toThrow("different provider account");
    expect(harness.mutations).toEqual([]);
  });
});

describe("vendor MCP connection revoke", () => {
  test("revokes the refresh token at the pinned RFC 7009 endpoint, then disconnects", async () => {
    const harness = oauthHarness();
    seedVendorConnection(harness, { generation: 2, refreshToken: "refresh-2" });
    harness.respond = async () => new Response(null, { status: 200 });

    await revokeProviderConnection(harness.dependencies, SCOPE, storedConnection(harness));

    expect(harness.fetches).toHaveLength(1);
    const [request] = harness.fetches;
    expect(request?.url).toBe("https://mcp.notion.example/token/revoke");
    expect(request?.init.method).toBe("POST");
    expect(request?.init.redirect).toBe("error");
    expect(header(request!.init, "content-type")).toBe("application/x-www-form-urlencoded");
    expect(header(request!.init, "authorization")).toBeNull();
    expect(formBody(request!.init)).toEqual({
      client_id: CIMD_CLIENT_ID,
      token: "refresh-2",
      token_type_hint: "refresh_token",
    });
    expect(harness.mutations.map((mutation) => mutation.action)).toEqual(["revoked"]);
    expect(storedConnection(harness).data.status).toBe("disconnected");
  });

  test("revokes the access token when no refresh token is held", async () => {
    const harness = oauthHarness();
    seedVendorConnection(harness, { generation: 0 });
    harness.respond = async () => new Response(null, { status: 200 });
    await revokeProviderConnection(harness.dependencies, SCOPE, storedConnection(harness));
    expect(formBody(harness.fetches[0]!.init)).toMatchObject({
      token: "old-access-token",
      token_type_hint: "access_token",
    });
  });

  test("still disconnects locally when provider revocation fails", async () => {
    const harness = oauthHarness();
    seedVendorConnection(harness, { generation: 0, refreshToken: "refresh-0" });
    harness.respond = async () => new Response("unavailable", { status: 503 });
    await revokeProviderConnection(harness.dependencies, SCOPE, storedConnection(harness));
    expect(harness.fetches).toHaveLength(1);
    expect(storedConnection(harness).data.status).toBe("disconnected");
  });

  test("only disconnects when no revocation endpoint is pinned", async () => {
    const harness = oauthHarness([linearInput]);
    seedVendorConnection(harness, {
      data: { oauthResource: linearInput.mcpServer.url, providerKey: "linear" },
      generation: 0,
      refreshToken: "refresh-0",
    });
    const warn = spyOn(console, "warn");
    try {
      await revokeProviderConnection(harness.dependencies, SCOPE, storedConnection(harness));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    expect(harness.fetches).toEqual([]);
    expect(storedConnection(harness).data.status).toBe("disconnected");
  });
});
