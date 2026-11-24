import { X509Certificate } from "node:crypto";

import type { Element } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";

import {
  attributeValue,
  childElements,
  isElementNamed,
  parseXml,
  SAML_ASSERTION_NAMESPACE,
  XMLDSIG_NAMESPACE,
} from "./xml.ts";

/** xml-crypto 6.4 also accepts rsa-sha1, hmac-sha1 and MGF1, and implements no ECDSA. */
const SIGNATURE_ALGORITHMS: readonly string[] = [
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512",
];
const DIGEST_ALGORITHMS: readonly string[] = [
  "http://www.w3.org/2001/04/xmlenc#sha256",
  "http://www.w3.org/2001/04/xmlenc#sha512",
];

export type SignatureDefect =
  | "signature_missing"
  | "signature_algorithm_forbidden"
  | "signature_reference_mismatch"
  | "signature_untrusted";

export type AssertionSignature =
  | { readonly kind: "signed"; readonly assertion: Element; readonly assertionId: string }
  | { readonly kind: "rejected"; readonly defect: SignatureDefect };

/**
 * Verifies the Assertion's own enveloped signature against the trusted certificates and returns the
 * Assertion re-parsed from the bytes xml-crypto authenticated. xml-crypto re-parses `responseXml`
 * with its own xmldom copy, so the returned element is checked again for name and ID instead of
 * trusting that both parsers agreed on which element the reference selected.
 */
export function verifyAssertionSignature(input: {
  readonly responseXml: string;
  readonly assertion: Element;
  readonly signingCertificates: readonly [string, ...string[]];
}): AssertionSignature {
  const assertionId = attributeValue(input.assertion, "ID");
  const signatures = childElements(input.assertion, XMLDSIG_NAMESPACE, "Signature");
  const [signature] = signatures;
  if (signature === undefined) return { defect: "signature_missing", kind: "rejected" };
  if (signatures.length > 1 || !assertionId) {
    return { defect: "signature_reference_mismatch", kind: "rejected" };
  }

  const load = (certificate: string): SignedXml => {
    const verifier = new SignedXml({
      getCertFromKeyInfo: () => null,
      publicCert: new X509Certificate(Buffer.from(certificate, "base64")).publicKey,
    });
    verifier.loadSignature(signature);
    return verifier;
  };
  const [firstCertificate, ...otherCertificates] = candidateCertificates(
    signature,
    input.signingCertificates,
  );
  let loaded: SignedXml;
  let verifiers: SignedXml[];
  try {
    loaded = load(firstCertificate);
    verifiers = [loaded, ...otherCertificates.map(load)];
  } catch {
    return { defect: "signature_untrusted", kind: "rejected" };
  }

  const references = loaded.getReferences();
  if (
    !SIGNATURE_ALGORITHMS.includes(loaded.signatureAlgorithm ?? "") ||
    !references.every((reference) => DIGEST_ALGORITHMS.includes(reference.digestAlgorithm))
  ) {
    return { defect: "signature_algorithm_forbidden", kind: "rejected" };
  }
  if (references.length !== 1 || references[0]?.uri !== `#${assertionId}`) {
    return { defect: "signature_reference_mismatch", kind: "rejected" };
  }

  for (const verifier of verifiers) {
    try {
      if (!verifier.checkSignature(input.responseXml)) continue;
    } catch {
      continue;
    }
    const [signedXml, ...extra] = verifier.getSignedReferences();
    const signed = signedXml === undefined ? undefined : parseXml(signedXml);
    const element = signed?.kind === "parsed" ? signed.document.documentElement : null;
    if (
      extra.length > 0 ||
      element === null ||
      !isElementNamed(element, SAML_ASSERTION_NAMESPACE, "Assertion") ||
      attributeValue(element, "ID") !== assertionId
    ) {
      return { defect: "signature_reference_mismatch", kind: "rejected" };
    }
    return { assertion: element, assertionId, kind: "signed" };
  }
  return { defect: "signature_untrusted", kind: "rejected" };
}

/**
 * Each check canonicalizes and digests the whole Assertion, so the KeyInfo certificate picks the one
 * trusted certificate to check. KeyInfo is unsigned: it never adds trust, and when it names no
 * trusted certificate every trusted certificate is checked.
 */
function candidateCertificates(
  signature: Element,
  signingCertificates: readonly [string, ...string[]],
): readonly [string, ...string[]] {
  const named = childElements(signature, XMLDSIG_NAMESPACE, "KeyInfo")
    .flatMap((keyInfo) => childElements(keyInfo, XMLDSIG_NAMESPACE, "X509Data"))
    .flatMap((data) => childElements(data, XMLDSIG_NAMESPACE, "X509Certificate"))
    .map((element) => Buffer.from(element.textContent ?? "", "base64"));
  const hinted = signingCertificates.find((certificate) =>
    named.some((der) => der.equals(Buffer.from(certificate, "base64"))),
  );
  return hinted === undefined ? signingCertificates : [hinted];
}
