import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeBrainModelGateway } from "./model-gateway.ts";

async function sentFallbacks(environment: Readonly<Record<string, string | undefined>>) {
  const bodies: Record<string, unknown>[] = [];
  const gateway = makeBrainModelGateway({
    baseUrl: "https://gateway.internal",
    environment,
    lambda: {
      send: (async () => ({
        Payload: Buffer.from(
          JSON.stringify({ expiresAt: 4_102_444_800, models: [], ok: true, token: "brain-token" }),
        ),
      })) as never,
    },
    tokenIssuer: "brain-token-issuer",
  });
  await Effect.runPromiseExit(
    gateway.chatCompletion({
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
        return new Response("refused", { status: 400 });
      }) as typeof fetch,
      messages: [{ content: "What changed?", role: "user" }],
      modelId: "openai/gpt-6-luna",
      scope: { organizationId: "org_1" },
    }),
  );
  return bodies.map((body) => body.fallbacks);
}

describe("Brain model gateway", () => {
  test("requests the deployment's configured fallbacks", async () => {
    expect(
      await sentFallbacks({
        DEPLOYMENTS_AI_DEFAULT_MODEL_FALLBACK_IDS: "openai/gpt-5.6-luna, openai/gpt-6-sol",
      }),
    ).toEqual([["openai/gpt-5.6-luna", "openai/gpt-6-sol"]]);
  });

  test("keeps the code default fallbacks when none are configured", async () => {
    expect(await sentFallbacks({})).toEqual([
      ["openrouter/z-ai/glm-5.2", "openrouter/xiaomi/mimo-v2.5"],
    ]);
  });
});
