import { describe, expect, test } from "bun:test";
import { createE2eCallbackFetch } from "./e2e-callback-main.ts";

const credentials = { initial: "initial-secret", rotated: "rotated-secret" };
const envelope = (marker: unknown = "proof") => ({
  agentDeploymentId: "01J00000000000000000000000",
  callbackEvidenceId: "01J00000000000000000000001",
  effect: "read",
  idempotencyKey: "provider-mutation:run:tool-call",
  input: { marker },
  inputHash: "hash",
  logicalIdempotencyKey: "tool-call",
  organizationId: "01J00000000000000000000002",
  policyAction: "allow",
  requiredScopes: ["callback:context:read"],
  runId: "01J00000000000000000000003",
  threadId: "01J00000000000000000000004",
  toolCallId: "01J00000000000000000000005",
  toolName: "e2e.callback.echo",
  version: 1,
});
const request = (
  body: unknown,
  options: { authorization?: string; method?: string; path?: string; rawBody?: string } = {},
) =>
  new Request(`https://api.example.test${options.path ?? "/_e2e/callback/initial"}`, {
    ...(options.method === "GET" ? {} : { body: options.rawBody ?? JSON.stringify(body) }),
    headers: {
      authorization: `Bearer ${options.authorization ?? credentials.initial}`,
      "content-type": "application/json",
    },
    method: options.method ?? "POST",
  });

describe("deployed E2E HTTP callback fixture", () => {
  test("echoes the worker callback envelope for the path-specific bearer", async () => {
    const fetch = createE2eCallbackFetch(async () => credentials);
    const initial = await fetch(request(envelope()));
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({
      authenticatedAs: "initial",
      echo: "E2E callback echo: proof",
      idempotencyKey: "provider-mutation:run:tool-call",
      marker: "proof",
      toolCallId: "01J00000000000000000000005",
      toolName: "e2e.callback.echo",
    });

    const rotated = await fetch(
      request(envelope("rotated-proof"), {
        authorization: credentials.rotated,
        path: "/_e2e/callback/rotated",
      }),
    );
    expect(await rotated.json()).toMatchObject({
      authenticatedAs: "rotated",
      marker: "rotated-proof",
    });
  });

  test("rejects bearers that do not belong to the requested credential path", async () => {
    const fetch = createE2eCallbackFetch(async () => credentials);
    const wrong = await fetch(request(envelope(), { authorization: "wrong" }));
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toBe("Bearer");
    expect(await fetch(request(envelope(), { path: "/_e2e/callback/rotated" }))).toMatchObject({
      status: 401,
    });
    expect(await fetch(request(envelope(), { authorization: credentials.rotated }))).toMatchObject({
      status: 401,
    });
  });

  test("serves only the fixture credential paths and POST", async () => {
    let loads = 0;
    const fetch = createE2eCallbackFetch(async () => {
      loads += 1;
      return credentials;
    });
    expect(await fetch(request(envelope(), { path: "/_e2e/callback/other" }))).toMatchObject({
      status: 404,
    });
    expect(await fetch(request(envelope(), { path: "/_e2e/mcp/initial" }))).toMatchObject({
      status: 404,
    });
    expect(loads).toBe(0);

    const get = await fetch(request(undefined, { method: "GET" }));
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect(
      await fetch(request(undefined, { authorization: "wrong", method: "GET" })),
    ).toMatchObject({ status: 401 });
  });

  test("rejects malformed, oversized, and incomplete callback envelopes", async () => {
    const fetch = createE2eCallbackFetch(async () => credentials);
    const malformed = await fetch(request(undefined, { rawBody: "{not json" }));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid_json" });

    expect(await fetch(request({ ...envelope(), padding: "x".repeat(17_000) }))).toMatchObject({
      status: 413,
    });

    const { toolCallId: _toolCallId, ...missingToolCall } = envelope();
    for (const body of [
      null,
      [envelope()],
      { ...envelope(), version: 2 },
      missingToolCall,
      { ...envelope(), input: [] },
      envelope(42),
      envelope(""),
      envelope("x".repeat(257)),
    ]) {
      const rejected = await fetch(request(body));
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ error: "invalid_callback" });
    }
  });

  test("loads current credentials for every request and recovers after a transient failure", async () => {
    let attempts = 0;
    const fetch = createE2eCallbackFetch(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient Parameter Store failure");
      return credentials;
    });

    expect(fetch(request(envelope()))).rejects.toThrow("transient Parameter Store failure");
    expect(await fetch(request(envelope()))).toMatchObject({ status: 200 });
    expect(attempts).toBe(2);
  });
});
