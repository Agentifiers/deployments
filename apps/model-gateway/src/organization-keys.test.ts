import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { DecryptCommand, GenerateDataKeyCommand, type KMSClient } from "@aws-sdk/client-kms";
import {
  makeKmsEnvelopeAdapter,
  makeModelProviderCredentialPersistence,
  makeOrganizationModelKeyResolver,
  Ulid,
} from "@deployments-ai/db";
import { evaluationMemoryDatabase } from "@deployments-ai/db/evaluation-testing";
import { makeModelGateway } from "@deployments-ai/model-gateway";
import { Effect, Schema } from "effect";
import {
  ALLOWED_MODEL,
  FALLBACK_MODEL,
  p256KeyPair,
  RUN_ID,
  runClaims,
  runLease,
  signToken,
  startFakeBifrost,
  startGateway,
} from "./test-support.ts";

const ulid = Schema.decodeUnknownSync(Ulid);
const ORGANIZATION_ID = ulid(runClaims(0).organizationId);
const OWNER_ID = ulid("01ARZ3NDEKTSV4RRFFQ69G0020");
const CREDENTIAL_KEY_ARN =
  "arn:aws:kms:us-east-2:111122223333:key/22222222-3333-4444-5555-666666666666";
const FIRST_KEY = `sk-proj-${randomBytes(24).toString("base64url")}`;
const SECOND_KEY = `sk-proj-${randomBytes(24).toString("base64url")}`;

/** Decrypts only under the dedicated key and the exact encryption context it sealed with. */
const sealed = new Map<number, string>();
const kms = {
  send: async (command: unknown) => {
    if (command instanceof GenerateDataKeyCommand) {
      const id = sealed.size + 1;
      sealed.set(id, JSON.stringify([command.input.KeyId, command.input.EncryptionContext]));
      return { CiphertextBlob: new Uint8Array([id]), Plaintext: new Uint8Array(32).fill(id) };
    }
    if (command instanceof DecryptCommand) {
      const id = command.input.CiphertextBlob?.[0] ?? 0;
      if (
        sealed.get(id) !== JSON.stringify([command.input.KeyId, command.input.EncryptionContext])
      ) {
        throw Object.assign(new Error("Invalid ciphertext"), {
          name: "InvalidCiphertextException",
        });
      }
      return { Plaintext: new Uint8Array(32).fill(id) };
    }
    throw new Error("Unexpected KMS command.");
  },
} as unknown as KMSClient;

const memory = evaluationMemoryDatabase([]);
const envelope = makeKmsEnvelopeAdapter({ keyId: CREDENTIAL_KEY_ARN, kms, stage: "test" });
const credentials = makeModelProviderCredentialPersistence({ database: memory.database, envelope });
const change = {
  actorPrincipalId: OWNER_ID,
  organizationId: ORGANIZATION_ID,
  provider: "openai",
} as const;
const keys = p256KeyPair();
const bifrost = startFakeBifrost();
const clock = { now: Date.parse("2026-10-18T00:00:00.000Z") };
const gateway = startGateway({
  bifrostUrl: bifrost.url,
  organizationKeys: makeOrganizationModelKeyResolver({
    database: memory.database,
    envelope,
    now: () => clock.now,
  }),
  publicKey: keys.publicKey,
});

afterAll(() => {
  for (const entry of gateway.logs) {
    expect(JSON.stringify(entry)).not.toContain(FIRST_KEY);
    expect(JSON.stringify(entry)).not.toContain(SECOND_KEY);
  }
  void gateway.server.stop(true);
  void bifrost.server.stop(true);
});

beforeEach(() => {
  gateway.leases.value = runLease({
    expiresAt: new Date(gateway.clock.now + 60_000).toISOString(),
  });
  bifrost.requests.length = 0;
  bifrost.state.respond = (request) =>
    Response.json(
      {
        choices: [{ finish_reason: "stop", message: { content: "done", role: "assistant" } }],
        id: "chatcmpl-1",
        model: ALLOWED_MODEL,
        usage: { completion_tokens: 2, prompt_tokens: 5, total_tokens: 7 },
      },
      request.headers["x-bf-direct-key"] === "true"
        ? { headers: { "x-bifrost-routing-info-key": "header-provided" } }
        : {},
    );
});

function fundedRunToken(credentialId: string, keyVersion: number) {
  return signToken(
    runClaims(gateway.clock.now, { funding: { openai: { credentialId, keyVersion } } }),
    keys.privateKey,
  );
}

async function chatStatus(token: string) {
  const response = await fetch(`${gateway.url}/v1/chat/completions`, {
    body: JSON.stringify({ messages: [{ content: "hello", role: "user" }], model: ALLOWED_MODEL }),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    method: "POST",
  });
  return { body: (await response.json()) as unknown, status: response.status };
}

describe("organization-funded run through the gateway", () => {
  test("serves the run with the organization's stored key and records the organization as payer", async () => {
    const stored = await credentials.set({ ...change, apiKey: FIRST_KEY });
    const token = fundedRunToken(stored.credentialId, stored.keyVersion);

    const result = await Effect.runPromise(
      makeModelGateway({ baseUrl: gateway.url, credentials: async () => token }).chatCompletion({
        fallbackModelIds: [FALLBACK_MODEL],
        messages: [{ content: "hello", role: "user" }],
        modelCallId: "call_1",
        modelId: ALLOWED_MODEL,
        runId: RUN_ID,
      }),
    );

    expect(bifrost.requests.map(({ headers }) => headers.authorization)).toEqual([
      `Bearer ${FIRST_KEY}`,
    ]);
    expect(bifrost.requests[0]?.headers["x-bf-direct-key"]).toBe("true");
    expect(bifrost.requests[0]?.body).not.toHaveProperty("fallbacks");
    expect(result.usage?.payer).toEqual({
      kind: "organization",
      modelCredentialId: stored.credentialId,
    });
  });

  test("serves a run whose exhausted ceiling left only its organization-funded primary in the token", async () => {
    const stored = await credentials.set({ ...change, apiKey: FIRST_KEY });
    const token = signToken(
      runClaims(gateway.clock.now, {
        funding: { openai: { credentialId: stored.credentialId, keyVersion: stored.keyVersion } },
        models: [ALLOWED_MODEL],
      }),
      keys.privateKey,
    );

    const result = await Effect.runPromise(
      makeModelGateway({ baseUrl: gateway.url, credentials: async () => token }).chatCompletion({
        fallbackModelIds: [FALLBACK_MODEL, "openrouter/z-ai/glm-5.2"],
        messages: [{ content: "hello", role: "user" }],
        modelCallId: "call_2",
        modelId: ALLOWED_MODEL,
        runId: RUN_ID,
      }),
    );

    expect(bifrost.requests.map(({ headers }) => headers.authorization)).toEqual([
      `Bearer ${FIRST_KEY}`,
    ]);
    expect(bifrost.requests[0]?.body).not.toHaveProperty("fallbacks");
    expect(result.usage?.payer).toEqual({
      kind: "organization",
      modelCredentialId: stored.credentialId,
    });
  });

  test("refuses a replaced or revoked key with 401 once the cached key expires", async () => {
    const first = await credentials.set({ ...change, apiKey: FIRST_KEY });
    expect((await chatStatus(fundedRunToken(first.credentialId, first.keyVersion))).status).toBe(
      200,
    );
    const second = await credentials.set({ ...change, apiKey: SECOND_KEY });
    clock.now += 60_000;
    const unavailable = {
      body: {
        error: {
          code: "model_credential_unavailable",
          message: "The organization's model credential is unavailable.",
          type: "model_gateway_error",
        },
      },
      status: 401,
    };

    expect(await chatStatus(fundedRunToken(first.credentialId, first.keyVersion))).toEqual(
      unavailable,
    );
    expect((await chatStatus(fundedRunToken(second.credentialId, second.keyVersion))).status).toBe(
      200,
    );
    expect(bifrost.requests.at(-1)?.headers.authorization).toBe(`Bearer ${SECOND_KEY}`);

    await credentials.remove(change);
    clock.now += 60_000;
    expect(await chatStatus(fundedRunToken(second.credentialId, second.keyVersion))).toEqual(
      unavailable,
    );
  });
});
