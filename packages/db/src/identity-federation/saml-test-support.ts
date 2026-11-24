import {
  samlIdentityClaims,
  verifySamlResponse,
  type SamlIdentityClaims,
} from "@deployments-ai/identity/saml";
import {
  ASSERTION_ID,
  IDP_ENTITY_ID,
  NOW,
  PERSISTENT_FORMAT,
  idpKey,
  responseXml,
  trust,
  type SigningKey,
} from "@deployments-ai/identity/saml-testing";
import type { SamlIdentityProvider } from "../records/identity-federation.ts";
import { federationRecord } from "./record-builders.ts";
import { CONNECTION, ORGANIZATION, START } from "./test-support.ts";

export const SAML_ISSUER = IDP_ENTITY_ID;
export const SAML_ASSERTION_ID = ASSERTION_ID;
export const SAML_ISSUE_INSTANT = START;

const attribute = (name: string, value: string) =>
  `<saml:Attribute Name="${name}"><saml:AttributeValue>${value}</saml:AttributeValue></saml:Attribute>`;

/**
 * Claims minted the only way production mints them: from a response the verifier accepted. The
 * verifier trusts `key` alone, as an ACS would once `key` is the connection's certificate.
 */
export function samlClaims(input: {
  readonly email?: string;
  readonly issuer?: string;
  readonly key?: SigningKey;
  readonly subject?: string;
}): SamlIdentityClaims {
  const key = input.key ?? idpKey;
  const issuer = input.issuer ?? IDP_ENTITY_ID;
  const verified = verifySamlResponse(
    responseXml({
      attributes:
        (input.email === undefined ? "" : attribute("email", input.email)) +
        attribute("name", "Dana Example"),
      issuer,
      key,
      nameId: input.subject ?? "dana-subject",
      nameIdFormat: PERSISTENT_FORMAT,
    }),
    { ...trust, idpEntityId: issuer, signingCertificates: [key.certificate] },
    NOW,
  );
  if (verified.kind === "rejected") throw new Error(`fixture rejected: ${verified.defect}`);
  const result = samlIdentityClaims(verified.assertion);
  if (result.kind === "rejected") throw new Error(`fixture claims rejected: ${result.defect}`);
  return result.claims;
}

export function samlProviderRecord(overrides: Partial<SamlIdentityProvider> = {}) {
  return federationRecord("organization-identity-provider", {
    connectionId: CONNECTION,
    createdAt: START,
    displayName: "Acme SAML",
    id: "oidc",
    issuer: SAML_ISSUER,
    jit: { kind: "enabled", role: "member" },
    organizationId: ORGANIZATION,
    protocol: "saml",
    signingCertificates: [
      {
        certificate: idpKey.certificate,
        notAfter: "2036-01-01T00:00:00.000Z",
        sha256Fingerprint: "AA:BB",
      },
    ],
    singleSignOnUrl: "https://idp.example.test/sso",
    state: { enforcement: "optional", kind: "active" },
    unsolicitedSignIn: "enabled",
    updatedAt: START,
    version: 1,
    ...overrides,
  });
}
