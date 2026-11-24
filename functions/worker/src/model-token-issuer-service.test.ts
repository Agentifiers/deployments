import { describe, expect, it } from "bun:test";
import {
  makeModelPolicyPersistence,
  type ByokProvider,
  type DynamoDatabaseService,
} from "@deployments-ai/db";
import {
  MODEL_GATEWAY_SERVICE_TOKEN_TTL_SECONDS,
  type ModelGatewayServiceTokenClaims,
} from "@deployments-ai/model-gateway";
import { id, inMemoryDatabase } from "./agent-run.fixture.ts";
import { cachedModelOperatorGrants } from "./model-token-issuer-admission.ts";
import {
  modelTokenFundingConfigFromEnv,
  type ModelTokenFundingConfig,
} from "./model-token-issuer-funding.ts";
import { issueModelToken, modelTokenIssuerConfigFromEnv } from "./model-token-issuer.ts";
import {
  issueServiceModelToken,
  type ModelServiceTokenIssuerConfig,
} from "./model-token-issuer-service.ts";
import {
  claimedRun,
  grantModelSpendCeiling,
  operatorSpendShard,
  setPhiDataBoundary,
  setupClaimedRun,
  storeOrganizationModelKey,
  TEST_CREDENTIAL_ID,
  TEST_FUNDING,
  TEST_LEASE_OWNER,
  TEST_NOW,
  TEST_SIGNING_KEY_ARN,
  testIssuerDependencies,
  threadLease,
  verifiedClaims,
  type TestIssuerOptions,
} from "./model-token.fixture.ts";

/** A database whose organization standing reads fail once `succeeding` of them have succeeded. */
function failingStandingReads(
  database: DynamoDatabaseService,
  succeeding = 0,
): DynamoDatabaseService {
  let reads = 0;
  return {
    ...database,
    getRecord: async (table, key, consistent) => {
      if (key.sk === "ORGANIZATION-STANDING" && (reads += 1) > succeeding) {
        throw new Error("DynamoDB is unavailable.");
      }
      return database.getRecord(table, key, consistent);
    },
  };
}

const ANSWER_MODEL_ID = "openrouter/qwen/qwen3.7-plus";
const EMBEDDING_MODEL_ID = "openai/text-embedding-3-small";
/** Curated, so the curated defaults admit it in any environment without a policy. */
const TENANT_MODEL_ID = "openrouter/z-ai/glm-5.2";
const GRANTED_MODEL_ID = "openrouter/vendor/operator-granted";

const tenant = {
  environmentId: id(3),
  organizationId: id(1),
  projectId: id(2),
};

function serviceIssuer(
  overrides: Partial<ModelServiceTokenIssuerConfig> = {},
): ModelServiceTokenIssuerConfig {
  return {
    kind: "service",
    service: "brain",
    serviceModels: [ANSWER_MODEL_ID, EMBEDDING_MODEL_ID],
    tenantModels: false,
    ...overrides,
  };
}

function setup(options: TestIssuerOptions = {}) {
  return testIssuerDependencies(inMemoryDatabase([]).database, options);
}

describe("service model token issuer", () => {
  it("defaults to the configured service models and verifies against the signing key", async () => {
    const { dependencies, key } = setup();

    const response = await issueModelToken(serviceIssuer(), dependencies, { kind: "service" });

    if (!response.ok) throw new Error(`Issuance was refused: ${response.message}`);
    const iat = Math.floor(TEST_NOW.getTime() / 1000);
    expect(response).toMatchObject({
      expiresAt: iat + MODEL_GATEWAY_SERVICE_TOKEN_TTL_SECONDS,
      models: [ANSWER_MODEL_ID, EMBEDDING_MODEL_ID],
    });
    const claims = (await verifiedClaims(
      response.token,
      key.publicKey,
    )) as ModelGatewayServiceTokenClaims;
    expect(claims).toEqual({
      aud: "model-gateway",
      exp: iat + 900,
      iat,
      iss: "deployments-ai-model-token-issuer",
      jti: "token-id-1",
      kind: "service",
      models: [ANSWER_MODEL_ID, EMBEDDING_MODEL_ID],
      service: "brain",
      sub: "service:brain",
    });
    expect(key.signingInputs).toHaveLength(1);
  });

  it("mints a requested configured model with its attribution context", async () => {
    const { dependencies, grantLoads, key } = setup();
    const context = { ...tenant, runId: id(10), workspaceId: id(4) };

    const response = await issueModelToken(serviceIssuer(), dependencies, {
      context,
      kind: "service",
      models: [` ${EMBEDDING_MODEL_ID.toUpperCase()} `],
    });

    if (!response.ok) throw new Error(`Issuance was refused: ${response.message}`);
    expect(response.models).toEqual([EMBEDDING_MODEL_ID]);
    expect(await verifiedClaims(response.token, key.publicKey)).toMatchObject({
      ...context,
      models: [EMBEDDING_MODEL_ID],
    });
    expect(grantLoads()).toBe(0);
  });

  it("refuses a foreign model when the service may not use tenant models", async () => {
    const { dependencies, key } = setup();

    const response = await issueModelToken(serviceIssuer(), dependencies, {
      context: tenant,
      kind: "service",
      models: [ANSWER_MODEL_ID, TENANT_MODEL_ID],
    });

    expect(response).toMatchObject({ code: "model_not_admitted", ok: false });
    expect(key.signingInputs).toHaveLength(0);
  });

  it("admits a tenant model through the environment when tenant models are enabled", async () => {
    const { dependencies, key } = setup();

    const response = await issueModelToken(
      serviceIssuer({ service: "evaluations", serviceModels: [], tenantModels: true }),
      dependencies,
      { context: tenant, kind: "service", models: [TENANT_MODEL_ID] },
    );

    if (!response.ok) throw new Error(`Issuance was refused: ${response.message}`);
    expect(await verifiedClaims(response.token, key.publicKey)).toMatchObject({
      ...tenant,
      models: [TENANT_MODEL_ID],
      service: "evaluations",
      sub: "service:evaluations",
    });
  });

  it("admits a tenant model only an operator grant for the context's agent allows", async () => {
    const agentDefinitionId = id(5);
    const issuer = serviceIssuer({ serviceModels: [], tenantModels: true });
    const request = {
      context: { ...tenant, agentDefinitionId },
      kind: "service",
      models: [GRANTED_MODEL_ID],
    };

    const refused = await issueModelToken(issuer, setup().dependencies, request);
    expect(refused).toMatchObject({ code: "model_not_admitted", ok: false });

    const granted = await issueModelToken(
      issuer,
      setup({
        grants: [
          {
            agentId: agentDefinitionId,
            allowedModels: [GRANTED_MODEL_ID],
            providers: ["openrouter"],
          },
        ],
      }).dependencies,
      request,
    );
    expect(granted).toMatchObject({ models: [GRANTED_MODEL_ID], ok: true });
  });

  it("refuses a tenant model the environment policy denies", async () => {
    const memory = inMemoryDatabase([]);
    await makeModelPolicyPersistence(memory.database).create(
      tenant,
      { includeCuratedModels: false, models: [], name: "Nothing" },
      { principalId: id(11) },
    );
    const { dependencies } = testIssuerDependencies(memory.database);

    const response = await issueModelToken(serviceIssuer({ tenantModels: true }), dependencies, {
      context: tenant,
      kind: "service",
      models: [TENANT_MODEL_ID],
    });

    expect(response).toMatchObject({ code: "model_not_admitted", ok: false });
  });

  it("refuses tenant models without a complete environment context", async () => {
    const issuer = serviceIssuer({ tenantModels: true });
    for (const context of [undefined, { organizationId: tenant.organizationId }]) {
      const { dependencies, grantLoads } = setup();
      // eslint-disable-next-line no-await-in-loop -- refusals are independent and sequential.
      const response = await issueModelToken(issuer, dependencies, {
        ...(context ? { context } : {}),
        kind: "service",
        models: [TENANT_MODEL_ID],
      });
      expect(response).toMatchObject({ code: "model_not_admitted", ok: false });
      expect(grantLoads()).toBe(0);
    }
  });

  it("refuses malformed and foreign payloads with invalid_request", async () => {
    const { dependencies, key } = setup();
    const issuer = serviceIssuer({ serviceModels: [], tenantModels: true });
    const payloads: unknown[] = [
      null,
      { kind: "unknown" },
      {
        kind: "run",
        leaseOwner: "worker-1",
        organizationId: id(1),
        runId: id(10),
        threadId: id(8),
      },
      { kind: "service" },
      { kind: "service", models: [] },
      { kind: "service", models: [""] },
      { kind: "service", models: "openai/gpt-5" },
      { kind: "service", models: Array.from({ length: 65 }, (_, index) => `openai/m-${index}`) },
      { extra: 1, kind: "service", models: [TENANT_MODEL_ID] },
      { context: { ...tenant, threadId: id(8) }, kind: "service", models: [TENANT_MODEL_ID] },
      { context: { ...tenant, projectId: 7 }, kind: "service", models: [TENANT_MODEL_ID] },
      { context: [tenant], kind: "service", models: [TENANT_MODEL_ID] },
    ];

    for (const payload of payloads) {
      // eslint-disable-next-line no-await-in-loop -- refusals are independent and sequential.
      const response = await issueModelToken(issuer, dependencies, payload);
      expect(response).toMatchObject({ code: "invalid_request", ok: false });
    }
    expect(key.signingInputs).toHaveLength(0);
  });

  it("throws when signing fails", async () => {
    const { dependencies } = setup({
      signer: {
        keyId: TEST_SIGNING_KEY_ARN,
        sign: async () => {
          throw new Error("KMS is unavailable.");
        },
      },
    });

    expect(issueModelToken(serviceIssuer(), dependencies, { kind: "service" })).rejects.toThrow(
      "KMS is unavailable.",
    );
  });
});

describe("service model token funding", () => {
  const BRAIN_FUNDING = {
    ...TEST_FUNDING,
    credentialProviders: new Set(["openrouter"] as const),
    embeddingModelIds: new Set([EMBEDDING_MODEL_ID]),
  };

  /** An organization whose 1 USD operator-funded ceiling is used up this month. */
  async function exhaustedOrganization(
    options: {
      readonly funding?: ModelTokenFundingConfig;
      readonly organizationKey?: ByokProvider;
    } = {},
  ) {
    const memory = inMemoryDatabase([operatorSpendShard(tenant, 1_000_000)]);
    await grantModelSpendCeiling(memory.database, tenant.organizationId, 1_000_000);
    if (options.organizationKey) {
      await storeOrganizationModelKey(
        memory.database,
        tenant.organizationId,
        options.organizationKey,
      );
    }
    return testIssuerDependencies(memory.database, { funding: options.funding ?? BRAIN_FUNDING });
  }

  it("signs the organization's key into a token whose context names the organization", async () => {
    const { dependencies, key } = await exhaustedOrganization({ organizationKey: "openrouter" });

    const response = await issueModelToken(serviceIssuer(), dependencies, {
      context: { organizationId: tenant.organizationId },
      kind: "service",
    });

    if (!response.ok) throw new Error(`Issuance was refused: ${response.message}`);
    expect(await verifiedClaims(response.token, key.publicKey)).toMatchObject({
      funding: { openrouter: { credentialId: TEST_CREDENTIAL_ID, keyVersion: 1 } },
      models: [ANSWER_MODEL_ID, EMBEDDING_MODEL_ID],
      organizationId: tenant.organizationId,
    });
  });

  it("mints embedding tokens at an exhausted ceiling, operator-funded", async () => {
    const { dependencies, key } = await exhaustedOrganization();

    const response = await issueModelToken(serviceIssuer(), dependencies, {
      context: { organizationId: tenant.organizationId },
      kind: "service",
      models: [EMBEDDING_MODEL_ID],
    });

    if (!response.ok) throw new Error(`Issuance was refused: ${response.message}`);
    expect(await verifiedClaims(response.token, key.publicKey)).not.toHaveProperty("funding");
  });

  it("refuses an operator-funded answer model at an exhausted ceiling", async () => {
    const { dependencies, key } = await exhaustedOrganization();

    const response = await issueModelToken(serviceIssuer(), dependencies, {
      context: { organizationId: tenant.organizationId },
      kind: "service",
      models: [ANSWER_MODEL_ID],
    });

    expect(response).toEqual({
      code: "operator_funding_exhausted",
      message: `Organization ${tenant.organizationId} has used 1.00 USD of its 1.00 USD monthly operator-funded model spend ceiling, so ${ANSWER_MODEL_ID} cannot be served on the operator's keys. Add the organization's own key for the provider or raise the ceiling.`,
      ok: false,
    });
    expect(key.signingInputs).toHaveLength(0);
  });

  describe("Brain answers for an OpenAI-key-only organization at an exhausted ceiling", () => {
    const BRAIN_ANSWER_MODEL_ID = "openai/gpt-4o-mini";
    const PLATFORM_FALLBACK_IDS = ["openrouter/xiaomi/mimo-v2.5", "openrouter/z-ai/glm-5.2"];
    const brain = serviceIssuer({
      serviceModels: [BRAIN_ANSWER_MODEL_ID, ...PLATFORM_FALLBACK_IDS, EMBEDDING_MODEL_ID],
    });
    const exhaustedWithOpenAIKey = () =>
      exhaustedOrganization({
        funding: { ...BRAIN_FUNDING, credentialProviders: new Set(["openai", "openrouter"]) },
        organizationKey: "openai",
      });

    it("run on the organization's key without the platform fallbacks", async () => {
      const { dependencies, key } = await exhaustedWithOpenAIKey();

      const response = await issueModelToken(brain, dependencies, {
        context: { organizationId: tenant.organizationId },
        kind: "service",
        models: [BRAIN_ANSWER_MODEL_ID, ...PLATFORM_FALLBACK_IDS],
      });

      if (!response.ok) throw new Error(`Issuance was refused: ${response.message}`);
      const claims = await verifiedClaims(response.token, key.publicKey);
      expect({ funding: claims.funding, models: claims.models }).toEqual({
        funding: { openai: { credentialId: TEST_CREDENTIAL_ID, keyVersion: 1 } },
        models: [BRAIN_ANSWER_MODEL_ID],
      });
    });

    it("are refused when the operator would pay for the answer model", async () => {
      const { dependencies, key } = await exhaustedWithOpenAIKey();

      const response = await issueModelToken(brain, dependencies, {
        context: { organizationId: tenant.organizationId },
        kind: "service",
        models: [...PLATFORM_FALLBACK_IDS, BRAIN_ANSWER_MODEL_ID],
      });

      expect(response).toEqual({
        code: "operator_funding_exhausted",
        message: `Organization ${tenant.organizationId} has used 1.00 USD of its 1.00 USD monthly operator-funded model spend ceiling, so ${PLATFORM_FALLBACK_IDS[0]} cannot be served on the operator's keys. Add the organization's own key for the provider or raise the ceiling.`,
        ok: false,
      });
      expect(key.signingInputs).toHaveLength(0);
    });
  });

  it("leaves tokens without an organization operator-funded and unmetered", async () => {
    const { dependencies, key } = setup({
      funding: {
        ...BRAIN_FUNDING,
        installDefaults: {
          ...TEST_FUNDING.installDefaults,
          operatorFundedModelSpendCeiling: { monthlyUsdMicros: 0 },
        },
      },
    });

    const response = await issueModelToken(serviceIssuer(), dependencies, { kind: "service" });

    if (!response.ok) throw new Error(`Issuance was refused: ${response.message}`);
    expect(await verifiedClaims(response.token, key.publicKey)).not.toHaveProperty("funding");
  });

  it("refuses a context organization that is not a ULID", async () => {
    const { dependencies } = setup();

    expect(
      await issueModelToken(serviceIssuer(), dependencies, {
        context: { organizationId: "org_1" },
        kind: "service",
      }),
    ).toEqual({
      code: "invalid_request",
      message: "Service token context organizationId must be a ULID.",
      ok: false,
    });
  });
});

describe("service tokens inside a PHI data boundary", () => {
  /** Curated, so the curated defaults admit them in any environment without a policy. */
  const BEDROCK_ANSWER_MODEL_ID = "bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0";
  const BEDROCK_EMBEDDING_MODEL_ID = "bedrock/global.cohere.embed-v4:0";
  const funding = { ...TEST_FUNDING, embeddingModelIds: new Set([EMBEDDING_MODEL_ID]) };
  const outsideBoundary = (organizationId: string, modelIds: readonly string[]) => ({
    code: "model_outside_data_boundary" as const,
    message: `Organization ${organizationId}'s phi data boundary allows only bedrock models; ${modelIds.join(", ")} is outside it.`,
    ok: false as const,
  });

  async function phiOrganization() {
    const memory = inMemoryDatabase([]);
    await setPhiDataBoundary(memory.database, tenant.organizationId);
    return testIssuerDependencies(memory.database, { funding });
  }

  it("refuses the configured service models outside Bedrock", async () => {
    const { dependencies, key } = await phiOrganization();

    const response = await issueModelToken(serviceIssuer(), dependencies, {
      context: { organizationId: tenant.organizationId },
      kind: "service",
    });

    expect(response).toEqual(
      outsideBoundary(tenant.organizationId, [ANSWER_MODEL_ID, EMBEDDING_MODEL_ID]),
    );
    expect(key.signingInputs).toHaveLength(0);
  });

  it("refuses an embedding-only token outside Bedrock, unlike a hold", async () => {
    const { dependencies, key } = await phiOrganization();

    const response = await issueModelToken(serviceIssuer(), dependencies, {
      context: { organizationId: tenant.organizationId },
      kind: "service",
      models: [EMBEDDING_MODEL_ID],
    });

    expect(response).toEqual(outsideBoundary(tenant.organizationId, [EMBEDDING_MODEL_ID]));
    expect(key.signingInputs).toHaveLength(0);
  });

  it("mints Bedrock service models", async () => {
    const { dependencies, key } = await phiOrganization();
    const models = [BEDROCK_ANSWER_MODEL_ID, BEDROCK_EMBEDDING_MODEL_ID];

    const response = await issueModelToken(serviceIssuer({ serviceModels: models }), dependencies, {
      context: { organizationId: tenant.organizationId },
      kind: "service",
    });

    if (!response.ok) throw new Error(`Issuance was refused: ${response.message}`);
    expect(await verifiedClaims(response.token, key.publicKey)).toMatchObject({
      models,
      organizationId: tenant.organizationId,
    });
  });

  it("still mints a token that names no organization", async () => {
    const { dependencies } = await phiOrganization();

    const response = await issueModelToken(serviceIssuer(), dependencies, { kind: "service" });

    expect(response).toMatchObject({ models: [ANSWER_MODEL_ID, EMBEDDING_MODEL_ID], ok: true });
  });

  it("refuses a run claim without a context organization by the run's boundary", async () => {
    const { fixture, memory } = setupClaimedRun((fixture) => [
      fixture.release,
      claimedRun(fixture),
      threadLease(fixture),
    ]);
    const { organizationId } = fixture.run.data;
    await setPhiDataBoundary(memory.database, organizationId);
    const { dependencies, key } = testIssuerDependencies(memory.database, { funding });
    const request = {
      kind: "service",
      models: [ANSWER_MODEL_ID],
      run: {
        leaseOwner: TEST_LEASE_OWNER,
        organizationId,
        runId: fixture.run.data.id,
        threadId: fixture.run.data.threadId,
      },
    } as const;

    expect(await issueModelToken(serviceIssuer(), dependencies, request)).toMatchObject({
      code: "invalid_request",
      ok: false,
    });
    expect(await issueServiceModelToken(serviceIssuer(), dependencies, request)).toEqual(
      outsideBoundary(organizationId, [ANSWER_MODEL_ID]),
    );
    expect(key.signingInputs).toHaveLength(0);
  });

  it("fails the invocation when the boundary read fails", async () => {
    const memory = inMemoryDatabase([]);
    const { dependencies, key } = testIssuerDependencies(failingStandingReads(memory.database), {
      funding,
    });

    expect(
      issueModelToken(serviceIssuer(), dependencies, {
        context: { organizationId: tenant.organizationId },
        kind: "service",
        models: [EMBEDDING_MODEL_ID],
      }),
    ).rejects.toThrow("DynamoDB is unavailable.");
    expect(key.signingInputs).toHaveLength(0);
  });
});

describe("model token funding configuration", () => {
  const TENANT_LIMIT_DEFAULTS = JSON.stringify({
    active_sandboxes: 4,
    api_request_burst: 20,
    api_requests_per_second: 10,
    concurrent_runs: 8,
  });

  it("reads enabled providers, embedding models, and the default ceiling", () => {
    expect(
      modelTokenFundingConfigFromEnv({
        DEPLOYMENTS_AI_MODEL_CREDENTIAL_PROVIDERS: "openai, openrouter",
        DEPLOYMENTS_AI_MODEL_TOKEN_EMBEDDING_MODELS: ` ${EMBEDDING_MODEL_ID.toUpperCase()}, text-embedding-3-large`,
        DEPLOYMENTS_AI_OPERATOR_FUNDED_MODEL_SPEND_CEILING_USD_MICROS: "5000000",
        DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS: TENANT_LIMIT_DEFAULTS,
      }),
    ).toEqual({
      credentialProviders: new Set(["openai", "openrouter"]),
      embeddingModelIds: new Set([EMBEDDING_MODEL_ID, "openai/text-embedding-3-large"]),
      installDefaults: {
        operatorFundedModelSpendCeiling: { monthlyUsdMicros: 5_000_000 },
        tenantLimits: TEST_FUNDING.installDefaults.tenantLimits,
      },
    });
  });

  it("leaves funding off and spend unlimited when nothing is configured", () => {
    expect(
      modelTokenFundingConfigFromEnv({
        DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS: TENANT_LIMIT_DEFAULTS,
      }),
    ).toEqual(TEST_FUNDING);
  });

  it("rejects a provider organizations cannot fund and a fractional ceiling", () => {
    for (const env of [
      { DEPLOYMENTS_AI_MODEL_CREDENTIAL_PROVIDERS: "bedrock" },
      { DEPLOYMENTS_AI_OPERATOR_FUNDED_MODEL_SPEND_CEILING_USD_MICROS: "0.5" },
    ]) {
      expect(() =>
        modelTokenFundingConfigFromEnv({
          ...env,
          DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS: TENANT_LIMIT_DEFAULTS,
        }),
      ).toThrow();
    }
  });
});

describe("model token issuer configuration", () => {
  it("reads run and service issuers from the environment", () => {
    expect(
      modelTokenIssuerConfigFromEnv({ DEPLOYMENTS_AI_MODEL_TOKEN_ISSUER_KIND: "run" }),
    ).toEqual({ kind: "run" });
    expect(
      modelTokenIssuerConfigFromEnv({
        DEPLOYMENTS_AI_MODEL_TOKEN_ISSUER_KIND: "service",
        DEPLOYMENTS_AI_MODEL_TOKEN_SERVICE: "memory",
        DEPLOYMENTS_AI_MODEL_TOKEN_SERVICE_MODELS: ` ${EMBEDDING_MODEL_ID}, ,${ANSWER_MODEL_ID}`,
        DEPLOYMENTS_AI_MODEL_TOKEN_TENANT_MODELS: "true",
      }),
    ).toEqual({
      kind: "service",
      service: "memory",
      serviceModels: [EMBEDDING_MODEL_ID, ANSWER_MODEL_ID],
      tenantModels: true,
    });
  });

  it("rejects incomplete or invalid issuer environments", () => {
    for (const env of [
      {},
      { DEPLOYMENTS_AI_MODEL_TOKEN_ISSUER_KIND: "other" },
      { DEPLOYMENTS_AI_MODEL_TOKEN_ISSUER_KIND: "service" },
      {
        DEPLOYMENTS_AI_MODEL_TOKEN_ISSUER_KIND: "service",
        DEPLOYMENTS_AI_MODEL_TOKEN_SERVICE: "brain",
        DEPLOYMENTS_AI_MODEL_TOKEN_TENANT_MODELS: "yes",
      },
    ]) {
      expect(() => modelTokenIssuerConfigFromEnv(env)).toThrow();
    }
  });
});

describe("operator grant cache", () => {
  it("reuses grants for sixty seconds and retries failed reads", async () => {
    let clock = 0;
    let reads = 0;
    let fail = true;
    const load = cachedModelOperatorGrants(
      async () => {
        reads += 1;
        if (fail) throw new Error("SSM is unavailable.");
        return JSON.stringify([{ allowedModels: [GRANTED_MODEL_ID], organizationId: id(1) }]);
      },
      () => clock,
    );

    expect(load()).rejects.toThrow("SSM is unavailable.");
    fail = false;
    const [first, concurrent] = await Promise.all([load(), load()]);
    expect(first).toEqual([{ allowedModels: [GRANTED_MODEL_ID], organizationId: id(1) }]);
    expect(concurrent).toBe(first);
    clock = 59_999;
    expect(await load()).toBe(first);
    expect(reads).toBe(2);
    clock = 60_000;
    await load();
    expect(reads).toBe(3);
  });
});
