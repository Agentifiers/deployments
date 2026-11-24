import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import type { ModelGatewayRunLease, ModelGatewayRunLeaseReader } from "@deployments-ai/db";
import {
  generateBifrostInternalVirtualKey,
  MODEL_GATEWAY_TOKEN_AUDIENCE,
  MODEL_GATEWAY_TOKEN_ISSUER,
  type ModelGatewayRunTokenClaims,
  type ModelGatewayServiceTokenClaims,
  type OperatorModelSpend,
  type OrganizationModelKeyResolver,
} from "@deployments-ai/model-gateway";
import { createModelGatewayHandler } from "./gateway.ts";
import { makeOperatorSpendCheck } from "./operator-spend.ts";
import { makeRunActivityCheck } from "./run-activity.ts";
import { makeTrustedPublicKeys, type FetchPublicKey } from "./signing-keys.ts";

export const TRUSTED_KEY_ARN =
  "arn:aws:kms:us-east-2:111122223333:key/11111111-2222-3333-4444-555555555555";
export const PROVIDER_API_KEY = `sk-proj-${randomBytes(24).toString("base64url")}`;
export const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G0001";
export const THREAD_ID = "01ARZ3NDEKTSV4RRFFQ69G0002";
export const LEASE_OWNER = "worker-a/claim-1";
export const ALLOWED_MODEL = "openai/gpt-4o-mini";
export const FALLBACK_MODEL = "openrouter/anthropic/claude-sonnet-4";
export const EMBEDDING_MODEL = "openai/text-embedding-3-small";

export function p256KeyPair() {
  return generateKeyPairSync("ec", { namedCurve: "P-256" });
}

/** Signs claims as an ES256 compact JWS the way the KMS-backed issuers do. */
export function signToken(
  claims: Record<string, unknown>,
  privateKey: KeyObject,
  keyId: string = TRUSTED_KEY_ARN,
) {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${segment({ alg: "ES256", kid: keyId, typ: "JWT" })}.${segment(claims)}`;
  const signature = sign("sha256", Buffer.from(input), {
    dsaEncoding: "ieee-p1363",
    key: privateKey,
  });
  return `${input}.${signature.toString("base64url")}`;
}

export function runClaims(nowMs: number, overrides: Partial<ModelGatewayRunTokenClaims> = {}) {
  const iat = Math.floor(nowMs / 1000);
  return {
    aud: MODEL_GATEWAY_TOKEN_AUDIENCE,
    environmentId: "01ARZ3NDEKTSV4RRFFQ69G0003",
    exp: iat + 600,
    iat,
    iss: MODEL_GATEWAY_TOKEN_ISSUER,
    jti: randomUUID(),
    kind: "run",
    leaseOwner: LEASE_OWNER,
    models: [ALLOWED_MODEL, FALLBACK_MODEL],
    organizationId: "01ARZ3NDEKTSV4RRFFQ69G0004",
    projectId: "01ARZ3NDEKTSV4RRFFQ69G0005",
    runId: RUN_ID,
    sub: `run:${RUN_ID}`,
    threadId: THREAD_ID,
    ...overrides,
  } satisfies ModelGatewayRunTokenClaims;
}

export function serviceClaims(
  nowMs: number,
  overrides: Partial<ModelGatewayServiceTokenClaims> = {},
) {
  const iat = Math.floor(nowMs / 1000);
  return {
    aud: MODEL_GATEWAY_TOKEN_AUDIENCE,
    exp: iat + 900,
    iat,
    iss: MODEL_GATEWAY_TOKEN_ISSUER,
    jti: randomUUID(),
    kind: "service",
    models: [ALLOWED_MODEL, EMBEDDING_MODEL],
    organizationId: "01ARZ3NDEKTSV4RRFFQ69G0004",
    service: "memory",
    sub: "service:memory",
    ...overrides,
  } satisfies ModelGatewayServiceTokenClaims;
}

export function runLease(overrides: { expiresAt: string; owner?: string; runId?: string }) {
  return {
    data: {
      expiresAt: overrides.expiresAt,
      id: THREAD_ID,
      leaseKey: `agent-run-thread/${THREAD_ID}`,
      owner: overrides.owner ?? LEASE_OWNER,
      runId: overrides.runId ?? RUN_ID,
      threadId: THREAD_ID,
    },
    itemType: "runtime-lease",
  } as unknown as ModelGatewayRunLease;
}

interface FakeBifrostRequest {
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
  readonly path: string;
}

/** A stand-in for Bifrost on an ephemeral loopback port; each test sets `respond`. */
export function startFakeBifrost() {
  const requests: FakeBifrostRequest[] = [];
  const state: { respond: (request: FakeBifrostRequest) => Response | Promise<Response> } = {
    respond: () => Response.json({ ok: true }),
  };
  const server = Bun.serve({
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/health") return new Response("ok");
      const recorded = {
        body: (await request.json()) as Record<string, unknown>,
        headers: Object.fromEntries(request.headers.entries()),
        path,
      };
      requests.push(recorded);
      return state.respond(recorded);
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  return { requests, server, state, url: `http://127.0.0.1:${server.port}` };
}

/**
 * The gateway on an ephemeral port with an injectable clock, KMS fake, lease fake, and log
 * capture. Operator-funded spend is unlimited unless `readOperatorSpend` says otherwise.
 */
export function startGateway(input: {
  bifrostUrl: string;
  internalVirtualKey?: string;
  organizationKeys?: OrganizationModelKeyResolver;
  publicKey: KeyObject;
  readOperatorSpend?: (organizationId: string, asOf: Date) => Promise<OperatorModelSpend>;
}) {
  const internalVirtualKey = input.internalVirtualKey ?? generateBifrostInternalVirtualKey();
  const logs: Record<string, unknown>[] = [];
  const clock = { now: Date.now() };
  const kmsCalls: string[] = [];
  const kms: { fail: boolean } = { fail: false };
  const fetchPublicKey: FetchPublicKey = async (keyArn) => {
    kmsCalls.push(keyArn);
    if (kms.fail) throw new Error("KMS unavailable");
    return {
      keySpec: "ECC_NIST_P256",
      keyUsage: "SIGN_VERIFY",
      publicKey: input.publicKey.export({ format: "der", type: "spki" }),
    };
  };
  const leases: { reads: number; value: ModelGatewayRunLease | Error | undefined } = {
    reads: 0,
    value: undefined,
  };
  const reader: ModelGatewayRunLeaseReader = {
    getThreadExecutionLease: async () => {
      leases.reads += 1;
      if (leases.value instanceof Error) throw leases.value;
      return leases.value;
    },
  };
  const now = () => clock.now;
  const server = Bun.serve({
    fetch: createModelGatewayHandler({
      bifrostUrl: input.bifrostUrl,
      internalVirtualKey,
      log: (entry) => logs.push(JSON.parse(JSON.stringify(entry))),
      now,
      operatorSpend: makeOperatorSpendCheck({
        now,
        read: input.readOperatorSpend ?? (async () => ({ kind: "unlimited" })),
      }),
      organizationKeys: input.organizationKeys,
      publicKey: makeTrustedPublicKeys([TRUSTED_KEY_ARN], fetchPublicKey),
      requestId: randomUUID,
      runActivity: makeRunActivityCheck({ now, reader }),
    }),
    hostname: "127.0.0.1",
    maxRequestBodySize: 128 * 1024 * 1024,
    port: 0,
  });
  return {
    clock,
    internalVirtualKey,
    kms,
    kmsCalls,
    leases,
    logs,
    server,
    url: `http://127.0.0.1:${server.port}`,
  };
}
