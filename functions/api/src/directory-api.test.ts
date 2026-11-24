import {
  ServiceName,
  Ulid,
  makeDirectory,
  makeOrganizationStandingRepository,
  makeDynamoDatabase,
  makeTenancyPersistence,
  tableNamesFromEnvironment,
  type OrganizationRole,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { humanPrincipalRecord } from "@deployments-ai/db/memory-testing";
import { standingInstallation } from "@deployments-ai/organization-admission/testing";
import { parseInstallDefaultEntitlements } from "@deployments-ai/tenant-limits/install-defaults";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { ApiIdentity } from "./api-service-contracts.ts";
import { createDirectoryApi } from "./directory-api.ts";
import { planFeaturesFromEnvironment } from "./plan-features.ts";
import { createScimApi } from "./scim/scim-api.ts";

const ulid = Schema.decodeUnknownSync(Ulid);
const OWNER = ulid("01ARZ3NDEKTSV4RRFFQ69G5FA0");
const NOW = "2026-10-18T09:00:00.000Z";
const SCIM_BASE_URL = "https://api.example.test/scim/v2";
const ENVIRONMENT = {
  DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS: JSON.stringify({
    active_sandboxes: 8,
    api_request_burst: 40,
    api_requests_per_second: 20,
    concurrent_runs: 8,
  }),
};

async function setup() {
  const fake = fakeDynamoDocumentClient();
  const tables = tableNamesFromEnvironment({});
  fake.put(tables.control, humanPrincipalRecord(OWNER, "owner@acme.example"));
  const database = makeDynamoDatabase(fake.client, tables);
  const created = await makeTenancyPersistence({ database }).organizations.create({
    body: { name: "Acme" },
    identity: { principalId: OWNER, scopes: ["platform:*"] },
    idempotencyKey: "organization-acme",
    query: {},
    scope: {},
  });
  const acme = ulid(created.id);
  let secrets = 0;
  const directory = makeDirectory({
    database,
    now: () => new Date(NOW),
    randomSecret: () => `random-value-${++secrets}`,
  });
  const human = (organizationRole: OrganizationRole): ApiIdentity => ({
    authentication: "tenant-jwt",
    organizationIds: [acme],
    organizationRole,
    principalId: organizationRole === "owner" ? OWNER : ulid("01ARZ3NDEKTSV4RRFFQ69G5FA1"),
    scopes: ["members:read", "members:write"],
  });
  const identities: Readonly<Record<string, ApiIdentity>> = {
    admin: human("admin"),
    member: human("member"),
    owner: human("owner"),
  };
  const api = createDirectoryApi({
    authenticate: async (request) => identities[request.headers.get("authorization") ?? ""] ?? null,
    directory,
    features: planFeaturesFromEnvironment({ database, environment: ENVIRONMENT }),
    idempotency: { execute: async (input) => input.operation() },
    requestId: () => "req-test",
  });
  const scim = createScimApi({
    directory,
    gate: standingInstallation({ organizationId: acme }).gate,
  });
  let keys = 0;
  const send = async (caller: string, method: string, path: string, body?: unknown) => {
    const response = await api(
      new Request(`https://api.example.test${path}`, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          authorization: caller,
          "x-deployments-organization": acme,
          ...(method === "GET" ? {} : { "idempotency-key": `key-${++keys}` }),
        },
        method,
      }),
    );
    if (!response) throw new Error(`No route handled ${method} ${path}`);
    const text = await response.text();
    return { body: JSON.parse(text) as Record<string, any>, status: response.status, text };
  };
  const scimStatus = async (secret: string) =>
    (await scim(
      new Request(`${SCIM_BASE_URL}/Users`, { headers: { authorization: `Bearer ${secret}` } }),
    ))!.status;
  const standing = makeOrganizationStandingRepository({
    database,
    installDefaults: parseInstallDefaultEntitlements(ENVIRONMENT),
  });
  const setServiceFeatures = (features: { readonly scim?: boolean }) =>
    standing.setGrant({
      actor: { kind: "service", service: Schema.decodeUnknownSync(ServiceName)("billing") },
      entitlements: { features },
      organizationId: acme,
    });
  return { scimStatus, send, setServiceFeatures };
}

describe("directory administration API", () => {
  test("a plan without scim refuses setup and new tokens but still reads and revokes", async () => {
    const { send, setServiceFeatures } = await setup();
    await send("owner", "PUT", "/v1/directory", { defaultRole: "member" });
    const issued = await send("owner", "POST", "/v1/directory/tokens");
    await setServiceFeatures({ scim: false });

    const refused = await Promise.all([
      send("owner", "PUT", "/v1/directory", { defaultRole: "viewer" }),
      send("owner", "POST", "/v1/directory/tokens"),
    ]);
    expect(refused.map(({ body, status }) => [status, body.code, body.feature, body.type])).toEqual(
      [
        [
          403,
          "feature_not_in_plan",
          "scim",
          "https://docs.deployments.ai/errors/feature-not-in-plan",
        ],
        [
          403,
          "feature_not_in_plan",
          "scim",
          "https://docs.deployments.ai/errors/feature-not-in-plan",
        ],
      ],
    );
    expect((await send("owner", "GET", "/v1/directory")).status).toBe(200);
    const tokenId = issued.body.token.id as string;
    expect((await send("owner", "DELETE", `/v1/directory/tokens/${tokenId}`)).status).toBe(200);

    await setServiceFeatures({ scim: true });
    expect((await send("owner", "POST", "/v1/directory/tokens")).status).toBe(201);
  });

  test("refuses an organization member on every directory route", async () => {
    const { send } = await setup();
    await send("owner", "PUT", "/v1/directory", { defaultRole: "member" });
    const replies = await Promise.all([
      send("member", "GET", "/v1/directory"),
      send("member", "PUT", "/v1/directory", { defaultRole: "viewer" }),
      send("member", "POST", "/v1/directory/tokens"),
      send("member", "DELETE", "/v1/directory/tokens/01ARZ3NDEKTSV4RRFFQ69G5FC1"),
    ]);

    expect(replies.map(({ body, status }) => [status, body.code])).toEqual([
      [403, "insufficient_role"],
      [403, "insufficient_role"],
      [403, "insufficient_role"],
      [403, "insufficient_role"],
    ]);
    expect(replies[0]!.body.detail).toBe(
      "Directory sync administration requires one of these organization roles: owner, admin.",
    );
    expect((await send("owner", "GET", "/v1/directory")).body.tokens).toEqual([]);
  });

  test("reports an organization without directory sync as not configured", async () => {
    const { send } = await setup();

    const reply = await send("admin", "GET", "/v1/directory");

    expect([reply.status, reply.body.code]).toEqual([404, "directory_not_configured"]);
  });

  test("rejects a default role directory sync cannot grant", async () => {
    const { send } = await setup();

    const reply = await send("admin", "PUT", "/v1/directory", { defaultRole: "owner" });

    expect([reply.status, reply.body.code]).toEqual([422, "validation_failed"]);
  });

  test("an admin configures the directory and rotates its two tokens", async () => {
    const { scimStatus, send } = await setup();

    const configured = await send("admin", "PUT", "/v1/directory", { defaultRole: "viewer" });
    expect([configured.status, configured.body]).toEqual([
      200,
      {
        createdAt: NOW,
        defaultRole: "viewer",
        scimBaseUrl: SCIM_BASE_URL,
        tokens: [],
        updatedAt: NOW,
      },
    ]);

    const first = await send("admin", "POST", "/v1/directory/tokens");
    expect(first.status).toBe(201);
    expect(first.body.token).toEqual({
      createdAt: NOW,
      createdBy: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
      id: first.body.token.id,
      secret: "dpl_scim_random-value-1",
      tokenPrefix: "dpl_scim_random-",
    });
    expect(first.body.directory.tokens).toEqual([
      {
        createdAt: NOW,
        createdBy: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
        id: first.body.token.id,
        tokenPrefix: "dpl_scim_random-",
      },
    ]);
    const second = await send("admin", "POST", "/v1/directory/tokens");
    expect(second.body.token.secret).toBe("dpl_scim_random-value-2");

    const read = await send("admin", "GET", "/v1/directory");
    expect(read.body.tokens.map(({ id }: { id: string }) => id)).toEqual([
      first.body.token.id,
      second.body.token.id,
    ]);
    expect([read.text.includes("dpl_scim_random-value-1"), read.text.includes('"secret"')]).toEqual(
      [false, false],
    );

    const third = await send("admin", "POST", "/v1/directory/tokens");
    expect([third.status, third.body.code]).toEqual([409, "directory_token_limit"]);
    expect(await scimStatus("dpl_scim_random-value-1")).toBe(200);

    const revoked = await send("admin", "DELETE", `/v1/directory/tokens/${first.body.token.id}`);
    expect(revoked.body.tokens.map(({ id }: { id: string }) => id)).toEqual([second.body.token.id]);
    expect(await scimStatus("dpl_scim_random-value-1")).toBe(401);
    expect(await scimStatus("dpl_scim_random-value-2")).toBe(200);

    const replacement = await send("admin", "POST", "/v1/directory/tokens");
    expect([replacement.status, replacement.body.token.secret]).toEqual([
      201,
      "dpl_scim_random-value-3",
    ]);
    const unknown = await send("admin", "DELETE", `/v1/directory/tokens/${first.body.token.id}`);
    expect([unknown.status, unknown.body.code]).toEqual([404, "directory_token_not_found"]);
  });
});
