import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { ACCESS_PATTERN_REGISTRY } from "../access-patterns.ts";
import { decodePlatformRecord, withCanonicalRecordKeys } from "./index.ts";

const ORGANIZATION = "01ARZ3NDEKTSV4RRFFQ69G5FC0";
const AT = "2026-10-08T12:00:00.000Z";

const STORED_OIDC_PROVIDER = {
  data: {
    clientId: "0oa-client",
    clientSecret: {
      algorithm: "AES-256-GCM",
      authenticationTag: "tag",
      ciphertext: "ciphertext",
      encryptedDataKey: "key",
      encryptionContextHash: "hash",
      iv: "iv",
      schemaVersion: 1,
    },
    clientSecretSetAt: AT,
    connectionId: "01ARZ3NDEKTSV4RRFFQ69G5FC2",
    createdAt: AT,
    displayName: "Acme Okta",
    endpoints: {
      authorization: "https://acme.okta.com/oauth2/v1/authorize",
      jwks: "https://acme.okta.com/oauth2/v1/keys",
      token: "https://acme.okta.com/oauth2/v1/token",
    },
    id: "oidc",
    issuer: "https://acme.okta.com",
    jit: { kind: "enabled", role: "member" },
    organizationId: ORGANIZATION,
    signingAlgorithms: ["RS256"],
    state: { enforcement: "optional", kind: "active" },
    tokenEndpointAuthMethod: "client_secret_basic",
    updatedAt: AT,
    version: 1,
  },
  gsi1pk: `ORG#${ORGANIZATION}`,
  gsi1sk: "ORGANIZATION-IDENTITY-PROVIDER#all#2026-10-08T12%3A00%3A00.000Z#oidc",
  itemType: "organization-identity-provider",
  pk: `ORG#${ORGANIZATION}`,
  sk: "ORGANIZATION-IDENTITY-PROVIDER#oidc",
} as const;

const SAML_PROVIDER_DATA = {
  connectionId: "01ARZ3NDEKTSV4RRFFQ69G5FC3",
  createdAt: AT,
  displayName: "Acme Okta",
  id: "oidc",
  issuer: "http://www.okta.com/exk1",
  jit: { kind: "disabled" },
  organizationId: ORGANIZATION,
  protocol: "saml",
  signingCertificates: [
    { certificate: "MIIB", notAfter: "2027-10-08T12:00:00.000Z", sha256Fingerprint: "AB:CD" },
  ],
  singleSignOnUrl: "https://acme.okta.com/app/exk1/sso/saml",
  state: { enforcement: "optional", kind: "active" },
  unsolicitedSignIn: "disabled",
  updatedAt: AT,
  version: 1,
} as const;

const decode = (input: unknown): Promise<unknown> => Effect.runPromise(decodePlatformRecord(input));
const rejects = async (input: unknown) =>
  Exit.isFailure(await Effect.runPromiseExit(decodePlatformRecord(input)));

describe("organization identity provider record", () => {
  test("a stored OIDC row decodes unchanged at its original keys", async () => {
    expect(await decode(STORED_OIDC_PROVIDER)).toEqual(STORED_OIDC_PROVIDER);
  });

  test("a SAML row keys to the same provider slot", async () => {
    const record = withCanonicalRecordKeys({
      data: SAML_PROVIDER_DATA,
      itemType: "organization-identity-provider",
    });
    expect([record.pk, record.sk]).toEqual([
      `ORG#${ORGANIZATION}`,
      "ORGANIZATION-IDENTITY-PROVIDER#oidc",
    ]);
    expect(await decode(record)).toEqual(record);
  });

  test("a row mixing OIDC and SAML fields is rejected", async () => {
    const samlWithClient = {
      ...STORED_OIDC_PROVIDER,
      data: { ...SAML_PROVIDER_DATA, clientId: "0oa-client" },
    };
    const oidcWithSingleSignOn = {
      ...STORED_OIDC_PROVIDER,
      data: { ...STORED_OIDC_PROVIDER.data, singleSignOnUrl: "https://acme.okta.com/sso" },
    };
    expect(await rejects(samlWithClient)).toBe(true);
    expect(await rejects(oidcWithSingleSignOn)).toBe(true);
  });

  test("a SAML entity ID longer than 512 characters is rejected", async () => {
    const record = withCanonicalRecordKeys({
      data: { ...SAML_PROVIDER_DATA, issuer: `urn:${"a".repeat(509)}` },
      itemType: "organization-identity-provider",
    });
    expect(await rejects(record)).toBe(true);
  });

  test("stays listed among an organization's resources", () => {
    expect(
      ACCESS_PATTERN_REGISTRY.find((pattern) => pattern.name === "control.organization-resources")
        ?.recordTypes,
    ).toContain("organization-identity-provider");
  });
});

describe("federation issuers", () => {
  test("SAML entity IDs persist on grants and link requests", async () => {
    const grant = withCanonicalRecordKeys({
      data: {
        authenticatedAt: AT,
        connectionId: "01ARZ3NDEKTSV4RRFFQ69G5FC3",
        createdAt: AT,
        expiresAt: "2026-10-08T13:00:00.000Z",
        id: "01ARZ3NDEKTSV4RRFFQ69G5FC4",
        issuer: "http://www.okta.com/x",
        organizationId: ORGANIZATION,
        principalId: "01ARZ3NDEKTSV4RRFFQ69G5FC5",
        subject: "alice@acme.com",
      },
      itemType: "organization-federated-grant",
      ttl: Math.floor(Date.parse("2026-10-08T13:00:00.000Z") / 1_000),
    });
    const request = withCanonicalRecordKeys({
      data: {
        bindingHash: "binding",
        connectionId: "01ARZ3NDEKTSV4RRFFQ69G5FC3",
        createdAt: AT,
        expiresAt: "2026-10-08T12:30:00.000Z",
        id: "01ARZ3NDEKTSV4RRFFQ69G5FC6",
        issuer: "urn:a:b",
        organizationId: ORGANIZATION,
        principalId: "01ARZ3NDEKTSV4RRFFQ69G5FC5",
        status: "pending",
        subject: "alice@acme.com",
        tokenHash: "token-hash",
        updatedAt: AT,
        version: 1,
      },
      itemType: "identity-federation-link-request",
      ttl: Math.floor(Date.parse("2026-10-08T12:30:00.000Z") / 1_000),
    });
    expect(await decode(grant)).toEqual(grant);
    expect(await decode(request)).toEqual(request);
  });
});
