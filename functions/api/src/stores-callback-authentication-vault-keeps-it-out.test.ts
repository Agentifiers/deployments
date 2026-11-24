import { describe, expect, test } from "bun:test";
import { ENVIRONMENT_ID, fixture, IDS, invocation } from "./administration-persistence.fixture.ts";

describe("administration persistence", () => {
  test("stores callback authentication in the vault and keeps it out of public responses", async () => {
    const fixtureValue = fixture();
    expect(
      fixtureValue.service.invoke(
        "createExtensionTool",
        invocation({
          defaultPolicyAction: "require_approval",
          description: "Authenticated callback mutation",
          effect: "write",
          execution: {
            completionMode: "sync",
            endpointOrigin: "https://callbacks.example.com",
            endpointPath: "/mutate",
            type: "http_callback",
          },
          inputSchema: { type: "object" },
          name: "custom.authenticated_callback",
          providerKey: "github",
          requiredScopes: [],
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });

    expect(
      fixtureValue.service.invoke(
        "createExtensionTool",
        invocation({
          callbackSecret: "callback\nsecret",
          defaultPolicyAction: "require_approval",
          description: "Authenticated callback mutation",
          effect: "write",
          execution: {
            completionMode: "sync",
            endpointOrigin: "https://callbacks.example.com",
            endpointPath: "/mutate",
            type: "http_callback",
          },
          inputSchema: { type: "object" },
          name: "custom.authenticated_callback",
          providerKey: "github",
          requiredScopes: [],
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_callback_auth" });

    const extension = (await fixtureValue.service.invoke(
      "createExtensionTool",
      invocation({
        callbackSecret: "callback-secret",
        defaultPolicyAction: "require_approval",
        description: "Authenticated callback mutation",
        effect: "write",
        execution: {
          completionMode: "sync",
          endpointOrigin: "https://callbacks.example.com",
          endpointPath: "/mutate",
          type: "http_callback",
        },
        inputSchema: { type: "object" },
        name: "custom.authenticated_callback",
        providerKey: "github",
        requiredScopes: [],
      }),
    )) as Record<string, unknown>;
    expect(extension).toMatchObject({ hasCallbackAuth: true });
    expect(extension).not.toHaveProperty("authSecretRef");
    expect(JSON.stringify(extension)).not.toContain("callback-secret");
    expect(
      fixtureValue.service.invoke("updateExtensionTool", {
        ...invocation({
          callbackSecret: "replacement\u007fsecret",
          expectedVersion: 0,
        }),
        params: { toolName: "custom.authenticated_callback" },
      }),
    ).rejects.toMatchObject({ code: "invalid_callback_auth" });
    expect(
      fixtureValue.service.invoke("updateExtensionTool", {
        ...invocation({
          execution: {
            completionMode: "sync",
            endpointOrigin: "https://attacker.example",
            endpointPath: "/mutate",
            type: "http_callback",
          },
          expectedVersion: 0,
        }),
        params: { toolName: "custom.authenticated_callback" },
      }),
    ).rejects.toMatchObject({ code: "callback_auth_replacement_required" });
    expect(
      fixtureValue.service.invoke("updateExtensionTool", {
        ...invocation({
          execution: {
            completionMode: "sync",
            endpointOrigin: "https://callbacks.example.com",
            endpointPath: "/attacker",
            type: "http_callback",
          },
          expectedVersion: 0,
        }),
        params: { toolName: "custom.authenticated_callback" },
      }),
    ).rejects.toMatchObject({ code: "callback_auth_replacement_required" });
  });

  test("persists callback workspace file patterns on create and update and rejects unsafe ones", async () => {
    const { service } = fixture();
    const execution = (include: unknown) => ({
      completionMode: "sync",
      endpointOrigin: "https://callbacks.example.com",
      endpointPath: "/publish",
      type: "http_callback",
      workspaceFiles: { include },
    });
    const create = (include: unknown) =>
      service.invoke(
        "createExtensionTool",
        invocation({
          callbackSecret: "callback-secret",
          defaultPolicyAction: "require_approval",
          description: "Publish sandbox files",
          effect: "write",
          execution: execution(include),
          inputSchema: { type: "object" },
          name: "custom.publish_site",
          providerKey: "github",
          requiredScopes: [],
        }),
      );
    for (const include of [["/etc/passwd"], ["site/../../x"], [], [""]]) {
      expect(create(include)).rejects.toMatchObject({ code: "invalid_workspace_files" });
    }

    const created = (await create(["site/*.html", "site/*.css"])) as Record<string, unknown>;
    expect(created.execution).toMatchObject({
      workspaceFiles: { include: ["site/*.html", "site/*.css"] },
    });
    const update = (include: unknown) =>
      service.invoke("updateExtensionTool", {
        ...invocation({ execution: execution(include), expectedVersion: 0 }),
        params: { toolName: "custom.publish_site" },
      });
    expect(update(["site\0/x"])).rejects.toMatchObject({ code: "invalid_workspace_files" });
    const updated = (await update(["site/**/*"])) as Record<string, unknown>;
    expect(updated.execution).toMatchObject({ workspaceFiles: { include: ["site/**/*"] } });
  });

  test("persists a callback's run context opt-in through create and update, for callbacks only", async () => {
    const { service } = fixture();
    const execution = (runContext?: unknown) => ({
      completionMode: "sync",
      endpointOrigin: "https://callbacks.example.com",
      endpointPath: "/draft",
      ...(runContext === undefined ? {} : { runContext }),
      type: "http_callback",
    });
    const body = {
      defaultPolicyAction: "allow",
      inputSchema: { type: "object" },
      requiredScopes: [],
    };
    const created = await service.invoke(
      "createExtensionTool",
      invocation({
        ...body,
        callbackSecret: "callback-secret",
        description: "Draft",
        effect: "write",
        execution: execution(["origin"]),
        name: "custom.draft",
        providerKey: "github",
      }),
    );
    const update = (changes: object, expectedVersion: number) =>
      service.invoke("updateExtensionTool", {
        ...invocation({ ...changes, expectedVersion }),
        params: { toolName: "custom.draft" },
      });
    const described = await update({ description: "Draft a bot" }, 0);
    const cleared = await update({ execution: execution() }, 1);
    const restored = await update({ execution: execution(["origin"]) }, 2);
    expect([created, described, cleared, restored]).toEqual([
      expect.objectContaining({ execution: execution(["origin"]) }),
      expect.objectContaining({ execution: execution(["origin"]) }),
      expect.objectContaining({ execution: execution() }),
      expect.objectContaining({ execution: execution(["origin"]) }),
    ]);
    expect(update({ execution: execution(["sender"]) }, 3)).rejects.toMatchObject({
      code: "invalid_run_context",
    });
    expect(
      service.invoke(
        "createExtensionTool",
        invocation({
          ...body,
          description: "Pick",
          effect: "read",
          execution: { runContext: ["origin"], type: "client" },
          name: "custom.pick",
        }),
      ),
    ).rejects.toMatchObject({ code: "run_context_unsupported" });
  });

  test("preserves the capability cursor when listing a connection page", async () => {
    const { service, queryInputs } = fixture();
    const exclusiveStartKey = {
      gsi2pk: "cursor-partition",
      gsi2sk: "cursor-sort",
      pk: "record-partition",
      sk: "record-sort",
    };
    const cursor = Buffer.from(
      JSON.stringify({
        environmentId: ENVIRONMENT_ID,
        itemType: "connection-capability",
        key: exclusiveStartKey,
        version: 1,
      }),
    ).toString("base64url");
    await service.invoke("listConnectionCapabilities", {
      ...invocation(undefined, IDS[0]),
      query: { cursor, limit: 5 },
    });
    expect(queryInputs.at(-1)).toMatchObject({
      ExclusiveStartKey: exclusiveStartKey,
      Limit: 5,
    });
  });

  test("rejects cursors without complete DynamoDB keys", async () => {
    const { service } = fixture();
    const cursor = Buffer.from(
      JSON.stringify({
        environmentId: ENVIRONMENT_ID,
        itemType: "connection-capability",
        key: {},
        version: 1,
      }),
    ).toString("base64url");
    expect(
      service.invoke("listConnectionCapabilities", {
        ...invocation(undefined, IDS[0]),
        query: { cursor, limit: 5 },
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor", kind: "invalid-input" });
  });

  test("discovers only allowlisted MCP tools with vault auth and rejects mismatched extensions", async () => {
    const fixtureValue = fixture();
    const server = (await fixtureValue.service.invoke(
      "createMcpServer",
      invocation({
        auth: { bearerToken: "mcp/secret+value" },
        endpointOrigin: "https://mcp.example",
        endpointPath: "/rpc",
        name: "Primary MCP",
        toolAllowlist: ["remote.allowed"],
      }),
    )) as { readonly id: string; readonly version: number };

    expect(
      fixtureValue.service.invoke(
        "updateMcpServer",
        invocation(
          {
            endpointOrigin: "https://attacker.example",
            expectedVersion: server.version,
          },
          server.id,
        ),
      ),
    ).rejects.toMatchObject({ code: "mcp_auth_replacement_required" });
    expect(
      fixtureValue.service.invoke(
        "updateMcpServer",
        invocation(
          {
            endpointPath: "/attacker",
            expectedVersion: server.version,
          },
          server.id,
        ),
      ),
    ).rejects.toMatchObject({ code: "mcp_auth_replacement_required" });

    const discovery = await fixtureValue.service.invoke(
      "discoverMcpServer",
      invocation(undefined, server.id),
    );
    expect(discovery).toMatchObject({
      serverId: server.id,
      tools: [{ remoteName: "remote.allowed" }],
    });
    expect(fixtureValue.getDiscoveryInput()).toMatchObject({
      headers: { authorization: "Bearer mcp/secret+value" },
      toolAllowlist: ["remote.allowed"],
    });
    fixtureValue.setDiscoveryTools([
      {
        description: "mcp%252Fsecret%252Bvalue",
        inputSchema: { type: "object" },
        remoteName: "remote.allowed",
      },
    ]);
    expect(
      fixtureValue.service.invoke("discoverMcpServer", invocation(undefined, server.id)),
    ).rejects.toMatchObject({ code: "mcp_discovery_credential_echo" });

    expect(
      fixtureValue.service.invoke(
        "createExtensionTool",
        invocation({
          defaultPolicyAction: "deny",
          description: "Bad mapping",
          effect: "read",
          execution: {
            mcpServerId: server.id,
            remoteToolName: "remote.not-allowed",
            type: "mcp",
          },
          inputSchema: { type: "object" },
          name: "custom.bad",
          requiredScopes: [],
        }),
      ),
    ).rejects.toMatchObject({ code: "mcp_tool_not_allowed" });

    expect(
      fixtureValue.service.invoke(
        "createExtensionTool",
        invocation({
          defaultPolicyAction: "deny",
          description: "Provider-tagged MCP mapping",
          effect: "read",
          execution: {
            mcpServerId: server.id,
            remoteToolName: "remote.allowed",
            type: "mcp",
          },
          inputSchema: { type: "object" },
          name: "custom.provider_tagged",
          providerKey: "github",
          requiredScopes: [],
        }),
      ),
    ).rejects.toMatchObject({ code: "mcp_provider_forbidden" });

    expect(
      fixtureValue.service.invoke(
        "createExtensionTool",
        invocation({
          defaultPolicyAction: "deny",
          description: "Unsupported MCP mutation",
          effect: "write",
          execution: {
            mcpServerId: server.id,
            remoteToolName: "remote.allowed",
            type: "mcp",
          },
          inputSchema: { type: "object" },
          name: "custom.mcp_write",
          requiredScopes: [],
        }),
      ),
    ).rejects.toMatchObject({ code: "mcp_effect_unsupported" });

    expect(
      fixtureValue.service.invoke(
        "createExtensionTool",
        invocation({
          callbackSecret: "callback-secret",
          defaultPolicyAction: "deny",
          description: "Built-in collision",
          effect: "read",
          execution: {
            completionMode: "sync",
            endpointOrigin: "https://callbacks.example.com",
            endpointPath: "/read",
            type: "http_callback",
          },
          inputSchema: { type: "object" },
          name: "shopify.products.search",
          providerKey: "shopify",
          requiredScopes: [],
        }),
      ),
    ).rejects.toMatchObject({ code: "tool_name_reserved" });
  });

  test("rejects MCP discovery output that echoes only an authorization payload", async () => {
    const fixtureValue = fixture();
    const server = (await fixtureValue.service.invoke(
      "createMcpServer",
      invocation({
        auth: { authorization: "Basic base64payload" },
        endpointOrigin: "https://mcp.example",
        endpointPath: "/rpc",
        name: "Primary MCP",
        toolAllowlist: ["remote.allowed"],
      }),
    )) as { readonly id: string };
    fixtureValue.setDiscoveryTools([
      {
        description: "base64payload",
        inputSchema: { type: "object" },
        remoteName: "remote.allowed",
      },
    ]);

    expect(
      fixtureValue.service.invoke("discoverMcpServer", invocation(undefined, server.id)),
    ).rejects.toMatchObject({ code: "mcp_discovery_credential_echo" });
  });

  test("registers client-executed extensions without vault credentials", async () => {
    const fixtureValue = fixture();
    const body = {
      defaultPolicyAction: "allow",
      description: "Reads the caller's local weather sensor.",
      effect: "read",
      execution: { timeoutMs: 60_000, type: "client" },
      inputSchema: { properties: { city: { type: "string" } }, type: "object" },
      name: "custom.local_weather",
      outputSchema: { properties: { temperature: { type: "number" } }, type: "object" },
      requiredScopes: [],
    };
    expect(
      fixtureValue.service.invoke(
        "createExtensionTool",
        invocation({ ...body, callbackSecret: "secret" }),
      ),
    ).rejects.toMatchObject({ code: "client_tool_credentials_forbidden" });

    const extension = (await fixtureValue.service.invoke(
      "createExtensionTool",
      invocation(body),
    )) as Record<string, unknown>;
    expect(extension).toMatchObject({
      execution: { timeoutMs: 60_000, type: "client" },
      hasCallbackAuth: false,
      outputSchema: body.outputSchema,
    });
    expect(fixtureValue.credentialWrites).toHaveLength(0);
    expect(
      fixtureValue.service.invoke("getExtensionTool", {
        ...invocation(undefined),
        params: { toolName: "custom.local_weather" },
      }),
    ).resolves.toMatchObject({ name: "custom.local_weather" });
  });
});
