import type { Element } from "@xmldom/xmldom";

import { type SignatureDefect, verifyAssertionSignature } from "./signature.ts";
import {
  attributeValue,
  childElements,
  isElementNamed,
  onlyChild,
  parseXml,
  SAML_ASSERTION_NAMESPACE,
  SAML_PROTOCOL_NAMESPACE,
  type XmlDefect,
} from "./xml.ts";

declare const verifiedAssertionBrand: unique symbol;

/** Read only from the bytes the IdP signed. Only `verifySamlResponse` mints one. */
export interface VerifiedAssertion {
  readonly [verifiedAssertionBrand]: true;
  readonly issuer: string;
  readonly assertionId: string;
  readonly issueInstant: string;
  readonly authnInstant: string;
  readonly sessionIndex: string | null;
  readonly nameId: string;
  readonly nameIdFormat: string | null;
  /**
   * The signed bearer SubjectConfirmationData InResponseTo. A Response@InResponseTo that differs
   * from it is rejected, so `null` means the response names no request anywhere.
   */
  readonly inResponseTo: string | null;
  readonly notOnOrAfter: string;
  readonly attributes: Readonly<Record<string, readonly string[]>>;
}

export interface SamlTrust {
  /** The required Audience. */
  readonly spEntityId: string;
  /** The required Response@Destination (when present) and SubjectConfirmationData@Recipient. */
  readonly acsUrl: string;
  /** The required assertion Issuer. */
  readonly idpEntityId: string;
  /** Base64 DER. More than one during IdP certificate rollover. */
  readonly signingCertificates: readonly [string, ...string[]];
}

export const SAML_CLOCK_SKEW_MS = 60_000;

export type SamlResponseDefect =
  | XmlDefect
  | SignatureDefect
  | "not_a_response"
  | "status_not_success"
  | "encrypted_assertion_unsupported"
  | "assertion_count"
  | "destination_mismatch"
  | "issuer_mismatch"
  | "audience_mismatch"
  | "instant_malformed"
  | "not_yet_valid"
  | "expired"
  | "subject_missing"
  | "name_id_transient"
  | "recipient_mismatch"
  | "in_response_to_mismatch"
  | "authn_statement_missing";

export type SamlVerification =
  | { readonly kind: "verified"; readonly assertion: VerifiedAssertion }
  | { readonly kind: "rejected"; readonly defect: SamlResponseDefect };

const STATUS_SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";
const BEARER_METHOD = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const TRANSIENT_NAME_ID_FORMAT = "urn:oasis:names:tc:SAML:2.0:nameid-format:transient";
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

const rejected = (defect: SamlResponseDefect): SamlVerification => ({ defect, kind: "rejected" });

/** `responseXml` is the base64-decoded SAMLResponse form value. Stateless: replay is the caller's. */
export function verifySamlResponse(
  responseXml: string,
  trust: SamlTrust,
  now: Date,
): SamlVerification {
  const parsed = parseXml(responseXml);
  if (parsed.kind === "rejected") return rejected(parsed.defect);
  const { document } = parsed;
  const response = document.documentElement;
  if (response === null || !isElementNamed(response, SAML_PROTOCOL_NAMESPACE, "Response")) {
    return rejected("not_a_response");
  }

  const status = onlyChild(response, SAML_PROTOCOL_NAMESPACE, "Status");
  const statusCode = status && onlyChild(status, SAML_PROTOCOL_NAMESPACE, "StatusCode");
  if (statusCode === undefined || attributeValue(statusCode, "Value") !== STATUS_SUCCESS) {
    return rejected("status_not_success");
  }
  if (document.getElementsByTagNameNS(SAML_ASSERTION_NAMESPACE, "EncryptedAssertion").length > 0) {
    return rejected("encrypted_assertion_unsupported");
  }
  const envelopeAssertion = onlyChild(response, SAML_ASSERTION_NAMESPACE, "Assertion");
  if (
    envelopeAssertion === undefined ||
    document.getElementsByTagNameNS(SAML_ASSERTION_NAMESPACE, "Assertion").length !== 1
  ) {
    return rejected("assertion_count");
  }
  const destination = attributeValue(response, "Destination");
  if (destination !== null && destination !== trust.acsUrl) return rejected("destination_mismatch");

  const signature = verifyAssertionSignature({
    assertion: envelopeAssertion,
    responseXml,
    signingCertificates: trust.signingCertificates,
  });
  if (signature.kind === "rejected") return rejected(signature.defect);

  return verifiedAssertion({
    assertion: signature.assertion,
    assertionId: signature.assertionId,
    now: now.getTime(),
    responseInResponseTo: attributeValue(response, "InResponseTo"),
    trust,
  });
}

function verifiedAssertion(input: {
  readonly assertion: Element;
  readonly assertionId: string;
  readonly responseInResponseTo: string | null;
  readonly trust: SamlTrust;
  readonly now: number;
}): SamlVerification {
  const { assertion, now, trust } = input;
  const issuer = onlyChild(assertion, SAML_ASSERTION_NAMESPACE, "Issuer");
  if (issuer?.textContent !== trust.idpEntityId) return rejected("issuer_mismatch");

  const issueInstant = instant(attributeValue(assertion, "IssueInstant"));
  if (issueInstant === undefined) return rejected("instant_malformed");
  if (issueInstant - SAML_CLOCK_SKEW_MS > now) return rejected("not_yet_valid");

  const conditions = onlyChild(assertion, SAML_ASSERTION_NAMESPACE, "Conditions");
  if (conditions === undefined) return rejected("audience_mismatch");
  const audienceRestrictions = childElements(
    conditions,
    SAML_ASSERTION_NAMESPACE,
    "AudienceRestriction",
  );
  // Every AudienceRestriction must be satisfied; each one lists alternatives (SAML core 2.5.1.4).
  if (
    audienceRestrictions.length === 0 ||
    !audienceRestrictions.every((restriction) =>
      childElements(restriction, SAML_ASSERTION_NAMESPACE, "Audience").some(
        (audience) => audience.textContent === trust.spEntityId,
      ),
    )
  ) {
    return rejected("audience_mismatch");
  }
  const notBefore = optionalInstant(attributeValue(conditions, "NotBefore"));
  const conditionsNotOnOrAfter = optionalInstant(attributeValue(conditions, "NotOnOrAfter"));
  if (notBefore === undefined || conditionsNotOnOrAfter === undefined) {
    return rejected("instant_malformed");
  }
  if (notBefore !== null && notBefore - SAML_CLOCK_SKEW_MS > now) return rejected("not_yet_valid");
  if (conditionsNotOnOrAfter !== null && conditionsNotOnOrAfter + SAML_CLOCK_SKEW_MS <= now) {
    return rejected("expired");
  }

  const subject = onlyChild(assertion, SAML_ASSERTION_NAMESPACE, "Subject");
  const nameId = subject && onlyChild(subject, SAML_ASSERTION_NAMESPACE, "NameID");
  const bearerConfirmations = subject
    ? childElements(subject, SAML_ASSERTION_NAMESPACE, "SubjectConfirmation").filter(
        (confirmation) => attributeValue(confirmation, "Method") === BEARER_METHOD,
      )
    : [];
  const [bearer] = bearerConfirmations;
  const confirmationData =
    bearerConfirmations.length === 1 && bearer
      ? onlyChild(bearer, SAML_ASSERTION_NAMESPACE, "SubjectConfirmationData")
      : undefined;
  if (nameId === undefined || !nameId.textContent || confirmationData === undefined) {
    return rejected("subject_missing");
  }
  const nameIdFormat = attributeValue(nameId, "Format");
  if (nameIdFormat === TRANSIENT_NAME_ID_FORMAT) return rejected("name_id_transient");
  if (attributeValue(confirmationData, "Recipient") !== trust.acsUrl) {
    return rejected("recipient_mismatch");
  }
  const notOnOrAfterValue = attributeValue(confirmationData, "NotOnOrAfter");
  if (notOnOrAfterValue === null) return rejected("subject_missing");
  const notOnOrAfter = instant(notOnOrAfterValue);
  if (notOnOrAfter === undefined) return rejected("instant_malformed");
  if (notOnOrAfter + SAML_CLOCK_SKEW_MS <= now) return rejected("expired");
  const inResponseTo = attributeValue(confirmationData, "InResponseTo");
  if (input.responseInResponseTo !== null && input.responseInResponseTo !== inResponseTo) {
    return rejected("in_response_to_mismatch");
  }

  const authnStatement = onlyChild(assertion, SAML_ASSERTION_NAMESPACE, "AuthnStatement");
  if (authnStatement === undefined) return rejected("authn_statement_missing");
  const authnInstant = instant(attributeValue(authnStatement, "AuthnInstant"));
  if (authnInstant === undefined) return rejected("instant_malformed");

  const verified = {
    assertionId: input.assertionId,
    attributes: assertionAttributes(assertion),
    authnInstant: new Date(authnInstant).toISOString(),
    inResponseTo,
    issueInstant: new Date(issueInstant).toISOString(),
    issuer: trust.idpEntityId,
    nameId: nameId.textContent,
    nameIdFormat,
    notOnOrAfter: new Date(notOnOrAfter).toISOString(),
    sessionIndex: attributeValue(authnStatement, "SessionIndex"),
  };
  return { assertion: verified as VerifiedAssertion, kind: "verified" };
}

/** `undefined` when absent or not an xs:dateTime with a zone; SAML instants are UTC. */
function instant(value: string | null): number | undefined {
  if (value === null || !DATE_TIME.test(value)) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) ? undefined : milliseconds;
}

/** `null` when absent, `undefined` when present but malformed. */
function optionalInstant(value: string | null): number | null | undefined {
  return value === null ? null : instant(value);
}

function assertionAttributes(assertion: Element): Record<string, readonly string[]> {
  const attributes = new Map<string, string[]>();
  for (const statement of childElements(
    assertion,
    SAML_ASSERTION_NAMESPACE,
    "AttributeStatement",
  )) {
    for (const attribute of childElements(statement, SAML_ASSERTION_NAMESPACE, "Attribute")) {
      const name = attributeValue(attribute, "Name");
      if (name === null) continue;
      const values = childElements(attribute, SAML_ASSERTION_NAMESPACE, "AttributeValue").map(
        (value) => value.textContent ?? "",
      );
      attributes.set(name, [...(attributes.get(name) ?? []), ...values]);
    }
  }
  // Object.fromEntries defines own properties, so a "__proto__" attribute name stays data.
  return Object.fromEntries(attributes);
}
