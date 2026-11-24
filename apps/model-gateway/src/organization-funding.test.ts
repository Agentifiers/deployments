import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  OrganizationModelKeyUnavailableError,
  type ModelFundingClaim,
  type OrganizationModelKeyRequest,
  type OrganizationModelKeyResolver,
} from "@deployments-ai/model-gateway";
import {
  ALLOWED_MODEL,
  EMBEDDING_MODEL,
  FALLBACK_MODEL,
  p256KeyPair,
  runClaims,
  runLease,
  serviceClaims,
  signToken,
  startFakeBifrost,
  startGateway,
} from "./test-support.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G0004";
const CREDENTIAL_ID = "01ARZ3NDEKTSV4RRFFQ69G0010";
const TENANT_KEY = `tenant-${randomBytes(24).toString("base64url")}`;

const keys = p256KeyPair();
const bifrost = startFakeBifrost();
const resolved: OrganizationModelKeyRequest[] = [];
const RESOLVED_KEYS: Record<number, string> = {
  2: TENANT_KEY,
  3: `sk-bf-${randomBytes(24).toString("base64url")}`,
  4: "tenant key with spaces",
};
const organizationKeys: OrganizationModelKeyResolver = {
  resolve: async (request) => {
    resolved.push(request);
    if (request.keyVersion === 5) throw new OrganizationModelKeyUnavailableError("KMS throttled");
    return RESOLVED_KEYS[request.keyVersion];
  },
};
const gateway = startGateway({
  bifrostUrl: bifrost.url,
  organizationKeys,
  publicKey: keys.publicKey,
});
const unwiredGateway = startGateway({ bifrostUrl: bifrost.url, publicKey: keys.publicKey });
const observed: string[] = [];

afterAll(() => {
  for (const text of [...observed, ...gateway.logs.map((entry) => JSON.stringify(entry))]) {
    expect(text).not.toContain(TENANT_KEY);
  }
  void gateway.server.stop(true);
  void unwiredGateway.server.stop(true);
  void bifrost.server.stop(true);
});

beforeEach(() => {
  gateway.leases.value = runLease({
    expiresAt: new Date(gateway.clock.now + 60_000).toISOString(),
  });
  bifrost.requests.length = 0;
  resolved.length = 0;
  bifrost.state.respond = (request) =>
    Response.json(
      { id: "chatcmpl-1", choices: [] },
      request.headers["x-bf-direct-key"] === "true"
        ? { headers: { "x-bifrost-routing-info-key": "header-provided" } }
        : {},
    );
});

const openAiFunding = (keyVersion = 2): ModelFundingClaim => ({
  openai: { credentialId: CREDENTIAL_ID, keyVersion },
});

async function post(input: {
  readonly body: Record<string, unknown>;
  readonly path?: string;
  readonly target?: { readonly url: string };
  readonly token: string;
}) {
  const response = await fetch(
    `${(input.target ?? gateway).url}${input.path ?? "/v1/chat/completions"}`,
    {
      body: JSON.stringify(input.body),
      headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
      method: "POST",
    },
  );
  const text = await response.text();
  observed.push(text);
  return { status: response.status, text };
}

const chat = (extra: Record<string, unknown> = {}) => ({
  messages: [{ content: "hello", role: "user" }],
  model: ALLOWED_MODEL,
  ...extra,
});

describe("organization-funded forwarding", () => {
  test("sends the organization's key as a Bifrost direct key and drops fallbacks", async () => {
    const token = signToken(
      runClaims(gateway.clock.now, { funding: openAiFunding() }),
      keys.privateKey,
    );
    const response = await post({ body: chat({ fallbacks: [FALLBACK_MODEL] }), token });

    expect(response.status).toBe(200);
    expect(resolved).toEqual([
      {
        credentialId: CREDENTIAL_ID,
        keyVersion: 2,
        organizationId: ORGANIZATION_ID,
        provider: "openai",
      },
    ]);
    expect(bifrost.requests).toHaveLength(1);
    const [forwarded] = bifrost.requests;
    expect(forwarded?.headers["x-bf-vk"]).toBe(gateway.internalVirtualKey);
    expect(forwarded?.headers["x-bf-direct-key"]).toBe("true");
    expect(forwarded?.headers.authorization).toBe(`Bearer ${TENANT_KEY}`);
    expect(forwarded?.body).toEqual(chat());
  });

  test("drops fallbacks when only a fallback's provider is organization-funded", async () => {
    const funding = { openrouter: { credentialId: CREDENTIAL_ID, keyVersion: 2 } };
    const token = signToken(
      serviceClaims(gateway.clock.now, { funding, models: [ALLOWED_MODEL, FALLBACK_MODEL] }),
      keys.privateKey,
    );
    const response = await post({ body: chat({ fallbacks: [FALLBACK_MODEL] }), token });

    expect(response.status).toBe(200);
    expect(resolved).toEqual([]);
    const [forwarded] = bifrost.requests;
    expect(forwarded?.headers["x-bf-direct-key"]).toBeUndefined();
    expect(forwarded?.headers.authorization).toBeUndefined();
    expect(forwarded?.body).toEqual(chat());
  });

  test("serves an organization-funded primary whose token omits the fallbacks the request names", async () => {
    const token = signToken(
      serviceClaims(gateway.clock.now, { funding: openAiFunding(), models: [ALLOWED_MODEL] }),
      keys.privateKey,
    );
    const response = await post({
      body: chat({ fallbacks: [FALLBACK_MODEL, "openrouter/z-ai/glm-5.2"] }),
      token,
    });

    expect(response.status).toBe(200);
    const [forwarded] = bifrost.requests;
    expect(forwarded?.headers.authorization).toBe(`Bearer ${TENANT_KEY}`);
    expect(forwarded?.body).toEqual(chat());
  });

  test("still refuses an operator-funded request naming a fallback its token omits", async () => {
    const token = signToken(
      serviceClaims(gateway.clock.now, { models: [ALLOWED_MODEL] }),
      keys.privateKey,
    );
    const response = await post({ body: chat({ fallbacks: [FALLBACK_MODEL] }), token });

    expect(response.status).toBe(403);
    expect(JSON.parse(response.text)).toMatchObject({ error: { code: "model_not_allowed" } });
    expect(bifrost.requests).toHaveLength(0);
  });

  test("keeps embeddings on the operator's pool key", async () => {
    const token = signToken(
      serviceClaims(gateway.clock.now, { funding: openAiFunding() }),
      keys.privateKey,
    );
    const response = await post({
      body: { input: ["a"], model: EMBEDDING_MODEL },
      path: "/v1/embeddings",
      token,
    });

    expect(response.status).toBe(200);
    expect(resolved).toEqual([]);
    expect(bifrost.requests[0]?.headers["x-bf-direct-key"]).toBeUndefined();
    expect(bifrost.requests[0]?.headers.authorization).toBeUndefined();
  });

  test("refuses, without forwarding, a key it cannot resolve or Bifrost would ignore", async () => {
    const refusal = {
      error: {
        code: "model_credential_unavailable",
        message: "The organization's model credential is unavailable.",
        type: "model_gateway_error",
      },
    };
    const funded = (target: typeof gateway, keyVersion: number) =>
      post({
        body: chat(),
        target,
        token: signToken(
          serviceClaims(target.clock.now, { funding: openAiFunding(keyVersion) }),
          keys.privateKey,
        ),
      });

    const responses = [
      await funded(gateway, 1),
      await funded(gateway, 3),
      await funded(gateway, 4),
      await funded(unwiredGateway, 2),
    ];

    expect(responses.map(({ status, text }) => ({ body: JSON.parse(text), status }))).toEqual(
      Array.from({ length: 4 }, () => ({ body: refusal, status: 401 })),
    );
    expect(resolved.map(({ keyVersion }) => keyVersion)).toEqual([1, 3, 4]);
    expect(bifrost.requests).toEqual([]);
  });

  test("answers 502 when the key store is unavailable", async () => {
    const token = signToken(
      serviceClaims(gateway.clock.now, { funding: openAiFunding(5) }),
      keys.privateKey,
    );
    const response = await post({ body: chat(), token });

    expect(response.status).toBe(502);
    expect(JSON.parse(response.text)).toMatchObject({
      error: { code: "model_credential_store_unavailable" },
    });
    expect(bifrost.requests).toEqual([]);
  });

  test("refuses a response that Bifrost served with a key other than the organization's", async () => {
    bifrost.state.respond = () =>
      Response.json(
        { id: "chatcmpl-1", choices: [] },
        { headers: { "x-bifrost-routing-info-key": "deployments-ai-openai" } },
      );
    const token = signToken(
      serviceClaims(gateway.clock.now, { funding: openAiFunding() }),
      keys.privateKey,
    );
    const response = await post({ body: chat(), token });

    expect(response.status).toBe(502);
    expect(JSON.parse(response.text)).toMatchObject({ error: { code: "funding_mismatch" } });
  });

  test("refuses body keys that Bifrost would read as model or fallbacks", async () => {
    const token = signToken(
      serviceClaims(gateway.clock.now, { funding: openAiFunding() }),
      keys.privateKey,
    );
    const responses = [
      await post({ body: chat({ Fallbacks: [FALLBACK_MODEL] }), token }),
      await post({ body: chat({ MODEL: FALLBACK_MODEL }), token }),
    ];

    expect(responses.map(({ status, text }) => ({ body: JSON.parse(text), status }))).toEqual([
      {
        body: {
          error: {
            code: "invalid_request",
            message: "Fallbacks must be spelled fallbacks.",
            type: "model_gateway_error",
          },
        },
        status: 400,
      },
      {
        body: {
          error: {
            code: "invalid_request",
            message: "MODEL must be spelled model.",
            type: "model_gateway_error",
          },
        },
        status: 400,
      },
    ]);
    expect(bifrost.requests).toEqual([]);
  });

  test("scrubs the organization's key from an upstream error body", async () => {
    bifrost.state.respond = () =>
      Response.json(
        { error: { message: `Incorrect API key provided: ${TENANT_KEY}` } },
        { status: 401 },
      );
    const token = signToken(
      serviceClaims(gateway.clock.now, { funding: openAiFunding() }),
      keys.privateKey,
    );
    const response = await post({ body: chat(), token });

    expect(response.status).toBe(401);
    expect(JSON.parse(response.text)).toEqual({
      error: { message: "Incorrect API key provided: [redacted]" },
    });
  });
});
