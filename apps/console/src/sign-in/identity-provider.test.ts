import { describe, expect, test } from "bun:test";
import { IdentityProviderResponse, IdentityProviderState } from "@deployments-ai/api-contract";
import { Schema } from "effect";
import {
  protocolSwitchWarning,
  providerForm,
  providerMoves,
  providerRequest,
} from "./identity-provider.ts";

const AT = "2026-10-09T12:00:00.000Z";
const ORGANIZATION = "01K000000000000000000000G1";
const decodeProvider = Schema.decodeUnknownSync(IdentityProviderResponse);

const common = {
  connectionId: "01K000000000000000000000C1",
  createdAt: AT,
  displayName: "Example SSO",
  jit: { kind: "enabled", role: "viewer" },
  organizationId: ORGANIZATION,
  state: { enforcement: "optional", kind: "active" },
  updatedAt: AT,
};

const oidc = decodeProvider({
  ...common,
  clientId: "console-client",
  clientSecretSetAt: AT,
  endpoints: {
    authorization: "https://login.example.com/authorize",
    jwks: "https://login.example.com/jwks",
    token: "https://login.example.com/token",
  },
  issuer: "https://login.example.com",
  protocol: "oidc",
  redirectUri: "https://auth.example.test/federation/callback",
  signingAlgorithms: ["RS256"],
  tokenEndpointAuthMethod: "client_secret_basic",
});

const samlByUrl = decodeProvider({
  ...common,
  emailAttribute: "mail",
  issuer: "http://www.okta.com/exk1",
  metadataUrl: "https://example.okta.com/app/exk1/sso/saml/metadata",
  protocol: "saml",
  serviceProvider: {
    acsUrl: `https://auth.example.test/saml/${ORGANIZATION}/acs`,
    entityId: `https://auth.example.test/saml/${ORGANIZATION}`,
    metadataUrl: `https://auth.example.test/saml/${ORGANIZATION}/metadata`,
  },
  signingCertificates: [{ notAfter: "2036-01-01T00:00:00.000Z", sha256Fingerprint: "AB:CD" }],
  singleSignOnUrl: "https://example.okta.com/app/exk1/sso/saml",
  state: { enforcement: "required", kind: "active" },
  unsolicitedSignIn: "enabled",
});

const samlByDocument = decodeProvider({
  ...common,
  issuer: "https://sts.windows.net/tenant/",
  protocol: "saml",
  serviceProvider: {
    acsUrl: `https://auth.example.test/saml/${ORGANIZATION}/acs`,
    entityId: `https://auth.example.test/saml/${ORGANIZATION}`,
    metadataUrl: `https://auth.example.test/saml/${ORGANIZATION}/metadata`,
  },
  signingCertificates: [{ notAfter: "2036-01-01T00:00:00.000Z", sha256Fingerprint: "EF:01" }],
  singleSignOnUrl: "https://login.microsoftonline.com/tenant/saml2",
  unsolicitedSignIn: "disabled",
});

const blank = providerForm(null);

describe("providerRequest for OpenID Connect", () => {
  test("a new provider needs every field, the secret included", () => {
    const form = {
      ...blank,
      clientId: " console-client ",
      displayName: "Example SSO",
      issuer: "https://login.example.com",
    };
    expect(providerRequest(form, null)).toEqual({
      kind: "incomplete",
      reason: "Enter the client secret.",
    });
    expect(providerRequest({ ...form, newClientSecret: "s3cret" }, null)).toEqual({
      body: {
        clientId: "console-client",
        clientSecret: "s3cret",
        displayName: "Example SSO",
        issuer: "https://login.example.com",
        jit: { kind: "disabled" },
      },
      kind: "ready",
    });
  });

  test("an edit keeps the stored secret unless the connection changes", () => {
    const form = providerForm(oidc);
    expect(providerRequest(form, oidc)).toEqual({ kind: "incomplete", reason: "Nothing changed." });
    expect(providerRequest({ ...form, displayName: "Example", jit: "member" }, oidc)).toEqual({
      body: {
        clientId: "console-client",
        displayName: "Example",
        issuer: "https://login.example.com",
        jit: { kind: "enabled", role: "member" },
      },
      kind: "ready",
    });
    expect(providerRequest({ ...form, issuer: "https://sso.example.com" }, oidc)).toEqual({
      kind: "incomplete",
      reason: "Changing the issuer or client ID needs the new client secret.",
    });
  });

  test("switching a SAML provider to OpenID Connect needs the client secret", () => {
    const form = {
      ...providerForm(samlByUrl),
      clientId: "console-client",
      issuer: "https://login.example.com",
      protocol: "oidc" as const,
    };
    expect(providerRequest(form, samlByUrl)).toEqual({
      kind: "incomplete",
      reason: "Switching to OpenID Connect needs the client secret.",
    });
  });
});

describe("providerRequest for SAML", () => {
  test("a metadata URL is trimmed and the optional email attribute is left out when blank", () => {
    const form = {
      ...blank,
      displayName: " Okta ",
      metadataUrl: " https://example.okta.com/app/exk1/sso/saml/metadata ",
      protocol: "saml" as const,
    };
    expect(providerRequest({ ...form, metadataUrl: "" }, null)).toEqual({
      kind: "incomplete",
      reason: "Enter the metadata URL and display name.",
    });
    expect(providerRequest(form, null)).toEqual({
      body: {
        displayName: "Okta",
        jit: { kind: "disabled" },
        metadata: { url: "https://example.okta.com/app/exk1/sso/saml/metadata" },
        protocol: "saml",
        unsolicitedSignIn: "disabled",
      },
      kind: "ready",
    });
  });

  test("pasted metadata is sent as written, with the email attribute and IdP-initiated sign-in", () => {
    const document = '<EntityDescriptor entityID="https://sts.windows.net/tenant/"/>\n';
    const form = {
      ...blank,
      displayName: "Entra",
      emailAttribute: " emailaddress ",
      jit: "member" as const,
      metadataSource: "document" as const,
      protocol: "saml" as const,
      unsolicitedSignIn: true,
    };
    expect(providerRequest(form, null)).toEqual({
      kind: "incomplete",
      reason: "Paste the metadata XML and enter the display name.",
    });
    expect(providerRequest({ ...form, metadataDocument: document }, null)).toEqual({
      body: {
        displayName: "Entra",
        emailAttribute: "emailaddress",
        jit: { kind: "enabled", role: "member" },
        metadata: { document },
        protocol: "saml",
        unsolicitedSignIn: "enabled",
      },
      kind: "ready",
    });
  });

  test("an unchanged save re-reads the metadata URL; a pasted provider needs its XML again", () => {
    expect(providerForm(samlByUrl)).toEqual({
      ...blank,
      displayName: "Example SSO",
      emailAttribute: "mail",
      jit: "viewer",
      metadataUrl: "https://example.okta.com/app/exk1/sso/saml/metadata",
      protocol: "saml",
      unsolicitedSignIn: true,
    });
    expect(providerRequest(providerForm(samlByUrl), samlByUrl)).toEqual({
      body: {
        displayName: "Example SSO",
        emailAttribute: "mail",
        jit: { kind: "enabled", role: "viewer" },
        metadata: { url: "https://example.okta.com/app/exk1/sso/saml/metadata" },
        protocol: "saml",
        unsolicitedSignIn: "enabled",
      },
      kind: "ready",
    });
    expect(providerRequest(providerForm(samlByDocument), samlByDocument)).toEqual({
      kind: "incomplete",
      reason: "Paste the metadata XML again. The platform keeps only what it read from it.",
    });
  });
});

describe("protocolSwitchWarning", () => {
  test("names the linked members who confirm by email and the enforcement reset", () => {
    expect(
      protocolSwitchWarning(samlByUrl, "oidc", { count: 3, kind: "counted", more: false }),
    ).toBe(
      "Switching protocols starts a new connection. Each of the 3 linked members confirms their email once on their next sign-in. Required sign-in goes back to optional until an owner requires it again.",
    );
    expect(protocolSwitchWarning(oidc, "saml", { count: 50, kind: "counted", more: true })).toBe(
      "Switching protocols starts a new connection. Each of the 50 or more linked members confirms their email once on their next sign-in.",
    );
    expect(protocolSwitchWarning(oidc, "saml", { count: 1, kind: "counted", more: false })).toBe(
      "Switching protocols starts a new connection. The linked member confirms their email once on their next sign-in.",
    );
    expect(protocolSwitchWarning(oidc, "saml", { kind: "unknown" })).toBe(
      "Switching protocols starts a new connection. Each linked member confirms their email once on their next sign-in.",
    );
  });

  test("says only that a new connection starts when nobody is linked, and nothing without a switch", () => {
    const none = { count: 0, kind: "counted", more: false } as const;
    expect(protocolSwitchWarning(oidc, "saml", none)).toBe(
      "Switching protocols starts a new connection.",
    );
    expect(protocolSwitchWarning(oidc, "oidc", none)).toBeNull();
    expect(protocolSwitchWarning(null, "saml", none)).toBeNull();
  });
});

test("only an owner sees the enforcement toggle; everyone with access may disable or enable", () => {
  const active = { enforcement: "optional", kind: "active" } as const;
  const required = { enforcement: "required", kind: "active" } as const;
  expect(providerMoves(active, true)).toEqual(["require", "disable"]);
  expect(providerMoves(active, false)).toEqual(["disable"]);
  expect(providerMoves(required, true)).toEqual(["make-optional", "disable"]);
  expect(providerMoves(required, false)).toEqual(["disable"]);
  expect(
    providerMoves(
      Schema.decodeUnknownSync(IdentityProviderState)({
        disabledAt: AT,
        kind: "disabled",
      }),
      true,
    ),
  ).toEqual(["enable"]);
});
