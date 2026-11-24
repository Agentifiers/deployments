import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { storedRecords } from "../directory/test-support.ts";
import { makeDynamoDatabase, tableNamesFromEnvironment } from "../dynamo-database.ts";
import { Ulid } from "../ids.ts";
import { Keys } from "../keys.ts";
import { PersistenceError } from "../persistence-types.ts";
import type { OrganizationIdentityProviderRecord } from "../records/identity-federation.ts";
import { makeTenancyPersistence } from "../tenancy-persistence-composition.ts";
import { humanPrincipalRecord } from "../tenancy-test-support.ts";
import { fakeDynamoDocumentClient } from "../testing/dynamo-document-client.fixture.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import { federatedGrantRecord } from "./access.ts";
import type { FederationAdministrator } from "./administration-context.ts";
import type {
  OidcIdentityProviderSettings,
  SamlIdentityProviderSettings,
} from "./administration-provider.ts";
import { makeIdentityFederationAdministration } from "./administration.ts";
import { createWithClaims } from "./operations.ts";
import { makeFederationReads } from "./reads.ts";
import { federationRecord } from "./record-builders.ts";
import { existingPrincipal } from "./test-support.ts";

const ulid = Schema.decodeUnknownSync(Ulid);
const OWNER = ulid("01ARZ3NDEKTSV4RRFFQ69G5FA0");
const RIVAL = ulid("01ARZ3NDEKTSV4RRFFQ69G5FA1");
const LINKED = ulid("01ARZ3NDEKTSV4RRFFQ69G5FA2");
const SESSION = ulid("01ARZ3NDEKTSV4RRFFQ69G5FB0");
const NOW = new Date("2026-10-08T12:00:00.000Z");
const ISSUER = "https://idp.example.com";
const REQUIRED = { enforcement: "required", kind: "active" } as const;

const discovered = {
  endpoints: {
    authorization: "https://idp.example.com/authorize",
    jwks: "https://idp.example.com/keys",
    token: "https://idp.example.com/token",
  },
  signingAlgorithms: ["RS256"],
  tokenEndpointAuthMethod: "client_secret_basic",
} as const;

let sequence = 0;

async function setup() {
  const fake = fakeDynamoDocumentClient();
  const tables = tableNamesFromEnvironment({});
  fake.put(tables.control, humanPrincipalRecord(OWNER, "owner@acme.example"));
  fake.put(tables.control, humanPrincipalRecord(RIVAL, "owner@rival.example"));
  const database = makeDynamoDatabase(fake.client, tables);
  const tenancy = makeTenancyPersistence({ database });
  const organization = async (
    principalId: Ulid,
    name: string,
  ): Promise<FederationAdministrator> => {
    const created = await tenancy.organizations.create({
      body: { name },
      identity: { principalId, scopes: ["platform:*"] },
      idempotencyKey: `organization-${++sequence}`,
      query: {},
      scope: {},
    });
    return { organizationId: ulid(created.id), principalId };
  };
  return {
    acme: await organization(OWNER, "Acme"),
    administration: makeIdentityFederationAdministration({ database, now: () => NOW }),
    database,
    fake,
    rival: await organization(RIVAL, "Rival"),
    tables,
  };
}

async function failure(work: Promise<unknown>) {
  try {
    await work;
  } catch (cause) {
    if (cause instanceof PersistenceError) return { code: cause.code, kind: cause.kind };
    throw cause;
  }
  throw new Error("Expected a persistence failure.");
}

function settings(
  overrides: Partial<OidcIdentityProviderSettings> = {},
): OidcIdentityProviderSettings {
  return {
    clientId: "client-1",
    discovered,
    displayName: "Acme Okta",
    issuer: ISSUER,
    jit: { kind: "enabled", role: "member" },
    protocol: "oidc",
    ...overrides,
  };
}

const SAML_ENTITY_ID = "http://www.okta.com/exk1";
const certificate = (fingerprint: string) => ({
  certificate: "MIIB",
  notAfter: "2027-10-08T12:00:00.000Z",
  sha256Fingerprint: fingerprint,
});

function samlSettings(
  overrides: Partial<SamlIdentityProviderSettings> = {},
): SamlIdentityProviderSettings {
  return {
    displayName: "Acme SAML",
    jit: { kind: "enabled", role: "member" },
    metadata: {
      entityId: SAML_ENTITY_ID,
      signingCertificates: [certificate("AA:01")],
      singleSignOnRedirectUrl: "https://acme.okta.com/app/exk1/sso/saml",
    },
    protocol: "saml",
    unsolicitedSignIn: "disabled",
    ...overrides,
  };
}

function sealedAs(secret: string): NonNullable<OidcIdentityProviderSettings["sealClientSecret"]> {
  return async ({ connectionId, organizationId }) => ({
    algorithm: "AES-256-GCM",
    authenticationTag: "tag",
    ciphertext: `${secret}|${organizationId}|${connectionId}`,
    encryptedDataKey: "data-key",
    encryptionContextHash: "context-hash",
    iv: "iv",
    schemaVersion: 1,
  });
}

function clientSecretOf({ data }: OrganizationIdentityProviderRecord) {
  if (data.protocol === "saml") throw new Error("expected an OIDC provider");
  return data.clientSecret;
}

function ownerGrant(organizationId: Ulid, connectionId: Ulid, authenticatedAt: string) {
  return federatedGrantRecord({
    authentication: {
      authenticatedAt,
      connectionId,
      issuer: ISSUER,
      method: "federated",
      organizationId,
      subject: "okta|owner",
    },
    createdAt: authenticatedAt,
    principalId: OWNER,
    tokenSessionExpiresAt: "2026-10-09T00:00:00.000Z",
    tokenSessionId: SESSION,
  });
}

describe("login domain administration", () => {
  test("adds a lowercased pending domain and lists it newest first", async () => {
    const { acme, administration } = await setup();
    const first = await administration.addLoginDomain(acme, "  Acme.Example ");
    await administration.addLoginDomain(acme, "eu.acme.example");
    expect(first.data).toMatchObject({
      domain: "acme.example",
      organizationId: acme.organizationId,
      state: { kind: "pending" },
      version: 1,
    });
    expect(first.data.verificationToken).toMatch(/^[0-9a-f]{32}$/u);
    const page = await administration.listLoginDomains(acme.organizationId, {});
    expect(page.items.map((domain) => String(domain.data.domain))).toEqual([
      "eu.acme.example",
      "acme.example",
    ]);
    expect(page.nextCursor).toBeNull();
    expect(await failure(administration.addLoginDomain(acme, "ACME.example"))).toEqual({
      code: "login_domain_exists",
      kind: "conflict",
    });
    expect(await failure(administration.addLoginDomain(acme, "localhost"))).toEqual({
      code: "invalid_login_domain",
      kind: "unprocessable",
    });
  });

  test("verifies only when the TXT value is published, and once per domain across organizations", async () => {
    const { acme, administration, rival } = await setup();
    const domain = await administration.addLoginDomain(acme, "acme.example");
    const observed: string[] = [];
    const publishing = (values: readonly string[]) => async (name: string) => {
      observed.push(name);
      return values;
    };
    expect(
      await failure(
        administration.verifyLoginDomain(acme, domain.data.id, publishing(["v=spf1 -all"])),
      ),
    ).toEqual({ code: "txt_not_found", kind: "unprocessable" });
    const verified = await administration.verifyLoginDomain(
      acme,
      domain.data.id,
      publishing(["v=spf1 -all", `deployments-login=${domain.data.verificationToken}`]),
    );
    expect(verified.data.state).toEqual({ kind: "verified", verifiedAt: NOW.toISOString() });
    expect(verified.data.version).toBe(2);
    expect(observed).toEqual([
      "_deployments-login.acme.example",
      "_deployments-login.acme.example",
    ]);
    const again = await administration.verifyLoginDomain(acme, domain.data.id, publishing([]));
    expect(again.data.version).toBe(2);
    expect(observed).toHaveLength(2);

    const contested = await administration.addLoginDomain(rival, "acme.example");
    const rivalProof = publishing([`deployments-login=${contested.data.verificationToken}`]);
    expect(
      await failure(administration.verifyLoginDomain(rival, contested.data.id, rivalProof)),
    ).toEqual({ code: "domain_claimed", kind: "conflict" });

    const removed = await administration.removeLoginDomain(acme, domain.data.id);
    expect(removed.data.state.kind).toBe("verified");
    expect((await administration.listLoginDomains(acme.organizationId, {})).items).toEqual([]);
    const claimed = await administration.verifyLoginDomain(rival, contested.data.id, rivalProof);
    expect(claimed.data.state.kind).toBe("verified");
    expect(await failure(administration.removeLoginDomain(acme, domain.data.id))).toEqual({
      code: "login_domain_not_found",
      kind: "not-found",
    });
  });

  test("concurrent verifications from two organizations admit exactly one", async () => {
    const { acme, administration, rival } = await setup();
    const outcomes = await Promise.all(
      [acme, rival].map(async (administrator) => {
        const domain = await administration.addLoginDomain(administrator, "shared.example");
        const proof = [`deployments-login=${domain.data.verificationToken}`];
        return administration
          .verifyLoginDomain(administrator, domain.data.id, async () => proof)
          .then(
            (verified) => verified.data.state.kind,
            (cause: unknown) => (cause instanceof PersistenceError ? cause.code : String(cause)),
          );
      }),
    );
    expect(outcomes.toSorted()).toEqual(["domain_claimed", "verified"]);
  });
});

describe("identity provider administration", () => {
  test("a new connection needs a secret sealed for its own connection id", async () => {
    const { acme, administration } = await setup();
    expect(await failure(administration.putIdentityProvider(acme, settings()))).toEqual({
      code: "client_secret_required",
      kind: "unprocessable",
    });
    const created = await administration.putIdentityProvider(
      acme,
      settings({ sealClientSecret: sealedAs("first") }),
    );
    expect(created.data).toMatchObject({
      clientId: "client-1",
      clientSecretSetAt: NOW.toISOString(),
      issuer: ISSUER,
      state: { enforcement: "optional", kind: "active" },
      version: 1,
    });
    expect(clientSecretOf(created).ciphertext).toBe(
      `first|${acme.organizationId}|${created.data.connectionId}`,
    );

    const renamed = await administration.putIdentityProvider(
      acme,
      settings({ displayName: "Acme SSO" }),
    );
    expect(renamed.data.connectionId).toBe(created.data.connectionId);
    expect(clientSecretOf(renamed)).toEqual(clientSecretOf(created));
    const rotated = await administration.putIdentityProvider(
      acme,
      settings({ sealClientSecret: sealedAs("second") }),
    );
    expect(rotated.data.connectionId).toBe(created.data.connectionId);
    expect(clientSecretOf(rotated).ciphertext).toBe(
      `second|${acme.organizationId}|${created.data.connectionId}`,
    );

    expect(
      await failure(
        administration.putIdentityProvider(acme, settings({ issuer: "https://login.example.org" })),
      ),
    ).toEqual({ code: "client_secret_required", kind: "unprocessable" });
    const moved = await administration.putIdentityProvider(
      acme,
      settings({ clientId: "client-2", sealClientSecret: sealedAs("third") }),
    );
    expect(moved.data.connectionId).not.toBe(created.data.connectionId);
    expect(clientSecretOf(moved).ciphertext).toBe(
      `third|${acme.organizationId}|${moved.data.connectionId}`,
    );
    expect(moved.data.version).toBe(4);
  });

  test("a deleted provider can be configured again", async () => {
    const { acme, administration } = await setup();
    await administration.putIdentityProvider(acme, settings({ sealClientSecret: sealedAs("a") }));
    const deleted = await administration.deleteIdentityProvider(acme);
    expect(deleted.data.version).toBe(1);
    expect(await failure(administration.getIdentityProvider(acme.organizationId))).toEqual({
      code: "identity_provider_not_found",
      kind: "not-found",
    });
    const recreated = await administration.putIdentityProvider(
      acme,
      settings({ sealClientSecret: sealedAs("b") }),
    );
    expect(recreated.data.version).toBe(3);
    expect((await administration.getIdentityProvider(acme.organizationId)).data.version).toBe(3);
  });

  test("requiring SSO needs the caller's unexpired grant through the current connection", async () => {
    const { acme, administration, fake, tables } = await setup();
    const provider = await administration.putIdentityProvider(
      acme,
      settings({ sealClientSecret: sealedAs("s") }),
    );
    const caller = { ...acme, tokenSessionId: SESSION };
    expect(await failure(administration.setIdentityProviderState(caller, REQUIRED))).toEqual({
      code: "enforcement_requires_federated_session",
      kind: "conflict",
    });
    fake.put(
      tables.control,
      ownerGrant(acme.organizationId, provider.data.connectionId, "2026-10-07T12:00:00.000Z"),
    );
    expect(await failure(administration.setIdentityProviderState(caller, REQUIRED))).toEqual({
      code: "enforcement_requires_federated_session",
      kind: "conflict",
    });
    fake.put(
      tables.control,
      ownerGrant(acme.organizationId, provider.data.connectionId, "2026-10-08T11:00:00.000Z"),
    );
    expect(await failure(administration.setIdentityProviderState(acme, REQUIRED))).toEqual({
      code: "enforcement_requires_federated_session",
      kind: "conflict",
    });
    const enforced = await administration.setIdentityProviderState(caller, REQUIRED);
    expect(enforced.data.state).toEqual(REQUIRED);

    const disabled = await administration.setIdentityProviderState(acme, { kind: "disabled" });
    expect(disabled.data.state).toEqual({ disabledAt: NOW.toISOString(), kind: "disabled" });
    const reactivated = await administration.setIdentityProviderState(acme, {
      enforcement: "optional",
      kind: "active",
    });
    expect(reactivated.data.state).toEqual({ enforcement: "optional", kind: "active" });
  });

  test("a new connection drops enforcement until an owner proves it again", async () => {
    const { acme, administration, fake, tables } = await setup();
    const provider = await administration.putIdentityProvider(
      acme,
      settings({ sealClientSecret: sealedAs("s") }),
    );
    fake.put(
      tables.control,
      ownerGrant(acme.organizationId, provider.data.connectionId, "2026-10-08T11:00:00.000Z"),
    );
    const caller = { ...acme, tokenSessionId: SESSION };
    await administration.setIdentityProviderState(caller, REQUIRED);
    const moved = await administration.putIdentityProvider(
      acme,
      settings({ issuer: "https://login.example.org", sealClientSecret: sealedAs("t") }),
    );
    expect(moved.data.state).toEqual({ enforcement: "optional", kind: "active" });
    expect(await failure(administration.setIdentityProviderState(caller, REQUIRED))).toEqual({
      code: "enforcement_requires_federated_session",
      kind: "conflict",
    });
  });
});

describe("SAML identity provider administration", () => {
  async function requiredSamlProvider() {
    const fixture = await setup();
    const provider = await fixture.administration.putIdentityProvider(fixture.acme, samlSettings());
    fixture.fake.put(
      fixture.tables.control,
      ownerGrant(fixture.acme.organizationId, provider.data.connectionId, NOW.toISOString()),
    );
    await fixture.administration.setIdentityProviderState(
      { ...fixture.acme, tokenSessionId: SESSION },
      REQUIRED,
    );
    return { ...fixture, provider };
  }

  test("a SAML connection survives only edits that keep its entity ID and certificate proof", async () => {
    const { acme, administration } = await requiredSamlProvider();
    const METADATA_URL = "https://acme.okta.com/app/exk1/sso/saml/metadata";
    const edit = (
      fingerprints: readonly [string, ...string[]],
      source: { readonly entityId?: string; readonly metadataUrl?: string } = {},
    ) =>
      samlSettings({
        displayName: "Acme SSO",
        emailAttribute: "mail",
        metadata: {
          entityId: source.entityId ?? SAML_ENTITY_ID,
          signingCertificates: [
            certificate(fingerprints[0]),
            ...fingerprints.slice(1).map(certificate),
          ],
          singleSignOnRedirectUrl: "https://acme.okta.com/app/exk1/sso/saml2",
        },
        ...(source.metadataUrl === undefined ? {} : { metadataUrl: source.metadataUrl }),
        unsolicitedSignIn: "enabled",
      });
    const outcomes: string[] = [];
    let connectionId = (await administration.getIdentityProvider(acme.organizationId)).data
      .connectionId;
    for (const settings of [
      edit(["AA:01"]),
      edit(["AA:01"], { metadataUrl: METADATA_URL }),
      edit(["BB:02", "AA:01"], { metadataUrl: METADATA_URL }),
      edit(["AA:01", "BB:02"]),
      edit(["BB:02"], { metadataUrl: `${METADATA_URL}?v=2` }),
      edit(["CC:03"]),
      edit(["CC:03"], { entityId: "urn:acme:idp" }),
    ]) {
      const saved = await administration.putIdentityProvider(acme, settings);
      outcomes.push(
        `${saved.data.connectionId === connectionId ? "kept" : "rotated"} ${JSON.stringify(saved.data.state)}`,
      );
      connectionId = saved.data.connectionId;
    }
    const required = JSON.stringify(REQUIRED);
    const optional = JSON.stringify({ enforcement: "optional", kind: "active" });
    expect(outcomes).toEqual([
      `kept ${required}`,
      `kept ${required}`,
      `kept ${required}`,
      `kept ${required}`,
      `rotated ${optional}`,
      `rotated ${optional}`,
      `rotated ${optional}`,
    ]);
  });

  test("the audit event records what a SAML connection trusts", async () => {
    const { acme, administration, fake } = await setup();
    await administration.putIdentityProvider(
      acme,
      samlSettings({
        metadata: {
          entityId: SAML_ENTITY_ID,
          signingCertificates: [certificate("AA:01"), certificate("BB:02")],
          singleSignOnRedirectUrl: "https://acme.okta.com/app/exk1/sso/saml",
        },
        metadataUrl: "https://acme.okta.com/app/exk1/sso/saml/metadata",
      }),
    );
    const saved = await administration.putIdentityProvider(acme, samlSettings());
    const payloads = storedRecords(fake, "events", "semantic-event")
      .filter(({ data }) => data.eventType.startsWith("organization-identity-provider."))
      .map(({ data: { eventType, payload } }) => ({ eventType, payload }));
    expect(payloads).toEqual([
      {
        eventType: "organization-identity-provider.created",
        payload: {
          connectionId: expect.any(String),
          enforcement: "optional",
          issuer: SAML_ENTITY_ID,
          metadataSource: { kind: "url", url: "https://acme.okta.com/app/exk1/sso/saml/metadata" },
          protocol: "saml",
          signingCertificateFingerprints: ["AA:01", "BB:02"],
          singleSignOnUrl: "https://acme.okta.com/app/exk1/sso/saml",
          state: "active",
          unsolicitedSignIn: "disabled",
        },
      },
      {
        eventType: "organization-identity-provider.updated",
        payload: {
          connectionId: saved.data.connectionId,
          enforcement: "optional",
          issuer: SAML_ENTITY_ID,
          metadataSource: { kind: "document" },
          protocol: "saml",
          signingCertificateFingerprints: ["AA:01"],
          singleSignOnUrl: "https://acme.okta.com/app/exk1/sso/saml",
          state: "active",
          unsolicitedSignIn: "disabled",
        },
      },
    ]);
  });

  test("switching OIDC to SAML replaces the row and rotates the connection", async () => {
    const { acme, administration, fake, tables } = await setup();
    const oidc = await administration.putIdentityProvider(
      acme,
      settings({ sealClientSecret: sealedAs("s") }),
    );
    fake.put(
      tables.control,
      ownerGrant(acme.organizationId, oidc.data.connectionId, NOW.toISOString()),
    );
    await administration.setIdentityProviderState({ ...acme, tokenSessionId: SESSION }, REQUIRED);
    const saml = await administration.putIdentityProvider(acme, samlSettings());
    expect(saml.data).toEqual({
      connectionId: saml.data.connectionId,
      createdAt: oidc.data.createdAt,
      displayName: "Acme SAML",
      id: "oidc",
      issuer: SAML_ENTITY_ID,
      jit: { kind: "enabled", role: "member" },
      organizationId: acme.organizationId,
      protocol: "saml",
      signingCertificates: [certificate("AA:01")],
      singleSignOnUrl: "https://acme.okta.com/app/exk1/sso/saml",
      state: { enforcement: "optional", kind: "active" },
      unsolicitedSignIn: "disabled",
      updatedAt: NOW.toISOString(),
      version: 3,
    });
    expect(saml.data.connectionId).not.toBe(oidc.data.connectionId);
  });

  test("switching SAML to OIDC needs a client secret and drops every SAML field", async () => {
    const { acme, administration } = await setup();
    const saml = await administration.putIdentityProvider(acme, samlSettings());
    expect(await failure(administration.putIdentityProvider(acme, settings()))).toEqual({
      code: "client_secret_required",
      kind: "unprocessable",
    });
    const oidc = await administration.putIdentityProvider(
      acme,
      settings({ sealClientSecret: sealedAs("s") }),
    );
    expect(oidc.data.connectionId).not.toBe(saml.data.connectionId);
    expect(Object.keys(oidc.data).sort()).toEqual([
      "clientId",
      "clientSecret",
      "clientSecretSetAt",
      "connectionId",
      "createdAt",
      "displayName",
      "endpoints",
      "id",
      "issuer",
      "jit",
      "organizationId",
      "signingAlgorithms",
      "state",
      "tokenEndpointAuthMethod",
      "updatedAt",
      "version",
    ]);
  });

  test("concurrent first OIDC and SAML configurations leave one provider", async () => {
    const { acme, administration } = await setup();
    const outcomes = await Promise.all([
      administration.putIdentityProvider(acme, settings({ sealClientSecret: sealedAs("s") })).then(
        (record) => record.data.protocol ?? "oidc",
        (cause: unknown) => failure(Promise.reject(cause)),
      ),
      administration.putIdentityProvider(acme, samlSettings()).then(
        (record) => record.data.protocol ?? "oidc",
        (cause: unknown) => failure(Promise.reject(cause)),
      ),
    ]);
    const stored = await administration.getIdentityProvider(acme.organizationId);
    expect(outcomes).toContainEqual({ code: "identity_provider_conflict", kind: "conflict" });
    expect(outcomes).toContainEqual(stored.data.protocol ?? "oidc");
  });
});

describe("federated link administration", () => {
  test("deletes a link with its claims and ends the linked principal's sessions", async () => {
    const { acme, administration, database, fake, tables } = await setup();
    const link = (id: string, principalId: Ulid, subject: string, at: string) =>
      federationRecord("principal-identity", {
        createdAt: at,
        id: ulid(id),
        issuer: ISSUER,
        organizationId: acme.organizationId,
        principalId,
        subject,
        updatedAt: at,
        version: 1,
      });
    const older = link(
      "01ARZ3NDEKTSV4RRFFQ69G5FC0",
      OWNER,
      "okta|owner",
      "2026-10-01T00:00:00.000Z",
    );
    const newer = link(
      "01ARZ3NDEKTSV4RRFFQ69G5FC1",
      LINKED,
      "okta|linked",
      "2026-10-02T00:00:00.000Z",
    );
    await database.transactWrite(createWithClaims(older, older.data.createdAt));
    await database.transactWrite(createWithClaims(newer, newer.data.createdAt));
    await database.transactWrite(
      existingPrincipal("linked@acme.example", LINKED).flatMap((record) =>
        createWithClaims(record, record.data.createdAt),
      ),
    );
    const subjectClaim = (subject: string) =>
      fake.get(tables.control, Keys.control.uniqueClaim(`principal-identity:${ISSUER}`, subject))
        ?.itemType;

    const firstPage = await administration.listLinks(acme.organizationId, { limit: 1 });
    expect(firstPage.items.map((item) => item.data.subject)).toEqual(["okta|linked"]);
    expect(typeof firstPage.nextCursor).toBe("string");
    const secondPage = await administration.listLinks(acme.organizationId, {
      cursor: String(firstPage.nextCursor),
      limit: 1,
    });
    expect(secondPage.items.map((item) => item.data.subject)).toEqual(["okta|owner"]);

    expect(subjectClaim("okta|linked")).toBe("unique-claim");
    const deleted = await administration.deleteLink(acme, newer.data.id);
    expect(deleted.data.subject).toBe("okta|linked");
    expect(subjectClaim("okta|linked")).toBeUndefined();
    expect(subjectClaim("okta|owner")).toBe("unique-claim");
    const reads = makeFederationReads(database);
    expect([
      (await reads.securityState(LINKED))?.data.sessionEpoch,
      (await reads.bffFence(LINKED))?.data.sessionEpoch,
    ]).toEqual([4, 4]);
    const remaining = await administration.listLinks(acme.organizationId, {});
    expect(remaining.items.map((item) => item.data.subject)).toEqual(["okta|owner"]);
    expect(await failure(administration.deleteLink(acme, newer.data.id))).toEqual({
      code: "link_not_found",
      kind: "not-found",
    });
  });

  test("an issuer subject links through one organization only", async () => {
    const { acme, database, rival } = await setup();
    const linkThrough = (organizationId: Ulid, id: string, subject: string) => {
      const link = federationRecord("principal-identity", {
        createdAt: NOW.toISOString(),
        id: ulid(id),
        issuer: ISSUER,
        organizationId,
        principalId: LINKED,
        subject,
        updatedAt: NOW.toISOString(),
        version: 1,
      });
      return database.transactWrite(createWithClaims(link, link.data.createdAt)).then(
        () => "linked",
        (cause: unknown) => {
          if (isDatabaseWriteConflict(cause)) return "conflict";
          throw cause;
        },
      );
    };
    expect([
      await linkThrough(acme.organizationId, "01ARZ3NDEKTSV4RRFFQ69G5FC0", "okta|shared"),
      await linkThrough(rival.organizationId, "01ARZ3NDEKTSV4RRFFQ69G5FC1", "okta|shared"),
      await linkThrough(rival.organizationId, "01ARZ3NDEKTSV4RRFFQ69G5FC2", "okta|other"),
    ]).toEqual(["linked", "conflict", "linked"]);
  });
});
