import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";

import { SignedXml } from "xml-crypto";

import type { SamlTrust } from "../verify.ts";

export {
  entraMetadata,
  IDP_CERTIFICATE,
  oktaMetadata,
  ROLLOVER_CERTIFICATE,
} from "./idp-metadata.ts";

export const NOW = new Date("2026-10-18T08:00:00.000Z");
export const IDP_ENTITY_ID = "https://idp.example.test/metadata";
export const SP_ENTITY_ID = "https://auth.platform.test/saml/01J8ORGANIZATION0000000000";
export const ACS_URL = "https://auth.platform.test/saml/01J8ORGANIZATION0000000000/acs";
export const REQUEST_ID = "_request-0001";
export const ASSERTION_ID = "_assertion-0001";
export const EMAIL_FORMAT = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
export const PERSISTENT_FORMAT = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
export const RSA_SHA1 = "http://www.w3.org/2000/09/xmldsig#rsa-sha1";
export const RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
export const RSA_SHA512 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512";
export const SHA1 = "http://www.w3.org/2000/09/xmldsig#sha1";
export const SHA256 = "http://www.w3.org/2001/04/xmlenc#sha256";
export const SHA512 = "http://www.w3.org/2001/04/xmlenc#sha512";

export interface SigningKey {
  readonly privateKey: KeyObject;
  /** Base64 DER X.509, as metadata and `SamlTrust` carry it. */
  readonly certificate: string;
}

export function signingKey(commonName: string): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    certificate: certificate({ commonName, issuerKey: privateKey, subjectKey: publicKey }),
    privateKey,
  };
}

export const idpKey = signingKey("idp.example.test");
export const rolloverKey = signingKey("idp.example.test rollover");
export const attackerKey = signingKey("attacker.example.test");

export const trust: SamlTrust = {
  acsUrl: ACS_URL,
  idpEntityId: IDP_ENTITY_ID,
  signingCertificates: [rolloverKey.certificate, idpKey.certificate],
  spEntityId: SP_ENTITY_ID,
};

export interface ResponseOptions {
  readonly sign?: "assertion" | "response" | "both" | "none";
  readonly assertionId?: string;
  readonly nameId?: string;
  readonly nameIdFormat?: string;
  readonly inResponseTo?: string;
  readonly responseInResponseTo?: string;
  readonly audience?: string;
  readonly recipient?: string;
  readonly destination?: string;
  readonly issuer?: string;
  readonly status?: string;
  readonly issueInstant?: string;
  readonly issueInstantOffsetMs?: number;
  readonly notBeforeOffsetMs?: number;
  readonly notOnOrAfterOffsetMs?: number;
  readonly key?: SigningKey;
  readonly signatureAlgorithm?: string;
  readonly digestAlgorithm?: string;
  /** Base64 DER X.509 the signature's KeyInfo names; omitted means no KeyInfo. */
  readonly keyInfoCertificate?: string;
  readonly attributes?: string;
}

const instant = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

export function assertionXml(options: ResponseOptions, id: string): string {
  const inResponseTo =
    options.inResponseTo === undefined ? "" : ` InResponseTo="${options.inResponseTo}"`;
  const expiry = instant(options.notOnOrAfterOffsetMs ?? 300_000);
  const nameId = options.nameId ?? "alice@acme.test";
  return (
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${options.issueInstant ?? instant(options.issueInstantOffsetMs ?? -1_000)}">` +
    `<saml:Issuer>${options.issuer ?? IDP_ENTITY_ID}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="${options.nameIdFormat ?? EMAIL_FORMAT}">${nameId}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData Recipient="${options.recipient ?? ACS_URL}" NotOnOrAfter="${expiry}"${inResponseTo}/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${instant(options.notBeforeOffsetMs ?? -60_000)}" NotOnOrAfter="${expiry}"><saml:AudienceRestriction><saml:Audience>${options.audience ?? SP_ENTITY_ID}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${instant(-2_000)}" SessionIndex="_session-${id}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement>${
      options.attributes ??
      `<saml:Attribute Name="email"><saml:AttributeValue>${nameId}</saml:AttributeValue></saml:Attribute>` +
        `<saml:Attribute Name="name"><saml:AttributeValue>Alice Example</saml:AttributeValue></saml:Attribute>` +
        `<saml:Attribute Name="groups"><saml:AttributeValue>eng</saml:AttributeValue><saml:AttributeValue>admins</saml:AttributeValue></saml:Attribute>`
    }</saml:AttributeStatement></saml:Assertion>`
  );
}

export function signElement(xml: string, localName: string, options: ResponseOptions): string {
  const key = options.key ?? idpKey;
  const signer = new SignedXml({
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    privateKey: key.privateKey.export({ format: "pem", type: "pkcs8" }),
    signatureAlgorithm: options.signatureAlgorithm ?? RSA_SHA256,
    ...(options.keyInfoCertificate === undefined
      ? {}
      : {
          getKeyInfoContent: () =>
            `<ds:X509Data><ds:X509Certificate>${options.keyInfoCertificate}</ds:X509Certificate></ds:X509Data>`,
        }),
  });
  signer.addReference({
    digestAlgorithm: options.digestAlgorithm ?? SHA256,
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    xpath: `/*[local-name(.)='${localName}']`,
  });
  signer.computeSignature(xml, {
    location: { action: "after", reference: "/*/*[local-name(.)='Issuer']" },
    prefix: "ds",
  });
  return signer.getSignedXml();
}

export function responseXml(options: ResponseOptions = {}): string {
  const sign = options.sign ?? "assertion";
  let assertion = assertionXml(options, options.assertionId ?? ASSERTION_ID);
  if (sign === "assertion" || sign === "both")
    assertion = signElement(assertion, "Assertion", options);
  const inResponseTo = options.responseInResponseTo ?? options.inResponseTo;
  const response =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_response-0001" Version="2.0" IssueInstant="${instant(-1_000)}" Destination="${options.destination ?? ACS_URL}"${inResponseTo === undefined ? "" : ` InResponseTo="${inResponseTo}"`}>` +
    `<saml:Issuer>${options.issuer ?? IDP_ENTITY_ID}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="${options.status ?? "urn:oasis:names:tc:SAML:2.0:status:Success"}"/></samlp:Status>` +
    `${assertion}</samlp:Response>`;
  return sign === "response" || sign === "both"
    ? signElement(response, "Response", options)
    : response;
}

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining >>= 8) bytes.unshift(remaining & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, ...contents: Buffer[]): Buffer {
  const body = Buffer.concat(contents);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

/**
 * A minimal X.509 v3 certificate signed with RSA/SHA-256 by `issuerKey`, so no private key is
 * committed. The subject key may differ from the issuer key (to describe an EC subject).
 */
export function certificate(input: {
  readonly commonName: string;
  readonly subjectKey: KeyObject;
  readonly issuerKey: KeyObject;
  readonly notAfter?: Date;
}): string {
  const notBefore = new Date("2026-01-01T00:00:00.000Z");
  const notAfter = input.notAfter ?? new Date("2036-01-01T00:00:00.000Z");
  const sequence = (...contents: Buffer[]) => der(0x30, ...contents);
  const utcTime = (date: Date) =>
    der(0x17, Buffer.from(`${date.toISOString().slice(2, 19).replace(/[-:T]/gu, "")}Z`, "ascii"));
  const sha256WithRsa = sequence(der(0x06, Buffer.from("2a864886f70d01010b", "hex")), der(0x05));
  const name = sequence(
    der(
      0x31,
      sequence(der(0x06, Buffer.from("550403", "hex")), der(0x0c, Buffer.from(input.commonName))),
    ),
  );
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    sha256WithRsa,
    name,
    sequence(utcTime(notBefore), utcTime(notAfter)),
    name,
    input.subjectKey.export({ format: "der", type: "spki" }),
  );
  const signature = sign("sha256", tbs, input.issuerKey);
  return sequence(tbs, sha256WithRsa, der(0x03, Buffer.from([0]), signature)).toString("base64");
}
