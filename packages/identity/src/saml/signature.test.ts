import { X509Certificate } from "node:crypto";

import { describe, expect, test } from "bun:test";
import { SignedXml } from "xml-crypto";

import { idpKey, REQUEST_ID, responseXml } from "./testing/saml-identity-provider.ts";
import { parseXml, XMLDSIG_NAMESPACE } from "./xml.ts";

// verifyAssertionSignature reads identity only from getSignedReferences(). xml-crypto does not
// document that it returns the canonical post-transform bytes, so an upgrade must fail here first.
describe("xml-crypto signed references", () => {
  test("are the exclusive canonical Assertion without its enveloped Signature", () => {
    const xml = responseXml({
      attributes: `<saml:Attribute Name="email"><saml:AttributeValue>alice@acme.test</saml:AttributeValue></saml:Attribute>`,
      inResponseTo: REQUEST_ID,
    });
    const parsed = parseXml(xml);
    if (parsed.kind === "rejected") throw new Error(`fixture rejected: ${parsed.defect}`);
    const signature = parsed.document
      .getElementsByTagNameNS(XMLDSIG_NAMESPACE, "Signature")
      .item(0);
    if (signature === null) throw new Error("fixture has no assertion signature");

    const verifier = new SignedXml({
      getCertFromKeyInfo: () => null,
      publicCert: new X509Certificate(Buffer.from(idpKey.certificate, "base64")).publicKey,
    });
    verifier.loadSignature(signature);

    expect(verifier.checkSignature(xml)).toBe(true);
    expect(verifier.getSignedReferences()).toEqual([
      `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_assertion-0001" IssueInstant="2026-10-18T07:59:59.000Z" Version="2.0">` +
        `<saml:Issuer>https://idp.example.test/metadata</saml:Issuer>` +
        `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">alice@acme.test</saml:NameID>` +
        `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="_request-0001" NotOnOrAfter="2026-10-18T08:05:00.000Z" Recipient="https://auth.platform.test/saml/01J8ORGANIZATION0000000000/acs"></saml:SubjectConfirmationData></saml:SubjectConfirmation></saml:Subject>` +
        `<saml:Conditions NotBefore="2026-10-18T07:59:00.000Z" NotOnOrAfter="2026-10-18T08:05:00.000Z"><saml:AudienceRestriction><saml:Audience>https://auth.platform.test/saml/01J8ORGANIZATION0000000000</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
        `<saml:AuthnStatement AuthnInstant="2026-10-18T07:59:58.000Z" SessionIndex="_session-_assertion-0001"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
        `<saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>alice@acme.test</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>` +
        `</saml:Assertion>`,
    ]);
  });
});
