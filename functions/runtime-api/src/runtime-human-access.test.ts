import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  OrganizationIdentityProviderRecord,
  RunRecord,
  ThreadRecord,
  Ulid,
  federatedGrantRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { openOperatorAccessRecord } from "@deployments-ai/db/operator-access-testing";
import {
  pausedToolCallRecord,
  pendingApprovalRecord,
  runLookupRecord,
} from "@deployments-ai/worker";
import { Schema } from "effect";
import { generateKeyPair, type CryptoKey } from "jose";
import { artifactReadable, type Artifact } from "./artifact-storage.ts";
import {
  apiKey,
  apiKeyRecords,
  environmentRecords,
  humanId,
  humanPrincipal,
  membership,
  runtimeApiClient,
  startJwtIssuer,
  tenantHeaders,
  type JwtIssuer,
} from "./runtime-human-access.fixture.ts";
import {
  deployment,
  deploymentId,
  environmentId,
  ids,
  memoryDatabase,
  now,
  organizationId,
  projectId,
  release,
  runLocator,
  runRecord,
  serviceAccountId,
} from "./runtime-lifecycle.fixture.ts";

const otherOrganizationId = ids[26]!;
const otherProjectId = ids[27]!;
const otherEnvironmentId = ids[28]!;
const approvalId = ids[21]!;
const toolCallId = ids[22]!;
const allScopes = "runs:read runs:write approvals:read approvals:write";
const connectionId = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G7C01");
const tokenSessionId = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G7S01");
const otherTokenSessionId = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G7S02");
const idpIssuer = "https://acme.okta.example";

let jwt: JwtIssuer;
let foreignKey: CryptoKey;

beforeAll(async () => {
  jwt = await startJwtIssuer();
  foreignKey = (await generateKeyPair("RS256")).privateKey;
});

afterAll(async () => {
  await jwt.stop();
});

function token(
  options: {
    readonly audience?: string;
    readonly expiresInSeconds?: number;
    readonly key?: CryptoKey;
    readonly scope?: string;
    readonly tokenSessionId?: Ulid;
  } = {},
) {
  return jwt.token({ ...options, scope: options.scope ?? allScopes });
}

function waitingRun() {
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...runRecord("queued").data,
        status: "waiting-for-approval" as const,
        toolContinuation: {
          completedToolCallIds: [],
          pendingAction: { kind: "approval" as const, toolCallId },
          version: 2,
        },
      },
      itemType: "run" as const,
    }),
  );
}

function ssoEnforcementRecords(): PlatformRecord[] {
  const authenticatedAt = new Date();
  const timestamp = authenticatedAt.toISOString();
  const provider = Schema.decodeUnknownSync(OrganizationIdentityProviderRecord)(
    withCanonicalRecordKeys({
      data: {
        clientId: "runtime-client",
        clientSecret: {
          algorithm: "AES-256-GCM",
          authenticationTag: "tag",
          ciphertext: "ciphertext",
          encryptedDataKey: "key",
          encryptionContextHash: "hash",
          iv: "iv",
          schemaVersion: 1,
        },
        clientSecretSetAt: timestamp,
        connectionId,
        createdAt: timestamp,
        displayName: "Acme Okta",
        endpoints: {
          authorization: `${idpIssuer}/authorize`,
          jwks: `${idpIssuer}/keys`,
          token: `${idpIssuer}/token`,
        },
        id: "oidc",
        issuer: idpIssuer,
        jit: { kind: "disabled" },
        organizationId,
        signingAlgorithms: ["RS256"],
        state: { enforcement: "required", kind: "active" },
        tokenEndpointAuthMethod: "client_secret_basic",
        updatedAt: timestamp,
        version: 1,
      },
      itemType: "organization-identity-provider" as const,
    }),
  );
  const grant = federatedGrantRecord({
    authentication: {
      authenticatedAt: timestamp,
      connectionId,
      issuer: idpIssuer,
      method: "federated",
      organizationId,
      subject: "okta-user",
    },
    createdAt: timestamp,
    principalId: humanId,
    tokenSessionExpiresAt: new Date(authenticatedAt.getTime() + 3_600_000).toISOString(),
    tokenSessionId,
  });
  return [provider, grant];
}

function fixture(
  options: {
    readonly member?: PlatformRecord | null;
    readonly platformAdministrator?: boolean;
    readonly records?: readonly PlatformRecord[];
  } = {},
) {
  const run = waitingRun();
  const action = {
    approvalId,
    effect: "write" as const,
    idempotencyKey: "tool/deploy-1",
    input: { environment: "staging" },
    inputSummary: "Deploy to staging.",
    kind: "approval" as const,
    policyReason: "Deployment requires approval.",
    requiredScopes: ["deploy:write"],
    toolCallId,
    toolName: "deployment.start",
  };
  const thread = Schema.decodeUnknownSync(ThreadRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: deploymentId,
        archived: false,
        channel: "api",
        createdAt: now.toISOString(),
        createdBy: { id: serviceAccountId, type: "service-account" as const },
        environmentId,
        id: run.data.threadId,
        organizationId,
        pinned: false,
        projectId,
        streamId: ids[18]!,
        title: "Deployment conversation",
        updatedAt: now.toISOString(),
        version: 0,
      },
      itemType: "thread" as const,
    }),
  );
  const memory = memoryDatabase([
    run,
    runLocator(run),
    runLookupRecord(run),
    thread,
    deployment(),
    release(),
    pausedToolCallRecord({ action, now, run }),
    pendingApprovalRecord({ action, now, run }),
    humanPrincipal(humanId, options.platformAdministrator),
    ...environmentRecords(environmentId, organizationId, projectId),
    ...environmentRecords(otherEnvironmentId, otherOrganizationId, otherProjectId),
    ...(options.member === null ? [] : [options.member ?? membership("admin")]),
    ...apiKeyRecords(),
    ...(options.records ?? []),
  ]);
  const { request, usage } = runtimeApiClient(memory.database, jwt.issuer);
  const resolve = async (bearer: string, decision = "approved") =>
    request("POST", `/v1/runs/${run.data.id}/approvals/${approvalId}/resolve`, bearer, {
      body: { decision, threadId: run.data.threadId },
    });
  const storedApproval = () =>
    [...memory.records.values()].find(
      (record) => record.itemType === "approval" && record.data.id === approvalId,
    ) as Extract<PlatformRecord, { readonly itemType: "approval" }>;
  return { request, resolve, run, storedApproval, tenantHeaders, thread, usage };
}

describe("runtime API platform bearer access", () => {
  test("an active admin lists runtime state and resolves an approval as themselves", async () => {
    const f = fixture();
    const bearer = await token();

    const runs = await f.request("GET", "/v1/runs", bearer, {
      query: { agentDeploymentId: deploymentId },
    });
    expect(runs.status).toBe(200);
    expect(runs.body.runs).toEqual([expect.objectContaining({ id: f.run.data.id })]);

    const threads = await f.request("GET", "/v1/threads", bearer);
    expect(threads.status).toBe(200);
    expect(threads.body.threads).toEqual([expect.objectContaining({ id: f.thread.data.id })]);

    const approvals = await f.request("GET", "/v1/approvals", bearer, {
      query: { status: "pending" },
    });
    expect(approvals.status).toBe(200);
    expect(approvals.body.approvals).toEqual([expect.objectContaining({ id: approvalId })]);

    const resolved = await f.resolve(bearer);
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ approval: { status: "approved" }, decision: "approved" });
    expect(f.storedApproval().data).toMatchObject({
      resolvedByPrincipalId: humanId,
      status: "approved",
    });
    expect(f.usage).toHaveLength(0);
  });

  test("lets members read but reserves runtime mutations for owners and admins", async () => {
    const f = fixture({ member: membership("member") });
    const bearer = await token();

    expect((await f.request("GET", "/v1/approvals", bearer)).status).toBe(200);
    expect(await f.resolve(bearer)).toMatchObject({
      body: { code: "insufficient_role" },
      status: 403,
    });
    expect(f.storedApproval().data.status).toBe("pending");
  });

  test("refuses platform administrators without membership or operator access", async () => {
    const f = fixture({ member: null, platformAdministrator: true });

    expect(await f.resolve(await token(), "rejected")).toMatchObject({
      body: { code: "operator_access_required" },
      status: 403,
    });
    expect(f.storedApproval().data.status).toBe("pending");
  });

  test("admits platform administrators without membership under open operator access", async () => {
    const f = fixture({
      member: null,
      platformAdministrator: true,
      records: [openOperatorAccessRecord({ organizationId, principalId: humanId })],
    });

    const resolved = await f.resolve(await token(), "rejected");

    expect(resolved.status).toBe(200);
    expect(f.storedApproval().data).toMatchObject({
      resolvedByPrincipalId: humanId,
      status: "rejected",
    });
  });

  test("rejects tokens that fail signature, expiry, or audience verification", async () => {
    const f = fixture();
    for (const bearer of [
      await token({ key: foreignKey }),
      await token({ expiresInSeconds: -30 }),
      await token({ audience: "https://other.example.test" }),
    ]) {
      expect(await f.request("GET", "/v1/approvals", bearer)).toMatchObject({
        body: { code: "unauthorized" },
        status: 401,
      });
    }
  });

  test("forbids callers without live access to the requested environment", async () => {
    const bearer = await token();
    const cases = [
      { code: "organization_scope_violation", fixture: fixture({ member: null }) },
      {
        code: "organization_scope_violation",
        fixture: fixture({ member: membership("admin", "removed") }),
      },
    ];
    for (const { code, fixture: f } of cases) {
      expect(await f.request("GET", "/v1/approvals", bearer)).toMatchObject({
        body: { code },
        status: 403,
      });
    }

    const f = fixture();
    expect(
      await f.request("GET", "/v1/approvals", bearer, {
        headers: { ...f.tenantHeaders, "x-deployments-environment": otherEnvironmentId },
      }),
    ).toMatchObject({ body: { code: "organization_scope_violation" }, status: 403 });
    expect(
      await f.request("GET", "/v1/approvals", bearer, {
        headers: {
          "x-deployments-environment": otherEnvironmentId,
          "x-deployments-organization": otherOrganizationId,
          "x-deployments-project": otherProjectId,
        },
      }),
    ).toMatchObject({ body: { code: "organization_scope_violation" }, status: 403 });
    expect(await f.request("GET", "/v1/approvals", bearer, { headers: {} })).toMatchObject({
      body: { code: "tenant_scope_required" },
      status: 403,
    });
  });

  test("requires the token session's federated grant when the organization enforces SSO", async () => {
    const f = fixture({ records: ssoEnforcementRecords() });

    const federated = await f.request("GET", "/v1/approvals", await token({ tokenSessionId }));
    expect(federated.status).toBe(200);
    for (const bearer of [await token(), await token({ tokenSessionId: otherTokenSessionId })]) {
      expect(await f.request("GET", "/v1/approvals", bearer)).toMatchObject({
        body: { code: "organization_sso_required" },
        status: 403,
      });
    }
  });

  test("requires the route scope in the token", async () => {
    const f = fixture();

    const denied = await f.request("GET", "/v1/approvals", await token({ scope: "runs:read" }));
    expect(denied).toMatchObject({ body: { code: "insufficient_scope" }, status: 403 });
  });

  test("serves the environment run feed and run lookup only inside the admitted environment", async () => {
    const base = runRecord("completed", ids[29]!, "foreign-run");
    const foreign = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...base.data,
          environmentId: otherEnvironmentId,
          organizationId: otherOrganizationId,
          projectId: otherProjectId,
        },
        itemType: "run" as const,
      }),
    );
    const f = fixture({ member: membership("member"), records: [foreign, runLocator(foreign)] });
    const reader = await token({ scope: "runs:read" });

    const feed = await f.request("GET", "/v1/runs", reader);
    expect(feed.status).toBe(200);
    expect(feed.body.runs).toEqual([expect.objectContaining({ id: f.run.data.id })]);
    const searched = await f.request("POST", "/v1/runs/search", reader, {
      body: { status: "waiting-for-approval" },
    });
    expect(searched.body.runs).toEqual([expect.objectContaining({ id: f.run.data.id })]);
    expect(await f.request("GET", `/v1/runs/${f.run.data.id}`, reader)).toMatchObject({
      body: { id: f.run.data.id, object: "run" },
      status: 200,
    });

    expect(await f.request("GET", `/v1/runs/${foreign.data.id}`, reader)).toMatchObject({
      body: { code: "not_found" },
      status: 404,
    });
    const otherEnvironmentHeaders = {
      "x-deployments-environment": otherEnvironmentId,
      "x-deployments-organization": otherOrganizationId,
      "x-deployments-project": otherProjectId,
    };
    for (const path of ["/v1/runs", `/v1/runs/${foreign.data.id}`]) {
      expect(
        await f.request("GET", path, reader, { headers: otherEnvironmentHeaders }),
      ).toMatchObject({ body: { code: "organization_scope_violation" }, status: 403 });
      expect(await f.request("GET", path, await token({ scope: "approvals:read" }))).toMatchObject({
        body: { code: "insufficient_scope" },
        status: 403,
      });
    }
  });

  test("keeps API keys service-attributed and usage-recorded", async () => {
    const f = fixture();

    const listed = await f.request("GET", "/v1/approvals", apiKey, { headers: {} });

    expect(listed.status).toBe(200);
    expect(f.usage).toEqual([
      expect.objectContaining({
        apiCredentialId: ids[31]!,
        outcome: "allowed",
        requestMethod: "GET",
        requestPath: "/v1/approvals",
      }),
    ]);
  });
});

describe("caller-private artifacts", () => {
  test("are readable only by the principal or service account that uploaded them", () => {
    const scope = { environmentId, organizationId, projectId };
    const human = {
      kind: "human",
      platformAdministrator: false,
      principalId: humanId,
      scope,
      scopes: [],
    } as const;
    const service = {
      credential: { data: { id: ids[31]! } },
      kind: "api-credential",
      scope,
      serviceAccount: { data: { id: serviceAccountId } },
    } as unknown as Parameters<typeof artifactReadable>[1];
    const artifact = (owner: Readonly<Record<string, string>>) =>
      ({ data: { owner, visibility: "private" } }) as unknown as Artifact;

    expect(artifactReadable(artifact({ principalId: humanId, type: "principal" }), human)).toBe(
      true,
    );
    expect(artifactReadable(artifact({ principalId: humanId, type: "principal" }), service)).toBe(
      false,
    );
    expect(artifactReadable(artifact({ principalId: ids[29]!, type: "principal" }), human)).toBe(
      false,
    );
    expect(
      artifactReadable(
        artifact({ serviceAccountId: serviceAccountId, type: "service-account" }),
        human,
      ),
    ).toBe(false);
    expect(
      artifactReadable(
        artifact({ serviceAccountId: serviceAccountId, type: "service-account" }),
        service,
      ),
    ).toBe(true);
  });
});
