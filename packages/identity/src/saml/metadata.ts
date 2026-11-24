import { X509Certificate } from "node:crypto";

import type { Element } from "@xmldom/xmldom";

import {
  attributeValue,
  childElements,
  isElementNamed,
  parseXml,
  SAML_METADATA_NAMESPACE,
  XMLDSIG_NAMESPACE,
  type XmlDefect,
} from "./xml.ts";

export interface SamlSigningCertificate {
  /** Base64 DER, as `SamlTrust.signingCertificates` carries it. */
  readonly certificate: string;
  /** Colon-separated uppercase hex, as `openssl x509 -fingerprint -sha256` prints it. */
  readonly sha256Fingerprint: string;
  readonly notAfter: string;
}

export interface IdpMetadata {
  /** EntityDescriptor@entityID: any absolute URI, such as Okta's `http://www.okta.com/…`. */
  readonly entityId: string;
  /** The HTTP-Redirect SingleSignOnService Location. */
  readonly singleSignOnRedirectUrl: string;
  readonly signingCertificates: readonly [SamlSigningCertificate, ...SamlSigningCertificate[]];
}

export type IdpMetadataDefect =
  | XmlDefect
  | "entities_descriptor_unsupported"
  | "not_entity_descriptor"
  | "entity_id_invalid"
  | "idp_descriptor_count"
  | "redirect_binding_missing"
  | "sso_url_not_https"
  | "signing_certificate_missing"
  | "signing_certificate_count"
  | "signing_certificate_invalid"
  | "signing_certificate_unsupported";

export type IdpMetadataParse =
  | { readonly kind: "parsed"; readonly metadata: IdpMetadata }
  | { readonly kind: "rejected"; readonly defect: IdpMetadataDefect };

/**
 * SAML allows 1024. 512 keeps the `principal-identity:<entityId>` claim key under DynamoDB's
 * 2048-byte partition key after URI encoding triples `/` and `:`.
 */
export const SAML_ENTITY_ID_MAX_LENGTH = 512;
export const SAML_MAX_SIGNING_CERTIFICATES = 4;

const SAML_PROTOCOL = "urn:oasis:names:tc:SAML:2.0:protocol";
const REDIRECT_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
const ABSOLUTE_URI = /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/u;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

const rejected = (defect: IdpMetadataDefect): IdpMetadataParse => ({ defect, kind: "rejected" });

/**
 * Reads one IdP EntityDescriptor. Certificates come only from the SAML 2.0 IDPSSODescriptor's
 * signing KeyDescriptors, never from WS-Federation RoleDescriptors, encryption keys or the metadata
 * document's own signature.
 */
export function parseIdpMetadata(xml: string): IdpMetadataParse {
  const parsed = parseXml(xml);
  if (parsed.kind === "rejected") return rejected(parsed.defect);
  const root = parsed.document.documentElement;
  if (root === null) return rejected("not_entity_descriptor");
  if (isElementNamed(root, SAML_METADATA_NAMESPACE, "EntitiesDescriptor")) {
    return rejected("entities_descriptor_unsupported");
  }
  if (!isElementNamed(root, SAML_METADATA_NAMESPACE, "EntityDescriptor")) {
    return rejected("not_entity_descriptor");
  }

  const entityId = attributeValue(root, "entityID") ?? "";
  if (entityId.length > SAML_ENTITY_ID_MAX_LENGTH || !ABSOLUTE_URI.test(entityId)) {
    return rejected("entity_id_invalid");
  }

  const descriptors = childElements(root, SAML_METADATA_NAMESPACE, "IDPSSODescriptor").filter(
    (descriptor) =>
      (attributeValue(descriptor, "protocolSupportEnumeration") ?? "")
        .split(/\s+/u)
        .includes(SAML_PROTOCOL),
  );
  const [descriptor] = descriptors;
  if (descriptor === undefined || descriptors.length > 1) return rejected("idp_descriptor_count");

  const redirect = childElements(descriptor, SAML_METADATA_NAMESPACE, "SingleSignOnService").find(
    (service) => attributeValue(service, "Binding") === REDIRECT_BINDING,
  );
  if (redirect === undefined) return rejected("redirect_binding_missing");
  const location = URL.parse(attributeValue(redirect, "Location") ?? "");
  if (location?.protocol !== "https:") return rejected("sso_url_not_https");

  const encodedCertificates = new Set(
    childElements(descriptor, SAML_METADATA_NAMESPACE, "KeyDescriptor")
      .filter((key) => (attributeValue(key, "use") ?? "signing") === "signing")
      .flatMap((key) => descendants(key, ["KeyInfo", "X509Data", "X509Certificate"]))
      .map((certificate) => (certificate.textContent ?? "").replace(/\s/gu, "")),
  );
  if (encodedCertificates.size > SAML_MAX_SIGNING_CERTIFICATES) {
    return rejected("signing_certificate_count");
  }
  const certificates: SamlSigningCertificate[] = [];
  for (const encoded of encodedCertificates) {
    const certificate = x509(encoded);
    if (certificate === undefined) return rejected("signing_certificate_invalid");
    if (certificate.publicKey.asymmetricKeyType !== "rsa") {
      return rejected("signing_certificate_unsupported");
    }
    certificates.push(describe(certificate));
  }
  const [first, ...rest] = certificates;
  if (first === undefined) return rejected("signing_certificate_missing");

  return {
    kind: "parsed",
    metadata: {
      entityId,
      signingCertificates: [first, ...rest],
      singleSignOnRedirectUrl: location.href,
    },
  };
}

/** For admin responses and the console, which show fingerprints instead of certificates. */
export function describeSigningCertificate(base64Der: string): SamlSigningCertificate | undefined {
  const certificate = x509(base64Der);
  return certificate && describe(certificate);
}

function x509(base64Der: string): X509Certificate | undefined {
  if (!BASE64.test(base64Der)) return undefined;
  try {
    return new X509Certificate(Buffer.from(base64Der, "base64"));
  } catch {
    return undefined;
  }
}

function describe(certificate: X509Certificate): SamlSigningCertificate {
  return {
    certificate: certificate.raw.toString("base64"),
    notAfter: certificate.validToDate.toISOString(),
    sha256Fingerprint: certificate.fingerprint256,
  };
}

function descendants(parent: Element, path: readonly string[]): Element[] {
  const [localName, ...rest] = path;
  if (localName === undefined) return [parent];
  return childElements(parent, XMLDSIG_NAMESPACE, localName).flatMap((child) =>
    descendants(child, rest),
  );
}
