import { describe, expect, test as it } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { Effect } from "effect";
import {
  MODEL_GATEWAY_TOKEN_AUDIENCE,
  MODEL_GATEWAY_TOKEN_ISSUER,
  signModelGatewayToken,
  type ModelGatewayServiceTokenClaims,
} from "./gateway-token.ts";
import { makeModelGateway, modelUsageLedgerEntry } from "./index.ts";

const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });

const claims: ModelGatewayServiceTokenClaims = {
  aud: MODEL_GATEWAY_TOKEN_AUDIENCE,
  exp: 1_800_000_900,
  funding: { openai: { credentialId: "credential-openai", keyVersion: 3 } },
  iat: 1_800_000_000,
  iss: MODEL_GATEWAY_TOKEN_ISSUER,
  jti: "jti_service",
  kind: "service",
  models: ["openai/gpt-5.2", "openrouter/z-ai/glm-5.2", "openai/text-embedding-3-small"],
  organizationId: "org_1",
  runId: RUN_ID,
  service: "memory",
  sub: "service:memory",
};

const fundedToken = await signModelGatewayToken({
  claims,
  keyId: "test-signing-key",
  sign: async ({ signingInput }) => sign("sha256", signingInput, keys.privateKey),
});

function gateway(token: string) {
  return makeModelGateway({ baseUrl: "https://bifrost.internal", credentials: async () => token });
}

function chatUsage(token: string, modelId: string, servedModelId = modelId) {
  return Effect.runPromise(
    gateway(token).chatCompletion({
      fetch: (async () =>
        Response.json({
          choices: [{ finish_reason: "stop", message: { content: "done" } }],
          model: servedModelId,
          usage: { completion_tokens: 2, prompt_tokens: 5, total_tokens: 7 },
        })) as unknown as typeof fetch,
      messages: [{ content: "hello", role: "user" }],
      modelCallId: "call_1",
      modelId,
      runId: RUN_ID,
    }),
  ).then((result) => result.usage?.payer);
}
describe("model usage payer", () => {
  it("records the organization credential when the token funds the primary model's provider", async () => {
    expect(await chatUsage(fundedToken, "openai/gpt-5.2")).toEqual({
      kind: "organization",
      modelCredentialId: "credential-openai",
    });
  });

  it("records the operator for a provider the token's organization does not fund", async () => {
    expect(await chatUsage(fundedToken, "openrouter/z-ai/glm-5.2")).toEqual({ kind: "operator" });
  });

  it("decides the payer by the primary model, which is the only one the gateway funds", async () => {
    expect(await chatUsage(fundedToken, "openrouter/z-ai/glm-5.2", "openai/gpt-5.2")).toEqual({
      kind: "operator",
    });
  });
  it("records the operator for a token without a funding claim", async () => {
    expect(await chatUsage("opaque-token", "openai/gpt-5.2")).toEqual({ kind: "operator" });
  });

  it("records embeddings as operator-funded even under an organization's funding claim", async () => {
    const result = await Effect.runPromise(
      gateway(fundedToken).embedding({
        dimensions: 3,
        fetch: (async () =>
          Response.json({
            data: [{ embedding: [1, 2, 3] }],
            model: "openai/text-embedding-3-small",
            usage: { total_tokens: 3 },
          })) as unknown as typeof fetch,
        input: "hello",
        modelCallId: "embedding_1",
        modelId: "openai/text-embedding-3-small",
        runId: RUN_ID,
      }),
    );

    expect(result.usage?.payer).toEqual({ kind: "operator" });
  });

  it("refuses usage paid with a credential for another provider", () => {
    expect(() =>
      modelUsageLedgerEntry({
        modelCallId: "call_1",
        modelId: "openrouter/z-ai/glm-5.2",
        payer: {
          credentialId: "credential-openai",
          keyVersion: 3,
          kind: "organization",
          provider: "openai",
        },
        provider: "openrouter",
        runId: RUN_ID,
        usage: { totalTokens: 7 },
      }),
    ).toThrow(
      "Usage of openrouter/z-ai/glm-5.2 cannot be paid with an organization's openai credential.",
    );
  });
});
