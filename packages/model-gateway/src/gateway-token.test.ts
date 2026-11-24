import { describe, expect, it } from "bun:test";
import { createHash, generateKeyPairSync, sign as signWithKey } from "node:crypto";

import {
  derEcdsaSignatureToJose,
  MODEL_GATEWAY_TOKEN_AUDIENCE,
  MODEL_GATEWAY_TOKEN_ISSUER,
  MODEL_GATEWAY_RUN_TOKEN_TTL_SECONDS,
  modelGatewayTokenAllowsModel,
  type ModelGatewayRunTokenClaims,
  type ModelGatewayServiceTokenClaims,
  signModelGatewayToken,
  verifyModelGatewayToken,
} from "./gateway-token.ts";

/** DER-encodes a big-endian ECDSA integer (minimal length, sign padding added). */
function derInteger(value: Uint8Array) {
  let bytes = Buffer.from(value);
  while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.subarray(1);
  if (bytes[0]! & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
}
function derSignature(r: Uint8Array, s: Uint8Array) {
  const body = Buffer.concat([derInteger(r), derInteger(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

const KEY_ID = "arn:aws:kms:us-east-2:123456789012:key/current";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const otherKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const NOW = 1_800_000_000;

const runClaims: ModelGatewayRunTokenClaims = {
  aud: MODEL_GATEWAY_TOKEN_AUDIENCE,
  environmentId: "env_1",
  exp: NOW + MODEL_GATEWAY_RUN_TOKEN_TTL_SECONDS,
  iat: NOW,
  iss: MODEL_GATEWAY_TOKEN_ISSUER,
  jti: "jti_run",
  kind: "run",
  leaseOwner: "worker-1:lease",
  models: ["openai/gpt-5.2", "openrouter/z-ai/glm-5.2"],
  organizationId: "org_1",
  projectId: "project_1",
  runId: "run_1",
  sub: "run:run_1",
  threadId: "thread_1",
  workspaceId: "workspace_1",
};
const serviceClaims: ModelGatewayServiceTokenClaims = {
  aud: MODEL_GATEWAY_TOKEN_AUDIENCE,
  exp: NOW + 900,
  iat: NOW,
  iss: MODEL_GATEWAY_TOKEN_ISSUER,
  jti: "jti_service",
  kind: "service",
  models: ["openai/text-embedding-3-small"],
  organizationId: "org_1",
  service: "memory",
  sub: "service:memory",
};

const trusted = async (keyId: string) => (keyId === KEY_ID ? keys.publicKey : undefined);
const verifyAt = (token: string, seconds = NOW, publicKey = trusted) =>
  verifyModelGatewayToken(token, { now: seconds * 1000, publicKey });
const sign = (claims: unknown, keyId = KEY_ID) =>
  signModelGatewayToken({
    claims: claims as ModelGatewayRunTokenClaims,
    keyId,
    sign: async ({ signingInput }) =>
      signWithKey("sha256", signingInput, { dsaEncoding: "der", key: keys.privateKey }),
  });
const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** Signs arbitrary header and payload JSON, bypassing the claim checks of the real signer. */
function signRaw(header: unknown, payload: unknown) {
  const input = `${segment(header)}.${segment(payload)}`;
  const signature = signWithKey("sha256", Buffer.from(input), {
    dsaEncoding: "ieee-p1363",
    key: keys.privateKey,
  });
  return `${input}.${signature.toString("base64url")}`;
}
const header = { alg: "ES256", kid: KEY_ID, typ: "JWT" };

describe("model gateway tokens", () => {
  it("verifies run and service tokens signed with a local key", async () => {
    const runToken = await sign(runClaims);
    expect(runToken.split(".")).toHaveLength(3);
    expect(JSON.parse(Buffer.from(runToken.split(".")[0]!, "base64url").toString())).toEqual(
      header,
    );
    expect(await verifyAt(runToken)).toEqual({ claims: runClaims, ok: true });
    expect(await verifyAt(await sign(serviceClaims))).toEqual({ claims: serviceClaims, ok: true });
  });

  it("hands the signer the signing input and its SHA-256 digest", async () => {
    const requests: { digest: Uint8Array; signingInput: Uint8Array }[] = [];
    const token = await signModelGatewayToken({
      claims: runClaims,
      keyId: KEY_ID,
      sign: async (request) => {
        requests.push(request);
        return signWithKey("sha256", request.signingInput, {
          dsaEncoding: "der",
          key: keys.privateKey,
        });
      },
    });
    const signingInput = token.split(".").slice(0, 2).join(".");
    expect(Buffer.from(requests[0]!.signingInput).toString()).toBe(signingInput);
    expect(Buffer.from(requests[0]!.digest)).toEqual(
      createHash("sha256").update(signingInput).digest(),
    );
  });

  it("refuses to sign invalid claims", async () => {
    const { leaseOwner: _leaseOwner, ...withoutLeaseOwner } = runClaims;
    expect(sign(withoutLeaseOwner)).rejects.toThrow("claims are invalid");
  });

  it("rejects bad signatures and untrusted keys", async () => {
    const token = await sign(runClaims);
    const [encodedHeader, , signature] = token.split(".");
    const tampered = `${encodedHeader}.${segment({ ...runClaims, models: ["*"] })}.${signature}`;
    expect(await verifyAt(tampered)).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(await verifyAt(token, NOW, async () => otherKeys.publicKey)).toMatchObject({
      ok: false,
      reason: "bad_signature",
    });
    const truncated = `${encodedHeader}.${token.split(".")[1]}.${Buffer.alloc(63).toString("base64url")}`;
    expect(await verifyAt(truncated)).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(await verifyAt(await sign(runClaims, "arn:aws:kms:us-east-2:1:key/old"))).toMatchObject({
      ok: false,
      reason: "unknown_key",
    });
    expect(await verifyAt(signRaw({ alg: "ES256" }, runClaims))).toMatchObject({
      ok: false,
      reason: "unknown_key",
    });
  });

  it("enforces expiry and issue time within the clock skew", async () => {
    const token = await sign(runClaims);
    expect(await verifyAt(token, runClaims.exp + 29)).toMatchObject({ ok: true });
    expect(await verifyAt(token, runClaims.exp + 30)).toMatchObject({
      ok: false,
      reason: "expired",
    });
    expect(await verifyAt(token, NOW - 30)).toMatchObject({ ok: true });
    expect(await verifyAt(token, NOW - 31)).toMatchObject({ ok: false, reason: "not_yet_valid" });
  });

  it("rejects foreign audiences and issuers", async () => {
    expect(await verifyAt(await sign({ ...runClaims, aud: "bifrost" }))).toMatchObject({
      ok: false,
      reason: "wrong_audience",
    });
    expect(await verifyAt(await sign({ ...runClaims, iss: "someone-else" }))).toMatchObject({
      ok: false,
      reason: "wrong_issuer",
    });
  });

  it("bounds the token lifetime", async () => {
    expect(await verifyAt(await sign({ ...serviceClaims, exp: NOW + 901 }))).toMatchObject({
      ok: false,
      reason: "lifetime_too_long",
    });
    expect(await verifyAt(await sign({ ...serviceClaims, exp: NOW }))).toMatchObject({
      ok: false,
      reason: "lifetime_too_long",
    });
  });

  it("rejects malformed tokens and other algorithms", async () => {
    const token = await sign(runClaims);
    const [, payload, signature] = token.split(".");
    for (const malformed of [
      "",
      "a.b",
      "a.b.c.d",
      `!!.${payload}.${signature}`,
      "x".repeat(16_385),
    ]) {
      expect(await verifyAt(malformed)).toMatchObject({ ok: false, reason: "malformed" });
    }
    expect(await verifyAt(`${segment(header)}.${payload}.not+base64`)).toMatchObject({
      ok: false,
      reason: "malformed",
    });
    expect(await verifyAt(`${segment({ ...header, alg: "none" })}.${payload}.`)).toMatchObject({
      ok: false,
      reason: "unsupported_algorithm",
    });
    expect(
      await verifyAt(`${segment({ ...header, alg: "HS256" })}.${payload}.${signature}`),
    ).toMatchObject({
      ok: false,
      reason: "unsupported_algorithm",
    });
    expect(
      await verifyAt(`${segment({ ...header, typ: "at+jwt" })}.${payload}.${signature}`),
    ).toMatchObject({
      ok: false,
      reason: "unsupported_algorithm",
    });
  });

  it("rejects validly signed tokens with invalid claims", async () => {
    const { leaseOwner: _leaseOwner, ...withoutLeaseOwner } = runClaims;
    for (const claims of [
      withoutLeaseOwner,
      { ...runClaims, sub: "run:other" },
      { ...serviceClaims, sub: "service:other" },
      { ...serviceClaims, kind: "admin" },
      { ...runClaims, models: Array.from({ length: 65 }, (_, index) => `openai/m${index}`) },
      { ...runClaims, models: ["openai/gpt-5.2", ""] },
      { ...serviceClaims, workspaceId: " " },
      { ...runClaims, exp: "later" },
      ["not", "an", "object"],
    ]) {
      expect(await verifyAt(signRaw(header, claims))).toMatchObject({
        ok: false,
        reason: "invalid_claims",
      });
    }
  });

  it("carries an organization funding claim through signing and verification", async () => {
    const funding = { openrouter: { credentialId: "cred_1", keyVersion: 3 } };
    const verified = await verifyAt(await sign({ ...serviceClaims, funding }));
    expect(verified).toEqual({ claims: { ...serviceClaims, funding }, ok: true });
  });

  it("rejects funding claims that are malformed or name no organization", async () => {
    const { organizationId: _organizationId, ...withoutOrganization } = serviceClaims;
    const ref = { credentialId: "cred_1", keyVersion: 1 };
    for (const claims of [
      { ...withoutOrganization, funding: { openai: ref } },
      { ...runClaims, funding: { bedrock: ref } },
      { ...runClaims, funding: { openai: { ...ref, keyVersion: 0 } } },
      { ...runClaims, funding: { openai: { ...ref, keyVersion: 1.5 } } },
      { ...runClaims, funding: { openai: { ...ref, credentialId: " " } } },
      { ...runClaims, funding: { openai: "cred_1" } },
      { ...runClaims, funding: [ref] },
      { ...runClaims, funding: null },
    ]) {
      expect(await verifyAt(signRaw(header, claims))).toMatchObject({
        ok: false,
        reason: "invalid_claims",
      });
    }
  });

  it("checks token models case-insensitively", () => {
    expect(modelGatewayTokenAllowsModel(runClaims, "OpenAI/GPT-5.2")).toBe(true);
    expect(modelGatewayTokenAllowsModel(runClaims, "openrouter/z-ai/glm-5.2")).toBe(true);
    expect(modelGatewayTokenAllowsModel(runClaims, "openai/gpt-4o")).toBe(false);
    expect(modelGatewayTokenAllowsModel({ ...serviceClaims, models: [] }, "openai/gpt-4o")).toBe(
      false,
    );
  });
});

describe("DER to JOSE signature conversion", () => {
  it("strips sign padding and left-pads short integers", () => {
    const r = Buffer.alloc(32, 0xff);
    const s = Buffer.alloc(30, 0x11);
    const der = derSignature(r, s);
    // r carries a leading zero (33 bytes); s is two bytes short.
    expect(der[3]).toBe(33);
    expect(Buffer.from(derEcdsaSignatureToJose(der))).toEqual(
      Buffer.concat([r, Buffer.alloc(2), s]),
    );
    expect(
      Buffer.from(derEcdsaSignatureToJose(derSignature(Buffer.from([1]), Buffer.from([2])))),
    ).toEqual(
      Buffer.concat([Buffer.alloc(31), Buffer.from([1]), Buffer.alloc(31), Buffer.from([2])]),
    );
  });

  it("rejects malformed DER", () => {
    const der = derSignature(Buffer.alloc(32, 1), Buffer.alloc(32, 2));
    expect(() => derEcdsaSignatureToJose(Buffer.concat([der, Buffer.from([0])]))).toThrow(
      "length mismatch",
    );
    expect(() => derEcdsaSignatureToJose(Buffer.from([0x31, 0]))).toThrow("sequence expected");
    expect(() => derEcdsaSignatureToJose(Buffer.from([0x30, 2, 0x05, 0]))).toThrow(
      "integer expected",
    );
    expect(() =>
      derEcdsaSignatureToJose(derSignature(Buffer.alloc(33, 1), Buffer.alloc(32, 2))),
    ).toThrow("too large");
    expect(() => derEcdsaSignatureToJose(Buffer.from([0x30]))).toThrow("Truncated");
  });
});
