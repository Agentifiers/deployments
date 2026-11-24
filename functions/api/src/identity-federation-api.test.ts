import {
  PrincipalIdentityRecord,
  bffFenceRecord,
  federatedGrantRecord,
  makeUniqueClaimRecord,
  securityStateRecord,
  uniqueClaimRequirements,
  withCanonicalRecordKeys,
  type Ulid,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  OWNER,
  OWNER_SESSION,
  SECRET,
  okta,
  setup,
  ulid,
} from "./identity-federation-api.fixture.ts";

function linkRecord(organizationId: Ulid, id: string, subject: string, createdAt: string) {
  return Schema.decodeUnknownSync(PrincipalIdentityRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt,
        email: `${subject}@acme.example`,
        id,
        issuer: okta.issuer,
        organizationId,
        principalId: OWNER,
        subject,
        updatedAt: createdAt,
        version: 1,
      },
      itemType: "principal-identity",
    }),
  );
}

describe("identity federation API", () => {
  test("serves only its own routes", async () => {
    const { handler } = await setup();
    expect(await handler(new Request("https://api.example.test/v1/projects"))).toBeUndefined();
    expect(
      await handler(new Request("https://api.example.test/v1/login-domains", { method: "PATCH" })),
    ).toBeUndefined();
  });

  test("a plan without sso refuses adding a domain or provider but still lists and removes", async () => {
    let sso = true;
    const { send } = await setup({ features: async () => ({ scim: true, sso }) });
    const added = await send("owner", "POST", "/v1/login-domains", { domain: "acme.example" });
    sso = false;

    const refused = await Promise.all([
      send("owner", "POST", "/v1/login-domains", { domain: "two.acme.example" }),
      send("owner", "POST", `/v1/login-domains/${added.body.id}/verify`),
      send("owner", "PUT", "/v1/identity-provider", {}),
      send("owner", "PUT", "/v1/identity-provider/state", { kind: "disabled" }),
    ]);
    expect(refused.map(({ body, status }) => [status, body.code, body.feature])).toEqual(
      Array.from({ length: 4 }, () => [403, "feature_not_in_plan", "sso"]),
    );
    expect((await send("owner", "GET", "/v1/login-domains")).status).toBe(200);
    expect((await send("owner", "DELETE", `/v1/login-domains/${added.body.id}`)).status).toBe(200);
  });

  test("adds a domain, verifies it through DNS, refuses a second organization, and releases it", async () => {
    const { send, txt } = await setup();
    const added = await send("owner", "POST", "/v1/login-domains", { domain: "Acme.Example" });
    expect(added.status).toBe(201);
    const token = String(added.body.dnsRecord.value).replace("deployments-login=", "");
    expect(token).toMatch(/^[0-9a-f]{32}$/u);
    expect(added.body).toMatchObject({
      dnsRecord: {
        name: "_deployments-login.acme.example",
        type: "TXT",
        value: `deployments-login=${token}`,
      },
      domain: "acme.example",
      state: { kind: "pending" },
    });
    const listed = await send("admin", "GET", "/v1/login-domains");
    expect(listed).toMatchObject({ body: { items: [added.body], nextCursor: null }, status: 200 });

    const verifyPath = `/v1/login-domains/${added.body.id}/verify`;
    expect(await send("owner", "POST", verifyPath)).toMatchObject({
      body: { code: "txt_not_found" },
      status: 422,
    });
    txt.set("_deployments-login.acme.example", [["v=spf1 -all"], ["deployments-login=", token]]);
    expect(await send("owner", "POST", verifyPath)).toMatchObject({
      body: { state: { kind: "verified" } },
      status: 200,
    });

    const contested = await send("rival", "POST", "/v1/login-domains", { domain: "acme.example" });
    const rivalToken = String(contested.body.dnsRecord.value);
    txt.set("_deployments-login.acme.example", [[rivalToken]]);
    const rivalVerify = `/v1/login-domains/${contested.body.id}/verify`;
    expect(await send("rival", "POST", rivalVerify)).toMatchObject({
      body: { code: "domain_claimed" },
      status: 409,
    });
    expect(await send("owner", "DELETE", `/v1/login-domains/${added.body.id}`)).toMatchObject({
      body: { domain: "acme.example", state: { kind: "verified" } },
      status: 200,
    });
    expect(await send("rival", "POST", rivalVerify)).toMatchObject({
      body: { state: { kind: "verified" } },
      status: 200,
    });
  });

  test("answers 503 dns_lookup_failed when the resolver times out and verifies on retry", async () => {
    const { dnsTimeouts, send, txt } = await setup();
    const added = await send("owner", "POST", "/v1/login-domains", { domain: "acme.example" });
    const verifyPath = `/v1/login-domains/${added.body.id}/verify`;
    txt.set("_deployments-login.acme.example", [[String(added.body.dnsRecord.value)]]);
    dnsTimeouts.add("_deployments-login.acme.example");
    expect(await send("owner", "POST", verifyPath)).toMatchObject({
      body: { code: "dns_lookup_failed" },
      status: 503,
    });
    expect(await send("admin", "GET", "/v1/login-domains")).toMatchObject({
      body: { items: [{ id: added.body.id, state: { kind: "pending" } }] },
    });
    dnsTimeouts.clear();
    expect(await send("owner", "POST", verifyPath)).toMatchObject({
      body: { state: { kind: "verified" } },
      status: 200,
    });
  });

  test("requires identity.administer, the organization header, and an idempotency key", async () => {
    const { acme, handler, send } = await setup();
    expect(await send("viewer", "GET", "/v1/login-domains")).toMatchObject({
      body: { code: "insufficient_role" },
      status: 403,
    });
    expect(await send("nobody", "GET", "/v1/identity-provider")).toMatchObject({ status: 401 });
    expect(await send("owner", "GET", "/v1/login-domains", undefined, "")).toMatchObject({
      body: { code: "missing_organization_context" },
      status: 400,
    });
    const unkeyed = await handler(
      new Request("https://api.example.test/v1/login-domains", {
        body: JSON.stringify({ domain: "acme.example" }),
        headers: { authorization: "owner", "x-deployments-organization": acme },
        method: "POST",
      }),
    );
    expect(unkeyed?.status).toBe(400);
    expect(await unkeyed?.json()).toMatchObject({ code: "missing_idempotency_key" });
  });

  test("configures the provider without ever returning its secret", async () => {
    const { acme, sealed, send } = await setup();
    expect(await send("admin", "PUT", "/v1/identity-provider", okta)).toMatchObject({
      body: { code: "client_secret_required" },
      status: 422,
    });
    const created = await send("admin", "PUT", "/v1/identity-provider", {
      ...okta,
      clientSecret: SECRET,
    });
    expect(created.status).toBe(200);
    const connectionId = String(created.body.connectionId);
    expect(created.body).toMatchObject({
      clientId: "0oa-client",
      endpoints: {
        authorization: "https://idp.example.com/authorize",
        jwks: "https://idp.example.com/keys",
        token: "https://idp.example.com/token",
        userinfo: "https://idp.example.com/userinfo",
      },
      issuer: "https://idp.example.com",
      jit: { kind: "enabled", role: "member" },
      organizationId: acme,
      protocol: "oidc",
      redirectUri: `https://auth.example.test/oauth2/federation/callback/${acme}`,
      signingAlgorithms: ["RS256"],
      state: { enforcement: "optional", kind: "active" },
      tokenEndpointAuthMethod: "client_secret_basic",
    });
    expect(sealed).toEqual([
      {
        binding: {
          connectionId,
          organizationId: acme,
          purpose: "identity-provider-client-secret",
        },
        value: SECRET,
      },
    ]);

    const rotated = await send("owner", "PUT", "/v1/identity-provider", {
      ...okta,
      clientSecret: "rotated-secret-value",
    });
    expect(rotated.body.connectionId).toBe(connectionId);
    expect(
      await send("owner", "PUT", "/v1/identity-provider", {
        ...okta,
        issuer: "https://login.example.org",
      }),
    ).toMatchObject({ body: { code: "client_secret_required" }, status: 422 });
    const moved = await send("owner", "PUT", "/v1/identity-provider", {
      ...okta,
      clientSecret: "moved-secret-value",
      issuer: "https://login.example.org",
    });
    expect(moved.body.connectionId).not.toBe(connectionId);
    expect(sealed.at(-1)?.binding.connectionId).toBe(moved.body.connectionId);
    expect(
      await send("owner", "PUT", "/v1/identity-provider", {
        ...okta,
        clientSecret: SECRET,
        issuer: "https://drift.example.com",
      }),
    ).toMatchObject({ body: { code: "discovery_issuer_mismatch" }, status: 422 });

    const fetched = await send("admin", "GET", "/v1/identity-provider");
    for (const response of [created, rotated, moved, fetched]) {
      expect(response.text).not.toContain(SECRET);
      expect(response.text).not.toContain("secret-value");
      expect(response.text).not.toContain("sealed-");
    }
    expect(Object.keys(fetched.body).toSorted()).toEqual([
      "clientId",
      "clientSecretSetAt",
      "connectionId",
      "createdAt",
      "displayName",
      "endpoints",
      "issuer",
      "jit",
      "organizationId",
      "protocol",
      "redirectUri",
      "signingAlgorithms",
      "state",
      "tokenEndpointAuthMethod",
      "updatedAt",
    ]);
  });

  test("saving a provider again picks up a userinfo endpoint without changing its connection", async () => {
    const { issuersWithoutUserinfo, send } = await setup();
    issuersWithoutUserinfo.add(okta.issuer);
    const saved = await send("owner", "PUT", "/v1/identity-provider", {
      ...okta,
      clientSecret: SECRET,
    });
    issuersWithoutUserinfo.delete(okta.issuer);
    const resaved = await send("owner", "PUT", "/v1/identity-provider", okta);

    expect([saved.body.endpoints, resaved.status, resaved.body.endpoints]).toStrictEqual([
      {
        authorization: "https://idp.example.com/authorize",
        jwks: "https://idp.example.com/keys",
        token: "https://idp.example.com/token",
      },
      200,
      {
        authorization: "https://idp.example.com/authorize",
        jwks: "https://idp.example.com/keys",
        token: "https://idp.example.com/token",
        userinfo: "https://idp.example.com/userinfo",
      },
    ]);
    expect(resaved.body.connectionId).toBe(saved.body.connectionId);
  });

  test("only an owner signed in through the current connection can require SSO", async () => {
    const { acme, fake, send, tables } = await setup();
    const created = await send("owner", "PUT", "/v1/identity-provider", {
      ...okta,
      clientSecret: SECRET,
    });
    const required = { enforcement: "required", kind: "active" };
    expect(await send("admin", "PUT", "/v1/identity-provider/state", required)).toMatchObject({
      body: { code: "insufficient_role" },
      status: 403,
    });
    expect(await send("owner", "PUT", "/v1/identity-provider/state", required)).toMatchObject({
      body: { code: "enforcement_requires_federated_session" },
      status: 409,
    });
    const authenticatedAt = new Date(Date.now() - 60_000).toISOString();
    fake.put(
      tables.control,
      federatedGrantRecord({
        authentication: {
          authenticatedAt,
          connectionId: ulid(created.body.connectionId),
          issuer: okta.issuer,
          method: "federated",
          organizationId: acme,
          subject: "okta|owner",
        },
        createdAt: authenticatedAt,
        principalId: OWNER,
        tokenSessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        tokenSessionId: OWNER_SESSION,
      }),
    );
    expect(await send("owner", "PUT", "/v1/identity-provider/state", required)).toMatchObject({
      body: { state: required },
      status: 200,
    });
    const disabled = await send("admin", "PUT", "/v1/identity-provider/state", {
      kind: "disabled",
    });
    expect(disabled.status).toBe(200);
    expect(disabled.body.state).toEqual({
      disabledAt: disabled.body.updatedAt,
      kind: "disabled",
    });
    expect((await send("admin", "GET", "/v1/identity-provider")).body.state.kind).toBe("disabled");
    expect(await send("admin", "DELETE", "/v1/identity-provider")).toMatchObject({
      body: { state: { kind: "disabled" } },
      status: 200,
    });
    expect(await send("admin", "GET", "/v1/identity-provider")).toMatchObject({
      body: { code: "identity_provider_not_found" },
      status: 404,
    });
  });

  test("lists federated links newest first and deletes one", async () => {
    const { acme, fake, send, tables } = await setup();
    const at = "2026-10-01T00:00:00.000Z";
    for (const record of [
      securityStateRecord({
        createdAt: at,
        credentialVersion: 1,
        principalId: OWNER,
        sessionEpoch: 2,
        version: 1,
      }),
      bffFenceRecord({
        createdAt: at,
        principalId: OWNER,
        principalStatus: "active",
        sessionEpoch: 2,
        version: 1,
      }),
    ]) {
      fake.put(tables.identity ?? "identity", record);
    }
    const older = linkRecord(
      acme,
      "01ARZ3NDEKTSV4RRFFQ69G5FC0",
      "okta|older",
      "2026-10-01T00:00:00.000Z",
    );
    const newer = linkRecord(
      acme,
      "01ARZ3NDEKTSV4RRFFQ69G5FC1",
      "okta|newer",
      "2026-10-02T00:00:00.000Z",
    );
    for (const link of [older, newer]) {
      fake.put(tables.control, link);
      for (const requirement of uniqueClaimRequirements(link)) {
        fake.put(tables.control, makeUniqueClaimRecord(requirement, link.data.createdAt));
      }
    }
    const listed = await send("admin", "GET", "/v1/identity-provider/links?limit=1");
    expect(listed.body.items).toEqual([
      {
        createdAt: "2026-10-02T00:00:00.000Z",
        email: "okta|newer@acme.example",
        id: "01ARZ3NDEKTSV4RRFFQ69G5FC1",
        issuer: "https://idp.example.com",
        principalId: OWNER,
        subject: "okta|newer",
      },
    ]);
    expect(typeof listed.body.nextCursor).toBe("string");
    expect(
      await send("admin", "DELETE", "/v1/identity-provider/links/01ARZ3NDEKTSV4RRFFQ69G5FC1"),
    ).toMatchObject({ body: { subject: "okta|newer" }, status: 200 });
    const remaining = await send("admin", "GET", "/v1/identity-provider/links");
    expect(remaining.body.items.map((item: { subject: string }) => item.subject)).toEqual([
      "okta|older",
    ]);
    expect(
      await send("admin", "DELETE", "/v1/identity-provider/links/01ARZ3NDEKTSV4RRFFQ69G5FC1"),
    ).toMatchObject({ body: { code: "link_not_found" }, status: 404 });
  });
});
