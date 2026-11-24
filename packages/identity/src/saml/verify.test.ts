import { describe, expect, test } from "bun:test";

import {
  ACS_URL,
  assertionXml,
  attackerKey,
  idpKey,
  IDP_ENTITY_ID,
  NOW,
  PERSISTENT_FORMAT,
  REQUEST_ID,
  type ResponseOptions,
  responseXml,
  rolloverKey,
  RSA_SHA1,
  RSA_SHA512,
  SHA1,
  SHA512,
  trust,
} from "./testing/saml-identity-provider.ts";
import { verifySamlResponse } from "./verify.ts";

const solicited: ResponseOptions = { inResponseTo: REQUEST_ID };
const verify = (xml: string) => verifySamlResponse(xml, trust, NOW);
const defectOf = (xml: string) => {
  const result = verify(xml);
  return result.kind === "rejected" ? result.defect : "verified";
};

const SIGNATURE = /<ds:Signature[\s\S]*?<\/ds:Signature>/u;
const ASSERTION = /<saml:Assertion[\s\S]*<\/saml:Assertion>/u;
const match = (xml: string, pattern: RegExp) => pattern.exec(xml)?.[0] ?? "";

describe("verifySamlResponse accepts", () => {
  test("a solicited response whose assertion is signed, read from the signed bytes", () => {
    expect<unknown>(verify(responseXml(solicited))).toEqual({
      assertion: {
        assertionId: "_assertion-0001",
        attributes: {
          email: ["alice@acme.test"],
          groups: ["eng", "admins"],
          name: ["Alice Example"],
        },
        authnInstant: "2026-10-18T07:59:58.000Z",
        inResponseTo: "_request-0001",
        issueInstant: "2026-10-18T07:59:59.000Z",
        issuer: "https://idp.example.test/metadata",
        nameId: "alice@acme.test",
        nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
        notOnOrAfter: "2026-10-18T08:05:00.000Z",
        sessionIndex: "_session-_assertion-0001",
      },
      kind: "verified",
    });
  });

  test("an unsolicited response with a persistent NameID, reporting no request", () => {
    const result = verify(
      responseXml({ nameId: "00u1abcdPERSIST", nameIdFormat: PERSISTENT_FORMAT }),
    );
    expect(result.kind === "verified" && result.assertion).toMatchObject({
      inResponseTo: null,
      nameId: "00u1abcdPERSIST",
      nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
    });
  });

  test("a response signed at both the response and the assertion", () => {
    expect(defectOf(responseXml({ ...solicited, sign: "both" }))).toBe("verified");
  });

  test("an assertion signed by the rollover certificate", () => {
    expect(defectOf(responseXml({ ...solicited, key: rolloverKey }))).toBe("verified");
  });

  test("an assertion whose KeyInfo names the second trusted certificate", () => {
    expect(defectOf(responseXml({ ...solicited, keyInfoCertificate: idpKey.certificate }))).toBe(
      "verified",
    );
  });

  test("an assertion signed by a trusted key whose KeyInfo names an untrusted certificate", () => {
    expect(
      defectOf(responseXml({ ...solicited, keyInfoCertificate: attackerKey.certificate })),
    ).toBe("verified");
  });

  test("rsa-sha512 with a sha512 digest", () => {
    const xml = responseXml({
      ...solicited,
      digestAlgorithm: SHA512,
      signatureAlgorithm: RSA_SHA512,
    });
    expect(defectOf(xml)).toBe("verified");
  });

  test("a NameID split by a comment as the whole text, not the prefix (CVE-2017-11428)", () => {
    const xml = responseXml({ ...solicited, nameId: "alice@acme.test.evil.test" }).replace(
      ">alice@acme.test.evil.test</saml:NameID>",
      ">alice@acme.test<!---->.evil.test</saml:NameID>",
    );
    const result = verify(xml);
    expect(result.kind === "verified" && result.assertion.nameId).toBe("alice@acme.test.evil.test");
  });

  test("a NotOnOrAfter 30 seconds ago, inside the 60 second skew", () => {
    expect(defectOf(responseXml({ ...solicited, notOnOrAfterOffsetMs: -30_000 }))).toBe("verified");
  });

  test("a stripped Response@InResponseTo, keeping the signed request reference", () => {
    const xml = responseXml(solicited).replace(` InResponseTo="${REQUEST_ID}"`, "");
    expect(xml).toContain(`InResponseTo="${REQUEST_ID}"/>`);
    const result = verify(xml);
    expect(result.kind === "verified" && result.assertion.inResponseTo).toBe("_request-0001");
  });

  test("repeated attributes merged and a __proto__ attribute name kept as data", () => {
    const xml = responseXml({
      attributes:
        `<saml:Attribute Name="__proto__"><saml:AttributeValue>x</saml:AttributeValue></saml:Attribute>` +
        `<saml:Attribute Name="mail"><saml:AttributeValue>a@acme.test</saml:AttributeValue></saml:Attribute>` +
        `<saml:Attribute Name="mail"><saml:AttributeValue>b@acme.test</saml:AttributeValue></saml:Attribute>`,
    });
    const result = verify(xml);
    const attributes = result.kind === "verified" ? result.assertion.attributes : {};
    expect(Object.entries(attributes)).toEqual([
      ["__proto__", ["x"]],
      ["mail", ["a@acme.test", "b@acme.test"]],
    ]);
    expect(Object.getPrototypeOf(attributes)).toBe(Object.prototype);
  });

  test("the same response twice, because replay protection belongs to the caller", () => {
    const xml = responseXml(solicited);
    expect(verify(xml)).toEqual(verify(xml));
    expect(defectOf(xml)).toBe("verified");
  });
});

describe("verifySamlResponse rejects signature attacks", () => {
  const signed = responseXml(solicited);
  const signedAssertion = match(signed, ASSERTION);
  const withoutAssertion = signed.replace(signedAssertion, "");
  const evilSameId = assertionXml({ ...solicited, nameId: "admin@acme.test" }, "_assertion-0001");
  const evilNewId = assertionXml({ ...solicited, nameId: "admin@acme.test" }, "_evil-0001");
  const afterIssuer = (xml: string, inserted: string) =>
    xml.replace("</saml:Issuer>", `</saml:Issuer>${inserted}`);
  const inResponse = (inserted: string) =>
    withoutAssertion.replace("</samlp:Response>", `${inserted}</samlp:Response>`);
  const signature = match(signedAssertion, SIGNATURE);

  test.each([
    ["response signed only", responseXml({ ...solicited, sign: "response" }), "signature_missing"],
    ["unsigned", responseXml({ ...solicited, sign: "none" }), "signature_missing"],
    [
      "NameID tampered after signing",
      signed.replace(">alice@acme.test</saml:NameID>", ">admin@acme.test</saml:NameID>"),
      "signature_untrusted",
    ],
    [
      "signed by a certificate outside the trust",
      responseXml({ ...solicited, key: attackerKey }),
      "signature_untrusted",
    ],
    [
      "signed by an attacker whose KeyInfo carries the attacker certificate",
      responseXml({ ...solicited, key: attackerKey, keyInfoCertificate: attackerKey.certificate }),
      "signature_untrusted",
    ],
    [
      "signed by an attacker whose KeyInfo carries a trusted certificate",
      responseXml({ ...solicited, key: attackerKey, keyInfoCertificate: idpKey.certificate }),
      "signature_untrusted",
    ],
    [
      "signed by the current key whose KeyInfo names the rollover certificate",
      responseXml({ ...solicited, keyInfoCertificate: rolloverKey.certificate }),
      "signature_untrusted",
    ],
    [
      "rsa-sha1",
      responseXml({ ...solicited, signatureAlgorithm: RSA_SHA1 }),
      "signature_algorithm_forbidden",
    ],
    [
      "rsa-sha256 over a sha1 digest",
      responseXml({ ...solicited, digestAlgorithm: SHA1 }),
      "signature_algorithm_forbidden",
    ],
    [
      "XSW: signed assertion in samlp:Extensions, evil same-ID assertion in place",
      afterIssuer(
        inResponse(evilSameId),
        `<samlp:Extensions>${signedAssertion}</samlp:Extensions>`,
      ),
      "assertion_count",
    ],
    [
      "XSW: signed assertion in samlp:Extensions, evil new-ID assertion in place",
      afterIssuer(inResponse(evilNewId), `<samlp:Extensions>${signedAssertion}</samlp:Extensions>`),
      "assertion_count",
    ],
    [
      "XSW8: evil assertion carries the signature, original inside ds:Object",
      inResponse(
        afterIssuer(
          evilNewId,
          signature.replace(
            "</ds:Signature>",
            `<ds:Object>${signedAssertion.replace(signature, "")}</ds:Object></ds:Signature>`,
          ),
        ),
      ),
      "assertion_count",
    ],
    [
      "XSW3: unsigned evil assertion before the signed one",
      inResponse(evilNewId + signedAssertion),
      "assertion_count",
    ],
    [
      "XSW: unsigned evil assertion after the signed one",
      inResponse(signedAssertion + evilNewId),
      "assertion_count",
    ],
    [
      "XSW4: evil assertion wraps the signed one",
      inResponse(evilNewId.replace("</saml:Assertion>", `${signedAssertion}</saml:Assertion>`)),
      "assertion_count",
    ],
  ] as const)("%s", (_name, xml, defect) => {
    expect(defectOf(xml)).toBe(defect);
  });

  test("XSW1: evil response carrying the response signature, original inside ds:Object", () => {
    const signedResponse = responseXml({ ...solicited, sign: "response" });
    const responseSignature = match(signedResponse, SIGNATURE);
    const evil = responseXml({ ...solicited, nameId: "admin@acme.test", sign: "none" });
    const wrapped = responseSignature.replace(
      "</ds:Signature>",
      `<ds:Object>${signedResponse.replace(responseSignature, "")}</ds:Object></ds:Signature>`,
    );
    expect(defectOf(afterIssuer(evil, wrapped))).toBe("assertion_count");
  });

  test("a signature inside the assertion whose reference is the response", () => {
    const signedResponse = responseXml({ ...solicited, sign: "response" });
    const responseSignature = match(signedResponse, SIGNATURE);
    const moved = signedResponse
      .replace(responseSignature, "")
      .replace(
        `${IDP_ENTITY_ID}</saml:Issuer><saml:Subject>`,
        `${IDP_ENTITY_ID}</saml:Issuer>${responseSignature}<saml:Subject>`,
      );
    expect(defectOf(moved)).toBe("signature_reference_mismatch");
  });
});

describe("verifySamlResponse rejects envelope and condition failures", () => {
  test.each([
    ["not XML", "<html><body>Sign in</body>", "xml_malformed"],
    [
      "a DOCTYPE with an internal entity",
      `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x "admin@acme.test">]>${responseXml(solicited)}`,
      "doctype_forbidden",
    ],
    ["a bare assertion", assertionXml(solicited, "_assertion-0001"), "not_a_response"],
    [
      "a non-success status",
      responseXml({ ...solicited, status: "urn:oasis:names:tc:SAML:2.0:status:Requester" }),
      "status_not_success",
    ],
    [
      "an encrypted assertion",
      responseXml({ ...solicited, sign: "none" }).replace(
        "</samlp:Status>",
        "</samlp:Status><saml:EncryptedAssertion/>",
      ),
      "encrypted_assertion_unsupported",
    ],
    [
      "a response without an assertion",
      responseXml(solicited).replace(match(responseXml(solicited), ASSERTION), ""),
      "assertion_count",
    ],
    [
      "a foreign Destination",
      responseXml({ ...solicited, destination: "https://evil.test/acs" }),
      "destination_mismatch",
    ],
    [
      "a foreign Issuer",
      responseXml({ ...solicited, issuer: "https://evil-idp.test" }),
      "issuer_mismatch",
    ],
    [
      "a foreign Audience",
      responseXml({ ...solicited, audience: "https://other-sp.test" }),
      "audience_mismatch",
    ],
    [
      "a foreign Recipient",
      responseXml({ ...solicited, recipient: "https://evil.test/acs" }),
      "recipient_mismatch",
    ],
    [
      "a NotOnOrAfter two minutes ago",
      responseXml({ ...solicited, notOnOrAfterOffsetMs: -120_000 }),
      "expired",
    ],
    [
      "a NotBefore five minutes ahead",
      responseXml({ ...solicited, notBeforeOffsetMs: 300_000 }),
      "not_yet_valid",
    ],
    [
      "an IssueInstant five minutes ahead",
      responseXml({ ...solicited, issueInstantOffsetMs: 300_000 }),
      "not_yet_valid",
    ],
    [
      "an IssueInstant without a zone",
      responseXml({ ...solicited, issueInstant: "2026-10-18T07:59:59" }),
      "instant_malformed",
    ],
    [
      "a Response@InResponseTo that differs from the signed one",
      responseXml({ ...solicited, responseInResponseTo: "_request-other" }),
      "in_response_to_mismatch",
    ],
    [
      "a Response@InResponseTo when the signed confirmation names no request",
      responseXml({ responseInResponseTo: REQUEST_ID }),
      "in_response_to_mismatch",
    ],
    [
      "a transient NameID",
      responseXml({
        ...solicited,
        nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
      }),
      "name_id_transient",
    ],
    ["an empty NameID", responseXml({ ...solicited, nameId: "" }), "subject_missing"],
  ] as const)("%s", (_name, xml, defect) => {
    expect(defectOf(xml)).toBe(defect);
  });

  test("an ACS URL compared exactly", () => {
    expect(
      verifySamlResponse(responseXml(solicited), { ...trust, acsUrl: `${ACS_URL}/` }, NOW),
    ).toEqual({ defect: "destination_mismatch", kind: "rejected" });
  });
});
