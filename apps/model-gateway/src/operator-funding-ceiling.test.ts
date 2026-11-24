import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  addScopeSpend,
  readOperatorFundedModelSpend,
  scopeSpendShardCandidates,
  Ulid,
} from "@deployments-ai/db";
import { makeTenancyTestDatabase } from "@deployments-ai/db/memory-testing";
import { Schema } from "effect";
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

const ulid = Schema.decodeUnknownSync(Ulid);
const ORGANIZATION_ID = ulid(runClaims(0).organizationId);
const CREDENTIAL_ID = "01ARZ3NDEKTSV4RRFFQ69G0010";
const TENANT_KEY = `tenant-${randomBytes(24).toString("base64url")}`;
const CEILING_USD_MICROS = 1_000_000;

const keys = p256KeyPair();
const bifrost = startFakeBifrost();
const memory = makeTenancyTestDatabase();
const spendReads: string[] = [];
const spendRead = { fail: false };
const gateway = startGateway({
  bifrostUrl: bifrost.url,
  organizationKeys: { resolve: async () => TENANT_KEY },
  publicKey: keys.publicKey,
  readOperatorSpend: async (organizationId, asOf) => {
    spendReads.push(organizationId);
    if (spendRead.fail) throw new Error("DynamoDB throttled");
    return readOperatorFundedModelSpend(memory.database, organizationId, {
      asOf,
      defaultCeiling: { monthlyUsdMicros: CEILING_USD_MICROS },
    });
  },
});
const openAiFunded = { openai: { credentialId: CREDENTIAL_ID, keyVersion: 1 } };

afterAll(() => {
  void gateway.server.stop(true);
  void bifrost.server.stop(true);
});

beforeEach(() => {
  memory.records.clear();
  spendReads.length = 0;
  spendRead.fail = false;
  gateway.clock.now += 60_000;
  gateway.leases.value = runLease({
    expiresAt: new Date(gateway.clock.now + 600_000).toISOString(),
  });
  bifrost.requests.length = 0;
  bifrost.state.respond = (request) =>
    Response.json(
      { choices: [], id: "chatcmpl-1" },
      request.headers["x-bf-direct-key"] === "true"
        ? { headers: { "x-bifrost-routing-info-key": "header-provided" } }
        : {},
    );
});

/** Records operator-funded spend in this month's organization spend shard, as the usage stream does. */
async function recordOperatorSpend(usdMicros: number) {
  const at = new Date(gateway.clock.now).toISOString();
  const candidate = scopeSpendShardCandidates({
    occurredAt: at,
    scope: {
      environmentId: ulid(runClaims(0).environmentId),
      organizationId: ORGANIZATION_ID,
      projectId: ulid(runClaims(0).projectId),
      workspaceId: undefined,
    },
    shard: 3,
    updatedAt: at,
  }).find((shard) => shard.data.scope === "organization" && shard.data.period === "monthly")!;
  await memory.database.putRecord(addScopeSpend(candidate, undefined, usdMicros, "operator"));
}

async function post(token: string, body: Record<string, unknown>, path = "/v1/chat/completions") {
  const response = await fetch(`${gateway.url}${path}`, {
    body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    method: "POST",
  });
  return { body: (await response.json()) as unknown, status: response.status };
}

const chat = (model: string) => ({ messages: [{ content: "hello", role: "user" }], model });

describe("operator-funded spend ceiling at the gateway", () => {
  test("refuses a token minted under the ceiling within 5 seconds of recorded spend reaching it, and keeps the organization's own key working", async () => {
    const token = signToken(
      runClaims(gateway.clock.now, {
        funding: openAiFunded,
        models: [FALLBACK_MODEL, ALLOWED_MODEL],
      }),
      keys.privateKey,
    );

    expect((await post(token, chat(FALLBACK_MODEL))).status).toBe(200);

    await recordOperatorSpend(CEILING_USD_MICROS);
    gateway.clock.now += 4_999;
    expect((await post(token, chat(FALLBACK_MODEL))).status).toBe(200);

    gateway.clock.now += 1;
    expect(await post(token, chat(FALLBACK_MODEL))).toEqual({
      body: {
        error: {
          code: "operator_funding_exhausted",
          message: `Organization ${ORGANIZATION_ID} has used 1.00 USD of its 1.00 USD monthly operator-funded model spend ceiling, so ${FALLBACK_MODEL} cannot be served on the operator's keys. Add the organization's own key for the provider or raise the ceiling.`,
          type: "model_gateway_error",
        },
      },
      status: 403,
    });

    expect(await post(token, chat(ALLOWED_MODEL))).toEqual({
      body: { choices: [], id: "chatcmpl-1" },
      status: 200,
    });
    expect(bifrost.requests.map((request) => request.body.model)).toEqual([
      FALLBACK_MODEL,
      FALLBACK_MODEL,
      ALLOWED_MODEL,
    ]);
    expect(bifrost.requests.at(-1)?.headers.authorization).toBe(`Bearer ${TENANT_KEY}`);
    expect(spendReads).toEqual([ORGANIZATION_ID, ORGANIZATION_ID]);
  });

  test("refuses a service token's operator-funded chat past the ceiling but never its embeddings", async () => {
    await recordOperatorSpend(CEILING_USD_MICROS + 1);
    const token = signToken(serviceClaims(gateway.clock.now), keys.privateKey);

    expect((await post(token, chat(ALLOWED_MODEL))).status).toBe(403);
    expect(
      (await post(token, { input: "hello", model: EMBEDDING_MODEL }, "/v1/embeddings")).status,
    ).toBe(200);
    expect(bifrost.requests.map((request) => request.path)).toEqual(["/v1/embeddings"]);
  });

  test("admits operator-funded calls below the ceiling and skips tokens without an organization", async () => {
    await recordOperatorSpend(CEILING_USD_MICROS - 1);
    const organizationToken = signToken(serviceClaims(gateway.clock.now), keys.privateKey);
    const { organizationId: _organizationId, ...platformClaims } = serviceClaims(gateway.clock.now);
    const platformToken = signToken(platformClaims, keys.privateKey);

    expect((await post(organizationToken, chat(ALLOWED_MODEL))).status).toBe(200);
    expect((await post(platformToken, chat(ALLOWED_MODEL))).status).toBe(200);
    expect(spendReads).toEqual([ORGANIZATION_ID]);
  });

  test("a failed spend read is 502 operator_spend_unavailable and is not cached", async () => {
    const token = signToken(serviceClaims(gateway.clock.now), keys.privateKey);
    spendRead.fail = true;

    expect(await post(token, chat(ALLOWED_MODEL))).toEqual({
      body: {
        error: {
          code: "operator_spend_unavailable",
          message: "Operator-funded model spend is unavailable.",
          type: "model_gateway_error",
        },
      },
      status: 502,
    });
    spendRead.fail = false;
    expect((await post(token, chat(ALLOWED_MODEL))).status).toBe(200);
    expect(spendReads).toEqual([ORGANIZATION_ID, ORGANIZATION_ID]);
    expect(bifrost.requests).toHaveLength(1);
  });
});
