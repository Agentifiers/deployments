import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrganizationModelKeyResolver } from "@deployments-ai/model-gateway";
import { BIFROST_VIRTUAL_KEY_FILE, renderBifrostRuntimeFiles } from "./render-bifrost-config.ts";
import { p256KeyPair, serviceClaims, signToken, startGateway } from "./test-support.ts";

const DOCKERFILE = new URL("../../../infrastructure/images/bifrost/Dockerfile", import.meta.url);
const RUNTIME_DIR = "/run/model-gateway";
const POOL_KEY = `pool-${randomBytes(24).toString("base64url")}`;
const TENANT_KEY = `tenant-${randomBytes(24).toString("base64url")}`;
const VIRTUAL_KEY_SHAPED_TENANT_KEY = `sk-bf-${randomBytes(24).toString("base64url")}`;
const CREDENTIAL_ID = "01ARZ3NDEKTSV4RRFFQ69G0010";
const PRIMARY_MODEL = "openai/gpt-4o-mini";
const FALLBACK_MODEL = "openai/gpt-4o";

interface UpstreamCall {
  readonly authorization: string | null;
  readonly model: unknown;
}

const upstreamCalls: UpstreamCall[] = [];
const failingModels = new Set<string>();
const upstream = Bun.serve({
  async fetch(request) {
    // Bifrost lists the provider's models at startup.
    if (request.method === "GET") return Response.json({ data: [], object: "list" });
    const body = (await request.json()) as { model?: unknown; stream?: unknown };
    upstreamCalls.push({ authorization: request.headers.get("authorization"), model: body.model });
    if (typeof body.model === "string" && failingModels.has(body.model)) {
      return Response.json(
        {
          error: {
            code: "invalid_request",
            message: "upstream refused",
            type: "invalid_request_error",
          },
        },
        { status: 400 },
      );
    }
    if (body.stream === true) {
      const chunk = {
        choices: [{ delta: { content: "ok", role: "assistant" }, finish_reason: "stop", index: 0 }],
        created: 1,
        id: "chatcmpl-upstream",
        model: body.model,
        object: "chat.completion.chunk",
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json({
      choices: [{ finish_reason: "stop", index: 0, message: { content: "ok", role: "assistant" } }],
      created: 1,
      id: "chatcmpl-upstream",
      model: body.model,
      object: "chat.completion",
      usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
    });
  },
  hostname: "0.0.0.0",
  port: 0,
});

const TENANT_KEYS_BY_VERSION: Record<number, string> = {
  1: TENANT_KEY,
  2: VIRTUAL_KEY_SHAPED_TENANT_KEY,
};
const organizationKeys: OrganizationModelKeyResolver = {
  resolve: async ({ credentialId, keyVersion }) =>
    credentialId === CREDENTIAL_ID ? TENANT_KEYS_BY_VERSION[keyVersion] : undefined,
};
const keys = p256KeyPair();
const state = {
  bifrostUrl: "",
  containerId: "",
  gatewayUrl: "",
  internalVirtualKey: "",
  runtimeDir: "",
  stopGateway: () => {},
};

async function waitForHealth(url: string) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const healthy = await fetch(`${url}/health`).then(
      (response) => response.ok,
      () => false,
    );
    if (healthy) return;
    await Bun.sleep(500);
  }
  const logs = await Bun.$`docker logs ${state.containerId}`.nothrow().text();
  throw new Error(`Bifrost did not become healthy within 90 seconds:\n${logs}`);
}

beforeAll(async () => {
  const image = /^FROM\s+(\S+)/mu.exec(await Bun.file(DOCKERFILE).text())?.[1];
  if (!image) throw new Error(`${DOCKERFILE.pathname} has no FROM line.`);
  state.runtimeDir = await mkdtemp(join(tmpdir(), "bifrost-direct-keys-"));
  await renderBifrostRuntimeFiles({
    MODEL_GATEWAY_BIFROST_RUNTIME_DIR: state.runtimeDir,
    MODEL_GATEWAY_HOSTED_PROVIDERS: "openai",
    MODEL_GATEWAY_OPENAI_BASE_URL: `http://host.docker.internal:${upstream.port}`,
  });
  state.internalVirtualKey = (
    await readFile(join(state.runtimeDir, BIFROST_VIRTUAL_KEY_FILE), "utf8")
  ).trim();
  state.containerId = (
    await Bun.$`docker run -d --rm --add-host host.docker.internal:host-gateway -p 127.0.0.1::8080 -v ${state.runtimeDir}:${RUNTIME_DIR}:ro -e OPENAI_API_KEY=${POOL_KEY} --entrypoint /bin/sh ${image} -c ${`mkdir -p /app/data && cp ${RUNTIME_DIR}/config.json /app/data/config.json && exec /app/docker-entrypoint.sh /app/main`}`.text()
  ).trim();
  const published = (await Bun.$`docker port ${state.containerId} 8080/tcp`.text()).trim();
  state.bifrostUrl = `http://${published.split("\n")[0]}`;
  await waitForHealth(state.bifrostUrl);
  const gateway = startGateway({
    bifrostUrl: state.bifrostUrl,
    internalVirtualKey: state.internalVirtualKey,
    organizationKeys,
    publicKey: keys.publicKey,
  });
  state.gatewayUrl = gateway.url;
  state.stopGateway = () => void gateway.server.stop(true);
}, 180_000);

afterAll(async () => {
  state.stopGateway();
  void upstream.stop(true);
  if (state.containerId) await Bun.$`docker rm -f ${state.containerId}`.quiet().nothrow();
  if (state.runtimeDir) await rm(state.runtimeDir, { force: true, recursive: true });
});

beforeEach(() => {
  upstreamCalls.length = 0;
  failingModels.clear();
});

/** A chat completion through the gateway; `keyVersion` makes it organization-funded. */
async function chat(input: {
  readonly body?: Record<string, unknown>;
  readonly keyVersion?: number;
}) {
  const token = signToken(
    serviceClaims(Date.now(), {
      ...(input.keyVersion === undefined
        ? {}
        : { funding: { openai: { credentialId: CREDENTIAL_ID, keyVersion: input.keyVersion } } }),
      models: [PRIMARY_MODEL, FALLBACK_MODEL],
    }),
    keys.privateKey,
  );
  const response = await fetch(`${state.gatewayUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      messages: [{ content: "hello", role: "user" }],
      model: PRIMARY_MODEL,
      ...input.body,
    }),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    method: "POST",
  });
  return { status: response.status, text: await response.text() };
}

describe("model gateway against the pinned Bifrost image", () => {
  test("an operator-funded request reaches the provider with the operator's pool key", async () => {
    const response = await chat({});

    expect(response.status).toBe(200);
    expect(upstreamCalls).toEqual([{ authorization: `Bearer ${POOL_KEY}`, model: "gpt-4o-mini" }]);
    expect(JSON.parse(response.text)).toMatchObject({
      extra_fields: { routing_info: { key: "deployments-ai-openai" } },
    });
  });

  test("an organization-funded request reaches the provider with the organization's key", async () => {
    const response = await chat({ keyVersion: 1 });

    expect(response.status).toBe(200);
    expect(upstreamCalls).toEqual([
      { authorization: `Bearer ${TENANT_KEY}`, model: "gpt-4o-mini" },
    ]);
    expect(JSON.parse(response.text)).toMatchObject({
      extra_fields: { routing_info: { key: "header-provided" } },
    });
  });

  test("an organization-funded streamed request reaches the provider with the organization's key", async () => {
    const response = await chat({ body: { stream: true }, keyVersion: 1 });

    expect(response.status).toBe(200);
    expect(response.text).toContain('"key":"header-provided"');
    expect(upstreamCalls).toEqual([
      { authorization: `Bearer ${TENANT_KEY}`, model: "gpt-4o-mini" },
    ]);
  });

  test("an organization-funded request with fallbacks reaches the provider once, never with the pool key", async () => {
    failingModels.add("gpt-4o-mini");
    const response = await chat({ body: { fallbacks: [FALLBACK_MODEL] }, keyVersion: 1 });

    expect(response.status).toBe(400);
    expect(response.text).not.toContain(TENANT_KEY);
    expect(upstreamCalls).toEqual([
      { authorization: `Bearer ${TENANT_KEY}`, model: "gpt-4o-mini" },
    ]);
  });

  test("a fallbacks key in another letter case is refused before it reaches Bifrost", async () => {
    failingModels.add("gpt-4o-mini");
    const response = await chat({ body: { Fallbacks: [FALLBACK_MODEL] }, keyVersion: 1 });

    expect(response.status).toBe(400);
    expect(JSON.parse(response.text)).toMatchObject({ error: { code: "invalid_request" } });
    expect(upstreamCalls).toEqual([]);
  });

  test("an organization key shaped like a Bifrost virtual key is refused, not served from the pool", async () => {
    const response = await chat({ keyVersion: 2 });

    expect(response.status).toBe(401);
    expect(JSON.parse(response.text)).toMatchObject({
      error: { code: "model_credential_unavailable" },
    });
    expect(upstreamCalls).toEqual([]);
  });

  test("the pinned image serves a fallback from the pool key, so the gateway must strip fallbacks", async () => {
    failingModels.add("gpt-4o-mini");
    const response = await fetch(`${state.bifrostUrl}/v1/chat/completions`, {
      body: JSON.stringify({
        fallbacks: [FALLBACK_MODEL],
        messages: [{ content: "hello", role: "user" }],
        model: PRIMARY_MODEL,
      }),
      headers: {
        authorization: `Bearer ${TENANT_KEY}`,
        "content-type": "application/json",
        "x-bf-direct-key": "true",
        "x-bf-vk": state.internalVirtualKey,
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-bifrost-routing-info-key")).toBe("deployments-ai-openai");
    expect(upstreamCalls).toEqual([
      { authorization: `Bearer ${TENANT_KEY}`, model: "gpt-4o-mini" },
      { authorization: `Bearer ${POOL_KEY}`, model: "gpt-4o" },
    ]);
  });

  test("the pinned image names the serving key in a streamed response's headers", async () => {
    const response = await fetch(`${state.bifrostUrl}/v1/chat/completions`, {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: PRIMARY_MODEL,
        stream: true,
      }),
      headers: {
        authorization: `Bearer ${TENANT_KEY}`,
        "content-type": "application/json",
        "x-bf-direct-key": "true",
        "x-bf-vk": state.internalVirtualKey,
      },
      method: "POST",
    });
    await response.text();

    expect(response.headers.get("x-bifrost-routing-info-key")).toBe("header-provided");
  });
});
