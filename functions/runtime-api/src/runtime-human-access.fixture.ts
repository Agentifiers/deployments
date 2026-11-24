import {
  ApiCredentialRecord,
  ServiceAccountRecord,
  key,
  makeUniqueClaimRecord,
  uniqueClaimRequirements,
  withCanonicalRecordKeys,
  Keys,
  type ApiCredentialUsageRecorder,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { createRuntimeHumanAuthenticator } from "./runtime-authentication.ts";
import { createRuntimeApiHandler } from "./runtime-handler.ts";
import {
  environmentId,
  ids,
  now,
  organizationId,
  projectId,
  serviceAccountId,
} from "./runtime-lifecycle.fixture.ts";
import {
  credentialHash,
  type HttpApiEvent,
  type RuntimeApiDependencies,
} from "./runtime-support.ts";

export const humanId = ids[25]!;
export const audience = "https://api.deployments.test";
export const apiKey = "dpl_test_runtime_human_access";
export const tenantHeaders = {
  "x-deployments-environment": environmentId,
  "x-deployments-organization": organizationId,
  "x-deployments-project": projectId,
};

export interface PlatformTokenOptions {
  readonly audience?: string;
  readonly expiresInSeconds?: number;
  readonly key?: CryptoKey;
  readonly scope: string;
  readonly subject?: Ulid;
  readonly tokenSessionId?: Ulid;
}

export interface JwtIssuer {
  readonly issuer: string;
  readonly stop: () => Promise<void>;
  readonly token: (options: PlatformTokenOptions) => Promise<string>;
}

export async function startJwtIssuer(): Promise<JwtIssuer> {
  const pair = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(pair.publicKey)), alg: "RS256", kid: "runtime-test" };
  const server = Bun.serve({
    fetch: () => Response.json({ keys: [jwk] }),
    hostname: "127.0.0.1",
    port: 0,
  });
  const issuer = `http://127.0.0.1:${server.port}`;
  return {
    issuer,
    stop: () => server.stop(true),
    token: (options) => {
      const issuedAt = Math.floor(Date.now() / 1_000);
      return new SignJWT({
        scope: options.scope,
        ...(options.tokenSessionId ? { sid: options.tokenSessionId } : {}),
      })
        .setProtectedHeader({ alg: "RS256", kid: "runtime-test" })
        .setSubject(options.subject ?? humanId)
        .setIssuer(issuer)
        .setAudience(options.audience ?? audience)
        .setIssuedAt(issuedAt - 60)
        .setExpirationTime(issuedAt + (options.expiresInSeconds ?? 300))
        .sign(options.key ?? pair.privateKey);
    },
  };
}

export function controlRecord(
  pk: string,
  sk: string,
  itemType: string,
  data: Record<string, unknown>,
) {
  return { data, itemType, pk, sk } as unknown as PlatformRecord;
}

export function environmentRecords(environment: Ulid, organization: Ulid, project: Ulid) {
  const environmentKey = { pk: key("ORG", organization, "PROJECT", project), sk: environment };
  const claimKey = Keys.control.uniqueClaim("environment-id", environment);
  return [
    controlRecord(claimKey.pk, claimKey.sk, "unique-claim", {
      namespace: "environment-id",
      ownerId: environment,
      ownerItemType: "environment",
      ownerPk: environmentKey.pk,
      ownerSk: environmentKey.sk,
    }),
    controlRecord(environmentKey.pk, environmentKey.sk, "environment", {
      id: environment,
      organizationId: organization,
      projectId: project,
      status: "active",
    }),
  ];
}

export function membership(role: string, status = "active", principalId: Ulid = humanId) {
  return controlRecord(
    key("ORG", organizationId),
    key("ORGANIZATION-MEMBER", principalId),
    "organization-member",
    { organizationId, principalId, role, status },
  );
}

export function humanPrincipal(principalId: Ulid = humanId, platformAdministrator = false) {
  return controlRecord(key("PRINCIPAL", principalId), key("PRINCIPAL", principalId), "principal", {
    id: principalId,
    kind: "human",
    ...(platformAdministrator ? { platformRole: "administrator" } : {}),
    status: "active",
  });
}

export function apiKeyRecords(scopes: readonly string[] = ["approvals:read"]) {
  const common = {
    createdAt: now.toISOString(),
    environmentId,
    organizationId,
    projectId,
    updatedAt: now.toISOString(),
    version: 0,
  };
  const account = Schema.decodeUnknownSync(ServiceAccountRecord)(
    withCanonicalRecordKeys({
      data: {
        ...common,
        id: serviceAccountId,
        name: "Runtime service",
        scopes,
        status: "active" as const,
      },
      itemType: "service-account" as const,
    }),
  );
  const credential = Schema.decodeUnknownSync(ApiCredentialRecord)(
    withCanonicalRecordKeys({
      data: {
        ...common,
        credentialHash: credentialHash(apiKey),
        id: ids[31]!,
        keyPrefix: "dpl_test",
        name: "Runtime credential",
        scopes,
        serviceAccountId,
        status: "active" as const,
      },
      itemType: "api-credential" as const,
    }),
  );
  const claim = makeUniqueClaimRecord(
    uniqueClaimRequirements(credential)[0]!,
    now.toISOString(),
  ) as PlatformRecord;
  return [account, credential, claim];
}

export function runtimeApiClient(database: DynamoDatabaseService, issuer: string) {
  const usage: Parameters<ApiCredentialUsageRecorder>[0][] = [];
  let nextId = 100;
  const dependencies = {
    authenticateHuman: createRuntimeHumanAuthenticator({
      database,
      jwt: { audience, claimProfile: "platform", issuer },
    }),
    database,
    durableTransport: { append: async () => ({}), currentOffset: async () => "0" },
    enqueueRun: async () => {},
    generateId: async () => `01ARZ3NDEKTSV4RRFFQ69G${String(nextId++).padStart(4, "0")}` as Ulid,
    now: () => now,
    recordApiCredentialUsage: async (input: Parameters<ApiCredentialUsageRecorder>[0]) => {
      usage.push(input);
    },
  } as unknown as RuntimeApiDependencies;
  const handler = createRuntimeApiHandler(dependencies);
  const request = async (
    method: string,
    path: string,
    bearer: string,
    options: {
      readonly body?: Record<string, unknown>;
      readonly headers?: Record<string, string>;
      readonly query?: Record<string, string>;
    } = {},
  ) => {
    const event: HttpApiEvent = {
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      headers: { authorization: `Bearer ${bearer}`, ...(options.headers ?? tenantHeaders) },
      queryStringParameters: options.query ?? null,
      rawPath: path,
      requestContext: { http: { method } },
    };
    const result = await handler(event);
    return { body: JSON.parse(result.body) as Record<string, unknown>, status: result.statusCode };
  };
  return { request, usage };
}
