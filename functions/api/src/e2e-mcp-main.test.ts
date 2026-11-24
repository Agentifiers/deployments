import { describe, expect, test } from "bun:test";
import { E2E_MCP_TOOL_NAME, createE2eMcpFetch } from "./e2e-mcp-main.ts";

const credentials = { initial: "initial-token", rotated: "rotated-token" };
const request = (body: unknown, authorization = credentials.initial, path = "/_e2e/mcp/initial") =>
  new Request(`https://api.example.test${path}`, {
    body: JSON.stringify(body),
    headers: { authorization: `Bearer ${authorization}`, "content-type": "application/json" },
    method: "POST",
  });

describe("deployed E2E MCP fixture", () => {
  test("requires the path-specific bearer and serves discovery plus tool calls", async () => {
    const fetch = createE2eMcpFetch(async () => credentials);
    expect(await fetch(request({}, "wrong"))).toMatchObject({ status: 401 });
    expect(await fetch(request({}, credentials.initial, "/_e2e/mcp/rotated"))).toMatchObject({
      status: 401,
    });

    const initialized = await fetch(
      request({ id: 1, jsonrpc: "2.0", method: "initialize", params: {} }),
    );
    expect(await initialized.json()).toMatchObject({
      id: 1,
      result: { serverInfo: { name: "deployments-ai-e2e-mcp" } },
    });

    const listed = await fetch(
      request({ id: 2, jsonrpc: "2.0", method: "tools/list", params: {} }),
    );
    expect(await listed.json()).toMatchObject({
      result: { tools: [{ name: E2E_MCP_TOOL_NAME }] },
    });

    const called = await fetch(
      request({
        id: 3,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { marker: "proof" }, name: E2E_MCP_TOOL_NAME },
      }),
    );
    expect(await called.json()).toMatchObject({
      result: { content: [{ text: "E2E MCP echo: proof", type: "text" }], isError: false },
    });
  });

  test("bounds request and echo sizes", async () => {
    const fetch = createE2eMcpFetch(async () => credentials);
    const nonObject = await fetch(request(null));
    expect(nonObject.status).toBe(400);
    expect(await nonObject.json()).toEqual({ error: "invalid_json" });

    const oversized = await fetch(
      request({ id: 1, jsonrpc: "2.0", method: "tools/call", padding: "x".repeat(17_000) }),
    );
    expect(oversized.status).toBe(413);

    const invalidMarker = await fetch(
      request({
        id: 2,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { marker: "x".repeat(257) }, name: E2E_MCP_TOOL_NAME },
      }),
    );
    expect(await invalidMarker.json()).toMatchObject({ error: { code: -32602 } });
  });

  test("loads current credentials for every request and recovers after a transient failure", async () => {
    let attempts = 0;
    const fetch = createE2eMcpFetch(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient Secrets Manager failure");
      return credentials;
    });

    expect(fetch(request({}))).rejects.toThrow("transient Secrets Manager failure");
    expect(await fetch(request({}))).toMatchObject({ status: 200 });
    expect(await fetch(request({}))).toMatchObject({ status: 200 });
    expect(attempts).toBe(3);
  });
});
