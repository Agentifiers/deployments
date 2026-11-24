import { describe, expect, it } from "bun:test";
import {
  makeModelPolicyPersistence,
  type ByokProvider,
  type DynamoDatabaseService,
  type PlatformRecord,
} from "@deployments-ai/db";
import {
  MODEL_GATEWAY_RUN_TOKEN_TTL_SECONDS,
  type ModelGatewayRunTokenClaims,
} from "@deployments-ai/model-gateway";
import { id, releaseWithManifest } from "./agent-run.fixture.ts";
import { issueModelToken } from "./model-token-issuer.ts";
import {
  claimedRun,
  grantModelSpendCeiling,
  operatorSpendShard,
  revokeOrganizationModelKey,
  runRequest,
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
  type RunFixture,
} from "./model-token.fixture.ts";
import type { AgentReleaseRecordValue } from "./types.ts";

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

const PRIMARY_MODEL_ID = "openrouter/qwen/qwen3.7-plus";
const CURATED_FALLBACK_ID = "openrouter/z-ai/glm-5.2";
/** Neither curated nor in the catalog: only an operator grant admits it. */
const GRANTED_MODEL_ID = "openrouter/vendor/operator-granted";
const OPENAI_MODEL_ID = "openai/gpt-5.2";
const SECOND_FALLBACK_ID = "openrouter/xiaomi/mimo-v2.5";
/** Curated, so the curated defaults admit it in any environment without a policy. */
const BEDROCK_MODEL_ID = "bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0";
/** Neither curated nor in the catalog: only an operator grant admits it. */
const BEDROCK_GRANTED_MODEL_ID = "bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0";
const RUN_ISSUER = { kind: "run" } as const;

function withModels(
  release: AgentReleaseRecordValue,
  model: { readonly fallbackIds?: string[]; readonly id: string },
) {
  const manifest = release.data.manifest;
  return releaseWithManifest(release, { ...manifest, spec: { ...manifest.spec, model } });
}

describe("run model token issuer", () => {
  it("mints a verifiable token with the run's tenancy, pins, and admitted models", async () => {
    const { fixture, memory } = setupClaimedRun((fixture) => [
      withModels(fixture.release, { fallbackIds: [CURATED_FALLBACK_ID], id: PRIMARY_MODEL_ID }),
      claimedRun(fixture),
      threadLease(fixture),
    ]);
    const { dependencies, key } = testIssuerDependencies(memory.database);

    const response = await issueModelToken(RUN_ISSUER, dependencies, runRequest(fixture));

    if (!response.ok) throw new Error(`Issuance was refused: ${response.message}`);
    const iat = Math.floor(TEST_NOW.getTime() / 1000);
    expect(response.models).toEqual([PRIMARY_MODEL_ID, CURATED_FALLBACK_ID]);
    expect(response.expiresAt).toBe(iat + MODEL_GATEWAY_RUN_TOKEN_TTL_SECONDS);
    expect(response.expiresAt - iat).toBe(600);
    const header = JSON.parse(
      Buffer.from(response.token.split(".")[0]!, "base64url").toString("utf8"),
    );
    expect(header).toEqual({ alg: "ES256", kid: TEST_SIGNING_KEY_ARN, typ: "JWT" });
    const claims = (await verifiedClaims(
      response.token,
      key.publicKey,
    )) as ModelGatewayRunTokenClaims;
    expect(claims).toEqual({
      agentDefinitionId: fixture.release.data.agentDefinitionId,
      agentDeploymentId: fixture.deployment.data.id,
      agentReleaseId: fixture.release.data.id,
      aud: "model-gateway",
      environmentId: fixture.run.data.environmentId,
      exp: iat + 600,
      iat,
      iss: "deployments-ai-model-token-issuer",
      jti: "token-id-1",
      kind: "run",
      leaseOwner: TEST_LEASE_OWNER,
      models: [PRIMARY_MODEL_ID, CURATED_FALLBACK_ID],
      organizationId: fixture.run.data.organizationId,
      projectId: fixture.run.data.projectId,
      runId: fixture.run.data.id,
      sub: `run:${fixture.run.data.id}`,
      threadId: fixture.run.data.threadId,
      workspaceId: fixture.run.data.workspaceId!,
    });
  });

  describe("lease-bound minting", () => {
    const refusals: readonly {
      readonly code: "lease_inactive" | "run_not_found";
      readonly name: string;
      readonly records: (fixture: RunFixture) => readonly PlatformRecord[];
    }[] = [
      {
        code: "lease_inactive",
        name: "no thread execution lease",
        records: (fixture) => [fixture.release, claimedRun(fixture)],
      },
      {
        code: "lease_inactive",
        name: "a lease held for another run",
        records: (fixture) => [
          fixture.release,
          claimedRun(fixture),
          threadLease(fixture, { runId: id(99) }),
        ],
      },
      {
        code: "lease_inactive",
        name: "a lease owned by another worker",
        records: (fixture) => [
          fixture.release,
          claimedRun(fixture),
          threadLease(fixture, { owner: "worker-2" }),
        ],
      },
      {
        code: "lease_inactive",
        name: "an expired lease",
        records: (fixture) => [
          fixture.release,
          claimedRun(fixture),
          threadLease(fixture, { expiresAt: "2026-07-22T00:00:10.000Z" }),
        ],
      },
      {
        code: "lease_inactive",
        name: "a run that is not running",
        records: (fixture) => [
          fixture.release,
          claimedRun(fixture, { status: "waiting-for-tool" }),
          threadLease(fixture),
        ],
      },
      {
        code: "lease_inactive",
        name: "a run claimed by another owner",
        records: (fixture) => [
          fixture.release,
          claimedRun(fixture, { claimedBy: "worker-2" }),
          threadLease(fixture),
        ],
      },
      {
        code: "run_not_found",
        name: "a lease whose run does not exist",
        records: (fixture) => [fixture.release, threadLease(fixture)],
      },
    ];

    for (const refusal of refusals) {
      it(`refuses ${refusal.name} with ${refusal.code} without signing`, async () => {
        const { fixture, memory } = setupClaimedRun(refusal.records);
        const { dependencies, key } = testIssuerDependencies(memory.database);

        const response = await issueModelToken(RUN_ISSUER, dependencies, runRequest(fixture));

        expect(response).toMatchObject({ code: refusal.code, ok: false });
        expect(key.signingInputs).toHaveLength(0);
      });
    }
  });

  it("refuses a pinned model the environment policy no longer allows", async () => {
    const { fixture, memory } = setupClaimedRun((fixture) => [
      fixture.release,
      claimedRun(fixture),
      threadLease(fixture),
    ]);
    await makeModelPolicyPersistence(memory.database).create(
      {
        environmentId: fixture.run.data.environmentId,
        organizationId: fixture.run.data.organizationId,
        projectId: fixture.run.data.projectId,
      },
      { includeCuratedModels: false, models: [], name: "Nothing" },
      { principalId: id(11) },
    );
    const { dependencies, key } = testIssuerDependencies(memory.database);

    const response = await issueModelToken(RUN_ISSUER, dependencies, runRequest(fixture));

    expect(response).toMatchObject({ code: "model_not_admitted", ok: false });
    expect(response.ok ? "" : response.message).toContain(PRIMARY_MODEL_ID);
    expect(key.signingInputs).toHaveLength(0);
  });

  it("admits a non-policy model through an operator grant for the agent", async () => {
    const records = (fixture: RunFixture) => [
      withModels(fixture.release, { id: GRANTED_MODEL_ID }),
      claimedRun(fixture),
      threadLease(fixture),
    ];
    const denied = setupClaimedRun(records);
    const refused = await issueModelToken(
      RUN_ISSUER,
      testIssuerDependencies(denied.memory.database).dependencies,
      runRequest(denied.fixture),
    );
    expect(refused).toMatchObject({ code: "model_not_admitted", ok: false });

    const { fixture, memory } = setupClaimedRun(records);
    const { dependencies, key } = testIssuerDependencies(memory.database, {
      grants: [
        {
          agentId: fixture.release.data.agentDefinitionId,
          allowedModels: [GRANTED_MODEL_ID],
          providers: ["openrouter"],
        },
      ],
    });
    const response = await issueModelToken(RUN_ISSUER, dependencies, runRequest(fixture));

    if (!response.ok) throw new Error(`Issuance was refused: ${response.message}`);
    expect(response.models).toEqual([GRANTED_MODEL_ID]);
    expect((await verifiedClaims(response.token, key.publicKey)).models).toEqual([
      GRANTED_MODEL_ID,
    ]);
  });

  it("refuses malformed and foreign payloads with invalid_request", async () => {
    const { fixture, memory } = setupClaimedRun((fixture) => [
      fixture.release,
      claimedRun(fixture),
      threadLease(fixture),
    ]);
    const { dependencies, key } = testIssuerDependencies(memory.database);
    const request = runRequest(fixture);
    const payloads: unknown[] = [
      undefined,
      "run",
      [request],
      { ...request, kind: "unknown" },
      { kind: "service" },
      { ...request, extra: true },
      { ...request, runId: "not-a-ulid" },
      { ...request, leaseOwner: "" },
      { ...request, leaseOwner: undefined },
    ];

    for (const payload of payloads) {
      // eslint-disable-next-line no-await-in-loop -- refusals are independent and sequential.
      const response = await issueModelToken(RUN_ISSUER, dependencies, payload);
      expect(response).toMatchObject({ code: "invalid_request", ok: false });
    }
    expect(key.signingInputs).toHaveLength(0);
  });

  it("throws when signing fails", async () => {
    const { fixture, memory } = setupClaimedRun((fixture) => [
      fixture.release,
      claimedRun(fixture),
      threadLease(fixture),
    ]);
    const { dependencies } = testIssuerDependencies(memory.database, {
      signer: {
        keyId: TEST_SIGNING_KEY_ARN,
        sign: async () => {
          throw new Error("KMS is unavailable.");
        },
      },
    });

    expect(issueModelToken(RUN_ISSUER, dependencies, runRequest(fixture))).rejects.toThrow(
      "KMS is unavailable.",
    );
  });

  describe("inside a PHI data boundary", () => {
    async function mintForPhiOrganization(model: {
      readonly fallbackIds?: string[];
      readonly id: string;
    }) {
      const { fixture, memory } = setupClaimedRun((fixture) => [
        withModels(fixture.release, model),
        claimedRun(fixture),
        threadLease(fixture),
      ]);
      await setPhiDataBoundary(memory.database, fixture.run.data.organizationId);
      const { dependencies, key } = testIssuerDependencies(memory.database, {
        grants: [
          {
            agentId: fixture.release.data.agentDefinitionId,
            allowedModels: [BEDROCK_GRANTED_MODEL_ID],
            providers: ["bedrock"],
          },
        ],
      });
      const response = await issueModelToken(RUN_ISSUER, dependencies, runRequest(fixture));
      return { fixture, key, response };
    }

    it("refuses a run whose primary model is not on Bedrock", async () => {
      const { fixture, key, response } = await mintForPhiOrganization({ id: PRIMARY_MODEL_ID });

      expect(response).toEqual({
        code: "model_outside_data_boundary",
        message: `Organization ${fixture.run.data.organizationId}'s phi data boundary allows only bedrock models; ${PRIMARY_MODEL_ID} is outside it.`,
        ok: false,
      });
      expect(key.signingInputs).toHaveLength(0);
    });

    it("refuses a Bedrock run with a fallback outside Bedrock", async () => {
      const { key, response } = await mintForPhiOrganization({
        fallbackIds: [BEDROCK_GRANTED_MODEL_ID, OPENAI_MODEL_ID],
        id: BEDROCK_MODEL_ID,
      });

      expect(response).toMatchObject({ code: "model_outside_data_boundary", ok: false });
      expect(response.ok ? "" : response.message).toEndWith(`; ${OPENAI_MODEL_ID} is outside it.`);
      expect(key.signingInputs).toHaveLength(0);
    });

    it("mints a run whose primary and fallbacks are all on Bedrock", async () => {
      const { key, response } = await mintForPhiOrganization({
        fallbackIds: [BEDROCK_GRANTED_MODEL_ID],
        id: BEDROCK_MODEL_ID,
      });

      if (!response.ok) throw new Error(`Issuance was refused: ${response.message}`);
      expect((await verifiedClaims(response.token, key.publicKey)).models).toEqual([
        BEDROCK_MODEL_ID,
        BEDROCK_GRANTED_MODEL_ID,
      ]);
    });

    it("fails the invocation when the boundary read fails after the standing check", async () => {
      const { fixture, memory } = setupClaimedRun((fixture) => [
        withModels(fixture.release, { id: BEDROCK_MODEL_ID }),
        claimedRun(fixture),
        threadLease(fixture),
      ]);
      await setPhiDataBoundary(memory.database, fixture.run.data.organizationId);
      const { dependencies, key } = testIssuerDependencies(
        failingStandingReads(memory.database, 1),
      );

      expect(issueModelToken(RUN_ISSUER, dependencies, runRequest(fixture))).rejects.toThrow(
        "DynamoDB is unavailable.",
      );
      expect(key.signingInputs).toHaveLength(0);
    });
  });

  describe("funding", () => {
    const OPENROUTER_FUNDING = {
      ...TEST_FUNDING,
      credentialProviders: new Set(["openrouter"] as const),
    };
    const BOTH_PROVIDERS_FUNDING = {
      ...TEST_FUNDING,
      credentialProviders: new Set(["openai", "openrouter"] as const),
    };
    const runWith =
      (model: { readonly fallbackIds: string[]; readonly id: string }, spentUsdMicros?: number) =>
      (fixture: RunFixture) => [
        withModels(fixture.release, model),
        claimedRun(fixture),
        threadLease(fixture),
        ...(spentUsdMicros === undefined
          ? []
          : [operatorSpendShard(fixture.run.data, spentUsdMicros)]),
      ];
    const runRecords = runWith({ fallbackIds: [CURATED_FALLBACK_ID], id: PRIMARY_MODEL_ID });

    async function mint(
      records: (fixture: RunFixture) => readonly PlatformRecord[],
      options: {
        readonly ceilingUsdMicros?: number;
        readonly funding?: typeof TEST_FUNDING;
        readonly organizationKey?: ByokProvider;
        readonly revokedKey?: boolean;
      } = {},
    ) {
      const { fixture, memory } = setupClaimedRun(records);
      const { organizationId } = fixture.run.data;
      if (options.organizationKey) {
        await storeOrganizationModelKey(memory.database, organizationId, options.organizationKey);
        if (options.revokedKey) {
          await revokeOrganizationModelKey(
            memory.database,
            organizationId,
            options.organizationKey,
          );
        }
      }
      if (options.ceilingUsdMicros !== undefined) {
        await grantModelSpendCeiling(memory.database, organizationId, options.ceilingUsdMicros);
      }
      const { dependencies, key } = testIssuerDependencies(memory.database, {
        funding: options.funding ?? OPENROUTER_FUNDING,
      });
      const response = await issueModelToken(RUN_ISSUER, dependencies, runRequest(fixture));
      return {
        claims: response.ok ? await verifiedClaims(response.token, key.publicKey) : undefined,
        fixture,
        response,
        signed: key.signingInputs.length,
      };
    }

    it("signs the organization's key for the run's provider into the claim, past the ceiling", async () => {
      const { claims, fixture } = await mint(
        (fixture) => [...runRecords(fixture), operatorSpendShard(fixture.run.data, 9_000_000)],
        { ceilingUsdMicros: 1_000_000, organizationKey: "openrouter" },
      );

      expect(claims).toMatchObject({
        funding: { openrouter: { credentialId: TEST_CREDENTIAL_ID, keyVersion: 1 } },
        models: [PRIMARY_MODEL_ID, CURATED_FALLBACK_ID],
        organizationId: fixture.run.data.organizationId,
      });
    });

    it("mints claims identical to an unfunded install when no provider is enabled", async () => {
      const plain = await mint(runRecords, { funding: TEST_FUNDING });
      const withStoredKey = await mint(runRecords, {
        funding: TEST_FUNDING,
        organizationKey: "openrouter",
      });

      expect(plain.claims).toBeDefined();
      expect(withStoredKey.claims).toEqual(plain.claims!);
      expect(Object.keys(plain.claims!)).not.toContain("funding");
    });

    it("operator-funds a run below the ceiling without a claim", async () => {
      const { claims } = await mint(
        (fixture) => [...runRecords(fixture), operatorSpendShard(fixture.run.data, 999_999)],
        { ceilingUsdMicros: 1_000_000 },
      );

      expect(claims?.models).toEqual([PRIMARY_MODEL_ID, CURATED_FALLBACK_ID]);
      expect(Object.keys(claims!)).not.toContain("funding");
    });

    it("refuses an operator-funded run once the ceiling is reached, naming the ceiling", async () => {
      const { fixture, response, signed } = await mint(
        (fixture) => [...runRecords(fixture), operatorSpendShard(fixture.run.data, 1_000_000)],
        { ceilingUsdMicros: 1_000_000 },
      );

      expect(response).toEqual({
        code: "operator_funding_exhausted",
        message: `Organization ${fixture.run.data.organizationId} has used 1.00 USD of its 1.00 USD monthly operator-funded model spend ceiling, so ${PRIMARY_MODEL_ID} cannot be served on the operator's keys. Add the organization's own key for the provider or raise the ceiling.`,
        ok: false,
      });
      expect(signed).toBe(0);
    });

    it("keeps an OpenAI-key-only organization's run on its key past the ceiling, without its OpenRouter fallbacks", async () => {
      const { claims } = await mint(
        runWith(
          { fallbackIds: [CURATED_FALLBACK_ID, SECOND_FALLBACK_ID], id: OPENAI_MODEL_ID },
          1_000_000,
        ),
        { ceilingUsdMicros: 1_000_000, funding: BOTH_PROVIDERS_FUNDING, organizationKey: "openai" },
      );

      expect({ funding: claims?.funding, models: claims?.models }).toEqual({
        funding: { openai: { credentialId: TEST_CREDENTIAL_ID, keyVersion: 1 } },
        models: [OPENAI_MODEL_ID],
      });
    });

    it("refuses an OpenAI-key-only organization's run whose primary the operator would pay for at the ceiling", async () => {
      const { fixture, response, signed } = await mint(
        runWith({ fallbackIds: [OPENAI_MODEL_ID], id: PRIMARY_MODEL_ID }, 1_000_000),
        { ceilingUsdMicros: 1_000_000, funding: BOTH_PROVIDERS_FUNDING, organizationKey: "openai" },
      );

      expect(response).toEqual({
        code: "operator_funding_exhausted",
        message: `Organization ${fixture.run.data.organizationId} has used 1.00 USD of its 1.00 USD monthly operator-funded model spend ceiling, so ${PRIMARY_MODEL_ID} cannot be served on the operator's keys. Add the organization's own key for the provider or raise the ceiling.`,
        ok: false,
      });
      expect(signed).toBe(0);
    });

    it("operator-funds a stored key's provider the install does not let organizations fund", async () => {
      const { claims } = await mint(runWith({ fallbackIds: [], id: OPENAI_MODEL_ID }), {
        funding: OPENROUTER_FUNDING,
        organizationKey: "openai",
      });

      expect({ funding: claims?.funding, models: claims?.models }).toEqual({
        funding: undefined,
        models: [OPENAI_MODEL_ID],
      });
    });

    it("operator-funds a revoked key's provider, so the ceiling refuses it", async () => {
      const { fixture, response } = await mint(
        runWith({ fallbackIds: [], id: PRIMARY_MODEL_ID }, 1_000_000),
        {
          ceilingUsdMicros: 1_000_000,
          organizationKey: "openrouter",
          revokedKey: true,
        },
      );

      expect(response).toEqual({
        code: "operator_funding_exhausted",
        message: `Organization ${fixture.run.data.organizationId} has used 1.00 USD of its 1.00 USD monthly operator-funded model spend ceiling, so ${PRIMARY_MODEL_ID} cannot be served on the operator's keys. Add the organization's own key for the provider or raise the ceiling.`,
        ok: false,
      });
    });

    it("applies the install default ceiling to an organization without a grant", async () => {
      const { response } = await mint(runRecords, {
        funding: {
          ...OPENROUTER_FUNDING,
          installDefaults: {
            ...TEST_FUNDING.installDefaults,
            operatorFundedModelSpendCeiling: { monthlyUsdMicros: 0 },
          },
        },
      });

      expect(response).toMatchObject({ code: "operator_funding_exhausted", ok: false });
    });

    it("admits an organization-funded model only through the environment policy, never a grant", async () => {
      const grantOnly = (fixture: RunFixture) => [
        withModels(fixture.release, { id: GRANTED_MODEL_ID }),
        claimedRun(fixture),
        threadLease(fixture),
      ];
      const { fixture, memory } = setupClaimedRun(grantOnly);
      await storeOrganizationModelKey(
        memory.database,
        fixture.run.data.organizationId,
        "openrouter",
      );
      const { dependencies } = testIssuerDependencies(memory.database, {
        funding: OPENROUTER_FUNDING,
        grants: [
          {
            agentId: fixture.release.data.agentDefinitionId,
            allowedModels: [GRANTED_MODEL_ID],
            providers: ["openrouter"],
          },
        ],
      });

      const response = await issueModelToken(RUN_ISSUER, dependencies, runRequest(fixture));

      expect(response).toMatchObject({ code: "model_not_admitted", ok: false });
      expect(response.ok ? "" : response.message).toContain(GRANTED_MODEL_ID);
    });
  });
});
