import { generateKeyPairSync } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { describeSigningCertificate, parseIdpMetadata } from "./metadata.ts";
import {
  entraMetadata,
  IDP_CERTIFICATE,
  oktaMetadata,
  ROLLOVER_CERTIFICATE,
} from "./testing/idp-metadata.ts";
import { certificate, idpKey } from "./testing/saml-identity-provider.ts";

const idpCertificate = {
  certificate: IDP_CERTIFICATE,
  notAfter: "2036-10-15T07:22:14.000Z",
  sha256Fingerprint:
    "3A:6F:9B:B2:85:59:D3:5F:0F:EE:87:A6:C8:02:99:B9:0A:50:5C:AF:8C:FE:59:26:B9:59:70:00:14:8C:62:21",
};
const rolloverCertificate = {
  certificate: ROLLOVER_CERTIFICATE,
  notAfter: "2036-10-15T07:23:05.000Z",
  sha256Fingerprint:
    "8D:54:90:69:A0:62:3F:D5:54:D5:8B:5C:1D:A1:A9:7B:9D:F6:D6:0E:AC:50:CE:B3:D6:F9:35:E0:74:A4:3E:CF",
};

const defectOf = (xml: string) => {
  const result = parseIdpMetadata(xml);
  return result.kind === "rejected" ? result.defect : "parsed";
};
const oktaWithCertificates = (...certificates: string[]) =>
  oktaMetadata.replace(
    /<md:KeyDescriptor[\s\S]*<\/md:KeyDescriptor>/u,
    certificates
      .map(
        (value) =>
          `<md:KeyDescriptor><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${value}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`,
      )
      .join(""),
  );

describe("parseIdpMetadata", () => {
  test("reads Okta metadata with a line-wrapped certificate", () => {
    expect(parseIdpMetadata(oktaMetadata)).toEqual({
      kind: "parsed",
      metadata: {
        entityId: "http://www.okta.com/exk1a2b3c4d5e6f7g8h9",
        signingCertificates: [idpCertificate],
        singleSignOnRedirectUrl:
          "https://acme.okta.com/app/acme_platform/exk1a2b3c4d5e6f7g8h9/sso/saml",
      },
    });
  });

  test("keeps Entra's rollover certificate and skips encryption, WS-Federation and metadata-signature certificates", () => {
    expect(parseIdpMetadata(entraMetadata)).toEqual({
      kind: "parsed",
      metadata: {
        entityId: "https://sts.windows.net/72f988bf-0000-0000-0000-2d7cd011db47/",
        signingCertificates: [idpCertificate, rolloverCertificate],
        singleSignOnRedirectUrl:
          "https://login.microsoftonline.com/72f988bf-0000-0000-0000-2d7cd011db47/saml2",
      },
    });
  });

  test("lists a repeated certificate once", () => {
    const result = parseIdpMetadata(oktaWithCertificates(IDP_CERTIFICATE, IDP_CERTIFICATE));
    expect(result.kind === "parsed" && result.metadata.signingCertificates).toEqual([
      idpCertificate,
    ]);
  });

  test("accepts an entityID of exactly 512 characters", () => {
    const entityId = `urn:${"a".repeat(508)}`;
    const result = parseIdpMetadata(
      oktaMetadata.replace("http://www.okta.com/exk1a2b3c4d5e6f7g8h9", entityId),
    );
    expect(result.kind === "parsed" && result.metadata.entityId).toBe(entityId);
  });

  const ecCertificate = certificate({
    commonName: "ec.example.test",
    issuerKey: idpKey.privateKey,
    subjectKey: generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey,
  });

  test.each([
    [
      "an EntitiesDescriptor aggregate",
      `<EntitiesDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata">${oktaMetadata.replace(/<\?xml[^>]*>/u, "")}</EntitiesDescriptor>`,
      "entities_descriptor_unsupported",
    ],
    ["an HTML sign-in page", "<html><body>Sign in</body>", "xml_malformed"],
    ["a well-formed XHTML page", "<html><body>Sign in</body></html>", "not_entity_descriptor"],
    [
      "Okta metadata behind a DOCTYPE",
      oktaMetadata.replace(
        /<\?xml[^>]*>/u,
        `<?xml version="1.0"?><!DOCTYPE md:EntityDescriptor [<!ENTITY x SYSTEM "file:///etc/passwd">]>`,
      ),
      "doctype_forbidden",
    ],
    [
      "an external entity (XXE)",
      `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>`,
      "doctype_forbidden",
    ],
    [
      "billion laughs",
      `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "lol"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]><r>&c;</r>`,
      "doctype_forbidden",
    ],
    [
      "an entityID over 512 characters",
      oktaMetadata.replace("http://www.okta.com/exk1a2b3c4d5e6f7g8h9", `urn:${"a".repeat(509)}`),
      "entity_id_invalid",
    ],
    [
      "a relative entityID",
      oktaMetadata.replace("http://www.okta.com/exk1a2b3c4d5e6f7g8h9", "exk1a2b3c4d5e6f7g8h9"),
      "entity_id_invalid",
    ],
    [
      "no SAML 2.0 IDPSSODescriptor",
      oktaMetadata.replace(
        'protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"',
        'protocolSupportEnumeration="urn:oasis:names:tc:SAML:1.1:protocol"',
      ),
      "idp_descriptor_count",
    ],
    [
      "no HTTP-Redirect SingleSignOnService",
      oktaMetadata.replace("bindings:HTTP-Redirect", "bindings:HTTP-Artifact"),
      "redirect_binding_missing",
    ],
    [
      "an http SingleSignOnService",
      oktaMetadata.replace('HTTP-Redirect" Location="https://', 'HTTP-Redirect" Location="http://'),
      "sso_url_not_https",
    ],
    [
      "only an encryption certificate",
      oktaMetadata.replace('use="signing"', 'use="encryption"'),
      "signing_certificate_missing",
    ],
    [
      "five signing certificates",
      oktaWithCertificates("AAAA", "AAAB", "AAAC", "AAAD", "AAAE"),
      "signing_certificate_count",
    ],
    [
      "a certificate that is not DER",
      oktaWithCertificates("bm90IGEgY2VydGlmaWNhdGU="),
      "signing_certificate_invalid",
    ],
    [
      "an EC certificate xml-crypto cannot verify",
      oktaWithCertificates(ecCertificate),
      "signing_certificate_unsupported",
    ],
  ] as const)("rejects %s", (_name, xml, defect) => {
    expect(defectOf(xml)).toBe(defect);
  });
});

describe("describeSigningCertificate", () => {
  test("describes a stored certificate by fingerprint and expiry", () => {
    expect(describeSigningCertificate(ROLLOVER_CERTIFICATE)).toEqual(rolloverCertificate);
  });

  test("returns undefined for a value that is not a certificate", () => {
    expect(describeSigningCertificate("not base64!")).toBeUndefined();
  });
});
