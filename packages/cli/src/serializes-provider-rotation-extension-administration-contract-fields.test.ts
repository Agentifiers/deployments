import { MOCK_TENANCY_FIXTURE_IDS } from "@agentifiers/deployments-sdk";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandCatalog } from "./catalog.ts";
import { runCli } from "./cli.ts";
import { buildRequest } from "./command-runtime.ts";
import { redactSecrets, renderOutput, renderStreamEvent, sanitizeTerminalText } from "./output.ts";
import type { CliIo } from "./types.ts";

const temporaryDirectories: string[] = [];
const temporaryServers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  await Promise.all(temporaryServers.splice(0).map((server) => server.stop(true)));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "deployments-cli-"));
  temporaryDirectories.push(directory);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    isInteractive: false,
  };
  return {
    directory,
    env: { DEPLOYMENTS_CONFIG_DIR: directory, NO_COLOR: "1" },
    io,
    stdout,
    stderr,
  };
}

describe("CLI capability catalog", () => {
  it("serializes provider rotation and extension administration contract fields", async () => {
    const administrationResourceId = MOCK_TENANCY_FIXTURE_IDS.apiCredential;
    const context = {
      apiUrl: "https://api.example.test",
      environmentId: MOCK_TENANCY_FIXTURE_IDS.environment,
      mock: false,
      profileName: "test",
    } as const;
    const oauthRotate = commandCatalog["oauth-app"]?.actions.rotate;
    const connectionAuthorize = commandCatalog.connection?.actions.authorize;
    const credentialCreate = commandCatalog.credential?.actions.create;
    const credentialRotate = commandCatalog.credential?.actions.rotate;
    const mcpServerCreate = commandCatalog["mcp-server"]?.actions.create;
    const mcpConnectionCreate = commandCatalog["mcp-connection"]?.actions.create;
    const extensionCreate = commandCatalog.extension?.actions.create;
    const extensionUpdate = commandCatalog.extension?.actions.update;
    if (
      !oauthRotate ||
      !connectionAuthorize ||
      !credentialCreate ||
      !credentialRotate ||
      !mcpServerCreate ||
      !mcpConnectionCreate ||
      !extensionCreate ||
      !extensionUpdate
    ) {
      throw new Error("Administration command catalog is incomplete.");
    }
    expect(
      await buildRequest(
        oauthRotate,
        {
          id: administrationResourceId,
          "client-secret": "new-secret",
          "expected-version": "2",
        },
        context,
        {},
      ),
    ).toMatchObject({ body: { clientSecret: "new-secret", expectedVersion: 2 } });
    expect(
      await buildRequest(
        connectionAuthorize,
        {
          provider: "tiktok_ads",
          resource: "advertiser-123",
          "return-url": "https://app.example.com/connections",
        },
        context,
        {},
      ),
    ).toMatchObject({
      body: {
        providerKey: "tiktok_ads",
        requestedResource: "advertiser-123",
        returnTo: "https://app.example.com/connections",
      },
    });
    expect(
      await buildRequest(
        credentialRotate,
        {
          id: administrationResourceId,
          credential: '{"apiKey":"new-credential"}',
          "expected-version": "3",
        },
        context,
        {},
      ),
    ).toMatchObject({
      body: { credential: { apiKey: "new-credential" }, expectedVersion: 3 },
    });
    expect(
      await buildRequest(
        credentialCreate,
        {
          credential: "scalar-api-key",
          name: "Scalar credential",
          provider: "buffer",
        },
        context,
        {},
      ),
    ).toMatchObject({
      body: {
        credential: "scalar-api-key",
        displayName: "Scalar credential",
        providerKey: "buffer",
      },
    });
    expect(
      await buildRequest(
        credentialCreate,
        {
          credential: "freshdesk-api-key",
          name: "Freshdesk",
          provider: "freshdesk",
          resource: "https://acme.freshdesk.com/mcp",
        },
        context,
        {},
      ),
    ).toMatchObject({
      body: {
        credential: "freshdesk-api-key",
        providerKey: "freshdesk",
        requestedResource: "https://acme.freshdesk.com/mcp",
      },
    });
    expect(
      await buildRequest(
        credentialCreate,
        {
          name: "Extension callbacks",
          provider: "extension_callback",
        },
        context,
        {},
      ),
    ).toMatchObject({
      body: {
        displayName: "Extension callbacks",
        providerKey: "extension_callback",
      },
    });
    expect(
      buildRequest(
        credentialCreate,
        {
          name: "Buffer",
          provider: "buffer",
        },
        context,
        {},
      ),
    ).rejects.toThrow("Provide --credential-env or --credential-file.");
    expect(
      await buildRequest(
        credentialRotate,
        {
          id: administrationResourceId,
          "credential-env": "PROVIDER_API_KEY",
          "expected-version": "4",
        },
        context,
        { PROVIDER_API_KEY: "environment-api-key" },
      ),
    ).toMatchObject({
      body: { credential: "environment-api-key", expectedVersion: 4 },
    });
    expect(
      await buildRequest(
        mcpServerCreate,
        {
          "auth-env": "MCP_AUTH",
          "endpoint-origin": "https://mcp.example",
          "endpoint-path": "/rpc",
          name: "MCP",
          tools: '["remote.read"]',
        },
        context,
        { MCP_AUTH: '{"bearerToken":"mcp-secret"}' },
      ),
    ).toMatchObject({
      body: {
        auth: { bearerToken: "mcp-secret" },
        toolAllowlist: ["remote.read"],
      },
    });
    expect(
      await buildRequest(mcpConnectionCreate, { server: administrationResourceId }, context, {}),
    ).toMatchObject({
      body: { mcpServerId: administrationResourceId },
    });
    const extensionFields = {
      "default-action": "require_approval",
      description: "Read documents",
      effect: "read",
      execution: JSON.stringify({
        mcpServerId: administrationResourceId,
        remoteToolName: "remote.read",
        type: "mcp",
      }),
      "input-schema": '{"type":"object"}',
      scopes: '["documents:read"]',
    };
    expect(
      await buildRequest(
        extensionCreate,
        { ...extensionFields, name: "custom.documents_read" },
        context,
        {},
      ),
    ).toMatchObject({
      body: {
        defaultPolicyAction: "require_approval",
        description: "Read documents",
        effect: "read",
        inputSchema: { type: "object" },
        requiredScopes: ["documents:read"],
      },
    });
    expect(
      await buildRequest(
        extensionUpdate,
        {
          ...extensionFields,
          "expected-version": "4",
          name: "custom.documents_read",
        },
        context,
        {},
      ),
    ).toMatchObject({
      body: {
        defaultPolicyAction: "require_approval",
        description: "Read documents",
        effect: "read",
        expectedVersion: 4,
        inputSchema: { type: "object" },
        requiredScopes: ["documents:read"],
      },
    });
  });

  it("exposes provider discovery and agent-email commands", async () => {
    const provider = await harness();
    expect(await runCli(["provider", "list", "--mock", "--json"], provider)).toBe(0);

    const inbox = await harness();
    expect(await runCli(["inbox", "list", "--mock", "--json"], inbox)).toBe(0);
  });

  it("uses limit pagination for tenancy and administration list commands", async () => {
    const urls: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        urls.push(request.url);
        return Response.json({ items: [], nextCursor: null });
      },
    });
    temporaryServers.push(server);

    const project = await harness();
    expect(
      await runCli(
        [
          "project",
          "list",
          "--page-size",
          "100",
          "--live",
          "--api-url",
          server.url.toString(),
          "--org",
          MOCK_TENANCY_FIXTURE_IDS.organization,
          "--json",
        ],
        project,
      ),
    ).toBe(0);

    const agents = await harness();
    expect(
      await runCli(
        [
          "agent",
          "list",
          "--page-size",
          "100",
          "--live",
          "--api-url",
          server.url.toString(),
          "--env",
          MOCK_TENANCY_FIXTURE_IDS.environment,
          "--json",
        ],
        agents,
      ),
    ).toBe(0);

    const usage = await harness();
    expect(
      await runCli(
        [
          "api-key",
          "usage",
          "--page-size",
          "100",
          "--live",
          "--api-url",
          server.url.toString(),
          "--env",
          MOCK_TENANCY_FIXTURE_IDS.environment,
          "--json",
        ],
        usage,
      ),
    ).toBe(0);

    const providers = await harness();
    expect(
      await runCli(
        [
          "provider",
          "list",
          "--page-size",
          "100",
          "--live",
          "--api-url",
          server.url.toString(),
          "--json",
        ],
        providers,
      ),
    ).toBe(0);

    expect(urls[0]).toContain("limit=100");
    expect(urls[1]).toContain("limit=100");
    expect(urls[2]).toContain("limit=100");
    expect(urls[3]).toContain("limit=100");
  });

  it("redacts credentials without hiding usage metrics or authorization URLs", () => {
    expect(
      redactSecrets({
        accessToken: "secret",
        accessUrl: "https://storage.example/signed",
        authorizationUrl: "https://provider.example/authorize",
        deviceToken: "device-secret",
        inputTokenCount: 42,
        invitationToken: "invite-secret",
        privateKeyPem: "private-secret",
        secretAccessKey: "provider-secret",
        secretKey: "generic-secret",
        signedUrls: ["https://storage.example/signed-1"],
        downloadUrls: ["https://storage.example/download-1"],
        urls: ["https://storage.example/generic-signed"],
        tokens: "token-bundle",
        totalTokens: 100,
      }),
    ).toEqual({
      accessToken: "[REDACTED]",
      accessUrl: "[REDACTED]",
      authorizationUrl: "https://provider.example/authorize",
      deviceToken: "[REDACTED]",
      inputTokenCount: 42,
      invitationToken: "[REDACTED]",
      privateKeyPem: "[REDACTED]",
      secretAccessKey: "[REDACTED]",
      secretKey: "[REDACTED]",
      signedUrls: "[REDACTED]",
      downloadUrls: "[REDACTED]",
      urls: "[REDACTED]",
      tokens: "[REDACTED]",
      totalTokens: 100,
    });
    expect(redactSecrets({ url: "https://storage.example/signed" })).toEqual({
      url: "[REDACTED]",
    });
    expect(redactSecrets("dpl_one_time_key", false, true)).toBe("[REDACTED]");
    expect(redactSecrets(["first-secret", "second-secret"], false, true)).toEqual([
      "[REDACTED]",
      "[REDACTED]",
    ]);
    expect(
      redactSecrets(
        {
          id: "key_1",
          status: "active",
          value: "one-time-secret",
          nested: { exportUrl: "signed-url" },
        },
        false,
        true,
        ["value", "export-url"],
      ),
    ).toEqual({
      id: "key_1",
      status: "active",
      value: "[REDACTED]",
      nested: { exportUrl: "[REDACTED]" },
    });
    expect(redactSecrets("dpl_one_time_key", true, true)).toBe("dpl_one_time_key");
  });

  it("sanitizes terminal control sequences in human-readable values", () => {
    expect(sanitizeTerminalText("safe\u001b]52;c;Y2xpcGJvYXJk\u0007\nspoof\rrow")).toBe(
      "safe spoof row",
    );
    const stdout: string[] = [];
    renderOutput({
      data: { ["field\u001b]52;c;Y2xpcGJvYXJk\u0007\nspoof"]: "value" },
      io: {
        stdout: (value) => stdout.push(value),
        stderr: () => {},
        isInteractive: false,
      },
      json: false,
      quiet: false,
      color: false,
      reveal: false,
      kind: "detail",
      requestId: "req\u009b31m_bad",
    });
    expect(stdout.join("\n")).not.toContain("\u001b");
    expect(stdout.join("\n")).not.toContain("\u009b");
    expect(stdout.join("\n")).toContain("field spoof");
    expect(stdout.join("\n")).toContain("request req_bad");

    stdout.length = 0;
    renderOutput({
      data: {
        items: [{ id: "prj_1", name: "Project" }],
        nextCursor: "cursor_next",
      },
      io: {
        stdout: (value) => stdout.push(value),
        stderr: () => {},
        isInteractive: false,
      },
      json: false,
      quiet: false,
      color: false,
      reveal: false,
      kind: "list",
    });
    expect(stdout.join("\n")).toContain("Next cursor: cursor_next");

    stdout.length = 0;
    renderOutput({
      data: {
        items: [{ eventId: "evt_1", action: "created", occurredAt: "now" }],
      },
      io: {
        stdout: (value) => stdout.push(value),
        stderr: () => {},
        isInteractive: false,
      },
      json: false,
      quiet: false,
      color: false,
      reveal: false,
      kind: "list",
    });
    expect(stdout.join("\n")).toContain("EVENTID");
    expect(stdout.join("\n")).toContain("evt_1");

    stdout.length = 0;
    renderOutput({
      data: { metadata: { nested: "safe\u009b31m\u202espoof" } },
      io: {
        stdout: (value) => stdout.push(value),
        stderr: () => {},
        isInteractive: false,
      },
      json: false,
      quiet: false,
      color: false,
      reveal: false,
      kind: "detail",
    });
    renderStreamEvent({
      data: {
        type: "event",
        metadata: { nested: "safe\u009dtitle\u009c\u202espoof" },
      },
      io: {
        stdout: (value) => stdout.push(value),
        stderr: () => {},
        isInteractive: false,
      },
      json: false,
      quiet: false,
      color: false,
      reveal: false,
    });
    expect(stdout.join("\n")).not.toContain("\u009b");
    expect(stdout.join("\n")).not.toContain("\u009d");
    expect(stdout.join("\n")).not.toContain("\u009c");
    expect(stdout.join("\n")).not.toContain("\u202e");

    stdout.length = 0;
    renderStreamEvent({
      data: {
        eventType: "run.started",
        occurredAt: "2026-07-25T12:00:00.000Z",
        runId: "run_1",
      },
      io: {
        stdout: (value) => stdout.push(value),
        stderr: () => {},
        isInteractive: false,
      },
      json: false,
      quiet: false,
      color: false,
      reveal: false,
    });
    expect(stdout).toEqual(['2026-07-25T12:00:00.000Z  run.started  {"runId":"run_1"}']);

    stdout.length = 0;
    const jsonPayload = { value: "safe\u009b31m\u061c\u200e\u200f\u202espoof" };
    renderOutput({
      data: jsonPayload,
      io: {
        stdout: (value) => stdout.push(value),
        stderr: () => {},
        isInteractive: false,
      },
      json: true,
      quiet: false,
      color: false,
      reveal: false,
      kind: "detail",
    });
    renderStreamEvent({
      data: jsonPayload,
      io: {
        stdout: (value) => stdout.push(value),
        stderr: () => {},
        isInteractive: false,
      },
      json: true,
      quiet: false,
      color: false,
      reveal: false,
    });
    expect(stdout.join("\n")).not.toContain("\u009b");
    expect(stdout.join("\n")).not.toContain("\u202e");
    expect(stdout.join("\n")).not.toContain("\u061c");
    expect(stdout.join("\n")).not.toContain("\u200e");
    expect(stdout.join("\n")).not.toContain("\u200f");
    expect(stdout.map((line) => JSON.parse(line))).toEqual([jsonPayload, jsonPayload]);

    const lineSeparated: string[] = [];
    renderStreamEvent({
      data: { message: "before\u2028middle\u2029after" },
      io: {
        stdout: (value) => lineSeparated.push(value),
        stderr: () => {},
        isInteractive: false,
      },
      json: true,
      quiet: false,
      color: false,
      reveal: false,
    });
    expect(lineSeparated).toHaveLength(1);
    expect(lineSeparated[0]).toContain("\\u2028");
    expect(lineSeparated[0]).toContain("\\u2029");
  });

  it("serializes vendor MCP tool sync and secretless pre-registered applications", async () => {
    const context = {
      apiUrl: "https://api.example.test",
      environmentId: MOCK_TENANCY_FIXTURE_IDS.environment,
      mock: false,
      profileName: "test",
    } as const;
    const toolsSync = commandCatalog.connection?.actions["tools-sync"];
    const register = commandCatalog["oauth-app"]?.actions.register;
    if (!toolsSync || !register) throw new Error("Vendor MCP commands are missing.");
    const connectionId = MOCK_TENANCY_FIXTURE_IDS.apiCredential;
    const sync = await buildRequest(toolsSync, { id: connectionId }, context, {});
    expect(sync).toMatchObject({
      method: "POST",
      path: `/v1/connections/${connectionId}/tools/sync`,
    });
    expect(sync.idempotencyKey).toBeString();
    const registered = await buildRequest(
      register,
      {
        "client-id": "mcp-client",
        name: "Notion MCP",
        provider: "notion",
        "redirect-uri": "https://channels.example.test/callback",
        registration: '{"method":"pre_registered","tokenEndpointAuthMethod":"none"}',
        scopes: "read",
      },
      context,
      {},
    );
    expect(registered.body).toEqual({
      clientId: "mcp-client",
      displayName: "Notion MCP",
      providerKey: "notion",
      redirectUris: ["https://channels.example.test/callback"],
      registration: { method: "pre_registered", tokenEndpointAuthMethod: "none" },
      requestedScopes: ["read"],
    });
  });
});
