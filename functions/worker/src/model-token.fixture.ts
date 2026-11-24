import { GenerateDataKeyCommand, type KMSClient } from "@aws-sdk/client-kms";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
  addScopeSpend,
  makeKmsEnvelopeAdapter,
  makeModelProviderCredentialPersistence,
  makeOrganizationStandingRepository,
  RunRecord,
  RuntimeLeaseRecord,
  scopeSpendShardCandidates,
  StandingActor,
  Ulid,
  usageScopeOf,
  withCanonicalRecordKeys,
  type ByokProvider,
  type DynamoDatabaseService,
  type PlatformRecord,
} from "@deployments-ai/db";
import {
  verifyModelGatewayToken,
  type ModelGatewayTokenClaims,
  type ModelOperatorGrant,
  type ModelRunTokenRequest,
} from "@deployments-ai/model-gateway";
import { Schema } from "effect";
import { fixtures, inMemoryDatabase } from "./agent-run.fixture.ts";
import type { ModelTokenIssuerDependencies } from "./model-token-issuer-admission.ts";
import type { ModelTokenFundingConfig } from "./model-token-issuer-funding.ts";
import type { ModelTokenSigner } from "./model-token-signer.ts";
import type {
  AgentDeploymentRecordValue,
  AgentReleaseRecordValue,
  RunRecordValue,
  ThreadRecordValue,
} from "./types.ts";

export const TEST_CREDENTIAL_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G0C01");
const TEST_OPERATOR_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G0C02");
const TEST_REVOCATION_EVENT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G0C03");
const TEST_OPERATOR = Schema.decodeUnknownSync(StandingActor)({
  kind: "operator",
  principalId: TEST_OPERATOR_ID,
});

export const TEST_SIGNING_KEY_ARN =
  "arn:aws:kms:us-east-2:123456789012:key/00000000-0000-4000-8000-000000000001";

function testModelTokenSigner() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const signingInputs: Uint8Array[] = [];
  const signer: ModelTokenSigner = {
    keyId: TEST_SIGNING_KEY_ARN,
    sign: async ({ signingInput }) => {
      signingInputs.push(signingInput);
      return sign("sha256", signingInput, { dsaEncoding: "der", key: privateKey });
    },
  };
  return { publicKey, signer, signingInputs };
}

export const TEST_NOW = new Date("2026-07-22T00:00:10.000Z");
export const TEST_LEASE_OWNER = "worker-1";

/** The parts of the shared agent-run fixture a run token needs. */
export interface RunFixture {
  readonly deployment: AgentDeploymentRecordValue;
  readonly release: AgentReleaseRecordValue;
  readonly run: RunRecordValue;
  readonly thread: ThreadRecordValue;
}

/** An install without organization keys, embedding models, or a spend ceiling. */
export const TEST_FUNDING: ModelTokenFundingConfig = {
  credentialProviders: new Set(),
  embeddingModelIds: new Set(),
  installDefaults: {
    operatorFundedModelSpendCeiling: "unlimited",
    tenantLimits: {
      activeSandboxes: 4,
      apiRequestBurst: 20,
      apiRequestsPerSecond: 10,
      concurrentRuns: 8,
    },
  },
};

export interface TestIssuerOptions {
  readonly funding?: ModelTokenFundingConfig;
  readonly grants?: readonly ModelOperatorGrant[];
  readonly signer?: ModelTokenSigner;
}

export function testIssuerDependencies(
  database: DynamoDatabaseService,
  options: TestIssuerOptions = {},
) {
  const key = testModelTokenSigner();
  let grantLoads = 0;
  const dependencies: ModelTokenIssuerDependencies = {
    database,
    funding: options.funding ?? TEST_FUNDING,
    generateTokenId: () => "token-id-1",
    loadOperatorGrants: async () => {
      grantLoads += 1;
      return options.grants ?? [];
    },
    now: () => TEST_NOW,
    signer: options.signer ?? key.signer,
  };
  return { dependencies, grantLoads: () => grantLoads, key };
}

/** Verifies a minted token against the test key as the gateway would. */
export async function verifiedClaims(
  token: string,
  publicKey: KeyObject,
): Promise<ModelGatewayTokenClaims> {
  const verification = await verifyModelGatewayToken(token, {
    now: TEST_NOW.getTime(),
    publicKey: async (keyId) => (keyId === TEST_SIGNING_KEY_ARN ? publicKey : undefined),
  });
  if (!verification.ok) throw new Error(`Token did not verify: ${verification.reason}`);
  return verification.claims;
}

function organizationModelKeys(database: DynamoDatabaseService, generatedId: Ulid) {
  const kms = {
    send: async (command: unknown) => {
      if (!(command instanceof GenerateDataKeyCommand)) throw new Error("Unexpected KMS command.");
      return { CiphertextBlob: new Uint8Array([1]), Plaintext: new Uint8Array(32).fill(1) };
    },
  } as unknown as KMSClient;
  return makeModelProviderCredentialPersistence({
    database,
    envelope: makeKmsEnvelopeAdapter({ keyId: "model-credential-key", kms, stage: "test" }),
    generateId: () => generatedId,
  });
}

/** Stores an organization's provider key the way the credentials API does, under a stand-in KMS. */
export function storeOrganizationModelKey(
  database: DynamoDatabaseService,
  organizationId: Ulid,
  provider: ByokProvider,
) {
  return organizationModelKeys(database, TEST_CREDENTIAL_ID).set({
    actorPrincipalId: TEST_OPERATOR_ID,
    apiKey: `sk-test-${provider}-key-0001`,
    organizationId,
    provider,
  });
}

/** Revokes the organization's stored provider key the way the credentials API does. */
export function revokeOrganizationModelKey(
  database: DynamoDatabaseService,
  organizationId: Ulid,
  provider: ByokProvider,
) {
  return organizationModelKeys(database, TEST_REVOCATION_EVENT_ID).remove({
    actorPrincipalId: TEST_OPERATOR_ID,
    organizationId,
    provider,
  });
}

/** Gives the organization an operator grant with this monthly operator-funded spend ceiling. */
export function grantModelSpendCeiling(
  database: DynamoDatabaseService,
  organizationId: Ulid,
  monthlyUsdMicros: number,
) {
  return makeOrganizationStandingRepository({
    database,
    installDefaults: TEST_FUNDING.installDefaults,
  }).setGrant({
    actor: TEST_OPERATOR,
    entitlements: { operatorFundedModelSpendCeiling: { monthlyUsdMicros } },
    organizationId,
  });
}

/** Places the organization inside the PHI data boundary the way an operator does. */
export function setPhiDataBoundary(database: DynamoDatabaseService, organizationId: Ulid) {
  return makeOrganizationStandingRepository({
    database,
    installDefaults: TEST_FUNDING.installDefaults,
  }).setDataBoundary({
    actor: TEST_OPERATOR,
    operatorNote: "BAA on file.",
    organizationId,
    profile: "phi",
  });
}

/** The organization's monthly spend shard for TEST_NOW's month, holding this operator-funded spend. */
export function operatorSpendShard(scope: Parameters<typeof usageScopeOf>[0], usdMicros: number) {
  const candidate = scopeSpendShardCandidates({
    occurredAt: "2026-07-05T00:00:00.000Z",
    scope: usageScopeOf(scope),
    shard: 0,
    updatedAt: "2026-07-05T00:00:00.000Z",
  }).find((shard) => shard.data.scope === "organization" && shard.data.period === "monthly")!;
  return addScopeSpend(candidate, undefined, usdMicros, "operator");
}

/** The run record as a worker that claimed it as {@link TEST_LEASE_OWNER} stores it. */
export function claimedRun(
  fixture: RunFixture,
  overrides: { readonly claimedBy?: string; readonly status?: "running" | "waiting-for-tool" } = {},
) {
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...fixture.run.data,
        attempt: 1,
        claimedAt: "2026-07-22T00:00:00.000Z",
        claimedBy: overrides.claimedBy ?? TEST_LEASE_OWNER,
        heartbeatAt: "2026-07-22T00:00:05.000Z",
        startedAt: "2026-07-22T00:00:00.000Z",
        status: overrides.status ?? "running",
        version: 1,
      },
      itemType: "run" as const,
    }),
  );
}

export function threadLease(
  fixture: RunFixture,
  overrides: { readonly expiresAt?: string; readonly owner?: string; readonly runId?: string } = {},
) {
  return Schema.decodeUnknownSync(RuntimeLeaseRecord)(
    withCanonicalRecordKeys({
      data: {
        acquiredAt: "2026-07-22T00:00:00.000Z",
        expiresAt: overrides.expiresAt ?? "2026-07-22T00:05:00.000Z",
        id: fixture.thread.data.id,
        leaseKey: `agent-run-thread/${fixture.thread.data.id}`,
        owner: overrides.owner ?? TEST_LEASE_OWNER,
        renewedAt: "2026-07-22T00:00:05.000Z",
        runId: overrides.runId ?? fixture.run.data.id,
        threadId: fixture.thread.data.id,
        version: 0,
      },
      itemType: "runtime-lease" as const,
    }),
  );
}

export function runRequest(fixture: RunFixture): ModelRunTokenRequest {
  return {
    kind: "run",
    leaseOwner: TEST_LEASE_OWNER,
    organizationId: fixture.run.data.organizationId,
    runId: fixture.run.data.id,
    threadId: fixture.run.data.threadId,
  };
}

export function setupClaimedRun(records: (fixture: RunFixture) => readonly PlatformRecord[]) {
  const fixture = fixtures();
  const memory = inMemoryDatabase([fixture.deployment, fixture.thread, ...records(fixture)]);
  return { fixture, memory };
}
