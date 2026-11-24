import { RemoteMcpError } from "@deployments-ai/mcp-client";
import { describe, expect, test } from "bun:test";
import { ACCESS_TOKEN, toolSyncFixture } from "./vendor-mcp-tool-sync.fixture.ts";

describe("vendor MCP mcp_discovery verification", () => {
  test("verifies by listing tools and grants the vendor MCP capability scopes", async () => {
    const fixture = toolSyncFixture({
      discover: async () => ({
        protocolVersion: "2026-07-28",
        serverName: "docs-mcp",
        tools: [{ inputSchema: { type: "object" }, name: "docs-search" }],
      }),
    });
    fixture.seedConnection({ capability: false });

    const verification = await fixture.invoke("requestConnectionVerification", {});

    expect(fixture.discoveries).toEqual([
      {
        endpointOrigin: "https://mcp.docs.example",
        endpointPath: "/mcp",
        headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
        timeoutMs: 25_000,
      },
    ]);
    expect(verification).toMatchObject({
      result: {
        method: "mcp_discovery",
        protocolVersion: "2026-07-28",
        scopes: ["tools:read", "tools:write"],
        serverName: "docs-mcp",
        toolCount: 1,
      },
      status: "verified",
    });
    expect(fixture.recordsOf("connection-capability").map((record) => record.data)).toEqual([
      expect.objectContaining({ scopes: ["tools:read", "tools:write"], status: "active" }),
    ]);
    expect(fixture.recordsOf("provider-connection")[0]?.data).toMatchObject({
      scopes: ["tools:read", "tools:write"],
      status: "active",
    });
  });

  test("marks the connection for reauthorization when the server rejects the credential", async () => {
    const fixture = toolSyncFixture({
      discover: async () => {
        throw new RemoteMcpError("http", "MCP endpoint returned HTTP 401.", { statusCode: 401 });
      },
    });
    fixture.seedConnection();

    const verification = await fixture.invoke("requestConnectionVerification", {});

    expect(verification).toMatchObject({
      error: { code: "provider_verification_failed" },
      status: "failed",
    });
    expect(fixture.recordsOf("connection-capability")[0]?.data.status).toBe("stale");
    expect(fixture.recordsOf("provider-connection")[0]?.data.status).toBe(
      "reauthorization-required",
    );
  });

  test("keeps the connection active when discovery fails transiently", async () => {
    const fixture = toolSyncFixture({
      discover: async () => {
        throw new RemoteMcpError("timeout", "MCP request timed out.");
      },
    });
    fixture.seedConnection();

    const verification = await fixture.invoke("requestConnectionVerification", {});

    expect(verification).toMatchObject({ status: "failed" });
    expect(fixture.recordsOf("connection-capability")[0]?.data.status).toBe("active");
    expect(fixture.recordsOf("provider-connection")[0]?.data.status).toBe("active");
  });
});
